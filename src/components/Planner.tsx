"use client";

import { useEffect, useState } from "react";
import type { PlanResponse } from "@/server/plan";
import type { ScheduledJob } from "@/engine/planner";
import { full, isk, pct, qty } from "@/lib/format";
import { stageName } from "@/lib/stages";
import { BuyList, StockPicker } from "./BuyList";

interface Form {
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  marketShare: number;
  minBatchProfit: number;
  caldariShipsFirst: boolean;
  maxItemShare: number;
  categories: string[];
}

const DEFAULT: Form = { budget: 10e9, cadenceDays: 2, horizonDays: 7, marketShare: 0.3, minBatchProfit: 30e6, caldariShipsFirst: true, maxItemShare: 0.2, categories: ["caldari_t1", "caldari_t2", "t3", "rigs_t1", "rigs_t2", "reactions"] };
const STORAGE = "pg.plan.v3";

export function Planner({ categories }: { categories: { key: string; label: string }[] }) {
  const [form, setForm] = useState<Form>(DEFAULT);
  const [plan, setPlan] = useState<(PlanResponse & { text: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSheet, setShowSheet] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE);
      if (s) setForm({ ...DEFAULT, ...(JSON.parse(s) as Partial<Form>) });
    } catch {}
  }, []);

  const set = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next));
    } catch {}
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
          Подбирает партии так, чтобы джоба корпуса заканчивалась к твоему следующему заходу, и раскладывает их по свободным слотам
          персонажей. Корпуса этой недели строятся из готовых компонентов, а компоненты и реакции на следующий круг ставятся параллельно,
          одной джобой на тип. Берутся только предметы, на которые есть свой чертёж или инвент.
        </p>
      </div>

      <section className="grid gap-4 rounded border border-line bg-sheet/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-6">
        <Num label="Бюджет, млрд ISK" value={form.budget / 1e9} step={0.5} onChange={(v) => set({ budget: v * 1e9 })} />
        <Num label="Захожу раз в, дней" value={form.cadenceDays} step={1} min={1} max={7} onChange={(v) => set({ cadenceDays: v })} />
        <Num label="План на, дней" value={form.horizonDays} step={1} min={1} max={28} onChange={(v) => set({ horizonDays: v })} />
        <Num label="Не больше, % рынка за период" value={Math.round(form.marketShare * 100)} step={5} min={5} max={100} onChange={(v) => set({ marketShare: v / 100 })} />
        <Num label="Партия от, млн ISK прибыли" value={form.minBatchProfit / 1e6} step={5} min={0} onChange={(v) => set({ minBatchProfit: v * 1e6 })} />
        <Num label="Одна позиция, не больше % бюджета" value={Math.round(form.maxItemShare * 100)} step={5} min={5} max={100} onChange={(v) => set({ maxItemShare: v / 100 })} />
        <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-6">
          <input type="checkbox" className="accent-[var(--marker)]" checked={form.caldariShipsFirst} onChange={(e) => set({ caldariShipsFirst: e.target.checked })} />
          Сначала калдарские корабли, остальное — заполнить свободные слоты и бюджет
        </label>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 sm:col-span-2 lg:col-span-6">
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
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-6">
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
          <section className="grid gap-4 sm:grid-cols-4">
            <Stat label="Прибыль плана" value={isk(plan.profit, true)} title={full(plan.profit)} tone="gain" />
            <Stat label="Нужно вложить" value={isk(plan.capital)} title={`${full(plan.capital)} из бюджета ${full(plan.request.budget)}`} />
            <Stat label="Заходов" value={String(plan.logins.length)} title="Дни, когда нужно что-то забрать или поставить" />
            <Stat
              label="Загрузка слотов"
              value={`${pct(plan.utilization.manufacturing, 0)} / ${pct(plan.utilization.reaction, 0)}`}
              title="Производство / реакции: доля времени слотов за период, занятая корпусами и компонентами"
            />
          </section>

          <section className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">Слоты</h2>
            <p className="text-graphite">
              {plan.slots
                .map((s) => `${s.owner}: производство ${s.manufacturing.total - s.manufacturing.busy} свободно из ${s.manufacturing.total}, реакции ${s.reaction.total - s.reaction.busy} из ${s.reaction.total}`)
                .join(" · ")}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-2xl font-semibold">По заходам</h2>
            {plan.logins.map((l) => (
              <div key={l.day} className="rounded border border-line bg-sheet/40 px-4 py-3">
                <p className="font-medium">{dayLabel(l.day)}</p>
                {l.finish.length > 0 && <p className="text-sm text-graphite">Забрать: {summarize(l.finish)}</p>}
                {l.prep.length > 0 && (
                  <p className="text-sm">
                    <span className="text-job">Компоненты и реакции на следующий круг:</span>{" "}
                    {l.prep.map((p) => `${p.name} × ${qty(p.runs)}`).join(", ")}
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
                Инвент заранее (лабораторные слоты пока не планируются):{" "}
                {plan.invention
                  .map((i) => `${i.name} — ${i.batches} BPC по ${i.runsPerBpc} ран.${i.decryptor ? `, ${i.decryptor.replace(" Decryptor", "")}` : ""}, ~${i.attemptsPerBatch} попыток на каждый (${i.source})`)
                  .join("; ")}.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">Партии</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] whitespace-nowrap text-left">
                <thead className="border-b border-line text-sm text-graphite">
                  <tr>
                    <th className="py-2 pr-4 font-normal">Предмет</th>
                    <th className="py-2 pr-4 text-right font-normal">Партий × ранов</th>
                    <th className="py-2 pr-4 text-right font-normal">Прибыль</th>
                    <th className="py-2 pr-4 text-right font-normal">Вложить</th>
                    <th className="py-2 text-right font-normal">Готово к</th>
                  </tr>
                </thead>
                <tbody>
                  {groupBatches(plan.batches).map((g) => (
                    <tr key={g.name} className="border-b border-line/40">
                      <td className="py-1.5 pr-4">{g.name}</td>
                      <td className="py-1.5 pr-4 text-right">
                        {g.count} × {g.runs}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-gain" title={full(g.profit)}>
                        {isk(g.profit, true)}
                      </td>
                      <td className="py-1.5 pr-4 text-right" title={full(g.capital)}>
                        {isk(g.capital)}
                      </td>
                      <td className="py-1.5 text-right text-graphite">{dayLabel(Math.ceil(g.end / plan.request.cadenceDays) * plan.request.cadenceDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <StagesPreview stages={plan.stages} />

          <BuyList stages={plan.stages} stockNote={<StockPicker syncedAt={plan.stock.syncedAt} />} />

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
  const m = new Map<string, number>();
  for (const j of jobs) m.set(j.name, (m.get(j.name) ?? 0) + j.runs);
  return [...m.entries()].map(([n, r]) => `${n} × ${r}`).join(", ");
}

function byOwner(jobs: ScheduledJob[]): [string, ScheduledJob[]][] {
  const m = new Map<string, ScheduledJob[]>();
  for (const j of jobs) m.set(j.owner, [...(m.get(j.owner) ?? []), j]);
  return [...m.entries()];
}

function groupBatches(b: PlanResponse["batches"]) {
  const m = new Map<string, { name: string; count: number; runs: number; profit: number; capital: number; end: number }>();
  for (const x of b) {
    const g = m.get(x.name) ?? { name: x.name, count: 0, runs: x.runs, profit: 0, capital: 0, end: 0 };
    g.count++;
    g.profit += x.profit;
    g.capital += x.capital;
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
      l.prep.length ? `Компоненты и реакции: ${l.prep.map((p) => `${p.name} × ${p.runs}`).join(", ")}` : "",
    ].filter(Boolean);
    return [
      "BEGIN:VEVENT",
      `UID:pg-plan-${stamp}-${i}@production-giant`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${fmt(day)}`,
      `DTEND;VALUE=DATE:${fmt(next)}`,
      `SUMMARY:${esc(`EVE: заход — ${l.start.length + l.prep.length} джоб поставить, ${l.finish.length} забрать`)}`,
      `DESCRIPTION:${esc(lines.join("\n"))}`,
      "END:VEVENT",
    ].join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Production Giant//plan//RU", ...events, "END:VCALENDAR"].join("\r\n");
}
