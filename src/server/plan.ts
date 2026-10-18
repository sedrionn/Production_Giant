/**
 * Weekly plan: candidates from the overview, batches sized to Nick's login rhythm, scheduled on
 * the real free slots of the characters (skills − running jobs), within a budget.
 */
import { batchRunsForCadence, planWeek, slotDays, type Plan, type PlanBatch, type PlanJob, type SlotKind, type SlotState } from "@/engine/planner";
import { JOB_ACTIVITY_IDS, SLOT_SKILLS } from "@/engine/bonuses";
import { characters, industryJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { calculate, type CalcResponse } from "./calculate";
import { CATEGORIES, isCaldariBranchShip, RACE_CALDARI, shipInputs, type CategoryKey } from "./catalog";
import { ownedBlueprintIndex, skillLevels } from "./characters";
import { getDb, getSde, getSettings, priceBook } from "./data";
import { recipeLookup } from "@/sde/recipes";
import fs from "node:fs";
import path from "node:path";
import { stockIndex } from "./assets";
import { planStages, type StageBuyInfo, type StageRecipe, type Stages } from "@/engine/stages";
import { quotePrice } from "@/engine/pricing";
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
  /** Max share of the budget one item may take (0..1). */
  maxItemShare: number;
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
  /** The plan split into stages (deepest first) with stock taken off, and the purchase list. */
  stages: Stages;
  /** Where the stock came from. */
  stock: { locations: number[]; syncedAt: string | null; owners: number; types: number };
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
  const { source: sde } = getSde();
  const jobs: PlanJob[] = r.jobs
    .filter((j) => j.activity === "manufacturing" || j.activity === "reaction")
    .map((j) => ({
      typeId: j.typeId,
      name: j.name,
      activity: j.activity,
      runs: j.runs,
      seconds: j.timeSeconds,
      depth: depth.get(j.typeId) ?? 1,
      maxRunsPerJob: sde.getBlueprint(j.blueprintTypeId)?.maxProductionLimit || undefined,
    }));
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
  /** Own BPCs of exactly this length: one batch each. */
  maxBatches?: number;
}

/** Own BPC lengths planned separately (longest groups first); shorter leftovers are ignored. */
const MAX_BPC_GROUPS = 3;

/**
 * Batch size per way of getting the blueprint, with the best profit per occupied product slot-day.
 * Own BPO/BPC: its runs. Invention (also when you still have a few BPCs left): every decryptor is
 * tried — +runs decryptors turn 1-run BPCs into multi-day jobs (Flycatcher with Augmentation).
 */
