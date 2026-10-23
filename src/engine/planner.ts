/**
 * Weekly production planner (pure). Nick logs in every `cadenceDays`; a slot that finishes
 * between logins sits idle until the next one.
 *
 * Steady-state model (how Nick runs it): the hulls of this week are built from components made
 * earlier; the components and reactions for the next round are built this week, merged across
 * all batches (one job per intermediate type, not one per batch).
 *  - batch size: the product job should end right before a login — best profit per *occupied*
 *    slot-day, ties → longer jobs (fewer logins);
 *  - product jobs start only at logins, on the earliest free slot of their kind (a reaction sold
 *    as a product goes to a reaction slot, not a factory one);
 *  - intermediates are pooled per type and must fit in the slots left over in the period;
 *  - greedy by tier (e.g. Caldari ships first), then profit per slot-day, within budget, a
 *    market cap per item and a per-item share of the budget (variety over one big hull);
 *  - pinned items go first, with their batch count, past the market cap and the budget share;
 *  - invention for the next round is pooled like components and must fit the lab slots;
 *  - stock: what a batch takes from the hangars is not paid from the budget; the stock is used up
 *    batch by batch, and batches made largely from stock go first within their tier;
 *  - jobs of a kind may have a length cap (reactions ≤ 2 days): longer ones run as parallel jobs.
 */
import { splitRuns } from "./stages";
import type { Activity } from "./types";

export type SlotKind = "manufacturing" | "reaction" | "science";
const KINDS: SlotKind[] = ["manufacturing", "reaction", "science"];
const DAY = 86_400;

export interface PlanJob {
  typeId: number;
  name: string;
  activity: Activity;
  runs: number;
  seconds: number;
  /** 0 = the product; 1 = its direct inputs; … Higher levels must finish first. */
  depth: number;
  /** Blueprint production limit: most runs one job may have. */
  maxRunsPerJob?: number;
  /**
   * Product only: the runs as sequential jobs of the same blueprint (one blueprint runs one job at
   * a time), from `splitSequential`. Each starts at the login after the previous one ends.
   */
  parts?: number[];
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
  /** Pinned by Nick: this many batches are planned first, whatever the ranking. */
  pinned?: number;
  /** Small batch that only fills slots left idle (set with the last tier); shown as such. */
  filler?: boolean;
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
  /** One of several sequential jobs of the same blueprint (1-based). */
  part?: { index: number; of: number };
}

/** An intermediate pooled over all batches of the plan. */
export interface PrepJob {
  typeId: number;
  name: string;
  activity: Activity;
  /** Invention: expected attempts (rounded up over the pool). */
  runs: number;
  seconds: number;
  depth: number;
  /** Login day to start it: deepest level first, one level per login. */
  start: number;
  /** Parallel jobs it is split into so each one ends inside the plan. */
  jobs: number;
  maxRunsPerJob?: number;
}

export interface Plan {
  /** fromStock: market value taken from stock (capital − fromStock = ISK spent). */
  batches: (PlanBatch & { start: number; end: number; fromStock: number })[];
  /** Product jobs on slots. */
  jobs: ScheduledJob[];
  /** Components and reactions for the next round, merged per type. */
  prep: PrepJob[];
  /** Login days with something to do, and what. */
  logins: { day: number; start: ScheduledJob[]; finish: ScheduledJob[]; prep: PrepJob[] }[];
  profit: number;
  /** ISK to spend: batch capital minus what comes from stock. */
  capital: number;
  /** Market value of what the plan takes from stock (not paid from the budget). */
  fromStock: number;
  /** Share of slot-days within the horizon that are busy (products + prep), per kind. */
  utilization: Record<SlotKind, number>;
  skipped: { name: string; reason: string }[];
  /** Things the plan cannot do as asked (e.g. more parallel jobs than free slots before the end). */
  warnings: string[];
}

/** Round a day up to the next login. */
/** What a batch takes from stock: units by type and their market value. Computed by the caller (it knows the recipe tree). */
export type StockUse = (batch: PlanBatch, left: ReadonlyMap<number, number>) => { take: Map<number, number>; value: number };

