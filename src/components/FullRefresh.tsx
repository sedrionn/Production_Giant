"use client";

import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@/server/tasks";
import { ago } from "@/lib/format";

interface Status {
  autoRefreshHours: number;
  lastAutoRefreshAt: string | null;
  task: TaskState | null;
}

/** Pages reload their data on this event when "Обновить всё" finishes. */
export const REFRESHED_EVENT = "pg:refreshed";

/** Calls `reload` after every finished "Обновить всё". */
export function useOnRefreshed(reload: () => void): void {
  useEffect(() => {
    window.addEventListener(REFRESHED_EVENT, reload);
    return () => window.removeEventListener(REFRESHED_EVENT, reload);
  }, [reload]);
}

const MARK: Record<NonNullable<TaskState["steps"]>[number]["status"], string> = { pending: "·", running: "…", done: "✓", error: "✗" };

/** The one "Обновить всё" button in the header: characters → indices → prices → volumes → plan. */
export function FullRefresh() {
  const [s, setS] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/refresh");
    if (!r.ok) return null;
    const next = (await r.json()) as Status;
    setS(next);
    return next;
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const running = !!s?.task && !s.task.finishedAt;
  useEffect(() => {
    if (!running) return;
    // Pages reload once the characters are in (jobs, assets: what a login needs first) and again at the end.
    let charsDone = false;
    const t = setInterval(async () => {
      const next = await load().catch(() => null);
      const chars = next?.task?.steps?.[0];
      const fire = (!charsDone && chars && (chars.status === "done" || chars.status === "error")) || next?.task?.finishedAt;
      if (chars && chars.status !== "pending" && chars.status !== "running") charsDone = true;
      if (fire) window.dispatchEvent(new Event(REFRESHED_EVENT));
    }, 1500);
    return () => clearInterval(t);
  }, [running, load]);

  const start = async () => {
    setOpen(true);
    await fetch("/api/refresh", { method: "POST" }).catch(() => {});
    await load().catch(() => {});
  };

  const t = s?.task ?? null;
  const steps = t?.steps ?? [];
  const failed = !running && t?.finishedAt ? steps.filter((x) => x.status === "error") : [];
  const at = steps.findIndex((x) => x.status === "running");
  return (
    <div className="relative shrink-0">
      <button
        onClick={running ? () => setOpen(!open) : start}
        className={`rounded px-3 py-1.5 font-medium ${running ? "bg-marker/60 text-ink" : failed.length ? "border border-loss bg-loss/15 text-loss hover:bg-loss/25" : "bg-marker text-ink hover:bg-marker/90"}`}
        title={failed.length ? failed.map((x) => `${x.name}: ${x.error}`).join("\n") : "Персонажи, индексы, цены и объёмы, затем пересчёт плана"}
      >
        {running ? `Обновляю ${Math.max(1, at + 1)}/${steps.length || 5}` : failed.length ? `Обновить всё (ошибок: ${failed.length})` : "Обновить всё"}
      </button>
      <p className="mt-0.5 text-xs text-graphite" aria-live="polite">
        {running && t
          ? `${t.phase}${t.total ? ` ${t.done} из ${t.total}` : "…"}`
          : s
            ? `${s.lastAutoRefreshAt ? `обновлено ${ago(s.lastAutoRefreshAt)}` : "ещё не обновлялось"}${s.autoRefreshHours ? "" : " · авто выкл."}`
            : " "}
        {steps.length > 0 && (
          <button onClick={() => setOpen(!open)} className="ml-1 underline hover:text-chalk">
            {open ? "скрыть" : "шаги"}
          </button>
        )}
      </p>
      {open && steps.length > 0 && (
        <ol className="absolute left-0 top-full z-20 mt-1 w-80 space-y-0.5 rounded border border-line bg-ink px-3 py-2 text-sm shadow-lg">
          {steps.map((x) => (
            <li key={x.name} className={x.status === "error" ? "text-loss" : x.status === "done" ? "text-gain" : x.status === "running" ? "text-chalk" : "text-graphite"}>
              {MARK[x.status]} {x.name}
              {x.status === "running" && t?.total ? ` ${t.done} из ${t.total}` : ""}
              {x.error ? <span className="block pl-4 text-xs">{x.error}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
