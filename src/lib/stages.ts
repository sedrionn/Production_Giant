import type { Stages } from "@/engine/stages";

/** "Этап 1: реакции" … deepest first; depth 0 is the products. */
export function stageName(s: Pick<Stages["stages"][number], "depth" | "lines">, maxDepth: number): string {
  const n = maxDepth - s.depth + 1;
  const what =
    s.depth === 0
      ? "корпуса и готовые предметы"
      : s.lines.every((l) => l.activity === "reaction")
        ? "реакции"
        : s.lines.some((l) => l.activity === "reaction")
          ? "компоненты и реакции"
          : "компоненты";
  return `Этап ${n}: ${what}`;
}
