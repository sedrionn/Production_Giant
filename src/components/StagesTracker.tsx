"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SavedPlanView } from "@/server/savedPlan";
import type { LineProgress, StageLine } from "@/engine/stages";
import { ago, duration, isk, pct, qty } from "@/lib/format";
import { stageName } from "@/lib/stages";
import { BuyList } from "./BuyList";

const STATE: Record<LineProgress["state"], { label: string; cls: string }> = {
  todo: { label: "не начато", cls: "text-graphite" },
  partial: { label: "частично", cls: "text-marker" },
  running: { label: "в работе", cls: "text-job" },
  done: { label: "готово", cls: "text-gain" },
};

export function StagesTracker() {
  const [view, setView] = useState<SavedPlanView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [hideDone, setHideDone] = useState(false);

  const load = useCallback(async (id?: number) => {
    try {
      const r = await fetch(`/api/plan/saved${id ? `?id=${id}` : ""}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setView(b.plan);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    try {
      setHideDone(localStorage.getItem("pg.stages.hideDone") === "1");
    } catch {}
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/characters/sync", { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      await load(view?.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const remove = async () => {
    if (!view) return;
    await fetch(`/api/plan/saved?id=${view.id}`, { method: "DELETE" });
    setView(undefined);
    load();
  };

  const toggleDone = (v: boolean) => {
    setHideDone(v);
    try {
      localStorage.setItem("pg.stages.hideDone", v ? "1" : "0");
    } catch {}
  };

  if (error) return <Shell><p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p></Shell>;
  if (view === undefined) return <Shell><p className="text-graphite">Загружаю…</p></Shell>;
  if (view === null)
    return (
      <Shell>
        <p className="text-graphite">
          Сохранённого плана нет. Составь план на странице{" "}
          <Link href="/plan" className="text-marker underline">
            «План»
          </Link>{" "}
          и нажми «Запускаю этот план».
        </p>
      </Shell>
    );

  const p = view.progress;
  const d = view.data;
  const max = Math.max(0, ...p.stages.map((s) => s.depth));
  const owners = ownersByType(d.jobs);
  const savedDay = (day: number) => new Date(Date.parse(view.createdAt) + day * 86_400_000).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" });

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-graphite">
            {view.title} · сохранён {new Date(view.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · прибыль{" "}
            <span className="text-gain">{isk(d.profit, true)}</span>, вложить {isk(d.capital)}
          </p>
          {view.others.length > 0 && (
            <p className="mt-1 text-sm text-graphite">
              Другие планы:{" "}
              {view.others.map((o, i) => (
                <span key={o.id}>
                  {i > 0 && ", "}
                  <button className="underline hover:text-chalk" onClick={() => load(o.id)}>
                    {o.title}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-graphite">
            <input type="checkbox" className="accent-[var(--marker)]" checked={hideDone} onChange={(e) => toggleDone(e.target.checked)} />
            скрыть готовое
          </label>
          <button onClick={sync} disabled={syncing} className="rounded border border-marker/70 px-3 py-1.5 text-marker hover:bg-marker/10 disabled:opacity-50" title="Подтянуть джобы из игры">
            {syncing ? "Синхронизирую…" : "Обновить джобы"}
          </button>
          <button onClick={remove} className="text-sm text-graphite hover:text-loss">
            Удалить план
          </button>
        </div>
      </div>

      <section className="space-y-1">
        <div className="h-2 overflow-hidden rounded bg-sheet-2" title={`Запущено ${pct(p.startedShare, 0)}, готово ${pct(p.doneShare, 0)} по времени джоб`}>
          <div className="h-full bg-job" style={{ width: pct(p.startedShare, 2) }}>
            <div className="h-full bg-gain" style={{ width: pct(p.startedShare ? p.doneShare / p.startedShare : 0, 2) }} />
          </div>
        </div>
        <p className="text-sm text-graphite">
          По времени джоб запущено {pct(p.startedShare, 0)}, готово {pct(p.doneShare, 0)}. Джобы из игры {ago(p.jobsSyncedAt)}; считаются те, что поставлены после сохранения плана.
        </p>
      </section>

      {p.stages.map((s) => {
        const lines = s.lines.filter((l) => !hideDone || l.progress.state !== "done");
        if (!lines.length) return null;
        return (
          <section key={s.depth} className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">{stageName(s, max)}</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] whitespace-nowrap text-left">
                <thead className="border-b border-line text-sm text-graphite">
                  <tr>
                    <th className="py-1.5 pr-4 font-normal">Предмет</th>
                    <th className="py-1.5 pr-4 text-right font-normal" title="Сколько штук нужно следующему этапу">
                      Нужно
                    </th>
                    <th className="py-1.5 pr-4 text-right font-normal">Со склада</th>
                    <th className="py-1.5 pr-4 text-right font-normal">Ранов</th>
                    <th className="py-1.5 pr-4 text-right font-normal" title="Время всех ранов одной джобой">
                      Время
                    </th>
                    <th className="py-1.5 pr-4 text-right font-normal">Запущено / готово</th>
                    <th className="py-1.5 pr-4 font-normal">Статус</th>
                    <th className="py-1.5 font-normal">{s.depth === 0 ? "Кто и когда" : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <Row key={`${l.typeId}:${l.activity}`} l={l} who={s.depth === 0 ? owners.get(l.typeId)?.map((o) => `${o.owner} ×${o.runs} (${o.start === 0 ? "сразу" : savedDay(o.start)})`).join(", ") : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {d.invention.length > 0 && (
        <p className="max-w-[90ch] text-sm text-graphite">
          Инвент:{" "}
          {d.invention
            .map((i) => `${i.name} — ${i.batches} BPC по ${i.runsPerBpc} ран.${i.decryptor ? `, ${i.decryptor.replace(" Decryptor", "")}` : ""}, ~${i.attemptsPerBatch} попыток на каждый (${i.source})`)
            .join("; ")}
          . Датакоры и декрипторы — в закупке с пометкой «инвент».
        </p>
      )}

      <BuyList stages={d.stages} stockNote={<span>Склад учтён на момент сохранения плана ({ago(d.stock.syncedAt)} по ассетам).</span>} />
    </Shell>
  );
}

function Row({ l, who }: { l: StageLine & { progress: LineProgress }; who?: string }) {
  const st = STATE[l.progress.state];
  return (
    <tr className={`border-b border-line/40 ${l.progress.state === "done" ? "text-graphite" : ""}`}>
      <td className="py-1.5 pr-4">
        {l.name}
        {l.activity === "reaction" && <span className="ml-2 text-xs text-graphite">реакция</span>}
      </td>
      <td className="py-1.5 pr-4 text-right">{qty(l.need)}</td>
      <td className="py-1.5 pr-4 text-right text-graphite">{l.fromStock ? qty(l.fromStock) : "—"}</td>
      <td className="py-1.5 pr-4 text-right font-medium">{l.runs ? qty(l.runs) : "—"}</td>
      <td className="py-1.5 pr-4 text-right text-graphite">{l.runs ? duration(l.seconds) : "—"}</td>
      <td className="py-1.5 pr-4 text-right">{l.runs ? `${qty(l.progress.started)} / ${qty(l.progress.done)}` : "—"}</td>
      <td className={`py-1.5 pr-4 ${st.cls}`}>
        {l.runs === 0 ? "всё со склада" : st.label}
        {l.progress.runningUntil && <span className="text-graphite"> до {new Date(l.progress.runningUntil).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
      </td>
      <td className="py-1.5 text-sm text-graphite">{who}</td>
    </tr>
  );
}

function ownersByType(jobs: SavedPlanView["data"]["jobs"]) {
  const m = new Map<number, { owner: string; runs: number; start: number }[]>();
  for (const j of jobs) {
    const list = m.get(j.typeId) ?? [];
    const same = list.find((x) => x.owner === j.owner && x.start === j.start);
    if (same) same.runs += j.runs;
    else list.push({ owner: j.owner, runs: j.runs, start: j.start });
    m.set(j.typeId, list);
  }
  return m;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6">
      <div>
        <h1 className="font-display text-4xl font-semibold tracking-wide">Этапы производства</h1>
        <p className="mt-1 max-w-[85ch] text-graphite">
          Сохранённый план по этапам: сначала реакции, потом компоненты, в конце корпуса. Что уже лежит на складе, не строится. Прогресс берётся из
          джоб в игре после синхронизации.
        </p>
      </div>
      {children}
    </div>
  );
}
