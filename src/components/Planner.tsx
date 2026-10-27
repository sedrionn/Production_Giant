"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlanResponse } from "@/server/plan";
import type { ScheduledJob } from "@/engine/planner";
import { full, isk, pct, qty } from "@/lib/format";
import { stageName } from "@/lib/stages";
import { BuyList, StockPicker } from "./BuyList";
import { useOnRefreshed } from "./FullRefresh";
import { Search } from "./ItemSearch";

interface Form {
  budget: number;
  /** Batches made largely from stock go first within their tier. */
  stockFirst: boolean;
  /** Fill idle reaction slots with small reactions for sale. */
  fillIdleReactions: boolean;
  cadenceDays: number;
  marketShare: number;
  minBatchProfit: number;
  caldariShipsFirst: boolean;
  maxItemShare: number;
  /** Longest reaction job, days; 0 = no cap. */
  maxReactionJobDays: number;
  /** Longest manufacturing job, days; a longer BPC runs as sequential jobs. 0 = no cap. */
  maxManufacturingJobDays: number;
  /** Purchase list: materials for this many weeks. */
  buyWeeks: number;
  categories: string[];
  /** Always in the plan, before everything else: exactly this many units. */
  pins: Pin[];
}

interface Pin {
  typeId: number;
  name: string;
  units: number;
  decryptor: "auto" | "none" | number;
  source: "auto" | "owned" | "invention";
}

const DEFAULT: Form = { budget: 10e9, stockFirst: true, fillIdleReactions: true, cadenceDays: 2, marketShare: 0.3, minBatchProfit: 30e6, caldariShipsFirst: true, maxItemShare: 0.2, maxReactionJobDays: 2, maxManufacturingJobDays: 7, buyWeeks: 1, categories: ["caldari_t1", "caldari_t2", "t3", "rigs_t1", "rigs_t2", "reactions", "warp_disruptors"], pins: [] };
/** Where the form lived before it moved to the app DB: read once and moved over. */
const LEGACY_STORAGE = "pg.plan.v3";

/** A form from before pins were in units and the bubbles were a default category. */
function migrateLegacy(raw: Omit<Partial<Form>, "pins"> & { pins?: (Partial<Pin> & { batches?: number })[] }): Form {
  const categories = raw.categories?.length ? raw.categories : DEFAULT.categories;
  return {
    ...DEFAULT,
    ...raw,
    categories: categories.includes("warp_disruptors") ? categories : [...categories, "warp_disruptors"],
    pins: (raw.pins ?? []).map((p) => ({ typeId: p.typeId ?? 0, name: p.name ?? "", units: p.units ?? p.batches ?? 1, decryptor: p.decryptor ?? "auto", source: p.source ?? "auto" })),
  };
}

