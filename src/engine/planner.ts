/**
 * Weekly production planner (pure). Nick logs in every `cadenceDays`; a slot that finishes
 * between logins sits idle until the next one.
 *
 * Steady-state model (how Nick runs it): the hulls of this week are built from components made
 * earlier; the components and reactions for the next round are built this week, merged across
 * all batches (one job per intermediate type, not one per batch).
 *  - batch size: the product job should end right before a login — best profit per *occupied*
 *    slot-day, ties → longer jobs (fewer logins);
 *  - product jobs start only at logins, on the earliest free manufacturing slot;
 *  - intermediates are pooled per type and must fit in the slots left over in the period;
 *  - greedy by tier (e.g. Caldari ships first), then profit per slot-day, within budget and a
 *    market cap per item.
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

/** An intermediate pooled over all batches of the plan. */
export interface PrepJob {
  typeId: number;
  name: string;
  activity: Activity;
  runs: number;
  seconds: number;
  depth: number;
  /** Login day to start it: deepest level first, one level per login. */
  start: number;
}

export interface Plan {
  batches: (PlanBatch & { start: number; end: number })[];
  /** Product jobs on slots. */
  jobs: ScheduledJob[];
  /** Components and reactions for the next round, merged per type. */
  prep: PrepJob[];
  /** Login days with something to do, and what. */
  logins: { day: number; start: ScheduledJob[]; finish: ScheduledJob[]; prep: PrepJob[] }[];
  profit: number;
  capital: number;
  /** Share of slot-days within the horizon that are busy (products + prep), per kind. */
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
  /** Batches earning less are only taken when nothing bigger fits. */
  minProfit?: number;
}): number {
  const { secondsPerRun, profitPerRun, maxRuns, cadenceDays, horizonDays } = p;
  if (secondsPerRun <= 0) return Math.max(1, maxRuns || 1);
  let best = 1;
  let bestScore = -Infinity;
  let bestBig = false;
  for (let k = 1; k * cadenceDays <= horizonDays + 1e-9; k++) {
    let runs = Math.max(1, Math.floor((k * cadenceDays * DAY) / secondsPerRun));
    if (maxRuns > 0) runs = Math.min(runs, maxRuns);
    const occupied = nextLogin((runs * secondsPerRun) / DAY, cadenceDays) || cadenceDays;
    const score = (profitPerRun * runs) / occupied;
    // A batch above the minimum always beats one below it: fewer, bigger jobs.
    const big = profitPerRun * runs >= (p.minProfit ?? 0);
    if (bestBig && !big) continue;
    if (big && !bestBig) {
      [best, bestScore, bestBig] = [runs, score, true];
      continue;
    }
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
 * intermediates count at their real length (they are pooled and fill otherwise idle slots).
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

  // Slot-days available per kind in the period, after what is already running.
  const capacity: Record<SlotKind, number> = { manufacturing: 0, reaction: 0 };
  for (const s of slots) capacity[s.kind] += Math.max(0, horizon - s.freeAt);
  const used: Record<SlotKind, number> = { manufacturing: 0, reaction: 0 };

  let budget = input.budget;
  const batches: Plan["batches"] = [];
  const jobs: ScheduledJob[] = [];
  const skipped: Plan["skipped"] = [];
  const unitsPlanned = new Map<number, number>();
  const prep = new Map<string, PrepJob>();

  for (const { c } of ranked) {
    let made = 0;
    const product = c.jobs.find((j) => j.depth === 0);
    if (!product) continue;
    const intermediates = c.jobs.filter((j) => j.depth > 0 && slotKind(j.activity));
    const need: Record<SlotKind, number> = { manufacturing: 0, reaction: 0 };
    for (const j of intermediates) need[slotKind(j.activity)!] += j.seconds / DAY;
    while (made < Math.min(input.maxBatchesPerItem, c.maxBatches ?? Infinity)) {
      const why = (reason: string) => {
        if (!made) skipped.push({ name: c.name, reason });
      };
      if (c.capital > budget) {
        why("не хватает бюджета");
        break;
      }
      if ((unitsPlanned.get(c.typeId) ?? 0) + c.units > input.unitCap(c.typeId)) {
        why("рынок не возьмёт больше");
        break;
      }
      // The product job: earliest free manufacturing slot, at a login inside the period.
      let best = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].kind !== "manufacturing") continue;
        if (best === -1 || slots[i].freeAt < slots[best].freeAt) best = i;
      }
      if (best === -1 || slots[best].freeAt >= horizon) {
        why("нет свободных слотов в пределах недели");
        break;
      }
      const productDays = (nextLogin(slots[best].freeAt + product.seconds / DAY, cad) - slots[best].freeAt) || cad;
      const after = { ...used };
      after.manufacturing += Math.min(productDays, horizon - slots[best].freeAt) + need.manufacturing;
      after.reaction += need.reaction;
      if (after.manufacturing > capacity.manufacturing || after.reaction > capacity.reaction) {
        why("не хватит слотов на компоненты и реакции");
        break;
      }
      const start = slots[best].freeAt;
      const end = start + product.seconds / DAY;
      jobs.push({ ...product, batchTypeId: c.typeId, slot: best, owner: slots[best].owner, start, end });
      slots[best].freeAt = nextLogin(end, cad);
      Object.assign(used, after);
      for (const j of intermediates) {
        const k = `${j.typeId}:${j.activity}`;
        const cur = prep.get(k) ?? { typeId: j.typeId, name: j.name, activity: j.activity, runs: 0, seconds: 0, depth: 0, start: 0 };
        cur.runs += j.runs;
        cur.seconds += j.seconds;
        cur.depth = Math.max(cur.depth, j.depth);
        prep.set(k, cur);
      }
      batches.push({ ...c, start, end });
      budget -= c.capital;
      unitsPlanned.set(c.typeId, (unitsPlanned.get(c.typeId) ?? 0) + c.units);
      made++;
    }
  }

  // Prep: deepest level at the first login, one level per login after that.
  const prepJobs = [...prep.values()];
  const maxDepth = Math.max(0, ...prepJobs.map((p) => p.depth));
  for (const p of prepJobs) p.start = (maxDepth - p.depth) * cad;

  const days = new Map<number, Plan["logins"][number]>();
  const at = (d: number) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { day: d, start: [], finish: [], prep: [] }));
    return x;
  };
  for (const j of jobs) {
    at(j.start).start.push(j);
    at(nextLogin(j.end, cad)).finish.push(j);
  }
  for (const p of prepJobs) at(p.start).prep.push(p);

  const utilization = { manufacturing: 0, reaction: 0 } as Record<SlotKind, number>;
  for (const kind of ["manufacturing", "reaction"] as SlotKind[]) {
    const n = slots.filter((s) => s.kind === kind).length;
    if (n) utilization[kind] = Math.min(1, used[kind] / (n * horizon));
  }

  return {
    batches,
    jobs,
    prep: prepJobs.sort((a, b) => b.depth - a.depth || b.seconds - a.seconds),
    logins: [...days.values()].sort((a, b) => a.day - b.day),
    profit: batches.reduce((s, b) => s + b.profit, 0),
    capital: batches.reduce((s, b) => s + b.capital, 0),
    utilization,
    skipped,
  };
}
