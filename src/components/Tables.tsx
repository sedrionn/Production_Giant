"use client";

import { useState } from "react";
import type { CalcResponse } from "@/server/calculate";
import { duration, full, isk, qty } from "@/lib/format";

const ACTIVITY: Record<string, string> = { manufacturing: "производство", reaction: "реакция" };

export function JobsTable({ jobs }: { jobs: CalcResponse["jobs"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] whitespace-nowrap text-left">
        <thead className="border-b border-line text-sm text-graphite">
          <tr>
            <th className="py-2 pr-3 font-normal">Что</th>
            <th className="py-2 pr-3 font-normal">Где</th>
            <th className="py-2 pr-3 text-right font-normal">Раны</th>
            <th className="py-2 pr-3 text-right font-normal">ME / TE</th>
            <th className="py-2 pr-3 text-right font-normal">Выход</th>
            <th className="py-2 pr-3 text-right font-normal">Излишек</th>
            <th className="py-2 pr-3 text-right font-normal" title="Estimated Item Value: базовые материалы × adjusted price × раны">EIV</th>
            <th className="py-2 pr-3 text-right font-normal" title="EIV × cost index с бонусами структуры и системы">Индекс</th>
            <th className="py-2 pr-3 text-right font-normal" title="Налог владельца структуры">Налог</th>
            <th className="py-2 pr-3 text-right font-normal" title="SCC surcharge">SCC</th>
            <th className="py-2 pr-3 text-right font-normal">Джоба</th>
            <th className="py-2 text-right font-normal">Время</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.typeId} className="border-b border-line/40 hover:bg-sheet/70">
              <td className="py-1.5 pr-3">{j.name}</td>
              <td className="py-1.5 pr-3 text-graphite">{ACTIVITY[j.activity] ?? j.activity}</td>
              <td className="py-1.5 pr-3 text-right">{qty(j.runs)}</td>
              <td className="py-1.5 pr-3 text-right text-graphite">{j.activity === "reaction" ? "—" : `${j.me} / ${j.te}`}</td>
              <td className="py-1.5 pr-3 text-right">{qty(j.output)}</td>
              <td className={`py-1.5 pr-3 text-right ${j.surplus ? "text-marker" : "text-graphite"}`}>{j.surplus ? qty(j.surplus) : "—"}</td>
              <td className="py-1.5 pr-3 text-right text-graphite" title={full(j.costBreakdown.eiv)}>{isk(j.costBreakdown.eiv)}</td>
              <td className="py-1.5 pr-3 text-right text-graphite" title={full(j.costBreakdown.grossCost)}>{isk(j.costBreakdown.grossCost)}</td>
              <td className="py-1.5 pr-3 text-right text-graphite" title={full(j.costBreakdown.facilityTax)}>{isk(j.costBreakdown.facilityTax)}</td>
              <td className="py-1.5 pr-3 text-right text-graphite" title={full(j.costBreakdown.sccSurcharge)}>{isk(j.costBreakdown.sccSurcharge)}</td>
              <td className="py-1.5 pr-3 text-right" title={full(j.cost)}>{isk(j.cost)}</td>
              <td className="py-1.5 text-right text-graphite">{duration(j.timeSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ShoppingTable({ lines }: { lines: CalcResponse["shopping"] }) {
  const [copied, setCopied] = useState(false);
  const total = lines.reduce((s, l) => s + (l.cost ?? 0), 0);
  const volume = lines.reduce((s, l) => s + l.volume, 0);

  const copy = async () => {
    // EVE multibuy accepts "Name<TAB>Quantity" per line.
    await navigator.clipboard.writeText(lines.map((l) => `${l.name}\t${l.quantity}`).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={copy}
          className="rounded bg-marker px-3 py-1.5 font-medium text-ink hover:bg-marker/90"
        >
          {copied ? "Скопировано" : "Скопировать для мультибая"}
        </button>
        <span className="text-graphite">
          {lines.length} позиций на <span className="text-chalk">{isk(total)}</span>, {qty(Math.round(volume))} м³
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left">
          <thead className="border-b border-line text-sm text-graphite">
            <tr>
              <th className="py-2 pr-3 font-normal">Предмет</th>
              <th className="py-2 pr-3 text-right font-normal">Кол-во</th>
              <th className="py-2 pr-3 text-right font-normal">Цена</th>
              <th className="py-2 pr-3 text-right font-normal">Сумма</th>
              <th className="py-2 text-right font-normal">Объём, м³</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.typeId} className="border-b border-line/40 hover:bg-sheet/70">
                <td className="py-1.5 pr-3">
                  {l.name}
                  {l.priceFlags?.map((f) => (
                    <span key={f.kind} className="ml-2 rounded border border-loss/60 px-1 text-xs text-loss" title="Цена материала не подменяется: проверь стакан перед покупкой">
                      {f.label}
                    </span>
                  ))}
                </td>
                <td className="py-1.5 pr-3 text-right">{qty(l.quantity)}</td>
                <td className="py-1.5 pr-3 text-right text-graphite" title={full(l.unitPrice)}>{isk(l.unitPrice)}</td>
                <td className={`py-1.5 pr-3 text-right ${l.cost === null ? "text-loss" : ""}`} title={full(l.cost)}>
                  {l.cost === null ? "нет цены" : isk(l.cost)}
                </td>
                <td className="py-1.5 text-right text-graphite">{qty(Math.round(l.volume))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
