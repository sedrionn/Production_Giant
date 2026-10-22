/**
 * Market sanity: the price a product really sells for, not the speculators' wall.
 *
 * sell_min in Jita can be one order on an illiquid item (Capital Algid Energy Administrations Unit II:
 * 220M with 0 trades in 30 days) or a raised wall (Small Explosive Shield Reinforcer II: 19.9M against
 * 1.56M traded). The reference is the regional market history; the order book is capped by it.
 * Material prices are never replaced (you pay what is on the market): they only get flags.
 */
import { quotePrice, type MarketQuote, type PriceMode } from "./pricing";

/** Thresholds: UX choices, not game constants. Defaults; Nick can change them in the settings. */
export const MARKET_SANITY = {
  /** Days with trades in the last 7 for the 7-day VWAP to be the reference. */
  minDays7: 4,
  /** Fewer days with trades in the last 30 = no market: the product sells only into buy orders. */
  minDaysTraded30: 10,
  /** The product price may be at most this much above the reference (0.15 = +15%). */
  maxPremium: 0.15,
  /** sell_min above reference × this = flagged as a spike. */
  spikeRatio: 1.5,
  /** sell_min / buy_max above this = flagged as a wide spread. */
  maxSpread: 3,
} as const;

export type MarketSanityConfig = { -readonly [K in keyof typeof MARKET_SANITY]: number };

/** Region market history, aggregated (see volumeStats). */
export interface MarketHistory {
  vwap7d: number | null;
  vwap30d: number | null;
  /** Median of the daily averages over the days with trades in the last 30. */
  median30d: number | null;
  daysTraded7d: number;
  daysTraded30d: number;
}

export type SanityFlag =
  | { kind: "no_market"; label: string }
  | { kind: "spike"; label: string; ratio: number }
  | { kind: "wide_spread"; label: string; ratio: number }
  | { kind: "not_for_sale"; label: string };

export interface RealisticPrice {
  /** Price to count revenue with (null = no price at all). */
  price: number | null;
  /** What the order book alone gives in this mode. */
  raw: number | null;
  /** Reference from history; null = none. */
  ref: number | null;
  /** false = no history loaded yet: the raw price is used as is. */
  checked: boolean;
  flags: SanityFlag[];
}

/** Reference price from history: 7-day VWAP when traded often enough, else 30-day VWAP, else the median. */
export function referencePrice(h: MarketHistory, cfg: MarketSanityConfig = MARKET_SANITY): number | null {
  if (h.vwap7d !== null && h.daysTraded7d >= cfg.minDays7) return h.vwap7d;
  return h.vwap30d ?? h.median30d;
}

const times = (r: number) => `×${r >= 100 ? r.toFixed(0) : r.toFixed(1)}`;

function spreadFlag(q: MarketQuote | undefined, cfg: MarketSanityConfig): SanityFlag[] {
  if (!q || q.sellMin === null || !q.buyMax) return [];
  const ratio = q.sellMin / q.buyMax;
  return ratio > cfg.maxSpread ? [{ kind: "wide_spread", label: `широкий спред ${times(ratio)}`, ratio }] : [];
}

/**
 * Sale price of a product. `history` undefined/null = not loaded yet (no check, raw price).
 *  - no market (traded on fewer than minDaysTraded30 days, or no reference): buy_max (0 without buy orders);
 *  - sell: min(sell_min, ref × (1 + maxPremium)); an empty sell side lists at ref;
 *  - buy: min(buy_max, ref × (1 + maxPremium));
 *  - split: middle of buy_max and the realistic sell.
 */
export function realisticPrice(
  quote: MarketQuote | undefined,
  history: MarketHistory | null | undefined,
  mode: PriceMode,
  cfg: MarketSanityConfig = MARKET_SANITY,
): RealisticPrice {
  const raw = quotePrice(quote, mode);
  if (!history) return { price: raw, raw, ref: null, checked: false, flags: [] };
  const ref = referencePrice(history, cfg);
  const buyMax = quote?.buyMax ?? null;
  const sellMin = quote?.sellMin ?? null;
  const flags = spreadFlag(quote, cfg);

  if (ref === null || history.daysTraded30d < cfg.minDaysTraded30) {
    const label = `нет рынка: сделки ${history.daysTraded30d} дн. из 30`;
    return { price: buyMax ?? 0, raw, ref, checked: true, flags: [{ kind: "no_market", label }, ...flags] };
  }
  const cap = ref * (1 + cfg.maxPremium);
  if (sellMin !== null && sellMin > ref * cfg.spikeRatio) {
    const ratio = sellMin / ref;
    flags.unshift({ kind: "spike", label: `цена выше истории ${times(ratio)}`, ratio });
  }
  const sell = sellMin === null ? ref : Math.min(sellMin, cap);
  const buy = buyMax === null ? null : Math.min(buyMax, cap);
  const price = mode === "sell" ? sell : mode === "buy" ? buy : buy === null ? sell : (buy + sell) / 2;
  return { price, raw, ref, checked: true, flags };
}

/**
 * Flags for a material you buy (its price is NOT replaced): not on sale, or priced far above history.
 * Without history only "not on sale" can be told.
 */
export function materialFlags(
  quote: MarketQuote | undefined,
  history: MarketHistory | null | undefined,
  mode: PriceMode,
  cfg: MarketSanityConfig = MARKET_SANITY,
): SanityFlag[] {
  const price = quotePrice(quote, mode);
  if (price === null) return [{ kind: "not_for_sale", label: "нет в продаже" }];
  const ref = history ? referencePrice(history, cfg) : null;
  if (ref !== null && price > ref * cfg.spikeRatio) {
    const ratio = price / ref;
    return [{ kind: "spike", label: `дороже истории ${times(ratio)}`, ratio }];
  }
  return [];
}
