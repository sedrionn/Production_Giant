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