/** Keeps the form on the server: pins stay until removed, "Обновить всё" rebuilds the plan with it. */
const store = (f: Form) => {
  fetch("/api/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).catch(() => {});
};

export function Planner({ categories }: { categories: { key: string; label: string }[] }) {
  const [form, setForm] = useState<Form>(DEFAULT);
  const [plan, setPlan] = useState<(PlanResponse & { text: string; computedAt?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSheet, setShowSheet] = useState(false);

  // The last plan and the form (with pins) come back from the server.
  useEffect(() => {
    fetch("/api/plan")
      .then((r) => r.json())
      .then((b: { plan?: PlanResponse & { text: string }; form?: Form | null }) => {
        if (b.plan) setPlan((cur) => cur ?? b.plan!);
        if (b.form) return setForm({ ...DEFAULT, ...b.form });
        // First visit after the move: take the form this browser kept and store it on the server.
        let legacy: string | null = null;
        try {
          legacy = localStorage.getItem(LEGACY_STORAGE);
        } catch {}
        if (!legacy) return;
        const next = migrateLegacy(JSON.parse(legacy));
        setForm(next);
        store(next);
      })
      .catch(() => {});
  }, []);

  // "Обновить всё" rebuilds the plan with the stored form: show the new one.
  useOnRefreshed(
    useCallback(() => {
      fetch("/api/plan")
        .then((r) => r.json())
        .then((b) => b.plan && setPlan(b.plan))
        .catch(() => {});
    }, []),
  );

  const set = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    store(next);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setPlan(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!plan) return;
    setSaving(true);
    try {
      const r = await fetch("/api/plan/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      window.location.href = "/plan/stages";
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowSheet(true);
    }
  };

  const ics = () => {
    if (!plan) return;
    const blob = new Blob([icsFor(plan)], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "production-plan.ics";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6">
      <div>
        <h1 className="font-display text-4xl font-semibold tracking-wide">План недели</h1>
        <p className="mt-1 max-w-[85ch] text-graphite">
          План на 7 дней: всё, что в нём есть, стартует на этой неделе (закончиться может позже). Корпуса этой недели строятся из того, что
          уже есть на складе, а компоненты и реакции под следующую неделю ставятся параллельно, одной джобой на тип. Первая неделя с пустым
          складом — разгонная. Берутся только предметы, на которые есть свой чертёж или инвент.
        </p>
      </div>

      <section className="grid gap-4 rounded border border-line bg-sheet/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-8">
        <Num label="Бюджет, млрд ISK" value={form.budget / 1e9} step={0.5} onChange={(v) => set({ budget: v * 1e9 })} />
        <Num label="Захожу раз в, дней" value={form.cadenceDays} step={1} min={1} max={7} onChange={(v) => set({ cadenceDays: v })} />
        <Num label="Не больше, % рынка за период" value={Math.round(form.marketShare * 100)} step={5} min={5} max={100} onChange={(v) => set({ marketShare: v / 100 })} />
        <Num label="Партия от, млн ISK прибыли" value={form.minBatchProfit / 1e6} step={5} min={0} onChange={(v) => set({ minBatchProfit: v * 1e6 })} />
        <Num label="Одна позиция, не больше % бюджета" value={Math.round(form.maxItemShare * 100)} step={5} min={5} max={100} onChange={(v) => set({ maxItemShare: v / 100 })} />
        <Num label="Реакция: джоба не длиннее, дней (0 — без лимита)" value={form.maxReactionJobDays} step={0.5} min={0} max={28} onChange={(v) => set({ maxReactionJobDays: v })} />
        <Num
          label="Производство: джоба не длиннее, дней (0 — без лимита)"
          value={form.maxManufacturingJobDays}
          step={1}
          min={0}
          max={28}
          onChange={(v) => set({ maxManufacturingJobDays: v })}
        />
        <Num label="Закупка: запас на, недель" value={form.buyWeeks} step={1} min={1} max={8} onChange={(v) => set({ buyWeeks: Math.min(8, Math.max(1, Math.round(v))) })} />
        <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-8">
          <input type="checkbox" className="accent-[var(--marker)]" checked={form.caldariShipsFirst} onChange={(e) => set({ caldariShipsFirst: e.target.checked })} />
          Сначала калдарские корабли, остальное — заполнить свободные слоты и бюджет
        </label>
        <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-8" title="Партия, у которой треть стоимости и больше лежит на складе, идёт первой в своём ярусе (только прибыльные). Склад в любом случае не тратит бюджет">
          <input type="checkbox" className="accent-[var(--marker)]" checked={form.stockFirst} onChange={(e) => set({ stockFirst: e.target.checked })} />
          Сначала то, что делается из склада (компоненты и материалы в твоих структурах)
        </label>
        <label
          className="flex items-center gap-2 sm:col-span-2 lg:col-span-8"
          title="Реакции на продажу с прибылью ниже порога партии ставятся в самом конце: только на реакционные слоты и бюджет, которые остались"
        >
          <input type="checkbox" className="accent-[var(--marker)]" checked={form.fillIdleReactions} onChange={(e) => set({ fillIdleReactions: e.target.checked })} />
          Заполнять пустые реакционные слоты мелкими реакциями на продажу
        </label>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 sm:col-span-2 lg:col-span-8">
          <legend className="mb-1 text-sm text-graphite">Что рассматривать</legend>
          {categories.map((c) => (
            <label key={c.key} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-[var(--marker)]"
                checked={form.categories.includes(c.key)}
                onChange={(e) => set({ categories: e.target.checked ? [...form.categories, c.key] : form.categories.filter((k) => k !== c.key) })}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
        <Pins pins={form.pins} onChange={(pins) => set({ pins })} />
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-8">
          <button onClick={run} disabled={busy || !form.categories.length} className="rounded bg-marker px-4 py-1.5 font-medium text-ink hover:bg-marker/90 disabled:opacity-50">
            {busy ? "Считаю…" : "Составить план"}
          </button>
          {plan && (
            <>
              <button onClick={save} disabled={saving} className="rounded border border-marker/70 px-3 py-1.5 text-marker hover:bg-marker/10 disabled:opacity-50" title="Сохранить план: на странице «Этапы» видно, что уже запущено и готово">
                {saving ? "Сохраняю…" : "Запускаю этот план → Этапы"}
              </button>
              <button onClick={copy} className="rounded border border-line px-3 py-1.5 hover:border-marker hover:text-marker">
                {copied ? "Скопировано" : "Скопировать лист для Claude"}
              </button>
              <button onClick={ics} className="rounded border border-line px-3 py-1.5 hover:border-marker hover:text-marker" title="Файл для Google Calendar или Outlook: событие на каждый заход">
                Заходы в календарь (.ics)
              </button>
            </>
          )}
        </div>
      </section>

      {error && <p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p>}
      {!plan && !busy && <p className="text-graphite">Задай бюджет и ритм заходов и нажми «Составить план». Цены берутся из последнего обновления.</p>}

      {plan && (
        <div className={`space-y-8 ${busy ? "opacity-60" : ""}`}>
          {plan.computedAt && (
            <p className="text-sm text-graphite">
              План составлен {new Date(plan.computedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}: бюджет{" "}
              {isk(plan.request.budget)}, заход раз в {plan.request.cadenceDays} дн. Если цены или склад обновились, составь заново.
            </p>
          )}
          {plan.rampUp && (
            <p className="rounded border border-marker/50 bg-marker/10 px-4 py-3">
              Разгон: склад пустой, поэтому на этой неделе корпусов нет — ставятся компоненты и реакции под следующую неделю. Со второй недели
              корпуса идут из готового, а компоненты параллельно под неделю после.
            </p>
          )}
          <section className="grid gap-4 sm:grid-cols-6">
            <Stat label="Прибыль недели" value={isk(plan.profit, true)} title={`${full(plan.profit)}: корпуса, которые стартуют на этой неделе`} tone="gain" />
            <Stat
              label="Заготовка: прибыль корпусов"
              value={isk(plan.nextWeekProfit ?? 0, true)}
              title="Корпуса следующей недели, компоненты которых ставятся сейчас (их вложения уже в «Нужно вложить»)"
            />
            <Stat label="Нужно вложить" value={isk(plan.capital)} title={`${full(plan.capital)} из бюджета ${full(plan.request.budget)}: только то, что покупается`} />
            <Stat label="Из склада" value={isk(plan.fromStock ?? 0)} title="Сколько стоили бы на рынке материалы и компоненты, которые план берёт со склада. Бюджет на них не тратится" />
            <Stat label="Заходов" value={String(plan.logins.length)} title="Дни, когда нужно что-то забрать или поставить" />
            <Stat
              label="Загрузка слотов"
              value={`${pct(plan.utilization.manufacturing, 0)} / ${pct(plan.utilization.reaction, 0)} / ${pct(plan.utilization.science ?? 0, 0)}`}
              title="Производство / реакции / лаборатории: доля времени слотов за период, занятая корпусами, компонентами и инвентом"
            />
          </section>

          <section className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">Слоты</h2>
            <p className="text-graphite">
              {plan.slots
                .map(
                  (s) =>
                    `${s.owner}: производство ${s.manufacturing.total - s.manufacturing.busy} свободно из ${s.manufacturing.total}, реакции ${s.reaction.total - s.reaction.busy} из ${s.reaction.total}, лаборатории ${s.science.total - s.science.busy} из ${s.science.total}`,
                )
                .join(" · ")}
            </p>
          </section>

          {plan.pins?.length > 0 && (
            <section className="space-y-1">
              <h2 className="font-display text-2xl font-semibold">Закрепы</h2>
              <ul className="space-y-0.5 text-sm">
                {plan.pins.map((x) => (
                  <li key={x.typeId} className={x.planned < x.want ? "text-loss" : ""}>
                    {x.name}:{" "}
                    {x.planned >= x.want
                      ? `закреплено ${qty(x.want)} шт.${x.planned > x.want ? ` → будет ${qty(x.planned)} (целыми BPC / ранами)` : ""}`
                      : `влезло ${qty(x.planned)} из ${qty(x.want)} шт. — ${x.reason}${x.missingSlotDays ? `, не хватает ~${x.missingSlotDays.toFixed(1)} слот-дней` : ""}`}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.marginal && <WhatMore plan={plan} />}

          <section className="space-y-3">
            <h2 className="font-display text-2xl font-semibold">По заходам</h2>
            {plan.warnings?.length > 0 && (
              <ul className="space-y-0.5 rounded border border-loss/50 bg-loss/10 px-4 py-2 text-sm text-loss">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {plan.logins.map((l) => (
              <div key={l.day} className="rounded border border-line bg-sheet/40 px-4 py-3">
                <p className="font-medium">{dayLabel(l.day)}</p>
                {l.finish.length > 0 && <p className="text-sm text-graphite">Забрать: {summarize(l.finish)}</p>}
                {l.prep.some((p) => p.activity === "copying") && (
                  <p className="text-sm">
                    <span className="text-job">Копии T1 со своего BPO (лаборатория):</span>{" "}
                    {l.prep
                      .filter((p) => p.activity === "copying")
                      .map(
                        (p) =>
                          `${p.name} — ${qty(p.runs)} копий по 1 рану, ${p.jobs > 1 ? `${p.jobs} джобы параллельно по ~${hours(p.seconds / p.jobs)}` : `одна джоба на ${hours(p.seconds)}`}`,
                      )
                      .join(", ")}
                  </p>
                )}
                {l.prep.some((p) => p.activity === "invention") && (
                  <p className="text-sm">
                    <span className="text-job">Инвент в лаборатории:</span>{" "}
                    {l.prep
                      .filter((p) => p.activity === "invention")
                      .map(
                        (p) =>
                          `${p.name.replace(" (инвент)", "")} — ${qty(p.runs)} попыток, ${p.jobs > 1 ? `${p.jobs} джобы параллельно по ~${hours(p.seconds / p.jobs)}` : `одна джоба на ${hours(p.seconds)}`}`,
                      )
                      .join(", ")}
                  </p>
                )}
                {l.prep.some((p) => p.activity === "manufacturing" || p.activity === "reaction") && (
                  <p className="text-sm">
                    <span className="text-job">Компоненты и реакции:</span>{" "}
                    {l.prep
                      .filter((p) => p.activity === "manufacturing" || p.activity === "reaction")
                      .map((p) => `${p.name} × ${qty(p.runs)}${p.jobs > 1 ? ` (${p.jobs} джоб параллельно)` : ""}`)
                      .join(", ")}
                  </p>
                )}
                {l.start.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {byOwner(l.start).map(([owner, jobs]) => (
                      <li key={owner}>
                        <span className="text-marker">{owner}</span> — поставить: {summarize(jobs)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {plan.invention.length > 0 && (
              <p className="max-w-[90ch] text-sm text-graphite">
                Инвент:{" "}
                {plan.invention
                  .map(
                    (i) =>
                      `${i.name} — ${i.batches} BPC по ${i.runsPerBpc} ран.${i.decryptor ? `, ${i.decryptor.replace(" Decryptor", "")}` : ""}, ~${i.attempts ?? i.attemptsPerBatch * i.batches} попыток${i.secondsPerAttempt ? ` по ${hours(i.secondsPerAttempt)}` : ""} (${i.source})`,
                  )
                  .join("; ")}
                . T1-копии для инвента в лаборатории пока не планируются.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">Корпуса этой недели</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] whitespace-nowrap text-left">
                <thead className="border-b border-line text-sm text-graphite">
                  <tr>
                    <th className="py-2 pr-4 font-normal">Предмет</th>
                    <th className="py-2 pr-4 text-right font-normal">Партий × ранов</th>
                    <th className="py-2 pr-4 text-right font-normal">Прибыль</th>
                    <th className="py-2 pr-4 text-right font-normal">Вложить</th>
                    <th className="py-2 pr-4 text-right font-normal">Из склада</th>
                    <th className="py-2 text-right font-normal">Готово к</th>
                  </tr>
                </thead>
                <tbody>
                  {groupBatches(plan.batches).map((g) => (
                    <tr key={g.name} className="border-b border-line/40">
                      <td className="py-1.5 pr-4">
                        {g.name}
                        {g.pinned && <span className="ml-2 rounded border border-marker/60 px-1 text-xs text-marker">закреплено</span>}
                        {g.filler && (
                          <span className="ml-2 rounded bg-sheet-2 px-1.5 text-xs text-graphite" title="Партия меньше порога прибыли: ставится только на реакционные слоты, которые иначе простаивают">
                            заполняет пустой слот
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {g.count} × {g.runs}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-gain" title={full(g.profit)}>
                        {isk(g.profit, true)}
                      </td>
                      <td className="py-1.5 pr-4 text-right" title={full(g.capital)}>
                        {isk(g.capital)}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-gain" title={full(g.fromStock)}>
                        {g.fromStock > 0 ? isk(g.fromStock) : <span className="text-graphite">—</span>}
                      </td>
                      <td className="py-1.5 text-right text-graphite">{dayLabel(Math.ceil(g.end / plan.request.cadenceDays) * plan.request.cadenceDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {plan.nextWeek?.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-display text-2xl font-semibold">Под следующую неделю</h2>
              <p className="max-w-[90ch] text-sm text-graphite">
                Компоненты, реакции и инвент для этих корпусов ставятся на этой неделе, сами корпуса — в плане следующей недели (их цепочка не
                успевает до конца этой). Деньги на них уже в «Нужно вложить».
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] whitespace-nowrap text-left">
                  <thead className="border-b border-line text-sm text-graphite">
                    <tr>
                      <th className="py-2 pr-4 font-normal">Предмет</th>
                      <th className="py-2 pr-4 text-right font-normal">Партий × ранов</th>
                      <th className="py-2 pr-4 text-right font-normal">Прибыль</th>
                      <th className="py-2 text-right font-normal">Вложить</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupBatches(plan.nextWeek.map((b) => ({ ...b, start: 0, end: 0 }))).map((g) => (
                      <tr key={g.name} className="border-b border-line/40">
                        <td className="py-1.5 pr-4">
                          {g.name}
                          {g.pinned && <span className="ml-2 rounded border border-marker/60 px-1 text-xs text-marker">закреплено</span>}
                        </td>
                        <td className="py-1.5 pr-4 text-right">
                          {g.count} × {g.runs}
                        </td>
                        <td className="py-1.5 pr-4 text-right text-gain" title={full(g.profit)}>
                          {isk(g.profit, true)}
                        </td>
                        <td className="py-1.5 text-right" title={full(g.capital)}>
                          {isk(g.capital)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {plan.carried?.length > 0 && (
            <p className="text-sm text-graphite">
              Не влезло в неделю, перейдёт в следующий план: {plan.carried.map((x) => `${x.name} × ${qty(x.runs)} (${x.jobs} джоб)`).join(", ")}.
            </p>
          )}

          <StagesPreview stages={plan.stages} />

          <BuyList
            stages={plan.stages}
            stockNote={
              <>
                <StockPicker syncedAt={plan.stock.syncedAt} />
                {plan.stock.inJobs && plan.stock.inJobs.length > 0 && (
                  <p className="mt-1" title="Идущие джобы в складских структурах, которые закончатся в пределах плана: их выход считается складом">
                    Плюс выход идущих джоб: {plan.stock.inJobs.map((j) => `${j.name} × ${qty(j.quantity)}`).join(", ")}.
                  </p>
                )}
              </>
            }
          />

          {plan.categoryCounts && plan.categoryCounts.length > 0 && (
            <p className="text-sm text-graphite" title="Сколько предметов в категории и сколько из них дошло до кандидатов плана (прибыльные, с чертежом и ценами)">
              Рассмотрено: {plan.categoryCounts.map((c) => `${c.label} — ${c.candidates} из ${c.items}`).join(" · ")}
            </p>
          )}

          {plan.skipped.length > 0 && (
            <details className="text-sm text-graphite">
              <summary className="cursor-pointer">Не вошло в план: {plan.skipped.length}</summary>
              <p className="mt-1">{plan.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}</p>
            </details>
          )}

          <details open={showSheet} className="text-sm" onToggle={(e) => setShowSheet((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-graphite">Лист кандидатов (что можно было бы строить, лучшие сверху)</summary>
            <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre rounded border border-line bg-ink px-3 py-2 text-xs">{plan.text}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

/** Short view of the stages on the plan page; the full tracker is on /plan/stages. */
function StagesPreview({ stages }: { stages: PlanResponse["stages"] }) {
  const max = Math.max(0, ...stages.stages.map((s) => s.depth));
  return (
    <section className="space-y-2">
      <h2 className="font-display text-2xl font-semibold">Этапы производства</h2>
      <ol className="space-y-1">
        {stages.stages.map((s) => {
          const lines = s.lines.filter((l) => l.runs > 0);
          const fromStock = s.lines.filter((l) => l.fromStock > 0 && l.runs === 0).length;
          return (
            <li key={s.depth}>
              <span className="font-medium">{stageName(s, max)}</span>
              <span className="text-graphite">
                {" "}
                — {qty(lines.length)} джоб{fromStock ? `, ${fromStock} позиций целиком со склада` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Items that always go into the plan first: exactly N units, with the blueprint source and decryptor. */
function Pins({ pins, onChange }: { pins: Form["pins"]; onChange: (p: Form["pins"]) => void }) {
  // A new key clears the search box after each pick.
  const [searchKey, setSearchKey] = useState(0);
  const [decryptors, setDecryptors] = useState<{ typeId: number; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/decryptors")
      .then((r) => (r.ok ? r.json() : []))
      .then(setDecryptors)
      .catch(() => {});
  }, []);
  const update = (typeId: number, patch: Partial<Pin>) => onChange(pins.map((x) => (x.typeId === typeId ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-2 sm:col-span-2 lg:col-span-8">
      <p className="text-sm text-graphite">
        Закрепить: ровно столько штук попадает в план первым, даже в минус. Количество округляется вверх до целого BPC (или рана). Лимиты рынка и
        доли бюджета на закреп не действуют (будет предупреждение), бюджет и слоты действуют. Закреп остаётся, пока его не снимешь.
      </p>
      <div className="space-y-1.5">
        {pins.map((p) => (
          <PinRow key={p.typeId} pin={p} decryptors={decryptors} onChange={(patch) => update(p.typeId, patch)} onRemove={() => onChange(pins.filter((x) => x.typeId !== p.typeId))} />
        ))}
      </div>
      <Search
        key={searchKey}
        endpoint="/api/search"
        idKey="typeId"
        placeholder="Добавить, например Flycatcher"
        value={null}
        onPick={(it) => {
          if (!pins.some((x) => x.typeId === it.id)) onChange([...pins, { typeId: it.id, name: it.name, units: 1, decryptor: "auto", source: "auto" }]);
          setSearchKey((k) => k + 1);
        }}
        className="w-64"
      />
    </div>
  );
}

interface PinOptionsView {
  outputPerRun: number;
  owned: { isBpo: boolean; me: number; te: number; bpcRuns: number[]; profitPerUnit: number | null } | null;
  invention: { decryptorId: number | null; name: string; runsPerBpc: number; chance: number; profitPerUnit: number | null }[];
}

function PinRow({ pin: p, decryptors, onChange, onRemove }: { pin: Pin; decryptors: { typeId: number; name: string }[]; onChange: (patch: Partial<Pin>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PinOptionsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (opts || open) return;
    fetch(`/api/plan/pin?typeId=${p.typeId}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        setOpts(b);
      })
      .catch((e) => setErr((e as Error).message));
  };
  const select = "rounded border border-line bg-ink px-1 py-0.5 text-sm";
  return (
    <div className="rounded border border-marker/60 px-2 py-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <input
          type="number"
          min={1}
          value={p.units}
          title="Штук продукта за план"
          onChange={(e) => onChange({ units: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
          className="w-20 rounded border border-line bg-ink px-1 py-0.5"
        />
        <span className="text-graphite">шт.</span>
        <select className={select} value={p.source} onChange={(e) => onChange({ source: e.target.value as Pin["source"] })} title="Откуда чертёж">
          <option value="auto">чертёж: авто</option>
          <option value="owned">свой BPO/BPC</option>
          <option value="invention">инвент</option>
        </select>
        {p.source !== "owned" && (
          <select
            className={select}
            value={String(p.decryptor)}
            onChange={(e) => onChange({ decryptor: e.target.value === "auto" || e.target.value === "none" ? e.target.value : Number(e.target.value) })}
            title="Декриптор для инвента"
          >
            <option value="auto">декриптор: авто (под ритм заходов)</option>
            <option value="none">без декриптора</option>
            {decryptors.map((d) => (
              <option key={d.typeId} value={d.typeId}>
                {d.name.replace(" Decryptor", "")}
              </option>
            ))}
          </select>
        )}
        <button onClick={toggle} className="text-graphite underline hover:text-chalk">
          {open ? "скрыть варианты" : "варианты"}
        </button>
        <button onClick={onRemove} className="ml-auto text-graphite hover:text-loss" title="Открепить">
          ✕
        </button>
      </div>
      {open && (err ? <p className="mt-1 text-loss">{err}</p> : opts ? <PinOptionsTable pin={p} o={opts} /> : <p className="mt-1 text-graphite">Считаю…</p>)}
    </div>
  );
}

/** For N units: how many BPCs, attempts and what profit each source / decryptor gives. */
function PinOptionsTable({ pin, o }: { pin: Pin; o: PinOptionsView }) {
  const units = (runs: number) => runs * o.outputPerRun;
  const rows: { key: string; label: string; bpcs: string; planned: number; attempts: string; profit: number | null; chosen: boolean }[] = [];
  if (o.owned) {
    const per = o.owned.isBpo ? 0 : units(Math.max(1, o.owned.bpcRuns[0] ?? 1));
    const planned = per ? Math.ceil(pin.units / per) * per : Math.ceil(pin.units / o.outputPerRun) * o.outputPerRun;
    rows.push({
      key: "owned",
      label: o.owned.isBpo ? `свой BPO (ME ${o.owned.me})` : `свои BPC (ME ${o.owned.me}, ${o.owned.bpcRuns.length} шт.)`,
      bpcs: o.owned.isBpo ? "—" : String(Math.ceil(pin.units / per)),
      planned,
      attempts: "—",
      profit: o.owned.profitPerUnit === null ? null : o.owned.profitPerUnit * planned,
      chosen: pin.source === "owned",
    });
  }
  for (const d of o.invention) {
    const per = units(d.runsPerBpc);
    const bpcs = Math.ceil(pin.units / per);
    const planned = bpcs * per;
    rows.push({
      key: String(d.decryptorId),
      label: `инвент: ${d.name.replace(" Decryptor", "")}`,
      bpcs: `${bpcs} × ${d.runsPerBpc} ран.`,
      planned,
      attempts: `~${Math.ceil(bpcs / Math.max(d.chance, 0.01) - 1e-9)} (${pct(d.chance, 0)})`,
      profit: d.profitPerUnit === null ? null : d.profitPerUnit * planned,
      chosen: pin.source !== "owned" && (pin.decryptor === "none" ? d.decryptorId === null : pin.decryptor === d.decryptorId),
    });
  }
  if (!rows.length) return <p className="mt-1 text-graphite">Нет своего чертежа и нельзя заинвентить.</p>;
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-graphite">
        <tr>
          <th className="pr-3 font-normal">Вариант</th>
          <th className="pr-3 text-right font-normal">BPC</th>
          <th className="pr-3 text-right font-normal">Будет штук</th>
          <th className="pr-3 text-right font-normal">Попыток (шанс)</th>
          <th className="text-right font-normal">Прибыль ≈</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.chosen ? "text-marker" : ""}>
            <td className="pr-3">{r.label}</td>
            <td className="pr-3 text-right">{r.bpcs}</td>
            <td className="pr-3 text-right">{qty(r.planned)}</td>
            <td className="pr-3 text-right">{r.attempts}</td>
            <td className={`text-right ${r.profit !== null && r.profit < 0 ? "text-loss" : "text-gain"}`}>{r.profit === null ? "—" : isk(r.profit, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const hours = (sec: number) =>
  sec >= 86_400 ? `${(sec / 86_400).toFixed(1)} дн.` : sec >= 3600 ? `${(sec / 3600).toFixed(sec < 36_000 ? 1 : 0)} ч` : `${Math.max(1, Math.round(sec / 60))} мин`;

function Num({ label, value, onChange, step, min, max }: { label: string; value: number; onChange: (v: number) => void; step: number; min?: number; max?: number }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-graphite">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-line bg-ink px-2 py-1.5 focus:border-marker focus:outline-none"
      />
    </label>
  );
}

/** What one more slot, character or billion would add; and what the plan buys because a slot is worth more. */
function WhatMore({ plan }: { plan: PlanResponse }) {
  const m = plan.marginal;
  const days = plan.request.horizonDays;
  const perDay = (x: number) => `${isk(x / days)} в день`;
  const bestSlot = Math.max(m.slot.manufacturing, m.slot.reaction, m.slot.science);
  const neck =
    bestSlot === 0 && m.budget.gain === 0
      ? "Ни слоты, ни бюджет план не ограничивают: упираешься в рынок или в выбор предметов."
      : m.budget.gain > bestSlot
        ? `Сейчас ограничивает бюджет: ещё ${isk(m.budget.step)} дают больше, чем лишний слот.`
        : "Сейчас ограничивают слоты: лишний слот даёт больше, чем ещё миллиард.";
  const pass = plan.slotPass;
  return (
    <section className="space-y-3">
      <h2 className="font-display text-2xl font-semibold">Что даст ещё</h2>
      <p className="text-graphite">
        План пересчитан с одним лишним слотом, персонажем или миллиардом, всё свободно с сегодня. Прибыль за план ({days} дн.). {neck}
      </p>
      <section className="grid gap-4 sm:grid-cols-5">
        <Stat label="+1 производственный слот" value={isk(m.slot.manufacturing, true)} title={perDay(m.slot.manufacturing)} />
        <Stat label="+1 реакционный слот" value={isk(m.slot.reaction, true)} title={perDay(m.slot.reaction)} />
        <Stat label="+1 лабораторный слот" value={isk(m.slot.science, true)} title={perDay(m.slot.science)} />
        <Stat
          label={m.character ? `+персонаж как ${m.character.like}` : "+персонаж"}
          value={isk(m.character?.gain ?? 0, true)}
          title="Такие же слоты, как у самого большого персонажа: сравни с ценой подписки или PLEX"
        />
        <Stat label={`+${isk(m.budget.step)} бюджета`} value={isk(m.budget.gain, true)} />
      </section>
      {pass && pass.bought.length > 0 && (
        <p className="text-sm">
          <span className="text-job">Покупаем, хотя дешевле построить:</span> слот на корпусах приносит {isk(pass.bar.manufacturing * 24)} в день (
          {isk(pass.bar.manufacturing)}/ч), а постройка этих компонентов экономит меньше. Прибыль плана от этого {isk(pass.gain, true)}.{" "}
          <span className="text-graphite">
            {pass.bought.map((b) => `${b.name} (${isk(b.savesPerHour)}/ч${b.activity === "reaction" ? `, реакция: слот ${isk(pass.bar.reaction)}/ч` : ""})`).join(", ")}
          </span>
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: "gain" }) {
  return (
    <div className="rounded border border-line bg-sheet/60 px-4 py-3" title={title}>
      <p className="text-sm text-graphite">{label}</p>
      <p className={`font-display text-3xl font-semibold ${tone === "gain" ? "text-gain" : ""}`}>{value}</p>
    </div>
  );
}

const dayLabel = (d: number) => {
  if (d === 0) return "Сегодня";
  const date = new Date(Date.now() + d * 86_400_000);
  return `День ${d} — ${date.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}`;
};

function summarize(jobs: ScheduledJob[]): string {
  const m = new Map<string, { runs: number; jobs: number }>();
  for (const j of jobs) {
    // A part of a longer BPC: same blueprint, the rest goes on at the next login after it ends.
    const name = j.part ? `${j.name} (часть ${j.part.index} из ${j.part.of}, тот же чертёж)` : j.name;
    const x = m.get(name) ?? { runs: 0, jobs: 0 };
    x.runs += j.runs;
    x.jobs++;
    m.set(name, x);
  }
  return [...m.entries()].map(([n, x]) => `${n} × ${x.runs}${x.jobs > 1 ? ` (${x.jobs} джоб)` : ""}`).join(", ");
}

function byOwner(jobs: ScheduledJob[]): [string, ScheduledJob[]][] {
  const m = new Map<string, ScheduledJob[]>();
  for (const j of jobs) m.set(j.owner, [...(m.get(j.owner) ?? []), j]);
  return [...m.entries()];
}

function groupBatches(b: PlanResponse["batches"]) {
  const m = new Map<string, { name: string; count: number; runs: number; profit: number; capital: number; fromStock: number; end: number; pinned: boolean; filler: boolean }>();
  for (const x of b) {
    const g = m.get(x.name) ?? { name: x.name, count: 0, runs: x.runs, profit: 0, capital: 0, fromStock: 0, end: 0, pinned: false, filler: false };
    g.fromStock += x.fromStock ?? 0;
    g.pinned ||= !!x.pinned;
    g.filler ||= !!x.filler;
    g.count++;
    g.profit += x.profit;
    g.capital += x.capital - (x.fromStock ?? 0);
    g.end = Math.max(g.end, x.end);
    m.set(x.name, g);
  }
  return [...m.values()].sort((a, c) => c.profit - a.profit);
}

/** One all-day event per login day (iCalendar), for Google Calendar / Outlook import. */
function icsFor(p: PlanResponse): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const events = p.logins.map((l, i) => {
    const day = new Date(Date.now() + l.day * 86_400_000);
    const next = new Date(day.getTime() + 86_400_000);
    const lines = [
      l.finish.length ? `Забрать: ${summarize(l.finish)}` : "",
      ...byOwner(l.start).map(([o, j]) => `${o}: поставить ${summarize(j)}`),
      l.prep.length ? `Компоненты и реакции: ${l.prep.map((p) => `${p.name} × ${p.runs}${p.jobs > 1 ? ` (${p.jobs} джоб)` : ""}`).join(", ")}` : "",
    ].filter(Boolean);
    return [
      "BEGIN:VEVENT",
      `UID:pg-plan-${stamp}-${i}@production-giant`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${fmt(day)}`,
      `DTEND;VALUE=DATE:${fmt(next)}`,
      `SUMMARY:${esc(`EVE: заход — ${l.start.length + l.prep.reduce((a, p) => a + p.jobs, 0)} джоб поставить, ${l.finish.length} забрать`)}`,
      `DESCRIPTION:${esc(lines.join("\n"))}`,
      "END:VEVENT",
    ].join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Production Giant//plan//RU", ...events, "END:VCALENDAR"].join("\r\n");
}
