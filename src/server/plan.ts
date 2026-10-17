/**
 * Weekly plan: candidates from the overview, batches sized to Nick's login rhythm, scheduled on
 * the real free slots of the characters (skills − running jobs), within a budget.
 */
import { batchRunsForCadence, planWeek, type Plan, type PlanBatch, type PlanJob, type SlotKind, type SlotState } from "@/engine/planner";
import { JOB_ACTIVITY_IDS, SLOT_SKILLS } from "@/engine/bonuses";
import { characters, industryJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { calculate, type CalcResponse } from "./calculate";
import { CATEGORIES, type CategoryKey } from "./catalog";
import { skillLevels } from "./characters";
import { getDb } from "./data";
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
  invention: { name: string; batches: number; attemptsPerBatch: number; source: string }[];
  /** All evaluated candidates, best first — the "sheet" for planning by hand or with Claude. */
  sheet: {
    name: string;
    category: string;
    runs: number;
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
    summary.push({
      owner: c.name,
      manufacturing: { total: total.manufacturing, busy: busyEnds.manufacturing.length },
      reaction: { total: total.reaction, busy: busyEnds.reaction.length },
      science: { total: total.science, busy: busyEnds.science.length },
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

function toBatch(r: CalcResponse): PlanBatch {
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

export function buildPlan(req: PlanRequest): PlanResponse {
  const t0 = Date.now();
  const now = Date.now();
  const cad = Math.max(1, req.cadenceDays);
  const horizon = Math.max(cad, req.horizonDays);

  // Candidates: best overview rows across the chosen categories (one row per item).
  const rows = new Map<number, OverviewRow & { category: string }>();
  for (const key of req.categories) {
    const label = CATEGORIES.find((c) => c.key === key)?.label ?? key;
    for (const r of computeOverview(key).rows) {
      if (r.error || r.profit === null || r.profit <= 0 || !r.jobSeconds || !r.runs) continue;
      if (!rows.has(r.typeId)) rows.set(r.typeId, { ...r, category: label });
    }
  }
  const top = [...rows.values()].sort((a, b) => (b.iskPerHour ?? 0) - (a.iskPerHour ?? 0)).slice(0, req.candidates ?? 60);

  const calcs = new Map<number, CalcResponse>();
  const unpriced: string[] = [];
  const candidates: PlanBatch[] = [];
  const unitCap = new Map<number, number>();
  for (const r of top) {
    const runs = batchRunsForCadence({
      secondsPerRun: r.jobSeconds / r.runs,
      profitPerRun: (r.profit ?? 0) / r.runs,
      maxRuns: r.maxRuns,
      cadenceDays: cad,
      horizonDays: horizon,
    });
    try {
      const c = calculate({ typeId: r.typeId, runs });
      // A missing price understates the cost: such a "profit" is not real.
      if (c.warnings.some((w) => w.includes("нет рыночной цены"))) {
        unpriced.push(r.name);
        continue;
      }
      calcs.set(r.typeId, c);
      const owned = c.request.blueprintSource === "owned" ? c.ownedBlueprint : null;
      // Own BPCs: one batch per copy. BPO, invention or no blueprint: limited by market and slots only.
      candidates.push({ ...toBatch(c), maxBatches: owned && !owned.isBpo ? owned.copies : undefined });
      unitCap.set(r.typeId, r.avgDailyVolume30d ? Math.max(c.summary.output, r.avgDailyVolume30d * horizon * req.marketShare) : c.summary.output);
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
  const inv = new Map<number, PlanResponse["invention"][number]>();
  for (const b of plan.batches) {
    const c = calcs.get(b.typeId)!;
    for (const l of c.shopping) {
      const cur = shop.get(l.typeId) ?? { typeId: l.typeId, name: l.name, quantity: 0, cost: 0, volume: 0 };
      cur.quantity += l.quantity;
      cur.cost = cur.cost === null || l.cost === null ? null : cur.cost + l.cost;
      cur.volume += l.volume;
      shop.set(l.typeId, cur);
    }
    const ch = c.request.blueprintSource === "invention" ? c.invention.chosen : null;
    if (ch) {
      const cur = inv.get(b.typeId) ?? { name: b.name, batches: 0, attemptsPerBatch: Math.ceil(1 / Math.max(ch.chance, 0.01)), source: ch.sourceName };
      cur.batches++;
      inv.set(b.typeId, cur);
    }
  }

  const sheet = candidates
    .map((b) => {
      const r = rows.get(b.typeId)!;
      const days = b.jobs.reduce((s, j) => s + Math.max(cad, Math.ceil(j.seconds / DAY / cad) * cad), 0);
      return {
        name: b.name,
        category: r.category,
        runs: b.runs,
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
    `Бюджет ${r.budget.toLocaleString("ru-RU")} ISK, заход раз в ${r.cadenceDays} дн., горизонт ${r.horizonDays} дн., рынок до ${Math.round(r.marketShare * 100)}% недельного объёма.`,
    `Слоты: ${p.slots.map((s) => `${s.owner} — производство ${s.manufacturing.total} (занято ${s.manufacturing.busy}), реакции ${s.reaction.total} (занято ${s.reaction.busy})`).join("; ")}.`,
    "",
    "Предмет | категория | раны | прибыль | капитал | слото-дней | прибыль/слото-день | джоб | дней рынка | риски",
    ...p.sheet.map((s) =>
      [s.name, s.category, s.runs, Math.round(s.profit), Math.round(s.capital), s.slotDays, Math.round(s.profitPerSlotDay), s.jobs, s.marketDays?.toFixed(1) ?? "—", s.risks.join("; ") || "—"].join(" | "),
    ),
  ];
  return lines.join("\n");
}

