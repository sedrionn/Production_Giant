/**
 * The weekly plan form (budget, rhythm, categories, pins) lives in the app DB: pins stay until
 * Nick removes them, and "Обновить всё" can rebuild the plan with the same form.
 */
import { PLAN_HORIZON_DAYS } from "@/engine/planner";
import type { CategoryKey } from "./catalog";
import { getSettings, saveSettings } from "./data";
import type { PlanPin, PlanRequest } from "./plan";

/** What the plan page sends and stores: the request plus the pin names for display. */
export type PlanForm = Omit<PlanRequest, "pins" | "horizonDays"> & { pins: (PlanPin & { name: string })[] };

export const DEFAULT_CATEGORIES: CategoryKey[] = ["caldari_t1", "caldari_t2", "t3", "rigs_t1", "rigs_t2", "reactions", "warp_disruptors"];

const num = (v: unknown, dflt: number) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? dflt : Number(v));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parsePin(p: unknown): (PlanPin & { name: string }) | null {
  if (!p || typeof p !== "object") return null;
  const x = p as Record<string, unknown>;
  const typeId = Math.trunc(num(x.typeId, 0));
  if (typeId <= 0) return null;
  // Older forms pinned batches; a batch count becomes a unit count (the plan rounds up to whole BPCs anyway).
  const units = Math.max(1, Math.trunc(num(x.units ?? x.batches, 1)));
  const d = x.decryptor;
  const decryptor: PlanPin["decryptor"] = d === "none" ? "none" : typeof d === "number" && d > 0 ? Math.trunc(d) : typeof d === "string" && Number(d) > 0 ? Math.trunc(Number(d)) : "auto";
  const source: PlanPin["source"] = x.source === "owned" || x.source === "invention" ? x.source : "auto";
  return { typeId, units, decryptor, source, name: typeof x.name === "string" ? x.name : `#${typeId}` };
}

/** Validates whatever the page (or an old stored form) sends. */
export function parsePlanForm(body: unknown): PlanForm {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const categories = Array.isArray(b.categories) && b.categories.length ? (b.categories.filter((c) => typeof c === "string") as CategoryKey[]) : DEFAULT_CATEGORIES;
  return {
    budget: Math.max(0, num(b.budget, 10e9)),
    cadenceDays: clamp(num(b.cadenceDays, 2), 1, 7),
    categories,
    marketShare: clamp(num(b.marketShare, 0.3), 0.05, 1),
    minBatchProfit: Math.max(0, num(b.minBatchProfit, 30e6)),
    caldariShipsFirst: b.caldariShipsFirst !== false,
    maxItemShare: clamp(num(b.maxItemShare, 0.2), 0.05, 1),
    stockFirst: b.stockFirst !== false,
    fillIdleReactions: b.fillIdleReactions !== false,
    buyWeeks: clamp(Math.round(num(b.buyWeeks, 1)), 1, 8),
    maxReactionJobDays: clamp(num(b.maxReactionJobDays, 2), 0, 28),
    maxManufacturingJobDays: clamp(num(b.maxManufacturingJobDays, 7), 0, 28),
    pins: (Array.isArray(b.pins) ? b.pins : []).map(parsePin).filter((p): p is PlanPin & { name: string } => !!p),
  };
}

/** The request the planner gets: the week is always 7 days. */
export const planRequestOf = (f: PlanForm): PlanRequest => ({
  ...f,
  horizonDays: PLAN_HORIZON_DAYS,
  pins: f.pins.map(({ typeId, units, decryptor, source }) => ({ typeId, units, decryptor, source })),
});

export function storedPlanForm(): PlanForm | null {
  const f = getSettings().planForm;
  return f ? parsePlanForm(f) : null;
}

export function storePlanForm(f: PlanForm): void {
  saveSettings({ planForm: f as unknown as Record<string, unknown> });
}
