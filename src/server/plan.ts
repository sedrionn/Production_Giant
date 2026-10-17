/**
 * Weekly plan: candidates from the overview, batches sized to Nick's login rhythm, scheduled on
 * the real free slots of the characters (skills − running jobs), within a budget.
 */
import { batchRunsForCadence, planWeek, slotDays, type Plan, type PlanBatch, type PlanJob, type SlotKind, type SlotState } from "@/engine/planner";
import { JOB_ACTIVITY_IDS, SLOT_SKILLS } from "@/engine/bonuses";
import { characters, industryJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { calculate, type CalcResponse } from "./calculate";
import { CATEGORIES, RACE_CALDARI, shipInputs, type CategoryKey } from "./catalog";
import { skillLevels } from "./characters";
import { getDb, getSde } from "./data";
import { computeOverview, type OverviewRow } from "./overview";

export interface PlanRequest {
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  categories: CategoryKey[];
  /** Largest share of the item's weekly market volume to plan for (0.3 = 30%). */
  marketShare: number;
  /** How many top overview items to evaluate in full. */
  candidates?: number;
  /** Skip batches that earn less than this: not worth a separate job to babysit. */
  minBatchProfit: number;
  /** Plan Caldari ships before anything else (then by profit per slot-day). */
  caldariShipsFirst: boolean;
}

export interface SlotSummary {
  owner: string;
  manufacturing: { total: number; busy: number };
  reaction: { total: number; busy: number };
  science: { total: number; busy: number };
}

export interface PlanResponse extends Plan {
  request: PlanRequest;
  slots: SlotSummary[];
  shopping: { typeId: number; name: string; quantity: number; cost: number | null; volume: number }[];
  /** Invention needed for invented batches (lab slots are not scheduled yet). */
  invention: { name: string; batches: number; attemptsPerBatch: number; source: string; decryptor: string | null; runsPerBpc: number }[];
  /** All evaluated candidates, best first — the "sheet" for planning by hand or with Claude. */
  sheet: {
    name: string;
    category: string;
    runs: number;
    decryptor: string | null;
    profit: number;
    capital: number;
    slotDays: number;
    profitPerSlotDay: number;
    jobs: number;
    marketDays: number | null;
    risks: string[];
  }[];
  computedMs: number;
}

const DAY = 86_400_000;
const slotOf = (activityId: number): SlotKind | "science" =>
  activityId === JOB_ACTIVITY_IDS.manufacturing ? "manufacturing" : (JOB_ACTIVITY_IDS.reactions as readonly number[]).includes(activityId) ? "reaction" : "science";

function characterSlots(now: number): { slots: SlotState[]; summary: SlotSummary[] } {
  const db = getDb();
  const slots: SlotState[] = [];
  const summary: SlotSummary[] = [];
  for (const c of db.select().from(characters).all()) {
    const lv = skillLevels(c.characterId);
    const count = (ids: readonly number[]) => 1 + ids.reduce((s, id) => s + (lv.get(id) ?? 0), 0);
    const total = { manufacturing: count(SLOT_SKILLS.manufacturing), reaction: count(SLOT_SKILLS.reaction), science: count(SLOT_SKILLS.science) };
    const active = db
      .select()
      .from(industryJobs)
      .where(eq(industryJobs.installerId, c.characterId))
      .all()
      .filter((j) => j.status === "active");
    const busyEnds: Record<string, number[]> = { manufacturing: [], reaction: [], science: [] };
    for (const j of active) busyEnds[slotOf(j.activityId)].push(Math.max(0, (Date.parse(j.endDate) - now) / DAY));
    for (const kind of ["manufacturing", "reaction"] as SlotKind[]) {
      const ends = busyEnds[kind].sort((a, b) => a - b);
      for (let i = 0; i < total[kind]; i++) slots.push({ kind, owner: c.name, freeAt: ends[i] ?? 0 });
    }
    // Finished but not delivered jobs still show as active in ESI: they free up at the next login.
    const busy = (k: string) => busyEnds[k].filter((d) => d > 0).length;
    summary.push({
      owner: c.name,
      manufacturing: { total: total.manufacturing, busy: busy("manufacturing") },
      reaction: { total: total.reaction, busy: busy("reaction") },
      science: { total: total.science, busy: busy("science") },
    });
  }
  return { slots, summary };
}

/** Chain depth of every built type: root 0, its inputs 1, … (longest path). */
function depths(r: CalcResponse): Map<number, number> {
  const byId = new Map(r.nodes.map((n) => [n.typeId, n]));
  const depth = new Map<number, number>();
  const walk = (id: number, d: number, seen: Set<number>) => {
    if (seen.has(id)) return;
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    const n = byId.get(id);
    if (!n || n.decision !== "build") return;
    const next = new Set(seen).add(id);
    for (const c of n.children) walk(c.typeId, d + 1, next);
  };
  walk(r.product.typeId, 0, new Set());
  return depth;
}

export function toBatch(r: CalcResponse): PlanBatch {
  const depth = depths(r);
  const jobs: PlanJob[] = r.jobs
    .filter((j) => j.activity === "manufacturing" || j.activity === "reaction")
    .map((j) => ({ typeId: j.typeId, name: j.name, activity: j.activity, runs: j.runs, seconds: j.timeSeconds, depth: depth.get(j.typeId) ?? 1 }));
  return {
    typeId: r.product.typeId,
    name: r.product.name,
    runs: r.request.runs,
    units: r.summary.output,
    profit: r.summary.profit ?? 0,
    capital: r.summary.totalCost,
    jobs,
  };
}

export type Row = OverviewRow & { category: string; categoryKey: CategoryKey };

/** Reactions that feed Caldari ships rank this much higher (Nick's preference, soft). */
const PREFER_CALDARI_REACTIONS = 1.15;

interface Sized {
  route: "owned" | "invention";
  runs: number;
  /** undefined = settings default; null = no decryptor. */
  decryptorId?: number | null;
  profit: number;
  score: number;
}

/**
 * Batch size per way of getting the blueprint, with the best profit per occupied product slot-day.
 * Own BPO/BPC: its runs. Invention (also when you still have a few BPCs left): every decryptor is
 * tried — +runs decryptors turn 1-run BPCs into multi-day jobs (Flycatcher with Augmentation).
 */
export function sizeRoutes(r: Row, cad: number, horizon: number, minProfit = 0): Sized[] {
  const pick = (secondsPerRun: number, profitPerRun: number, maxRuns: number) => {
    const runs = batchRunsForCadence({ secondsPerRun, profitPerRun, maxRuns, cadenceDays: cad, horizonDays: horizon, minProfit });
    const occupied = Math.max(cad, Math.ceil((runs * secondsPerRun) / 86_400 / cad) * cad);
    return { runs, profit: profitPerRun * runs, score: (profitPerRun * runs) / occupied };
  };
  const out: Sized[] = [];
  if (r.blueprintSource === "bpo" || r.blueprintSource === "bpc") {
    const perRun = (r.profit ?? 0) / r.runs;
    // An own BPC is used up whole; a BPO is sized for the login rhythm.
    if (perRun > 0 && r.blueprintSource === "bpc" && r.maxRuns > 0) {
      const secs = (r.jobSeconds / r.runs) * r.maxRuns;
      const occupied = Math.max(cad, Math.ceil(secs / 86_400 / cad) * cad);
      out.push({ route: "owned", runs: r.maxRuns, profit: perRun * r.maxRuns, score: (perRun * r.maxRuns) / occupied });
    } else if (perRun > 0) out.push({ route: "owned", ...pick(r.jobSeconds / r.runs, perRun, r.maxRuns) });
    if (r.blueprintSource === "bpo") return out;
  }
  const c = calculate({ typeId: r.typeId, runs: r.runs, blueprintSource: "invention", compareDecryptors: true });
  if (c.request.blueprintSource !== "invention") return out;
  const base = (c.jobs.at(-1)?.timeSeconds ?? r.jobSeconds) / r.runs;
  const te0 = c.request.te;
  let best: Sized | null = null;
  for (const d of c.invention.comparison) {
    if (d.profit === null) continue;
    const secondsPerRun = (base * (1 - d.te / 100)) / (1 - te0 / 100);
    // An invented BPC is used up whole: its cost per run assumes every run gets built.
    const perRun = d.profit / r.runs;
    const occupied = Math.max(cad, Math.ceil((d.runsPerSuccess * secondsPerRun) / 86_400 / cad) * cad);
    const s = { runs: d.runsPerSuccess, profit: perRun * d.runsPerSuccess, score: (perRun * d.runsPerSuccess) / occupied };
    // Batches above the minimum first; then score; ties → the longer batch (fewer logins).
    const big = (x: { profit: number }) => x.profit >= minProfit;
    if (
      s.profit > 0 &&
      (!best ||
        (big(s) && !big(best)) ||
        (big(s) === big(best) && (s.score > best.score * 1.0001 || (s.score >= best.score * 0.9999 && s.runs > best.runs))))
    ) {
      best = { route: "invention", ...s, decryptorId: d.decryptorId };
    }
  }
  if (best) out.push(best);
  return out;
}

/** SDE category of ships. Caldari ships go first when asked (tier 0); everything else after. */
const CATEGORY_SHIP = 6;

export function buildPlan(req: PlanRequest): PlanResponse {
  const t0 = Date.now();
  const now = Date.now();
  const cad = Math.max(1, req.cadenceDays);
  const horizon = Math.max(cad, req.horizonDays);

  // Candidates: best overview rows across the chosen categories (one row per item).
  const rows = new Map<number, Row>();
  for (const key of req.categories) {
    const label = CATEGORIES.find((c) => c.key === key)?.label ?? key;
    for (const r of computeOverview(key).rows) {
      // Invented rows stay even if unprofitable at the default decryptor: another one may fix that.
      if (r.error || r.profit === null || !r.jobSeconds || !r.runs) continue;
      if (r.profit <= 0 && r.blueprintSource !== "invention") continue;
      if (!rows.has(r.typeId)) rows.set(r.typeId, { ...r, category: label, categoryKey: key });
    }
  }
  // Size each row for the login rhythm. Invented items also pick the decryptor that gives the best
  // profit per occupied slot-day: +runs decryptors turn 1-run BPCs into multi-day jobs (Flycatcher).
  const { source: sde } = getSde();
  const caldariInputs = shipInputs(sde, new Set([RACE_CALDARI]));
  const sized = [...rows.values()].flatMap((r) => {
    try {
      const t = sde.getType(r.typeId);
      const weight = r.categoryKey === "reactions" && caldariInputs.has(r.typeId) ? PREFER_CALDARI_REACTIONS : 1;
      const tier = req.caldariShipsFirst && t?.categoryId === CATEGORY_SHIP && t.raceId === RACE_CALDARI ? 0 : 1;
      return sizeRoutes(r, cad, horizon, req.minBatchProfit).map((s) => ({ r, ...s, weight, tier }));
    } catch {
      return [];
    }
  });
  const top = sized
    .filter((x) => x.profit >= req.minBatchProfit)
    .sort((a, b) => a.tier - b.tier || b.score * b.weight - a.score * a.weight)
    .slice(0, req.candidates ?? 150);

  const calcs = new Map<string, CalcResponse>();
  const unpriced: string[] = [];
  const noBlueprint: string[] = [];
  const candidates: PlanBatch[] = [];
  const unitCap = new Map<number, number>();
  for (const { r, route, runs, decryptorId, weight, tier } of top) {
    const key = `${r.typeId}:${route}`;
    try {
      const c = calculate({
        typeId: r.typeId,
        runs,
        blueprintSource: route,
        ...(route === "invention" && decryptorId !== undefined ? { decryptorId } : {}),
      });
      // A missing price understates the cost: such a "profit" is not real.
      if (c.warnings.some((w) => w.includes("нет рыночной цены"))) {
        unpriced.push(r.name);
        continue;
      }
      const owned = c.request.blueprintSource === "owned" ? c.ownedBlueprint : null;
      // Only what you can actually start: your own blueprint, or one you can invent.
      if (!owned && c.request.blueprintSource !== "invention") {
        noBlueprint.push(r.name);
        continue;
      }
      calcs.set(key, c);
      // Own BPCs: one batch per copy. BPO or invention: limited by market and slots only.
      const batch = toBatch(c);
      if (batch.profit < req.minBatchProfit) continue;
      candidates.push({ ...batch, key, weight, tier, maxBatches: owned && !owned.isBpo ? owned.copies : undefined });
      // Market cap: a share of what sells over the horizon. No history = one batch at most.
      unitCap.set(r.typeId, r.avgDailyVolume30d ? r.avgDailyVolume30d * horizon * req.marketShare : c.summary.output);
    } catch {
      /* not calculable at this size — skip */
    }
  }

  const { slots, summary } = characterSlots(now);
  const plan = planWeek({
    candidates,
    slots,
    budget: req.budget,
    cadenceDays: cad,
    horizonDays: horizon,
    maxBatchesPerItem: 10,
    unitCap: (id) => unitCap.get(id) ?? 0,
  });

  // One shopping list for everything in the plan.
  const shop = new Map<number, PlanResponse["shopping"][number]>();
  const inv = new Map<string, PlanResponse["invention"][number]>();
  for (const b of plan.batches) {
    const c = calcs.get(b.key ?? String(b.typeId))!;
    for (const l of c.shopping) {
      const cur = shop.get(l.typeId) ?? { typeId: l.typeId, name: l.name, quantity: 0, cost: 0, volume: 0 };
      cur.quantity += l.quantity;
      cur.cost = cur.cost === null || l.cost === null ? null : cur.cost + l.cost;
      cur.volume += l.volume;
      shop.set(l.typeId, cur);
    }
    const ch = c.request.blueprintSource === "invention" ? c.invention.chosen : null;
    if (ch) {
      const cur = inv.get(b.key ?? String(b.typeId)) ?? {
        name: b.name,
        batches: 0,
        attemptsPerBatch: Math.ceil(1 / Math.max(ch.chance, 0.01)),
        source: ch.sourceName,
        decryptor: c.invention.decryptor?.name ?? null,
        runsPerBpc: ch.runsPerSuccess,
      };
      cur.batches++;
      inv.set(b.key ?? String(b.typeId), cur);
    }
  }

  const sheet = candidates
    .map((b) => {
      const r = rows.get(b.typeId)!;
      const days = Math.round(slotDays(b, cad) * 10) / 10;
      const c = calcs.get(b.key ?? String(b.typeId));
      return {
        name: b.name + (c?.request.blueprintSource === "invention" ? " (инвент)" : " (свой чертёж)"),
        category: r.category,
        runs: b.runs,
        decryptor: c?.request.blueprintSource === "invention" ? c.invention.decryptor?.name ?? null : null,
        profit: b.profit,
        capital: b.capital,
        slotDays: days,
        profitPerSlotDay: b.profit / Math.max(cad, days),
        jobs: b.jobs.length,
        marketDays: r.avgDailyVolume30d ? b.units / r.avgDailyVolume30d : null,
        risks: r.marketRisks,
      };
    })
    .sort((a, b) => b.profitPerSlotDay - a.profitPerSlotDay);

  for (const name of unpriced) plan.skipped.push({ name, reason: "нет цены на часть материалов" });
  for (const name of noBlueprint) plan.skipped.push({ name, reason: "нет чертежа и нельзя заинвентить" });

  return {
    ...plan,
    request: { ...req, cadenceDays: cad, horizonDays: horizon },
    slots: summary,
    shopping: [...shop.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
    invention: [...inv.values()],
    sheet,
    computedMs: Date.now() - t0,
  };
}

/** Plain-text sheet for pasting into a chat with Claude. */
export function sheetText(p: PlanResponse): string {
  const r = p.request;
  const lines = [
    `Бюджет ${r.budget.toLocaleString("ru-RU")} ISK, заход раз в ${r.cadenceDays} дн., горизонт ${r.horizonDays} дн., рынок до ${Math.round(r.marketShare * 100)}% недельного объёма, партии от ${r.minBatchProfit.toLocaleString("ru-RU")} ISK прибыли.`,
    `Слоты: ${p.slots.map((s) => `${s.owner} — производство ${s.manufacturing.total} (занято ${s.manufacturing.busy}), реакции ${s.reaction.total} (занято ${s.reaction.busy})`).join("; ")}.`,
    "",
    "Предмет | категория | раны | декриптор | прибыль | капитал | слото-дней | прибыль/слото-день | джоб | дней рынка | риски",
    ...p.sheet.map((s) =>
      [s.name, s.category, s.runs, s.decryptor ?? "—", Math.round(s.profit), Math.round(s.capital), s.slotDays, Math.round(s.profitPerSlotDay), s.jobs, s.marketDays?.toFixed(1) ?? "—", s.risks.join("; ") || "—"].join(" | "),
    ),
  ];
  return lines.join("\n");
}

