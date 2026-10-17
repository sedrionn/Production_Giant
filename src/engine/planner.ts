/**
 * Weekly production planner (pure). Nick logs in every `cadenceDays`; a slot that finishes
 * between logins sits idle until the next one. So:
 *  - batch size: pick the run count whose product job ends right before a login
 *    (best profit per *occupied* slot-day, ties → longer jobs = fewer logins);
 *  - schedule: jobs start only at logins; intermediates first (deepest chain level first),
 *    the product job at the first login after its inputs are done;
 *  - greedy fill by profit per slot-day within the budget and a market cap per item.
 */
import type { Activity } from "./types";

export type SlotKind = "manufacturing" | "reaction";
const DAY = 86_400;

export interface PlanJob {
  typeId: number;
  name: string;
  activity: Activity;
  runs: number;
  seconds: number;
  /** 0 = the product; 1 = its direct inputs; … Higher levels must finish first. */
  depth: number;
}

export interface PlanBatch {
  typeId: number;
  name: string;
  runs: number;
  units: number;
  profit: number;
  /** ISK needed up front: materials + job fees + blueprint + freight. */
  capital: number;
  jobs: PlanJob[];
  /** How many batches of this item are possible at all (e.g. owned BPC copies); undefined = no limit. */
  maxBatches?: number;
  /** Preference multiplier on the ranking score (1 = neutral). */
  weight?: number;
  /** Lower tiers are planned first (e.g. 0 = Caldari ships); same tier → by score. */
  tier?: number;
  /** Distinguishes routes of the same item (own BPC vs invention); defaults to typeId. */
  key?: string;
}

export interface SlotState {
  kind: SlotKind;
  /** Character the slot belongs to (for the schedule); free text. */
  owner: string;
  /** Day (from now) when the slot is free; 0 = free now. */
  freeAt: number;
}

export interface ScheduledJob extends PlanJob {
  batchTypeId: number;
  slot: number;
  owner: string;
  /** Login day the job starts, and the day it ends (fractional). */
  start: number;
  end: number;
}

export interface Plan {
  batches: (PlanBatch & { start: number; end: number })[];
  jobs: ScheduledJob[];
  /** Login days with something to do, and what. */
  logins: { day: number; start: ScheduledJob[]; finish: ScheduledJob[] }[];
  profit: number;
  capital: number;
  /** Share of slot-days within the horizon that are busy, per kind. */
  utilization: Record<SlotKind, number>;
  skipped: { name: string; reason: string }[];
}

/** Round a day up to the next login. */
export const nextLogin = (day: number, cadence: number) => Math.max(0, Math.ceil(day / cadence - 1e-9)) * cadence + 0;

/**
 * Run count for one batch: the product job should end just before a login.
 * Returns the runs maximising profit per occupied day of the product slot.
 */
export function batchRunsForCadence(p: {
  secondsPerRun: number;
  profitPerRun: number;
  maxRuns: number;
  cadenceDays: number;
  horizonDays: number;
}): number {
  const { secondsPerRun, profitPerRun, maxRuns, cadenceDays, horizonDays } = p;
  if (secondsPerRun <= 0) return Math.max(1, maxRuns || 1);
  let best = 1;
  let bestScore = -Infinity;
  for (let k = 1; k * cadenceDays <= horizonDays + 1e-9; k++) {
    let runs = Math.max(1, Math.floor((k * cadenceDays * DAY) / secondsPerRun));
    if (maxRuns > 0) runs = Math.min(runs, maxRuns);
    const occupied = nextLogin((runs * secondsPerRun) / DAY, cadenceDays) || cadenceDays;
    const score = (profitPerRun * runs) / occupied;
    // ≥: a longer batch with the same daily profit means fewer logins.
    if (score >= bestScore - 1e-6 * Math.abs(bestScore)) {
      best = runs;
      bestScore = Math.max(score, bestScore);
    }
  }
  return best;
}

const slotKind = (a: Activity): SlotKind | null => (a === "manufacturing" ? "manufacturing" : a === "reaction" ? "reaction" : null);

/**
 * Slot-days a batch costs: the product job snaps to logins (its slot waits for you), the
 * intermediates count at their real length (they fill otherwise idle slots in parallel).
 */
export function slotDays(b: PlanBatch, cadence: number): number {
  return b.jobs.reduce((s, j) => s + (j.depth === 0 ? nextLogin(j.seconds / DAY, cadence) || cadence : j.seconds / DAY), 0);
}

