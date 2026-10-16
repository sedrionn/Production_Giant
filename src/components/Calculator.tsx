"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CalcRequest, CalcResponse } from "@/server/calculate";
import type { Decision } from "@/engine/tree";
import type { PriceMode } from "@/engine/pricing";
import { ago, isk, pct } from "@/lib/format";
import { Search, type Picked } from "./ItemSearch";
import { Ledger } from "./Ledger";
import { TreeView } from "./TreeView";
import { JobsTable, ShoppingTable } from "./Tables";

interface ProfileRow {
  id: number;
  name: string;
  structureType: string;
}

type Form = Omit<CalcRequest, "typeId"> & { item: Picked | null };

const STORAGE = "pg.calc.v1";
const DEFAULT_FORM: Form = { item: null, runs: 10, decisions: {} };
const MODES: { v: PriceMode; label: string }[] = [
  { v: "sell", label: "sell" },
  { v: "buy", label: "buy" },
  { v: "split", label: "середина" },
];

function load(): Form {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? { ...DEFAULT_FORM, ...(JSON.parse(raw) as Form) } : DEFAULT_FORM;
  } catch {
    return DEFAULT_FORM;
  }
}

export function Calculator() {
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [ready, setReady] = useState(false);
  const [res, setRes] = useState<CalcResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [tab, setTab] = useState<"tree" | "jobs" | "shopping">("tree");
  const seq = useRef(0);

  useEffect(() => {
    const saved = load();
    // Deep link from the overview: /?typeId=…&name=…&runs=…
    const q = new URLSearchParams(window.location.search);
    const id = Number(q.get("typeId"));
    if (id) {
      setForm({ ...DEFAULT_FORM, ...saved, item: { id, name: q.get("name") ?? `#${id}` }, runs: Number(q.get("runs")) || saved.runs, decisions: {}, me: undefined, te: undefined, inventionSourceId: undefined, blueprintSource: undefined });
      window.history.replaceState(null, "", "/");
    } else {
      setForm(saved);
    }
    setReady(true);
    fetch("/api/profiles")
      .then((r) => r.json())
      .then(setProfiles)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(form));
    } catch {}
  }, [form, ready]);

  const run = useCallback(async (f: Form) => {
    if (!f.item) return;
    const my = ++seq.current;
    setBusy(true);
    try {
      const { item, ...rest } = f;
      const r = await fetch("/api/calc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rest, typeId: item.id, compareDecryptors: true }),
      });
      const body = await r.json();
      if (my !== seq.current) return;
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setRes(body as CalcResponse);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => run(form), 200);
    return () => clearTimeout(t);
  }, [form, ready, run]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const decide = (typeId: number, d: Decision | null) =>
    setForm((f) => {
      const decisions = { ...(f.decisions ?? {}) };
      if (d === null) delete decisions[typeId];
      else decisions[typeId] = d;
      return { ...f, decisions };
    });

  const refresh = async () => {
    if (!form.item) return;
    setRefreshing("Тяну цены из ESI…");
    try {
      const r = await fetch("/api/prices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: form.item.id }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setRefreshing(body.failed.length ? `Обновлено ${body.quotes}, не удалось ${body.failed.length}` : `Обновлено ${body.quotes} цен`);
      await run(form);
    } catch (e) {
      setRefreshing(`ESI недоступен: ${(e as Error).message}`);
    }
    setTimeout(() => setRefreshing(null), 5000);
  };

  const mfgProfiles = profiles.filter((p) => !["athanor", "tatara"].includes(p.structureType));
  const rxProfiles = profiles.filter((p) => ["athanor", "tatara"].includes(p.structureType));
  const r = res?.request;
  const invention = res?.invention;

  return (
    <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-6 lg:grid-cols-[19rem_1fr]">
      {/* ---- job setup ---- */}
      <aside className="space-y-5">
        <Field label="Что строим">
          <Search
            endpoint="/api/search"
            idKey="typeId"
            placeholder="Например, Jackdaw"
            value={form.item}
            onPick={(item) => set({ item, decisions: {}, me: undefined, te: undefined, inventionSourceId: undefined, blueprintSource: undefined })}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Раны">
            <Num value={form.runs} min={1} max={100000} onChange={(runs) => set({ runs: runs ?? 1 })} />
          </Field>
          <Field label="ME">
            <Num value={form.me ?? r?.me} min={0} max={10} onChange={(me) => set({ me })} />
          </Field>
          <Field label="TE">
            <Num value={form.te ?? r?.te} min={0} max={20} onChange={(te) => set({ te })} />
          </Field>
        </div>

        <Field label="Чертёж">
          <Segmented
            value={r?.blueprintSource ?? form.blueprintSource ?? "owned"}
            options={[
              { v: "owned", label: "свой" },
              { v: "invention", label: "инвент", disabled: !invention?.options.length },
            ]}
            onChange={(v) => set({ blueprintSource: v as Form["blueprintSource"], me: undefined, te: undefined })}
          />
        </Field>

        {res && r?.blueprintSource === "owned" && (
          <p className="-mt-3 text-sm text-graphite">
            {res.ownedBlueprint
              ? `${res.ownedBlueprint.isBpo ? "BPO" : `BPC, ${res.ownedBlueprint.runs} ранов`}, ME ${res.ownedBlueprint.me} / TE ${res.ownedBlueprint.te}`
              : res.skillsSource === "characters"
                ? "у персонажей нет этого чертежа"
                : "ME/TE вводятся вручную"}
          </p>
        )}

        {r?.blueprintSource === "invention" && invention && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm text-graphite">Из чего инвентим</legend>
            {invention.options.map((o) => (
              <label
                key={o.sourceId}
                className={`flex cursor-pointer items-baseline justify-between gap-2 rounded px-2 py-1.5 ring-1 ${
                  invention.chosen?.sourceId === o.sourceId ? "bg-sheet ring-marker/60" : "ring-line hover:bg-sheet/60"
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <input
                    type="radio"
                    name="inv"
                    className="accent-[var(--marker)]"
                    checked={invention.chosen?.sourceId === o.sourceId}
                    onChange={() => set({ inventionSourceId: o.sourceId })}
                  />
                  <span>
                    {o.sourceName}
                    <span className="block text-xs text-graphite">
                      {pct(o.chance, 0)} шанс, {o.runsPerSuccess} ранов
                    </span>
                  </span>
                </span>
                <span className="text-right text-sm" title="Стоимость чертежа на один ран">
                  {isk(o.costPerRun)}
                  <span className="block text-xs text-graphite">за ран</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {r?.blueprintSource === "invention" && invention && invention.comparison.length > 1 && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-graphite" title="Прибыль той же партии с каждым декриптором: свой шанс, ME/TE и раны, полное дерево">
              Декриптор
            </legend>
            {[...invention.comparison]
              .sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity))
              .map((c, i) => {
                const active = (invention.decryptor?.typeId ?? null) === c.decryptorId;
                return (
                  <label
                    key={c.decryptorId ?? 0}
                    className={`flex cursor-pointer items-baseline justify-between gap-2 rounded px-2 py-1 ring-1 ${active ? "bg-sheet ring-marker/60" : "ring-line hover:bg-sheet/60"}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <input type="radio" name="dec" className="accent-[var(--marker)]" checked={active} onChange={() => set({ decryptorId: c.decryptorId, me: undefined, te: undefined })} />
                      <span>
                        {c.name.replace(" Decryptor", "")}
                        {i === 0 && <span className="ml-1.5 text-xs text-gain">лучший</span>}
                        <span className="block text-xs text-graphite">
                          ME {c.me} / TE {c.te}, {c.runsPerSuccess} ран., {pct(c.chance, 0)}
                        </span>
                      </span>
                    </span>
                    <span className={`text-right text-sm ${(c.profit ?? 0) >= 0 ? "text-gain" : "text-loss"}`}>{isk(c.profit, true)}</span>
                  </label>
                );
              })}
          </fieldset>
        )}

        <Field label="Производство">
          <Select
            value={form.manufacturingProfileId ?? res?.facilities.manufacturing?.id ?? ""}
            onChange={(v) => set({ manufacturingProfileId: v ? Number(v) : undefined })}
            options={mfgProfiles.map((p) => ({ v: p.id, label: p.name }))}
          />
        </Field>
        <Field label="Реакции">
          <Select
            value={form.reactionProfileId ?? res?.facilities.reaction?.id ?? ""}
            onChange={(v) => set({ reactionProfileId: v ? Number(v) : undefined })}
            options={rxProfiles.map((p) => ({ v: p.id, label: p.name }))}
          />
        </Field>

        <Field label="Материалы по">
          <Segmented value={r?.materialPriceMode ?? "sell"} options={MODES} onChange={(v) => set({ materialPriceMode: v as PriceMode })} />
        </Field>
        <Field label="Продаём по">
          <Segmented value={r?.productPriceMode ?? "sell"} options={MODES} onChange={(v) => set({ productPriceMode: v as PriceMode })} />
        </Field>

        <div className="space-y-2 border-t border-line pt-4">
          <button
            onClick={refresh}
            disabled={!form.item || !!refreshing}
            className="w-full rounded border border-marker/70 px-3 py-2 text-marker hover:bg-marker/10 disabled:opacity-50"
          >
            Обновить цены
          </button>
          <p className="text-sm text-graphite" aria-live="polite">
            {refreshing ?? (res ? priceNote(res) : "")}
          </p>
          {Object.keys(form.decisions ?? {}).length > 0 && (
            <button onClick={() => set({ decisions: {} })} className="text-sm text-graphite underline hover:text-chalk">
              Сбросить ручные решения ({Object.keys(form.decisions ?? {}).length})
            </button>
          )}
        </div>
      </aside>

      {/* ---- result ---- */}
      <main className={`min-w-0 space-y-6 transition-opacity ${busy ? "opacity-70" : ""}`}>
        {!form.item && <Empty />}
        {error && <p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p>}
        {res && form.item && (
          <>
            <div>
              <h1 className="font-display text-4xl font-semibold tracking-wide">
                {res.product.name} <span className="text-graphite">× {res.summary.output}</span>
              </h1>
              <p className="mt-1 text-graphite">
                {res.facilities.manufacturing?.name ?? "NPC"}
                {res.facilities.manufacturing?.systemName ? `, ${res.facilities.manufacturing.systemName}` : ""}
                {res.facilities.manufacturing?.costIndices.manufacturing !== undefined &&
                  `, индекс ${pct(res.facilities.manufacturing.costIndices.manufacturing, 2)}`}
              </p>
            </div>

            <Ledger s={res.summary} />

            {res.warnings.length > 0 && (
              <ul className="space-y-1 rounded border border-marker/40 bg-marker/5 px-4 py-3 text-sm">
                {res.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <div>
              <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
                {(
                  [
                    ["tree", "Дерево"],
                    ["jobs", `Джобы (${res.jobs.length})`],
                    ["shopping", `Закупка (${res.shopping.length})`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-marker text-chalk" : "border-transparent text-graphite hover:text-chalk"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === "tree" && <TreeView nodes={res.nodes} rootTypeId={res.product.typeId} onDecide={decide} />}
              {tab === "jobs" && <JobsTable jobs={res.jobs} />}
              {tab === "shopping" && <ShoppingTable lines={res.shopping} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function priceNote(res: CalcResponse): string {
  const p = res.prices;
  const parts: string[] = [res.skillsSource === "characters" ? "скиллы персонажей" : "скиллы из настроек"];
  if (p.esi) parts.push(`цены ESI: ${ago(p.oldest)}`);
  if (p.fixtures) parts.push(`${p.fixtures} цен из фикстур (${ago(p.fixturesCapturedAt)})`);
  if (p.none) parts.push(`${p.none} без цены`);
  if (res.sde.kind === "fixtures") parts.push("SDE из фикстур");
  return parts.join("; ");
}

function Empty() {
  return (
    <div className="rounded border border-dashed border-line px-6 py-16 text-center">
      <p className="font-display text-3xl">Выбери, что строить</p>
      <p className="mt-2 text-graphite">Начни вводить название слева: корабль, модуль, компонент или продукт реакции.</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-graphite">{label}</span>
      {children}
    </label>
  );
}

function Num({ value, min, max, onChange }: { value: number | undefined; min: number; max: number; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === "") return onChange(undefined);
        const n = Math.round(Number(e.target.value));
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
      className="w-full rounded border border-line bg-sheet px-2 py-2 text-right focus:border-marker focus:outline-none"
    />
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { v: string; label: string; disabled?: boolean }[];
  onChange: (v: string) => void;
}) {
  return (
    <div role="radiogroup" className="flex rounded border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={o.disabled}
          onClick={() => onChange(o.v)}
          className={`flex-1 rounded-sm px-2 py-1 text-sm disabled:opacity-40 ${value === o.v ? "bg-sheet-2 text-marker" : "text-graphite hover:text-chalk"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({ value, options, onChange }: { value: number | string; options: { v: number; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-line bg-sheet px-2 py-2 focus:border-marker focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
