import type { RealisticPrice } from "@/engine/marketSanity";
import { isk } from "./format";

/** One line on why the sale price differs from the order book (empty when it does not). */
export function saleNote(check: Omit<RealisticPrice, "price">, price: number | null): string {
  if (!check.checked) return "истории рынка нет: цена из стакана как есть (обнови объёмы)";
  const parts = [`в стакане ${isk(check.raw)}`, `по истории ${isk(check.ref)}`];
  if (price !== check.raw) parts.push(`считаю ${isk(price)}`);
  const why = check.flags.map((f) => f.label).join(", ");
  return price === check.raw && !why ? "" : `${parts.join(", ")}${why ? ` (${why})` : ""}`;
}
