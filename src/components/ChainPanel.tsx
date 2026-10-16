"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CalcResponse } from "@/server/calculate";
import type { Decision } from "@/engine/tree";
import { duration, full, isk, pct } from "@/lib/format";
import { TreeView } from "./TreeView";

/** Inline production chain for one overview row (same calculation as the calculator). */
export function ChainPanel({ typeId, name, runs }: { typeId: number; name: string; runs: number }) {
  const [res, setRes] = useState<CalcResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});

  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/calc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId, runs, decisions }),
      signal: ctl.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        setRes(body);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      });
    return () => ctl.abort();
  }, [typeId, runs, decisions]);

  const decide = (id: number, d: Decision | null) =>
    setDecisions((cur) => {
      const next = { ...cur };
      if (d === null) delete next[id];
      else next[id] = d;
      return next;
    });

  if (error) return <p className="px-4 py-3 text-loss">{error}</p>;
  if (!res) return <p className="px-4 py-3 text-graphite">Считаю цепочку…</p>;

  const s = res.summary;
  const root = res.jobs.at(-1);
  const facts: [string, string, string?][] = [
    ["Материалы", isk(s.materialCost), full(s.materialCost)],
    ["Джобы", isk(s.jobCost), full(s.jobCost)],
    ...(s.blueprintCost ? ([["Чертёж (инвент)", isk(s.blueprintCost), full(s.blueprintCost)]] as [string, string, string][]) : []),
    ["Налог и брокер", isk(s.saleFees), full(s.saleFees)],
    ["Выручка", isk(s.grossRevenue), full(s.grossRevenue)],
    ["Маржа", pct(s.margin)],
    ...(root ? ([["Джоба продукта", duration(root.timeSeconds)]] as [string, string][]) : []),
  ];

  return (
    <div className="space-y-3 border-l-2 border-marker/60 bg-ink/50 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className={`font-display text-2xl font-semibold ${(s.profit ?? 0) >= 0 ? "text-gain" : "text-loss"}`} title={full(s.profit)}>
          {isk(s.profit, true)}
        </span>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-graphite">
          {facts.map(([k, v, t]) => (
            <div key={k} className="flex gap-1.5" title={t}>
              <dt>{k}</dt>
              <dd className="text-chalk">{v}</dd>
            </div>
          ))}
        </dl>
        <Link
          href={`/?typeId=${typeId}&name=${encodeURIComponent(name)}&runs=${runs}`}
          className="ml-auto text-sm text-marker hover:underline"
        >
          Открыть в калькуляторе
        </Link>
      </div>
      {Object.keys(decisions).length > 0 && (
        <button onClick={() => setDecisions({})} className="text-sm text-graphite underline hover:text-chalk">
          Сбросить ручные решения
        </button>
      )}
      <TreeView nodes={res.nodes} rootTypeId={typeId} onDecide={decide} />
    </div>
  );
}
