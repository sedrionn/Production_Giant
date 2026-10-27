"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Ledger, LedgerItem } from "@/server/ledger";
import { CATEGORY_LABEL, type LedgerCategory } from "@/engine/ledger";
import { ago, full, isk, pct, qty } from "@/lib/format";
import { useOnRefreshed } from "./FullRefresh";

const PERIODS: { v: string; label: string }[] = [
  { v: "7", label: "7 дней" },
  { v: "30", label: "30 дней" },
  { v: "90", label: "90 дней" },
  { v: "all", label: "всё время" },
];
const STORAGE = "pg.money.v1";
/** Shown in this order; internal transfers last, they don't count. */
const ORDER: LedgerCategory[] = ["sales", "purchases", "market_fees", "industry", "contracts", "other", "internal"];

export function Money() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const d = localStorage.getItem(STORAGE);
      if (d && PERIODS.some((p) => p.v === d)) setDays(d);
    } catch {}
  }, []);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ledger?days=${d}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setData(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
    try {
      localStorage.setItem(STORAGE, days);
    } catch {}
  }, [days, load]);

  // Fresh data after "Обновить всё" in the header.
  useOnRefreshed(useCallback(() => { load(days); }, [days, load]));

  const noAccess = data?.characters.filter((c) => !c.moneyAccess) ?? [];
  const c = data?.cash;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-wide">Учёт</h1>
          <p className="mt-1 max-w-[80ch] text-graphite">
            Сколько потрачено и заработано по кошелькам персонажей, что построено и продано, и что требует внимания. Данные приходят при
            синхронизации персонажей.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" className="flex gap-1 rounded border border-line p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.v}
                role="tab"
                aria-selected={days === p.v}
                onClick={() => setDays(p.v)}
                className={`rounded px-3 py-1 text-sm ${days === p.v ? "bg-sheet-2 text-chalk" : "text-graphite hover:text-chalk"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p>}
      {noAccess.length > 0 && (
        <p className="rounded border border-marker/40 bg-marker/5 px-4 py-3">
          {noAccess.map((x) => x.name).join(", ")}: нет доступа к кошельку, ордерам и контрактам. Перезайди этими персонажами на странице{" "}
          <Link href="/characters" className="text-marker underline">
            «Персонажи»
          </Link>
          , потом нажми «Синхронизировать».
        </p>
      )}

      {data && c && (
        <div className={`space-y-8 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <section className="grid gap-4 sm:grid-cols-3">
            <Stat label="Итог за период" value={c.net} tone title="Все движения ISK по кошелькам, кроме переводов между своими персонажами" />
            <Stat label="Продажи" value={c.byCategory.sales} />
            <Stat
              label="На кошельках сейчас"
              value={data.totalBalance}
              hint={data.characters
                .filter((x) => x.balance !== null)
                .map((x) => `${x.name}: ${isk(x.balance)}`)
                .join(" · ")}
            />
          </section>

          <Alerts data={data} />

          <section className="space-y-2">
            <h2 className="font-display text-2xl font-semibold">Куда ушли деньги</h2>
            <table className="w-full max-w-[640px] text-left">
              <tbody>
                {ORDER.map((k) => (
                  <tr key={k} className={`border-b border-line/40 ${k === "internal" ? "text-graphite" : ""}`}>
                    <td className="py-1.5 pr-4">
                      {CATEGORY_LABEL[k]}
                      {k === "internal" && <span className="ml-2 text-xs">(в итог не входит)</span>}
                    </td>
                    <td className={`py-1.5 text-right ${k === "internal" ? "" : tone(c.byCategory[k])}`} title={full(c.byCategory[k])}>
                      {isk(c.byCategory[k], true)}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="py-2 pr-4">Итог</td>
                  <td className={`py-2 text-right ${tone(c.net)}`} title={full(c.net)}>
                    {isk(c.net, true)}
                  </td>
                </tr>
              </tbody>
            </table>
            {Object.keys(c.otherRefTypes).length > 0 && (
              <p className="max-w-[80ch] text-sm text-graphite">
                «Прочее»:{" "}
                {Object.entries(c.otherRefTypes)
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .map(([k, v]) => `${k} ${isk(v, true)}`)
                  .join(", ")}
              </p>
            )}
            {c.entries === 0 && <p className="text-graphite">За этот период записей в кошельке нет.</p>}
          </section>

          <Items items={data.items} />
        </div>
      )}
      {!data && !error && <p className="text-graphite">Загружаю…</p>}
    </div>
  );
}