export function sizeRoutes(r: Row, cad: number, horizon: number, minProfit = 0, bpcRuns: number[] = []): Sized[] {
  const pick = (secondsPerRun: number, profitPerRun: number, maxRuns: number) => {
    const runs = batchRunsForCadence({ secondsPerRun, profitPerRun, maxRuns, cadenceDays: cad, horizonDays: horizon, minProfit });
    const occupied = Math.max(cad, Math.ceil((runs * secondsPerRun) / 86_400 / cad) * cad);
    return { runs, profit: profitPerRun * runs, score: (profitPerRun * runs) / occupied };
  };
  const out: Sized[] = [];
  if (r.blueprintSource === "bpo" || r.blueprintSource === "bpc") {
    const perRun = (r.profit ?? 0) / r.runs;
    // An own BPC is used up whole, one batch per copy of its real length; a BPO is sized for the login rhythm.
    if (perRun > 0 && r.blueprintSource === "bpc" && r.maxRuns > 0) {
      const groups = new Map<number, number>();
      for (const n of bpcRuns.length ? bpcRuns : [r.maxRuns]) groups.set(n, (groups.get(n) ?? 0) + 1);
      for (const [runs, count] of [...groups.entries()].sort((a, b) => b[0] - a[0]).slice(0, MAX_BPC_GROUPS)) {
        const secs = (r.jobSeconds / r.runs) * runs;
        const occupied = Math.max(cad, Math.ceil(secs / 86_400 / cad) * cad);
        out.push({ route: "owned", runs, profit: perRun * runs, score: (perRun * runs) / occupied, maxBatches: count });
      }
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
  const recipe = recipeLookup(sde);
  const ownedIdx = ownedBlueprintIndex();
  const sized = [...rows.values()].flatMap((r) => {
    try {
      const t = sde.getType(r.typeId);
      const weight = r.categoryKey === "reactions" && caldariInputs.has(r.typeId) ? PREFER_CALDARI_REACTIONS : 1;
      // 0 = Caldari hulls; 1 = what dilutes them (rigs, reactions, other Caldari items); 2 = the rest.
      const caldariShip = !!t && isCaldariBranchShip(t);
      const filler = r.categoryKey.startsWith("rigs") || r.categoryKey === "reactions" || t?.raceId === RACE_CALDARI;
      const tier = !req.caldariShipsFirst ? 0 : caldariShip ? 0 : filler ? 1 : 2;
      const bp = recipe(r.typeId)?.blueprintTypeId;
      return sizeRoutes(r, cad, horizon, req.minBatchProfit, bp ? ownedIdx.get(bp)?.bpcRuns : undefined).map((s) => ({ r, ...s, weight, tier }));
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
  for (const { r, route, runs, decryptorId, weight, tier, maxBatches } of top) {
    const key = `${r.typeId}:${route}${maxBatches !== undefined ? `:${runs}` : ""}`;
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
      candidates.push({ ...batch, key, weight, tier, maxBatches: maxBatches ?? (owned && !owned.isBpo ? owned.copies : undefined) });
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
    maxItemShare: req.maxItemShare,
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

  const stages = stagesFor(plan, calcs, horizon);

  const sheet = candidates
    .map((b) => {
      const r = rows.get(b.typeId)!;
      const days = Math.round(slotDays(b, cad) * 10) / 10;
      const c = calcs.get(b.key ?? String(b.typeId));
      return {
        name: b.name + (c?.request.blueprintSource === "invention" ? " (инвент)" : b.key?.split(":").length === 3 ? ` (свой BPC на ${b.runs} ран.)` : " (свой чертёж)"),
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
    stages: stages.stages,
    stock: stages.stock,
    sheet,
    computedMs: Date.now() - t0,
  };
}

/**
 * Stages of the plan: all batches merged, what is in the stock hangars taken off (built
 * components and bought materials), plus datacores and decryptors for invention.
 */
function stagesFor(plan: Plan, calcs: Map<string, CalcResponse>, horizonDays: number): { stages: Stages; stock: PlanResponse["stock"] } {
  const { source: sde } = getSde();
  const s = getSettings();
  const recipes = new Map<number, StageRecipe>();
  const buy = new Map<number, StageBuyInfo>();
  const extra = new Map<number, number>();
  const note = new Map<number, string>();
  // Invented BPCs per route: attempts are an expectation over all of them (like EVE Guru), not per BPC.
  const invented = new Map<string, { c: CalcResponse; bpcs: number }>();
  for (const b of plan.batches) {
    const key = b.key ?? String(b.typeId);
    const c = calcs.get(key);
    if (!c) continue;
    for (const n of c.nodes) {
      if (n.decision !== "build" || !n.job || n.job.runs <= 0 || recipes.has(n.typeId)) continue;
      const isProduct = n.typeId === c.product.typeId;
      recipes.set(n.typeId, {
        typeId: n.typeId,
        name: n.name,
        activity: n.job.activity,
        outputPerRun: n.job.outputPerRun,
        secondsPerRun: n.job.timeSeconds / n.job.runs,
        inputs: n.children.map((ch) => ({ typeId: ch.typeId, perRun: ch.quantity / n.job!.runs, base: ch.baseQuantity })),
        me: n.job.me,
        materialMultiplier: n.job.materialMultiplier,
        // Components and reactions must be ready inside the plan: split what is longer than the horizon.
        maxJobSeconds: isProduct ? undefined : horizonDays * 86_400,
        maxRunsPerJob: isProduct ? undefined : sde.getBlueprint(n.job.blueprintTypeId)?.maxProductionLimit || undefined,
      });
    }
    for (const l of c.shopping) {
      if (buy.has(l.typeId)) continue;
      buy.set(l.typeId, { typeId: l.typeId, name: l.name, unitPrice: l.cost === null || !l.quantity ? null : l.cost / l.quantity, volume: l.quantity ? l.volume / l.quantity : 0 });
    }
    if (c.request.blueprintSource === "invention" && c.invention.chosen) {
      const cur = invented.get(key) ?? { c, bpcs: 0 };
      cur.bpcs++;
      invented.set(key, cur);
    }
  }

  const owned = ownedBlueprintIndex();
  const copies: NonNullable<Stages["blueprints"]> = [];
  for (const { c, bpcs } of invented.values()) {
    const ch = c.invention.chosen!;
    const attempts = Math.ceil(bpcs / Math.max(ch.chance, 0.01) - 1e-9);
    const add = (id: number, q: number, why: string) => {
      extra.set(id, (extra.get(id) ?? 0) + q);
      note.set(id, why);
    };
    for (const m of sde.getBlueprint(ch.sourceId)?.activities.invention?.materials ?? []) add(m.typeId, m.quantity * attempts, "инвент");
    if (c.invention.decryptor) add(c.invention.decryptor.typeId, attempts, "инвент");
    // The source is used up by every attempt: a relic is bought, a T1 blueprint needs one copy per attempt.
    const src = sde.getType(ch.sourceId);
    if (src?.categoryId === CATEGORY_BLUEPRINT) {
      const o = owned.get(ch.sourceId);
      copies.push({ typeId: ch.sourceId, name: src.name, copies: attempts, forItem: c.product.name, how: o?.isBpo ? "copy" : "buy" });
    } else add(ch.sourceId, attempts, "реликт");
  }

  const missing = [...extra.keys()].filter((id) => !buy.has(id));
  const prices = priceBook(missing, s.priceLocationId);
  for (const id of missing) {
    const t = sde.getType(id);
    buy.set(id, { typeId: id, name: t?.name ?? `#${id}`, unitPrice: quotePrice(prices.quote(id), s.materialPriceMode), volume: t ? t.packagedVolume ?? t.volume : 0 });
  }
  const st = stockIndex();
  const stages = planStages({
    products: plan.jobs.filter((j) => j.depth === 0).map((j) => ({ typeId: j.typeId, runs: j.runs })),
    recipes,
    buy,
    stock: st.stock,
    extraBuy: [...extra.entries()].map(([typeId, quantity]) => ({ typeId, quantity, note: note.get(typeId) ?? "инвент" })),
  });
  stages.blueprints = copies.sort((a, b) => a.how.localeCompare(b.how) || b.copies - a.copies);
  return { stages, stock: { locations: st.locations, syncedAt: st.syncedAt, owners: st.owners, types: st.stock.size } };
}

/** SDE category of blueprints (and nothing else): a T1 invention source, not a relic. */
const CATEGORY_BLUEPRINT = 9;

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


// ---- last plan --------------------------------------------------------------

const LAST_PLAN = () => path.resolve("data/last-plan.json");

/** Keeps the last plan on disk (data/ is local and never committed). Tests use an in-memory DB and skip it. */
export function rememberPlan(p: PlanResponse & { text: string; computedAt: string }): void {
  if (process.env.PG_APP_DB === ":memory:") return;
  try {
    fs.mkdirSync(path.dirname(LAST_PLAN()), { recursive: true });
    fs.writeFileSync(LAST_PLAN(), JSON.stringify(p));
  } catch {
    /* not critical */
  }
}

export function lastPlan(): (PlanResponse & { text: string; computedAt: string }) | null {
  try {
    return JSON.parse(fs.readFileSync(LAST_PLAN(), "utf8"));
  } catch {
    return null;
  }
}
