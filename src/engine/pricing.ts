import { MARKET } from "./bonuses";

/**
 * Which side of the order book a price comes from.
 *  - "buy":   highest buy order  (you place buy orders for materials / sell instantly into buy orders)
 *  - "sell":  lowest sell order  (you buy instantly from sell orders / list your product as a sell order)
 *  - "split": midpoint of the two
 */
export type PriceMode = "buy" | "sell" | "split";

export interface MarketQuote {
  typeId: number;
  buyMax: number | null;
  sellMin: number | null;
  buyVolume?: number;
  sellVolume?: number;
}

export function quotePrice(q: MarketQuote | undefined, mode: PriceMode): number | null {
  if (!q) return null;
  if (mode === "buy") return q.buyMax;
  if (mode === "sell") return q.sellMin;
  if (q.buyMax !== null && q.sellMin !== null) return (q.buyMax + q.sellMin) / 2;
  return q.buyMax ?? q.sellMin;
}

export interface FeeRates {
  /** Fraction, e.g. 0.03375 */
  salesTax: number;
  /** Fraction, e.g. 0.015 */
  brokerFee: number;
}

/**
 * Fee rules (documented in docs/decisions.md):
 * Acquiring materials
 *   - "sell":  take from sell orders  → no fee
 *   - "buy" / "split": you place a buy order → broker fee
 * Selling the product
 *   - "buy":   sell into buy orders → sales tax only
 *   - "sell" / "split": you place a sell order → sales tax + broker fee
 */
export function acquisitionFeeRate(mode: PriceMode, fees: FeeRates): number {
  return mode === "sell" ? 0 : fees.brokerFee;
}

export function saleFeeRate(mode: PriceMode, fees: FeeRates): number {
  return mode === "buy" ? fees.salesTax : fees.salesTax + fees.brokerFee;
}

export function salesTaxFromSkills(accountingLevel: number): number {
  return MARKET.salesTaxBase * (1 - MARKET.accountingReductionPerLevel * accountingLevel);
}

export function brokerFeeFromSkills(brokerRelations: number, factionStanding = 0, corpStanding = 0): number {
  return Math.max(
    0,
    MARKET.brokerFeeBase -
      MARKET.brokerRelationsPerLevel * brokerRelations -
      MARKET.factionStandingFactor * factionStanding -
      MARKET.corpStandingFactor * corpStanding,
  );
}

/** When a buy order is worth suggesting instead of buying from sell orders. UX choices, not game rules. */
export const BUY_ORDER = {
  /** Order (with broker fee) at least this much cheaper than buying now. */
  minSaving: 0.05,
  /** …and at least this many ISK on the line. */
  minIsk: 1_000_000,
  /** Skip when the order would take longer than this to fill at the usual daily volume. */
  maxDays: 7,
} as const;

export interface BuyOrderAdvice {
  /** Price to bid (the best buy order now). */
  price: number;
  /** ISK saved against buying from sell orders now, broker fee included. */
  saving: number;
  /** Days to fill at the 30-day average volume (null = no history). */
  days: number | null;
}

/**
 * Should this line be bought with a buy order? Only for materials priced at sell orders (an order
 * pays the broker fee and waits). Null when the spread is too thin, the sum too small or it fills too slowly.
 */
export function buyOrderAdvice(q: MarketQuote | undefined, quantity: number, fees: FeeRates, avgDailyVolume?: number | null): BuyOrderAdvice | null {
  if (!q || q.buyMax === null || q.sellMin === null || quantity <= 0) return null;
  const now = q.sellMin * quantity;
  const order = q.buyMax * (1 + fees.brokerFee) * quantity;
  const saving = now - order;
  if (saving < BUY_ORDER.minIsk || saving < now * BUY_ORDER.minSaving) return null;
  const days = avgDailyVolume && avgDailyVolume > 0 ? quantity / avgDailyVolume : null;
  if (days !== null && days > BUY_ORDER.maxDays) return null;
  return { price: q.buyMax, saving, days };
}
