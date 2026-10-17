"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskState } from "@/server/tasks";
import { ago } from "@/lib/format";

interface Status {
  autoRefreshHours: number;
  lastAutoRefreshAt: string | null;
  task: TaskState | null;
}

/** "Everything updates once a day" line with a manual "update all now". */
export function FullRefresh({ onDone }: { onDone?: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  const load = useCallback(async () => {
    const r = await fetch("/api/refresh");
    if (r.ok) setS(await r.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const running = s?.task && !s.task.finishedAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const r = await fetch("/api/refresh");
      if (!r.ok) return;
      const next = (await r.json()) as Status;
      setS(next);
      if (!next.task) done.current?.();
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  const start = async () => {
    const r = await fetch("/api/refresh", { method: "POST" });
    if (r.ok) setS((cur) => (cur ? { ...cur, task: null } : cur));
    await load();
  };

  if (!s) return null;
  const t = s.task;
  return (
    <p className="text-sm text-graphite" aria-live="polite">
      {running && t
        ? `Обновляю всё: ${t.phase}${t.total ? ` ${t.done} из ${t.total}` : "…"}`
        : `${s.autoRefreshHours ? `Персонажи и цены обновляются раз в ${s.autoRefreshHours === 24 ? "сутки" : `${s.autoRefreshHours} ч`}` : "Автообновление выключено"}, последнее: ${ago(s.lastAutoRefreshAt)}. `}
      {!running && (
        <button onClick={start} className="text-marker underline hover:text-chalk">
          Обновить всё сейчас
        </button>
      )}
    </p>
  );
}
