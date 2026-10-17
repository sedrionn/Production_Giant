/**
 * The plan Nick runs this week, frozen when he saves it (stages and purchases as they were),
 * with live progress from the industry jobs synced since then.
 */
import { desc, eq } from "drizzle-orm";
import { characters, industryJobs, savedPlans } from "@/db/schema";
import { JOB_ACTIVITY_IDS } from "@/engine/bonuses";
import { stageProgress, type LineProgress, type StageLine, type Stages } from "@/engine/stages";
import type { Activity } from "@/engine/types";
import type { ScheduledJob } from "@/engine/planner";
import { getDb } from "./data";
import type { PlanResponse } from "./plan";

export interface SavedPlanData {
  request: PlanResponse["request"];
  profit: number;
  capital: number;
  batches: { typeId: number; name: string; runs: number; profit: number; capital: number; start: number; end: number }[];
  /** Product jobs with owner and login day. */
  jobs: Pick<ScheduledJob, "typeId" | "name" | "runs" | "owner" | "start" | "end">[];
  stages: Stages;
  stock: PlanResponse["stock"];
  invention: PlanResponse["invention"];
}

export interface SavedPlanView {
  id: number;
  title: string;
  createdAt: string;
  data: SavedPlanData;
  progress: {
    /** Same shape as data.stages.stages, one progress entry per line. */
    stages: { depth: number; lines: (StageLine & { progress: LineProgress })[] }[];
    /** Share of job time started / finished (components have many short runs, so runs mislead). */
    startedShare: number;
    doneShare: number;
    jobsSyncedAt: string | null;
  };
  /** Older saved plans (id, title, date) for switching. */
  others: { id: number; title: string; createdAt: string }[];
}

const activityOf = (id: number): Activity | null =>
  id === JOB_ACTIVITY_IDS.manufacturing ? "manufacturing" : (JOB_ACTIVITY_IDS.reactions as readonly number[]).includes(id) ? "reaction" : null;

export function savePlan(p: PlanResponse, title?: string): number {
  const data: SavedPlanData = {
    request: p.request,
    profit: p.profit,
    capital: p.capital,
    batches: p.batches.map((b) => ({ typeId: b.typeId, name: b.name, runs: b.runs, profit: b.profit, capital: b.capital, start: b.start, end: b.end })),
    jobs: p.jobs.map((j) => ({ typeId: j.typeId, name: j.name, runs: j.runs, owner: j.owner, start: j.start, end: j.end })),
    stages: p.stages,
    stock: p.stock,
    invention: p.invention,
  };
  if (!data.stages?.stages || !Array.isArray(data.batches)) throw new Error("План без этапов — пересоставь его и сохрани ещё раз");
  const createdAt = new Date().toISOString();
  const label = title?.trim() || `План от ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
  const r = getDb().insert(savedPlans).values({ createdAt, title: label, data }).returning({ id: savedPlans.id }).get();
  return r.id;
}

export function deleteSavedPlan(id: number): void {
  getDb().delete(savedPlans).where(eq(savedPlans.id, id)).run();
}

export function savedPlanView(id?: number): SavedPlanView | null {
  const db = getDb();
  const all = db.select({ id: savedPlans.id, title: savedPlans.title, createdAt: savedPlans.createdAt }).from(savedPlans).orderBy(desc(savedPlans.id)).all();
  const pick = id ? all.find((p) => p.id === id) : all[0];
  if (!pick) return null;
  const row = db.select().from(savedPlans).where(eq(savedPlans.id, pick.id)).get()!;
  const data = row.data as SavedPlanData;

  // Jobs that started up to an hour before saving count too (you saved after starting them).
  const since = new Date(Date.parse(row.createdAt) - 3_600_000).toISOString();
  const jobs = db
    .select()
    .from(industryJobs)
    .all()
    .map((j) => ({ productTypeId: j.productTypeId, activity: activityOf(j.activityId), runs: j.runs, status: j.status, startDate: j.startDate, endDate: j.endDate }));
  const flat = data.stages.stages.flatMap((s) => s.lines);
  const prog = stageProgress(flat, jobs, since, new Date());
  let i = 0;
  const stages = data.stages.stages.map((s) => ({ depth: s.depth, lines: s.lines.map((l) => ({ ...l, progress: prog[i++] })) }));
  const sum = (f: (p: LineProgress, l: StageLine) => number) => flat.reduce((a, l, k) => a + f(prog[k], l), 0);
  const total = sum((_, l) => l.seconds);

  const synced = db.select({ at: characters.lastSyncAt }).from(characters).all().map((r) => r.at).filter((x): x is string => !!x).sort()[0] ?? null;

  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    data,
    progress: {
      stages,
      startedShare: total ? sum((p, l) => (l.runs ? (l.seconds * p.started) / l.runs : 0)) / total : 0,
      doneShare: total ? sum((p, l) => (l.runs ? (l.seconds * p.done) / l.runs : 0)) / total : 0,
      jobsSyncedAt: synced,
    },
    others: all.filter((p) => p.id !== row.id),
  };
}