/** A batch with at least this share of its cost covered by stock counts as "made from stock" (goes first in its tier). UX choice. */
export const STOCK_FIRST_SHARE = 0.3;

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

const slotKind = (a: Activity): SlotKind | null =>
  a === "manufacturing" ? "manufacturing" : a === "reaction" ? "reaction" : isLab(a) ? "science" : null;
/** Lab jobs (copying the T1 blueprint, then invention) feed only the hull: they live outside the component chain. */
const isLab = (a: Activity) => a === "invention" || a === "copying";

/**
 * Factory and reaction slot-days a batch costs: the product job snaps to logins (its slot waits
 * for you), the intermediates count at their real length (they are pooled and fill otherwise idle
 * slots). Lab time is a separate resource and does not count here.
 */
export function slotDays(b: PlanBatch, cadence: number): number {
  const snapped = (j: PlanJob) => (j.parts ?? [j.runs]).reduce((s, r) => s + (nextLogin((j.seconds * r) / j.runs / DAY, cadence) || cadence), 0);
  return b.jobs.reduce((s, j) => s + (slotKind(j.activity) === "science" ? 0 : j.depth === 0 ? snapped(j) : j.seconds / DAY), 0);
}

/**
 * Splits one blueprint's runs into sequential jobs no longer than `capDays` each (a single run may
 * be longer). Best split: fewest slot-days snapped to logins, then the lowest material cost (the
 * game rounds materials per job, so short jobs lose the ME saving), then fewer jobs. Longest first.
 * Without a cap, or when it fits, it is one job.
 */
export function splitSequential(p: {
  runs: number;
  secondsPerRun: number;
  capDays?: number;
  cadenceDays: number;
  /** Cost of what one job of `runs` runs consumes; omitted = only slot-days count. */
  partCost?: (runs: number) => number;
}): { parts: number[]; slotDays: number; extraCost: number } {
  const { runs, secondsPerRun, cadenceDays: cad } = p;
  const days = (k: number) => nextLogin((k * secondsPerRun) / DAY, cad) || cad;
  const memo = new Map<number, number>();
  const cost = (k: number) => {
    if (!p.partCost) return 0;
    if (!memo.has(k)) memo.set(k, p.partCost(k));
    return memo.get(k)!;
  };
  const maxRuns = p.capDays && secondsPerRun > 0 ? Math.max(1, Math.floor((p.capDays * DAY) / secondsPerRun + 1e-9)) : runs;
  if (runs <= maxRuns) return { parts: [runs], slotDays: days(runs), extraCost: 0 };
  type Best = { days: number; cost: number; n: number; first: number };
  const best: Best[] = [{ days: 0, cost: 0, n: 0, first: 0 }];
  const better = (a: Best, b: Best) =>
    a.days < b.days - 1e-9 || (Math.abs(a.days - b.days) <= 1e-9 && (a.cost < b.cost - 1e-6 || (Math.abs(a.cost - b.cost) <= 1e-6 && a.n < b.n)));
  for (let r = 1; r <= runs; r++) {
    let b: Best | null = null;
    for (let k = 1; k <= Math.min(r, maxRuns); k++) {
      const rest = best[r - k];
      const c = { days: rest.days + days(k), cost: rest.cost + cost(k), n: rest.n + 1, first: k };
      if (!b || better(c, b)) b = c;
    }
    best.push(b!);
  }
  const parts: number[] = [];
  for (let r = runs; r > 0; r -= best[r].first) parts.push(best[r].first);
  parts.sort((a, b) => b - a);
  return { parts, slotDays: best[runs].days, extraCost: p.partCost ? best[runs].cost - cost(runs) : 0 };
}

export interface PlanInput {
  candidates: PlanBatch[];
  slots: SlotState[];
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  /** Max batches of one item (market cap is applied by the caller via units). */
  maxBatchesPerItem: number;
  /** Max units of one item over the plan. */
  unitCap: (typeId: number) => number;
  /** Max share of the budget one item may take (all its batches together); default 1 = no cap. */
  maxItemShare?: number;
  /** Longest single job per slot kind, days (e.g. reactions: 2); longer ones are split into parallel jobs. */
  maxJobDays?: Partial<Record<SlotKind, number>>;
  /** Units on hand by type and how a batch uses them; without it everything is bought. */
  stock?: Map<number, number>;
  stockUse?: StockUse;
  /** Batches made largely from stock go first within their tier (profitable ones only). */
  stockFirst?: boolean;
}

