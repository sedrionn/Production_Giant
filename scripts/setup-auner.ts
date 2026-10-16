/**
 * npm run presets:auner — creates/updates presets for the EVEGuru Industrial Park in Auner
 * and makes them the defaults. Safe to re-run: matches presets by name.
 *
 * Sources: structure fit and taxes from the in-game info Nick shared (2026-10-16),
 * Thukker rig attributes from its Show Info, FW −50% from the job cost tooltip.
 * Values marked VERIFY are standard numbers, not yet checked in game.
 */
import { eq } from "drizzle-orm";
import type { RigRule } from "../src/engine/facility";
import { structureProfiles } from "../src/db/schema";
import { getDb, getSde, saveSettings, upsertProfile } from "../src/server/data";

const THUKKER = { high: 0.1, low: 1.9, null: 0.1 };

const SOTIYO_RIGS: RigRule[] = [
  {
    name: "Standup XL-Set Thukker Structure and Component Manufacturing Efficiency I",
    activity: "manufacturing",
    scopes: ["components", "structures"],
    material: 0.02,
    time: 0.2,
    security: THUKKER,
  },
  {
    name: "Thukker: капитальные компоненты (3.7%)",
    activity: "manufacturing",
    scopes: ["capital_components"],
    material: 0.037,
    time: 0.2,
    security: THUKKER,
  },
  // Confirmed in game: −38% job time on Jackdaw = 20% × 1.9.
  { name: "Standup XL-Set Ship Manufacturing Efficiency I", activity: "manufacturing", scopes: ["ships"], material: 0.02, time: 0.2 },
  // Show Info: time −20%, cost −10%, zones 1 / 1.9 / 2.1. Applies to invention, copying and research.
  { name: "Standup XL-Set Laboratory Optimization I", activity: "invention", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 },
  { name: "Standup XL-Set Laboratory Optimization I", activity: "copying", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 },
  { name: "Standup XL-Set Laboratory Optimization I", activity: "research_material", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 },
  { name: "Standup XL-Set Laboratory Optimization I", activity: "research_time", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 },
];

// Show Info: ME −2.4%, time −24%, lowsec ×1, null/WH ×1.1, banned in highsec. Covers all reactions.
const TATARA_RIGS: RigRule[] = [
  {
    name: "Standup L-Set Reactor Efficiency II",
    activity: "reaction",
    scopes: ["all"],
    material: 0.024,
    time: 0.24,
    security: { high: 0, low: 1, null: 1.1 },
  },
];

function main() {
  const sde = getSde();
  if (sde.kind !== "sqlite") throw new Error("Нужен data/sde.sqlite: сначала npm run sde:download");
  const auner = sde.source.searchSystems("Auner", 5).find((s) => s.name === "Auner");
  if (!auner) throw new Error("Система Auner не найдена в SDE: пересобери базу (npm run sde:download -- --force)");

  const byName = (name: string) => getDb().select().from(structureProfiles).where(eq(structureProfiles.name, name)).get();

  const forge = upsertProfile({
    id: byName("Guru Forge (Auner)")?.id,
    name: "Guru Forge (Auner)",
    structureType: "sotiyo",
    security: "low",
    solarSystemId: auner.systemId,
    facilityTax: 0.01, // Manufacturing Plant / Invention Lab / Research Lab: 1%
    systemJobBonus: 0.5, // FW, confirmed in the job cost tooltip
    rigs: SOTIYO_RIGS,
    isDefault: true,
  });

  const foundry = upsertProfile({
    id: byName("Guru Foundry (Auner)")?.id,
    name: "Guru Foundry (Auner)",
    structureType: "tatara",
    security: "low",
    solarSystemId: auner.systemId,
    facilityTax: 0.01, // Biochemical / Composite / Hybrid Reactor: 1% each
    systemJobBonus: 0.5, // FW is system-wide
    rigs: TATARA_RIGS,
    isDefault: false,
  });

  saveSettings({ manufacturingProfileId: forge.id, reactionProfileId: foundry.id });

  console.log(`Auner: system ${auner.systemId}, security ${auner.security?.toFixed(2)}`);
  console.log(`OK: "${forge.name}" (производство, по умолчанию) и "${foundry.name}" (реакции).`);
  console.log("Все риги заведены по Show Info из игры.");
}

main();
