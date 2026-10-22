"use client";

import { useEffect, useState } from "react";
import type { BuyLine, Stages } from "@/engine/stages";
import type { StockLocation } from "@/server/assets";
import { ago, full, isk, qty } from "@/lib/format";

/** EVE multibuy format: one "Name quantity" per line, pastes into the market window. */
export const multibuy = (lines: BuyLine[]) =>
  lines
    .filter((l) => l.toBuy > 0)
    .map((l) => `${l.name} ${l.toBuy}`)
    .join("\n");

export function BuyList({ stages, stockNote }: { stages: Stages; stockNote?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const lines = showAll ? stages.buy : stages.buy.filter((l) => l.toBuy > 0);
  const toBuy = stages.buy.filter((l) => l.toBuy > 0);
  const covered = stages.buy.length - toBuy.length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(multibuy(stages.buy));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl font-semibold">Закупка</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5 text-graphite">
            <input type="checkbox" className="accent-[var(--marker)]" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            показать и то, что есть на складе ({covered})
          </label>
          <button onClick={copy} disabled={!toBuy.length} className="rounded border border-line px-3 py-1 hover:border-marker hover:text-marker disabled:opacity-50" title="Формат multibuy: вставь в окно маркета в игре">
            {copied ? "Скопировано" : "Скопировать для multibuy"}
          </button>
        </div>
      </div>
      <p className="text-sm text-graphite">
        {(stages.weeks ?? 1) > 1 && <span className="text-chalk">Материалы на {stages.weeks} нед. (промежуточные — на одну). </span>}
        Купить {qty(toBuy.length)} позиций на {isk(stages.costWithStock)}, {qty(Math.round(toBuy.reduce((s, l) => s + l.volume, 0)))} м³
        {stages.freightPerM3 ? (
          <>
            , доставка <span className="text-chalk">{isk(stages.freightCost ?? 0)}</span> (по {qty(stages.freightPerM3)} ISK/м³)
          </>
        ) : null}
        .
        {stages.savedByStock > 0 && (
          <>
            {" "}
            Склад сэкономил <span className="text-gain">{isk(stages.savedByStock)}</span> из {isk(stages.costWithoutStock)}; готовые компоненты со склада не строятся, и под них ничего не закупается.
          </>
        )}
      </p>
      {stockNote && <div className="text-sm text-graphite">{stockNote}</div>}
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full min-w-[640px] whitespace-nowrap text-left">
          <thead className="sticky top-0 border-b border-line bg-ink text-sm text-graphite">
            <tr>
              <th className="py-1.5 pr-4 font-normal">Предмет</th>
              <th className="py-1.5 pr-4 text-right font-normal">Нужно</th>
              <th className="py-1.5 pr-4 text-right font-normal">На складе</th>
              <th className="py-1.5 pr-4 text-right font-normal">Купить</th>
              <th className="py-1.5 pr-4 text-right font-normal">ISK</th>
              <th className="py-1.5 text-right font-normal">м³</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.typeId} className={`border-b border-line/30 ${l.toBuy === 0 ? "text-graphite" : ""}`}>
                <td className="py-1 pr-4">
                  {l.name}
                  {l.note && <span className="ml-2 rounded bg-sheet-2 px-1.5 text-xs text-graphite">{l.note}</span>}
                  {l.flags?.map((f) => (
                    <span key={f} className="ml-2 rounded border border-loss/60 px-1 text-xs text-loss" title="Цена не подменяется: проверь стакан перед покупкой">
                      {f}
                    </span>
                  ))}
                </td>
                <td className="py-1 pr-4 text-right">{qty(l.need)}</td>
                <td className="py-1 pr-4 text-right text-graphite">{l.fromStock ? qty(l.fromStock) : "—"}</td>
                <td className="py-1 pr-4 text-right font-medium" title={l.buffer ? `в т.ч. запас +${qty(l.buffer)}` : undefined}>
                  {l.toBuy ? qty(l.toBuy) : "—"}
                </td>
                <td className="py-1 pr-4 text-right text-graphite" title={full(l.cost)}>
                  {l.toBuy ? isk(l.cost) : "—"}
                </td>
                <td className="py-1 text-right text-graphite">{l.toBuy ? qty(Math.round(l.volume)) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!stages.blueprints?.length && (
        <div className="space-y-1 pt-2">
          <h3 className="font-display text-xl font-semibold">Чертежи для инвента</h3>
          <p className="text-sm text-graphite">Каждая попытка инвента съедает одну T1-копию. Реликты для T3 уже в закупке выше.</p>
          <ul className="text-sm">
            {stages.blueprints.map((b) => (
              <li key={b.typeId}>
                {b.name} × {qty(b.copies)} <span className="text-graphite">для {b.forItem}</span> —{" "}
                {b.how === "copy" ? <span className="text-job">скопировать со своего BPO (джоба копирования в плане по заходам)</span> : <span className="text-marker">своего BPO нет: купить BPC в контрактах</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Which hangars count as stock. Default: the structures where your jobs run. */
export function StockPicker({ onChange, syncedAt }: { onChange?: () => void; syncedAt?: string | null }) {
  const [locs, setLocs] = useState<StockLocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    fetch("/api/stock")
      .then((r) => r.json())
      .then((b) => (b.error ? setError(b.error) : setLocs(b.locations)))
      .catch((e) => setError(String(e)));
  }, []);
  const save = async (ids: number[] | null) => {
    const r = await fetch("/api/stock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationIds: ids }) });
    const b = await r.json();
    if (b.error) setError(b.error);
    else {
      setLocs(b.locations);
      onChange?.();
    }
  };
  if (error) return <p className="text-sm text-loss">{error}</p>;
  if (!locs) return null;
  if (!locs.length)
    return <p className="text-sm text-graphite">Ассетов пока нет: синхронизируй персонажей. Если в заметках персонажа «нет доступа к ассетам» — перезайди им.</p>;
  const toggle = (id: number) => save(locs.filter((l) => (l.locationId === id ? !l.selected : l.selected)).map((l) => l.locationId));
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-graphite">
        Склад: {locs.filter((l) => l.selected).map((l) => l.name).join(", ") || "ничего не выбрано"}
        {syncedAt ? ` · ассеты ${ago(syncedAt)}` : ""}
      </summary>
      <ul className="mt-2 space-y-1">
        {(all ? locs : locs.filter((l, i) => l.selected || l.jobsHere || i < 8)).map((l) => (
          <li key={l.locationId}>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--marker)]" checked={l.selected} onChange={() => toggle(l.locationId)} />
              {l.name}
              <span className="text-graphite">
                · {qty(l.items)} предметов{l.jobsHere ? " · здесь идут джобы" : ""}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {!all && locs.length > 8 && (
        <button onClick={() => setAll(true)} className="mt-1 text-graphite underline hover:text-chalk">
          Ещё {locs.length - locs.filter((l, i) => l.selected || l.jobsHere || i < 8).length} локаций
        </button>
      )}{" "}
      <button onClick={() => save(null)} className="mt-2 text-graphite underline hover:text-chalk">
        По умолчанию: где идут джобы
      </button>
      <p className="mt-1 text-graphite">После изменения пересоставь план, чтобы закупка пересчиталась.</p>
    </details>
  );
}