export function planWeek(input: PlanInput): Plan {
  const { cadenceDays: cad, horizonDays: horizon } = input;
  const stockLeft = new Map(input.stock ?? []);
  const stockTakenBy = (c: PlanBatch) => (input.stockUse && stockLeft.size ? input.stockUse(c, stockLeft) : { take: new Map<number, number>(), value: 0 });
  // Static share at the start: decides the order only; the real use is taken batch by batch.
  const fromStockFirst = (c: PlanBatch) => (input.stockFirst && c.profit > 0 && c.capital > 0 && stockTakenBy(c).value / c.capital >= STOCK_FIRST_SHARE ? 0 : 1);
  const slots = input.slots.map((s) => ({ ...s, freeAt: nextLogin(s.freeAt, cad) }));
  const ranked = input.candidates
    .filter((c) => c.profit > 0 || c.pinned)
    .map((c) => ({ c, score: (c.profit / Math.max(cad, slotDays(c, cad))) * (c.weight ?? 1), stock: fromStockFirst(c) }))
    .sort((a, b) => (a.c.tier ?? 0) - (b.c.tier ?? 0) || a.stock - b.stock || b.score - a.score);

  // Slot-days available per kind in the period, after what is already running.
  const capacity: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  for (const s of slots) capacity[s.kind] += Math.max(0, horizon - s.freeAt);
  const used: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };

  let budget = input.budget;
  const batches: Plan["batches"] = [];
  const jobs: ScheduledJob[] = [];
  const skipped: Plan["skipped"] = [];
  const unitsPlanned = new Map<number, number>();
  const spentPerItem = new Map<number, number>();
  const itemCap = input.budget * Math.min(1, Math.max(0, input.maxItemShare ?? 1));
  const prep = new Map<string, PrepJob>();
  const made = new Map<PlanBatch, number>();
  const reported = new Set<string>();

  /** Places one batch of `c`, or returns why not. Pinned batches skip the market cap and the budget share. */
  const place = (c: PlanBatch, pinned: boolean): string | null => {
    const product = c.jobs.find((j) => j.depth === 0)!;
    // What stock covers is not paid: only the rest comes from the budget.
    const use = stockTakenBy(c);
    const cash = Math.max(0, c.capital - use.value);
    if (cash > budget) return "не хватает бюджета";
    if (!pinned) {
      // Spread the budget: one expensive hull must not crowd out the rest of the week.
      if ((spentPerItem.get(c.typeId) ?? 0) + cash > itemCap + 1e-6) return `одна позиция не больше ${Math.round((itemCap / input.budget) * 100)}% бюджета`;
      if ((unitsPlanned.get(c.typeId) ?? 0) + c.units > input.unitCap(c.typeId)) return "рынок не возьмёт больше";
    }
    const intermediates = c.jobs.filter((j) => j.depth > 0 && slotKind(j.activity));
    // The product job: earliest free slot of its kind, at a login inside the period. A job over the
    // length cap of its kind runs as several parallel jobs, each on its own slot.
    const kind: SlotKind = slotKind(product.activity) ?? "manufacturing";
    const cap = input.maxJobDays?.[kind];
    // Sequential parts of one blueprint stay on one slot, back to back; the first must start inside
    // the plan, the last may end next week. Otherwise: parallel jobs, each on its own slot.
    const sequential = (product.parts?.length ?? 0) > 1;
    const parts = product.parts ?? splitRuns(product.runs, product.seconds / product.runs, cap ? cap * DAY : undefined);
    const free = slots.map((x) => x.freeAt);
    const placed: { slot: number; runs: number; start: number; end: number }[] = [];
    let productDays = 0;
    for (const runs of parts) {
      let best = -1;
      if (sequential && placed.length) best = placed[0].slot;
      else
        for (let i = 0; i < slots.length; i++) {
          if (slots[i].kind !== kind) continue;
          if (best === -1 || free[i] < free[best]) best = i;
        }
      if (best === -1 || (free[best] >= horizon && !(sequential && placed.length))) return "нет свободных слотов в пределах недели";
      const start = free[best];
      const end = start + (product.seconds * runs) / product.runs / DAY;
      productDays += Math.max(0, Math.min(nextLogin(end, cad) - start || cad, horizon - start));
      placed.push({ slot: best, runs, start, end });
      free[best] = nextLogin(end, cad);
    }
    const after = { ...used };
    for (const j of intermediates) after[slotKind(j.activity)!] += j.seconds / DAY;
    after[kind] += productDays;
    if (after.manufacturing > capacity.manufacturing || after.reaction > capacity.reaction) return "не хватит слотов на компоненты и реакции";
    if (after.science > capacity.science) return "не хватит лабораторных слотов на инвент";
    for (const [i, x] of placed.entries()) {
      jobs.push({
        ...product,
        runs: x.runs,
        seconds: (product.seconds * x.runs) / product.runs,
        batchTypeId: c.typeId,
        slot: x.slot,
        owner: slots[x.slot].owner,
        start: x.start,
        end: x.end,
        ...(sequential ? { part: { index: i + 1, of: placed.length } } : {}),
      });
      slots[x.slot].freeAt = free[x.slot];
    }
    const start = Math.min(...placed.map((x) => x.start));
    const end = Math.max(...placed.map((x) => x.end));
    Object.assign(used, after);
    for (const j of intermediates) {
      const k = `${j.typeId}:${j.activity}`;
      const cur = prep.get(k) ?? { typeId: j.typeId, name: j.name, activity: j.activity, runs: 0, seconds: 0, depth: 0, start: 0, jobs: 1, maxRunsPerJob: j.maxRunsPerJob };
      cur.runs += j.runs;
      cur.seconds += j.seconds;
      cur.depth = Math.max(cur.depth, j.depth);
      prep.set(k, cur);
    }
    batches.push({ ...c, start, end, fromStock: c.capital - cash });
    budget -= cash;
    for (const [id, q] of use.take) stockLeft.set(id, Math.max(0, (stockLeft.get(id) ?? 0) - q));
    unitsPlanned.set(c.typeId, (unitsPlanned.get(c.typeId) ?? 0) + c.units);
    spentPerItem.set(c.typeId, (spentPerItem.get(c.typeId) ?? 0) + cash);
    made.set(c, (made.get(c) ?? 0) + 1);
    return null;
  };
  const fill = (c: PlanBatch, upTo: number) => {
    if (!c.jobs.some((j) => j.depth === 0)) return;
    while ((made.get(c) ?? 0) < Math.min(upTo, c.maxBatches ?? Infinity)) {
      const why = place(c, false);
      if (!why) continue;
      // Reported only when nothing of the item fit.
      if (!made.get(c) && !reported.has(c.key ?? String(c.typeId))) skipped.push({ name: c.name, reason: why });
      reported.add(c.key ?? String(c.typeId));
      break;
    }
  };

  // Pinned first (they may lose money: Nick decided). The count is per item: when one route runs out
  // (own BPCs used up), the next one (invention) adds the rest.
  const pinnedItems = new Map<number, PlanBatch[]>();
  for (const { c } of ranked) if (c.pinned && c.jobs.some((j) => j.depth === 0)) pinnedItems.set(c.typeId, [...(pinnedItems.get(c.typeId) ?? []), c]);
  for (const routes of pinnedItems.values()) {
    const want = Math.max(...routes.map((c) => c.pinned ?? 0));
    const count = () => routes.reduce((n, c) => n + (made.get(c) ?? 0), 0);
    let why: string | null = null;
    for (const c of routes) {
      while (count() < want && (made.get(c) ?? 0) < (c.maxBatches ?? Infinity)) {
        why = place(c, true);
        if (why) break;
      }
      if (count() >= want) break;
    }
    if (count() < want) skipped.push({ name: routes[0].name, reason: `закреплено ${want} шт., вошло ${count()}: ${why ?? "кончились свои BPC, инвента нет"}` });
    for (const c of routes) reported.add(c.key ?? String(c.typeId));
  }
  for (const { c } of ranked) if (c.profit > 0) fill(c, input.maxBatchesPerItem);

  // Prep: deepest level at the first login, one level per login after that.
  const prepJobs = [...prep.values()];
  // Copying and invention are on their own (lab) slots and only feed the hull: they start at the
  // first login (invention once the copies are ready) and do not push the component chain back.
  const maxDepth = Math.max(0, ...prepJobs.filter((p) => !isLab(p.activity)).map((p) => p.depth));
  for (const p of prepJobs) {
    p.start = isLab(p.activity) ? 0 : (maxDepth - p.depth) * cad;
    // A 22-day pooled job does not fit a week, and a blueprint caps runs per job: run it on as many
    // parallel slots as needed (components may finish next week: the limit is the horizon).
    const kind = slotKind(p.activity);
    const cap = kind ? input.maxJobDays?.[kind] : undefined;
    const byTime = Math.ceil(p.seconds / DAY / (cap ? Math.min(cap, Math.max(cad, horizon)) : Math.max(cad, horizon)) - 1e-9);
    const byRuns = p.maxRunsPerJob ? Math.ceil(p.runs / p.maxRunsPerJob) : 1;
    p.jobs = Math.min(p.runs, Math.max(1, byTime, byRuns));
    // Invention attempts (and the T1 copies they eat) are an expectation per batch: round up once over the pool.
    if (isLab(p.activity)) {
      const runs = Math.ceil(p.runs - 1e-9);
      p.seconds = p.runs > 0 ? (p.seconds * runs) / p.runs : 0;
      p.runs = runs;
      p.jobs = Math.min(runs, Math.max(1, Math.ceil(p.seconds / DAY / Math.max(cad, horizon) - 1e-9)));
    }
  }

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
  const { prep: placedPrep, warnings } = schedulePrep(prepJobs, slots, cad, horizon);
  for (const p of placedPrep) at(p.start).prep.push(p);

  const utilization: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  for (const kind of KINDS) {
    const n = slots.filter((s) => s.kind === kind).length;
    if (n) utilization[kind] = Math.min(1, used[kind] / (n * horizon));
  }

  return {
    batches,
    jobs,
    prep: placedPrep,
    warnings,
    logins: [...days.values()].sort((a, b) => a.day - b.day),
    profit: batches.reduce((s, b) => s + b.profit, 0),
    capital: batches.reduce((s, b) => s + b.capital - b.fromStock, 0),
    fromStock: batches.reduce((s, b) => s + b.fromStock, 0),
    utilization,
    skipped,
  };
}

