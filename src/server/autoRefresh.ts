/**
 * "Обновить всё" (the button in the header) and the daily refresh while the app runs, one function:
 * characters (skills, blueprints, jobs, assets, wallet, transactions, orders, contracts) → adjusted
 * prices and cost indices → Jita prices and traded volumes → the weekly plan again with the stored
 * form. A step that fails is shown on the button; the next steps still run.
 */
import { CATEGORIES } from "./catalog";
import { priceTypesFor } from "./calculate";
import { syncAll } from "./characters";
import { getSettings, saveSettings } from "./data";
import { ledgerPriceTypes } from "./ledger";
import { refreshScope } from "./overview";
import { buildPlan, rememberPlan, sheetText } from "./plan";
import { planRequestOf, storedPlanForm } from "./planForm";
import { refreshGlobal, refreshQuotes, refreshVolumes } from "./refreshPrices";
import { startTask, type TaskState } from "./tasks";

export const FULL_REFRESH_LABEL = "full-refresh";

export const REFRESH_STEPS = ["Персонажи", "Индексы и adjusted prices", "Цены Jita", "Объёмы продаж", "Пересчёт плана"] as const;

/** Runs one step: marks it, catches its error (or the partial failure it reports) and goes on. */
async function step(t: TaskState, i: number, run: () => Promise<string | void>): Promise<void> {
  const s = t.steps![i];
  s.status = "running";
  t.phase = s.name.toLowerCase();
  t.done = 0;
  t.total = 0;
  try {
    const partial = await run();
    s.status = partial ? "error" : "done";
    if (partial) s.error = partial;
  } catch (e) {
    s.status = "error";
    s.error = (e as Error).message;
  }
  if (s.status === "error") t.failed++;
}

export async function runFullRefresh(t: TaskState, deps: Partial<RefreshDeps> = {}): Promise<void> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const s = getSettings();
  t.steps = REFRESH_STEPS.map((name) => ({ name, status: "pending" }));
  const progress = (done: number, total: number) => {
    t.done = done;
    t.total = total;
  };

  await step(t, 0, async () => {
    const bad = (await d.syncAll()).flatMap((c) => ("error" in c ? [`${c.name}: ${c.error}`] : []));
    return bad.join("; ");
  });
  await step(t, 1, async () => {
    await d.refreshGlobal();
  });

  // Everything the overview categories, the ledger and the pins need.
  const priceTypes = new Set<number>(d.ledgerPriceTypes());
  const products = new Set<number>();
  for (const c of CATEGORIES) {
    try {
      const scope = d.refreshScope(c.key);
      for (const id of scope.priceTypes) priceTypes.add(id);
      for (const id of scope.products) products.add(id);
    } catch {
      /* a category that cannot be listed (e.g. no characters for "mine") */
    }
  }
  const form = storedPlanForm();
  for (const p of form?.pins ?? []) {
    products.add(p.typeId);
    try {
      for (const id of priceTypesFor(p.typeId)) priceTypes.add(id);
    } catch {
      /* no recipe */
    }
  }

  await step(t, 2, async () => {
    const q = await d.refreshQuotes([...priceTypes], s.priceRegionId, s.priceLocationId, progress);
    if (q.failed.length) return `не обновились ${q.failed.length} из ${priceTypes.size}`;
  });
  await step(t, 3, async () => {
    const v = await d.refreshVolumes([...products], s.priceRegionId, progress);
    if (v.failed.length) return `не обновились ${v.failed.length} из ${products.size}`;
  });
  await step(t, 4, async () => {
    // Only a plan Nick has made at least once: the form is stored with it.
    if (!form) return;
    const plan = d.buildPlan(planRequestOf(form));
    rememberPlan({ ...plan, text: sheetText(plan), computedAt: new Date().toISOString() });
  });
  saveSettings({ lastAutoRefreshAt: new Date().toISOString() });
  t.phase = "готово";
}

/** What the refresh calls (ESI and the planner); tests replace them. */
export interface RefreshDeps {
  syncAll: typeof syncAll;
  refreshGlobal: typeof refreshGlobal;
  refreshQuotes: typeof refreshQuotes;
  refreshVolumes: typeof refreshVolumes;
  refreshScope: typeof refreshScope;
  ledgerPriceTypes: typeof ledgerPriceTypes;
  buildPlan: typeof buildPlan;
}
const DEFAULT_DEPS: RefreshDeps = { syncAll, refreshGlobal, refreshQuotes, refreshVolumes, refreshScope, ledgerPriceTypes, buildPlan };

export function startFullRefresh(): TaskState {
  return startTask(FULL_REFRESH_LABEL, (t) => runFullRefresh(t));
}

/** Due when never run or older than the configured interval. */
export function refreshDue(now = Date.now()): boolean {
  const { autoRefreshHours, lastAutoRefreshAt } = getSettings();
  if (!autoRefreshHours) return false;
  return !lastAutoRefreshAt || now - Date.parse(lastAutoRefreshAt) >= autoRefreshHours * 3_600_000;
}

const g = globalThis as unknown as { __pgAutoRefresh?: NodeJS.Timeout };

/** Checks hourly; started once per server process from instrumentation.ts. */
export function scheduleAutoRefresh(): void {
  if (g.__pgAutoRefresh) return;
  const tick = () => {
    try {
      if (refreshDue()) startFullRefresh();
    } catch (e) {
      console.error("[auto-refresh]", e);
    }
  };
  setTimeout(tick, 60_000); // let the server warm up first
  g.__pgAutoRefresh = setInterval(tick, 3_600_000);
}
