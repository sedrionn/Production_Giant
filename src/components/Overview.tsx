"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Overview as OverviewData, OverviewRow } from "@/server/overview";
import type { TaskState } from "@/server/tasks";
import { ago, duration, full, isk, pct, qty } from "@/lib/format";

export interface CategoryTab {
  key: string;
  label: string;
}

type SortKey = "name" | "profit" | "profitPerRun" | "margin" | "iskPerHour" | "avgDailyVolume30d" | "marketDays" | "jobSeconds";

const STORAGE = "pg.overview.v1";

const COLUMNS: { key: SortKey; label: string; title?: string; align?: "right" }[] = [
  { key: "name", label: "Предмет" },
  { key: "profit", label: "Прибыль за партию", align: "right" },
  { key: "profitPerRun", label: "За ран", align: "right" },
  { key: "margin", label: "Маржа", align: "right" },
  { key: "iskPerHour", label: "ISK/ч", align: "right", title: "Прибыль за час джобы самого продукта (занятость слота)" },
  { key: "avgDailyVolume30d", label: "Продают в день", align: "right", title: "Средний объём сделок в регионе за 30 дней (в скобках — за 7)" },
  { key: "marketDays", label: "Партия = дней рынка", align: "right", title: "Сколько дней среднего объёма продаж занимает твоя партия" },
  { key: "jobSeconds", label: "Джоба", align: "right" },
];

export function Overview({ categories }: { categories: CategoryTab[] }) {
  const [cat, setCat] = useState(categories[0].key);
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "iskPerHour", dir: -1 });
  const [task, setTask] = useState<TaskState | null>(null);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") as { cat?: string; sort?: typeof sort };
      if (s.cat && categories.some((c) => c.key === s.cat)) setCat(s.cat);
      if (s.sort) setSort(s.sort);
    } catch {}
  }, [categories]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ cat, sort }));
    } catch {}
  }, [cat, sort]);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/overview?category=${key}`);
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
    load(cat);
  }, [cat, load]);

  // Poll the background refresh, then recompute.
  useEffect(() => {
    if (!task || task.finishedAt) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/tasks?id=${task.id}`);
      if (!r.ok) return;
      const next = (await r.json()) as TaskState;
      setTask(next);
      if (next.finishedAt) load(cat);
    }, 1000);
    return () => clearInterval(t);
  }, [task, cat, load]);

  const refresh = async () => {
    const r = await fetch("/api/overview/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: cat }),
    });
    const body = await r.json();
    if (!r.ok) return setError(body.error);
    setTask(body);
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (data?.rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
    const val = (r: OverviewRow) => (sort.key === "name" ? r.name : r[sort.key]);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [data, filter, sort]);

  const running = task && !task.finishedAt;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-wide">Что выгодно строить</h1>
          <p className="mt-1 max-w-[80ch] text-graphite">
            Полное дерево по каждому предмету с твоими структурами, порогом выгоды и режимами цен. Партия подобрана так, чтобы
            джоба продукта шла около {data?.targetJobDays ?? 5} дней (меняется в настройках).
          </p>
        </div>
        <div className="space-y-1 text-right">
          <button
            onClick={refresh}
            disabled={!!running}
            className="rounded border border-marker/70 px-3 py-2 text-marker hover:bg-marker/10 disabled:opacity-50"
          >
            Обновить цены и объёмы категории
          </button>
          <p className="text-sm text-graphite" aria-live="polite">
            {running
              ? `${task.phase}${task.total ? `: ${task.done} из ${task.total}` : "…"}`
              : task?.error
                ? `ESI недоступен: ${task.error}`
                : task?.finishedAt
                  ? `Обновлено${task.failed ? `, не удалось ${task.failed}` : ""}`
                  : data?.pricesOldest
                    ? `цены ESI: ${ago(data.pricesOldest)}`
                    : "цены из фикстур или не загружены"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
          {categories.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={cat === c.key}
              onClick={() => setCat(c.key)}
              className={`-mb-px border-b-2 px-3 py-2 ${cat === c.key ? "border-marker text-chalk" : "border-transparent text-graphite hover:text-chalk"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Фильтр по названию или группе"
          className="ml-auto w-72 rounded border border-line bg-sheet px-3 py-1.5 focus:border-marker focus:outline-none"
        />
      </div>

      {error && <p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p>}
      {data?.hint && <p className="rounded border border-marker/40 bg-marker/5 px-4 py-3">{data.hint}</p>}

      <div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}>
        <table className="w-full min-w-[1100px] whitespace-nowrap text-left">
          <thead className="border-b border-line text-sm text-graphite">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`py-2 pr-4 font-normal ${c.align === "right" ? "text-right" : ""}`} title={c.title}>
                  <button
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : c.key === "name" ? 1 : -1 }))}
                    className={`hover:text-chalk ${sort.key === c.key ? "text-marker" : ""}`}
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.typeId} className="border-b border-line/40 hover:bg-sheet/70">
                <td className="py-1.5 pr-4">
                  <Link
                    href={`/?typeId=${r.typeId}&name=${encodeURIComponent(r.name)}&runs=${Math.max(1, r.runs)}`}
                    className="hover:text-marker"
                  >
                    {r.name}
                  </Link>
                  <span className="ml-2 text-xs text-graphite">
                    {[
                      r.group,
                      SOURCE_LABEL[r.blueprintSource ?? ""] ?? "",
                      r.runs > 0 ? `${r.runs} ран.` : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                  {r.error && <span className="ml-2 text-xs text-loss">{r.error}</span>}
                </td>
                <td className={`py-1.5 pr-4 text-right ${tone(r.profit)}`} title={full(r.profit)}>
                  {isk(r.profit, true)}
                </td>
                <td className="py-1.5 pr-4 text-right text-graphite" title={full(r.profitPerRun)}>
                  {isk(r.profitPerRun, true)}
                </td>
                <td className={`py-1.5 pr-4 text-right ${tone(r.margin)}`}>{pct(r.margin)}</td>
                <td className={`py-1.5 pr-4 text-right font-medium ${tone(r.iskPerHour)}`}>{isk(r.iskPerHour, true)}</td>
                <td className="py-1.5 pr-4 text-right">
                  {r.avgDailyVolume30d === null ? (
                    <span className="text-graphite">—</span>
                  ) : (
                    <>
                      {vol(r.avgDailyVolume30d)}
                      <span className="text-graphite"> ({vol(r.avgDailyVolume7d ?? 0)})</span>
                    </>
                  )}
                </td>
                <td className={`py-1.5 pr-4 text-right ${r.marketDays !== null && r.marketDays > 7 ? "text-marker" : "text-graphite"}`}>
                  {r.marketDays === null ? "—" : r.marketDays < 0.1 ? "<0.1" : r.marketDays.toFixed(1)}
                </td>
                <td className="py-1.5 text-right text-graphite">{r.jobSeconds ? duration(r.jobSeconds) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !data?.hint && <p className="py-8 text-center text-graphite">Ничего не найдено.</p>}
      </div>
      {data && (
        <p className="text-sm text-graphite">
          {data.rows.length} предметов, посчитано за {(data.computedMs / 1000).toFixed(1)} с.
        </p>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { invention: "инвент", bpo: "свой BPO", bpc: "свой BPC", none: "нет чертежа" };
const tone = (v: number | null) => (v === null ? "text-graphite" : v >= 0 ? "text-gain" : "text-loss");
const vol = (v: number) => (v >= 100 ? qty(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1));