/** Extra budget the "what one more billion gives" figure is computed for. UX choice. */
export const BUDGET_STEP = 1e9;

export interface MarginalValues {
  /** Extra profit over the plan from one more free slot of a kind. */
  slot: Record<SlotKind, number>;
  /** The same per slot-day: what a day of that slot earns on the next batch that did not fit. */
  slotDay: Record<SlotKind, number>;
  /** Extra profit from one more character with the slots of the biggest one (all free). */
  character: { like: string; gain: number } | null;
  /** Extra profit from BUDGET_STEP more ISK. */
  budget: { step: number; gain: number };
}

/**
 * What one more slot, character or billion would add to the plan: the same plan is made again
 * with it. Shows the bottleneck (slots or ISK) and is the bar an intermediate must clear to take
 * a slot from the hulls. The planner is greedy, so a gain can be lumpy; it is never below 0.
 */
export function marginalValues(input: PlanInput, base: Plan = planWeek(input)): MarginalValues {
  const gain = (more: Partial<PlanInput>) => Math.max(0, planWeek({ ...input, ...more }).profit - base.profit);
  const horizon = Math.max(input.cadenceDays, input.horizonDays);
  const slot = { manufacturing: 0, reaction: 0, science: 0 };
  const slotDay = { ...slot };
  for (const kind of KINDS) {
    slot[kind] = gain({ slots: [...input.slots, { kind, owner: "+1 слот", freeAt: 0 }] });
    slotDay[kind] = slot[kind] / horizon;
  }
  const owners = [...new Set(input.slots.map((s) => s.owner))];
  const biggest = owners.sort((a, b) => input.slots.filter((s) => s.owner === b).length - input.slots.filter((s) => s.owner === a).length)[0];
  const twin = input.slots.filter((s) => s.owner === biggest).map((s) => ({ ...s, owner: `+${biggest}`, freeAt: 0 }));
  return {
    slot,
    slotDay,
    character: biggest === undefined ? null : { like: biggest, gain: gain({ slots: [...input.slots, ...twin] }) },
    budget: { step: BUDGET_STEP, gain: gain({ budget: input.budget + BUDGET_STEP }) },
  };
}

