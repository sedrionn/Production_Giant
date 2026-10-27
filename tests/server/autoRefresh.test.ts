import { describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

describe("Обновить всё", () => {
  it("runs every step in order; a failed step is shown and the rest still run; the plan is rebuilt with the stored form", async () => {
    const { runFullRefresh, REFRESH_STEPS } = await import("@/server/autoRefresh");
    const { storePlanForm, parsePlanForm } = await import("@/server/planForm");
    const { getSettings } = await import("@/server/data");
    storePlanForm(parsePlanForm({ categories: ["reactions"], pins: [] }));
    const calls: string[] = [];
    const t: import("@/server/tasks").TaskState = { id: "x", label: "full-refresh", phase: "", done: 0, total: 0, failed: 0, startedAt: "", finishedAt: null, error: null };
    let planned = 0;
    await runFullRefresh(t, {
      syncAll: async () => (calls.push("chars"), [{ characterId: 1, name: "Тест", error: "токен отозван" }]),
      refreshGlobal: async () => {
        calls.push("global");
        throw new Error("ESI 503");
      },
      refreshQuotes: async () => (calls.push("quotes"), { quotes: 1, failed: [] }),
      refreshVolumes: async () => (calls.push("volumes"), { volumes: 1, failed: [] }),
      refreshScope: () => ({ priceTypes: [34], products: [] }),
      ledgerPriceTypes: () => [],
      buildPlan: ((req: { horizonDays: number }) => {
        planned = req.horizonDays;
        throw new Error("не важно");
      }) as never,
    });
    expect(calls).toEqual(["chars", "global", "quotes", "volumes"]);
    expect(t.steps!.map((s) => s.name)).toEqual([...REFRESH_STEPS]);
    expect(t.steps!.map((s) => s.status)).toEqual(["error", "error", "done", "done", "error"]);
    expect(t.steps![0].error).toBe("Тест: токен отозван");
    expect(t.steps![1].error).toBe("ESI 503");
    expect(planned).toBe(7);
    expect(t.failed).toBe(3);
    expect(getSettings().lastAutoRefreshAt).not.toBeNull();
  });
});
