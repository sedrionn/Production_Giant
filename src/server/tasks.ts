/** Tiny in-memory registry for long-running refreshes (one local user, no queue needed). */
export interface TaskState {
  id: string;
  label: string;
  phase: string;
  done: number;
  total: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const g = globalThis as unknown as { __pgTasks?: Map<string, TaskState> };
const tasks: Map<string, TaskState> = (g.__pgTasks ??= new Map());

export function startTask(label: string, run: (t: TaskState) => Promise<void>): TaskState {
  // One refresh at a time per label: return the running one instead of hammering ESI twice.
  for (const t of tasks.values()) if (t.label === label && !t.finishedAt) return t;
  const t: TaskState = {
    id: Math.random().toString(36).slice(2, 10),
    label,
    phase: "старт",
    done: 0,
    total: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  tasks.set(t.id, t);
  run(t)
    .catch((e) => {
      t.error = (e as Error).message;
    })
    .finally(() => {
      t.finishedAt = new Date().toISOString();
    });
  return t;
}

export function getTask(id: string): TaskState | undefined {
  return tasks.get(id);
}