const KIND_NAME: Record<SlotKind, string> = { manufacturing: "производственных", reaction: "реакционных", science: "лабораторных" };

/**
 * Puts the parallel jobs of every pooled intermediate on real free slots (after the product jobs),
 * at logins: a level starts no earlier than its login and one login after the deeper level started;
 * what does not fit a login moves to the next one. Entries are split by start day.
 */
function schedulePrep(pool: PrepJob[], slots: SlotState[], cad: number, horizon: number): { prep: PrepJob[]; warnings: string[] } {
  const free = slots.map((s) => s.freeAt);
  const out: PrepJob[] = [];
  const warnings: string[] = [];
  const latestStart = new Map<number, number>();
  /** Per item: when its T1 copies are ready (invention starts at the login after). */
  const copiesReady = new Map<number, number>();
  const rank = (a: Activity) => (a === "copying" ? 0 : a === "invention" ? 1 : 2);
  const order = [...pool].sort((a, b) => rank(a.activity) - rank(b.activity) || b.depth - a.depth || b.seconds - a.seconds);
  for (const p of order) {
    const kind = slotKind(p.activity) ?? "manufacturing";
    let earliest = p.start;
    if (!isLab(p.activity)) for (const [d, st] of latestStart) if (d > p.depth) earliest = Math.max(earliest, nextLogin(st + cad, cad));
    if (p.activity === "invention" && copiesReady.has(p.typeId)) earliest = Math.max(earliest, nextLogin(copiesReady.get(p.typeId)!, cad));
    const runs = splitRuns(p.runs, p.runs ? p.seconds / p.runs : 0, undefined, Math.ceil(p.runs / p.jobs));
    const byDay = new Map<number, PrepJob>();
    let late = 0;
    for (const r of runs) {
      const seconds = p.runs ? (p.seconds * r) / p.runs : 0;
      let best = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].kind !== kind) continue;
        if (best === -1 || Math.max(free[i], earliest) < Math.max(free[best], earliest)) best = i;
      }
      const start = nextLogin(best === -1 ? earliest : Math.max(free[best], earliest), cad);
      if (best !== -1) free[best] = nextLogin(start + seconds / DAY, cad);
      if (best === -1 || start >= horizon) late++;
      const e = byDay.get(start) ?? { ...p, runs: 0, seconds: 0, jobs: 0, start };
      e.runs += r;
      e.seconds += seconds;
      e.jobs++;
      byDay.set(start, e);
      if (!isLab(p.activity)) latestStart.set(p.depth, Math.max(latestStart.get(p.depth) ?? 0, start));
      if (p.activity === "copying") copiesReady.set(p.typeId, Math.max(copiesReady.get(p.typeId) ?? 0, start + seconds / DAY));
    }
    out.push(...byDay.values());
    if (late) {
      const where = slots.some((s) => s.kind === kind) ? `не хватает свободных ${KIND_NAME[kind]} слотов до конца плана` : `нет ${KIND_NAME[kind]} слотов`;
      warnings.push(`${p.name}: ${late} из ${runs.length} джоб — ${where}, начнутся позже`);
    }
  }
  return { prep: out.sort((a, b) => a.start - b.start || b.depth - a.depth || b.seconds - a.seconds), warnings };
}