function Alerts({ data }: { data: Ledger }) {
  const { undercut, losingJobs } = data.alerts;
  if (!undercut.length && !losingJobs.length) {
    return (
      <p className="text-graphite">
        Сигналов нет: ордера не перебиты, активные джобы в плюсе{data.pricesOldest ? ` (цены ${ago(data.pricesOldest)})` : ""}.
      </p>
    );
  }
  return (
    <section className="space-y-2 rounded border border-marker/50 bg-marker/5 px-4 py-3">
      <h2 className="font-display text-2xl font-semibold text-marker">Требует внимания</h2>
      <ul className="space-y-1">
        {undercut.map((a) => (
          <li key={a.orderId}>
            <span className="font-medium">{a.name}</span>: {a.isBuy ? "твой buy-ордер перебили" : "твой ордер на продажу перебили"} — у тебя {isk(a.myPrice)},
            лучшая {isk(a.bestPrice)}, осталось {qty(a.volumeRemain)} шт.
          </li>
        ))}
        {losingJobs.map((j) => (
          <li key={j.jobId}>
            <span className="font-medium">{j.name}</span> × {j.runs}: по сегодняшним ценам партия в минусе ({isk(j.profit, true)}). Джоба
            закончится {new Date(j.endDate).toLocaleDateString("ru-RU")}.
          </li>
        ))}
      </ul>
      {data.pricesOldest && <p className="text-sm text-graphite">Цены Jita {ago(data.pricesOldest)}.</p>}
    </section>
  );
}

function Items({ items }: { items: LedgerItem[] }) {
  return (
    <section className="space-y-2">
      <h2 className="font-display text-2xl font-semibold">Построено и продано</h2>
      {items.length === 0 ? (
        <p className="text-graphite">За этот период нет законченных джоб и продаж.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] whitespace-nowrap text-left">
            <thead className="border-b border-line text-sm text-graphite">
              <tr>
                <th className="py-2 pr-4 font-normal">Предмет</th>
                <th className="py-2 pr-4 text-right font-normal">Построено</th>
                <th className="py-2 pr-4 text-right font-normal">Продано</th>
                <th className="py-2 pr-4 text-right font-normal">На продаже</th>
                <th className="py-2 pr-4 text-right font-normal">Выручка</th>
                <th className="py-2 pr-4 text-right font-normal" title="Средняя цена твоих продаж">
                  Средняя цена
                </th>
                <th className="py-2 pr-4 text-right font-normal" title="Лучшая цена продажи в Jita сейчас">
                  Jita сейчас
                </th>
                <th className="py-2 pr-4 text-right font-normal" title="Себестоимость единицы по сегодняшнему расчёту">
                  Себестоимость
                </th>
                <th className="py-2 text-right font-normal" title="(средняя цена − налог и брокер − себестоимость) / себестоимость">
                  Маржа факт
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.typeId} className="border-b border-line/40">
                  <td className="py-1.5 pr-4">
                    <Link href={`/?typeId=${r.typeId}&name=${encodeURIComponent(r.name)}`} className="hover:text-marker">
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-4 text-right">{r.built ? qty(r.built) : "—"}</td>
                  <td className="py-1.5 pr-4 text-right">{r.sold ? qty(r.sold) : "—"}</td>
                  <td className="py-1.5 pr-4 text-right text-graphite">{r.onSale ? qty(r.onSale) : "—"}</td>
                  <td className="py-1.5 pr-4 text-right" title={full(r.soldIsk)}>
                    {r.soldIsk ? isk(r.soldIsk) : "—"}
                  </td>
                  <td className="py-1.5 pr-4 text-right">{isk(r.avgSellPrice)}</td>
                  <td className="py-1.5 pr-4 text-right text-graphite">{isk(r.marketPrice)}</td>
                  <td className="py-1.5 pr-4 text-right text-graphite">{isk(r.estUnitCost)}</td>
                  <td className={`py-1.5 text-right ${tone(r.realisedMargin)}`}>{pct(r.realisedMargin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone: toned, hint, title }: { label: string; value: number | null; tone?: boolean; hint?: string; title?: string }) {
  return (
    <div className="rounded border border-line bg-sheet/60 px-4 py-3" title={title}>
      <p className="text-sm text-graphite">{label}</p>
      <p className={`font-display text-3xl font-semibold ${toned ? tone(value) : ""}`} title={full(value)}>
        {isk(value, toned)}
      </p>
      {hint && <p className="mt-1 truncate text-xs text-graphite">{hint}</p>}
    </div>
  );
}

const tone = (v: number | null) => (v === null ? "text-graphite" : v >= 0 ? "text-gain" : "text-loss");
