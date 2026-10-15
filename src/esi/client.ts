/**
 * Minimal public-ESI client (no auth yet — SSO comes in stage 2).
 * Node or server side only. Not reachable from cloud sessions.
 */
import type { EsiIndustrySystem, EsiMarketOrder, EsiMarketPrice } from "./types";

export const ESI_BASE = "https://esi.evetech.net/latest";
export const USER_AGENT = "production-giant (personal EVE industry tool; github.com/sedrionn/production_giant)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EsiError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`ESI ${status} ${url}: ${body.slice(0, 200)}`);
  }
}

async function esiFetch(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  // Error-limit protection: ESI bans clients that keep erroring.
  const remain = Number(res.headers.get("x-esi-error-limit-remain") ?? 100);
  const reset = Number(res.headers.get("x-esi-error-limit-reset") ?? 0);
  if (remain < 10 && reset > 0) await sleep(reset * 1000);
  if ((res.status === 420 || res.status >= 500) && attempt < 3) {
    await sleep(1000 * 2 ** attempt);
    return esiFetch(url, attempt + 1);
  }
  if (!res.ok) throw new EsiError(res.status, url, await res.text());
  return res;
}

function buildUrl(path: string, params: Record<string, string | number> = {}): string {
  const u = new URL(ESI_BASE + path);
  u.searchParams.set("datasource", "tranquility");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

export async function esiGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  return (await esiFetch(buildUrl(path, params))).json() as Promise<T>;
}

/** Follows X-Pages pagination and concatenates arrays. */
export async function esiGetAllPages<T>(path: string, params: Record<string, string | number> = {}): Promise<T[]> {
  const first = await esiFetch(buildUrl(path, { ...params, page: 1 }));
  const pages = Number(first.headers.get("x-pages") ?? 1);
  const out = (await first.json()) as T[];
  for (let p = 2; p <= pages; p++) out.push(...(await esiGet<T[]>(path, { ...params, page: p })));
  return out;
}

export const getMarketPrices = () => esiGet<EsiMarketPrice[]>("/markets/prices/");
export const getIndustrySystems = () => esiGet<EsiIndustrySystem[]>("/industry/systems/");
export const getRegionOrders = (regionId: number, typeId: number) =>
  esiGetAllPages<EsiMarketOrder>(`/markets/${regionId}/orders/`, { order_type: "all", type_id: typeId });

/** Runs `fn` over items with bounded concurrency (be nice to ESI). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
