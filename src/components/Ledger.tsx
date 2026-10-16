"use client";

import type { ProfitSummary } from "@/engine/profit";
import { duration, full, isk, pct } from "@/lib/format";

/**
 * The one loud element: what the run costs, stacked against what it sells for.
 * Both bars share one scale, so the gap between them is the profit (or the loss).
 */
export function Ledger({ s }: { s: ProfitSummary }) {
  const net = s.grossRevenue === null || s.saleFees === null ? null : s.grossRevenue - s.saleFees;
  const scale = Math.max(s.totalCost, s.grossRevenue ?? 0) || 1;
  const w = (v: number) => `${Math.max(0, (v / scale) * 100)}%`;
  const costParts = [
    { label: "Материалы", v: s.materialCost, c: "bg-mat" },
    { label: "Джобы", v: s.jobCost, c: "bg-job" },
    { label: "Чертёж (инвент)", v: s.blueprintCost, c: "bg-bpc" },
  ].filter((p) => p.v > 0);
  const profitable = (s.profit ?? 0) >= 0;

  return (
    <section aria-label="Расходы и выручка" className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
        <p className={`font-display text-5xl font-semibold leading-none ${s.profit === null ? "text-graphite" : profitable ? "text-gain" : "text-loss"}`} title={full(s.profit)}>
          {s.profit === null ? "нет цены" : isk(s.profit, true)}
        </p>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-graphite">
          <div className="flex gap-1.5">
            <dt>маржа</dt>
            <dd className="text-chalk">{pct(s.margin)}</dd>
          </div>
          <div className="flex gap-1.5" title="Прибыль, делённая на суммарное время всех джоб">
            <dt>в час джоб</dt>
            <dd className="text-chalk">{isk(s.iskPerHour, true)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>за штуку</dt>
            <dd className="text-chalk" title={full(s.costPerUnit)}>{isk(s.costPerUnit)}</dd>
          </div>
          <div className="flex gap-1.5" title="Сумма времени всех джоб без учёта параллельных слотов">
            <dt>все джобы</dt>
            <dd className="text-chalk">{duration(s.totalJobSeconds)}</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-2">
        <Bar label="Расход" total={s.totalCost}>
          {costParts.map((p) => (
            <span key={p.label} className={`${p.c} h-full`} style={{ width: w(p.v) }} title={`${p.label}: ${full(p.v)}`} />
          ))}
        </Bar>
        <Bar label="Выручка" total={net}>
          {net !== null && (
            <>
              <span className="h-full bg-gain/80" style={{ width: w(net) }} title={`После налогов: ${full(net)}`} />
              <span className="h-full bg-fee/40" style={{ width: w(s.saleFees ?? 0) }} title={`Налог и брокер: ${full(s.saleFees)}`} />
            </>
          )}
        </Bar>
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-graphite">
        {costParts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className={`inline-block size-2.5 rounded-sm ${p.c}`} aria-hidden />
            {p.label} <span className="text-chalk">{isk(p.v)}</span>
          </li>
        ))}
        {s.surplusCredit > 0 && (
          <li className="flex items-center gap-1.5" title="Остатки промежуточных от целых ранов (например, 40 топливных блоков, когда нужно 5). Остаются на складе, поэтому вычитаются из расхода по их себестоимости">
            Излишек в запас <span className="text-gain">−{isk(s.surplusCredit)}</span>
          </li>
        )}
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-fee/40" aria-hidden />
          Налог и брокер <span className="text-chalk">{isk(s.saleFees)}</span>
        </li>
        <li>
          {s.output} шт по <span className="text-chalk">{isk(s.unitPrice)}</span>
        </li>
      </ul>
    </section>
  );
}

function Bar({ label, total, children }: { label: string; total: number | null; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_6rem] items-center gap-3">
      <span className="text-sm text-graphite">{label}</span>
      <div className="flex h-5 overflow-hidden rounded-sm bg-sheet ring-1 ring-line">{children}</div>
      <span className="text-right" title={full(total)}>
        {isk(total)}
      </span>
    </div>
  );
}