export function planWeek(input: {
  candidates: PlanBatch[];
  slots: SlotState[];
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  /** Max batches of one item (market cap is applied by the caller via units). */
  maxBatchesPerItem: number;
  /** Max units of one item over the plan. */
  unitCap: (typeId: number) => number;
}): Plan {
  const { cadenceDays: cad, horizonDays: horizon } = input;
  const slots = input.slots.map((s) => ({ ...s, freeAt: nextLogin(s.freeAt, cad) }));
  const ranked = input.candidates
    .filter((c) => c.profit > 0)
    .map((c) => ({ c, score: (c.profit / Math.max(cad, slotDays(c, cad))) * (c.weight ?? 1) }))
    .sort((a, b) => (a.c.tier ?? 0) - (b.c.tier ?? 0) || b.score - a.score);

  let budget = input.budget;
  const batches: Plan["batches"] = [];
  const jobs: ScheduledJob[] = [];
  const skipped: Plan["skipped"] = [];
  const unitsPlanned = new Map<number, number>();

  for (const { c } of ranked) {
    let made = 0;
    while (made < Math.min(input.maxBatchesPerItem, c.maxBatches ?? Infinity)) {
      if (c.capital > budget) {
        if (!made) skipped.push({ name: c.name, reason: "не хватает бюджета" });
        break;
      }
      if ((unitsPlanned.get(c.typeId) ?? 0) + c.units > input.unitCap(c.typeId)) {
        if (!made) skipped.push({ name: c.name, reason: "рынок не возьмёт больше" });
        break;
      }
      const placed = place(c, slots, cad, horizon);
      if (!placed) {
        if (!made) skipped.push({ name: c.name, reason: "нет свободных слотов в пределах недели" });
        break;
      }
      for (const p of placed.jobs) {
        slots[p.slot].freeAt = nextLogin(p.end, cad);
        jobs.push(p);
      }
      batches.push({ ...c, start: placed.start, end: placed.end });
      budget -= c.capital;
      unitsPlanned.set(c.typeId, (unitsPlanned.get(c.typeId) ?? 0) + c.units);
      made++;
    }
  }

  const days = new Map<number, { day: number; start: ScheduledJob[]; finish: ScheduledJob[] }>();
  const at = (d: number) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { day: d, start: [], finish: [] }));
    return x;
  };
  for (const j of jobs) {
    at(j.start).start.push(j);
    at(nextLogin(j.end, cad)).finish.push(j);
  }

  const utilization = { manufacturing: 0, reaction: 0 } as Record<SlotKind, number>;
  for (const kind of ["manufacturing", "reaction"] as SlotKind[]) {
    const n = slots.filter((s) => s.kind === kind).length;
    if (!n) continue;
    const busy = jobs.filter((j) => slotKind(j.activity) === kind).reduce((s, j) => s + Math.min(horizon, j.end) - Math.min(horizon, j.start), 0);
    utilization[kind] = busy / (n * horizon);
  }

  return {
    batches,
    jobs,
    logins: [...days.values()].sort((a, b) => a.day - b.day),
    profit: batches.reduce((s, b) => s + b.profit, 0),
    capital: batches.reduce((s, b) => s + b.capital, 0),
    utilization,
    skipped,
  };
}

/** Places one batch: deepest chain level first, each level at the first login after the previous one ends. */
function place(b: PlanBatch, slots: SlotState[], cad: number, horizon: number): { jobs: ScheduledJob[]; start: number; end: number } | null {
  const free = slots.map((s) => s.freeAt);
  const out: ScheduledJob[] = [];
  const maxDepth = Math.max(0, ...b.jobs.map((j) => j.depth));
  let ready = 0;
  for (let d = maxDepth; d >= 0; d--) {
    let levelEnd = ready;
    for (const j of b.jobs.filter((x) => x.depth === d)) {
      const kind = slotKind(j.activity);
      if (!kind) continue;
      let best = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].kind !== kind) continue;
        if (best === -1 || Math.max(free[i], ready) < Math.max(free[best], ready)) best = i;
      }
      if (best === -1) return null;
      const start = nextLogin(Math.max(free[best], ready), cad);
      // The chain must start this week; later steps may run into the next one (steady state).
      if (d === maxDepth && start >= horizon) return null;
      const end = start + j.seconds / DAY;
      free[best] = nextLogin(end, cad);
      out.push({ ...j, batchTypeId: b.typeId, slot: best, owner: slots[best].owner, start, end });
      levelEnd = Math.max(levelEnd, end);
    }
    ready = nextLogin(levelEnd, cad);
  }
  const product = out.filter((j) => j.depth === 0);
  if (!product.length) return null;
  return { jobs: out, start: Math.min(...out.map((j) => j.start)), end: Math.max(...product.map((j) => j.end)) };
}
