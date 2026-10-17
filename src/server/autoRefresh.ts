/**
 * Daily full refresh while the app runs: characters (skills, blueprints, jobs, wallet),
 * then prices and traded volumes for every overview category and everything the ledger watches.
 * The manual buttons stay; this only saves Nick from pressing them.
 */
import { CATEGORIES } from "./catalog";
import { syncAll } from "./characters";
import { getSettings, saveSettings } from "./data";
import { ledgerPriceTypes } from "./ledger";
import { refreshScope } from "./overview";
import { refreshGlobal, refreshQuotes, refreshVolumes } from "./refreshPrices";
import { startTask, type TaskState } from "./tasks";

export const FULL_REFRESH_LABEL = "full-refresh";

export async function runFullRefresh(t: TaskState): Promise<void> {
  const s = getSettings();
  t.phase = "персонажи";
  const chars = await syncAll().catch(() => []);
  t.failed += chars.filter((c) => "error" in c).length;

  t.phase = "собираю список";
  const priceTypes = new Set<number>(ledgerPriceTypes());
  const products = new Set<number>();
  for (const c of CATEGORIES) {
    try {
      const scope = refreshScope(c.key);
      for (const id of scope.priceTypes) priceTypes.add(id);
      for (const id of scope.products) products.add(id);
    } catch {
      /* a category that cannot be listed (e.g. no characters for "mine") */
    }
  }

  t.phase = "индексы и adjusted prices";
  await refreshGlobal();
  t.phase = "цены Jita";
  const q = await refreshQuotes([...priceTypes], s.priceRegionId, s.priceLocationId, (d, n) => {
    t.done = d;
    t.total = n;
  });
  t.failed += q.failed.length;
  t.phase = "объёмы продаж";
  const v = await refreshVolumes([...products], s.priceRegionId, (d, n) => {
    t.done = d;
    t.total = n;
  });
  t.failed += v.failed.length;
  saveSettings({ lastAutoRefreshAt: new Date().toISOString() });
  t.phase = "готово";
}

export function startFullRefresh(): TaskState {
  return startTask(FULL_REFRESH_LABEL, runFullRefresh);
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
