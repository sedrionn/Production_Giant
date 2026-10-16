"use client";

import { useEffect, useState } from "react";
import type { AppSettings } from "@/db/seed";
import type { RigTier } from "@/engine/bonuses";
import type { RigSetup } from "@/engine/facility";
import { Search } from "./ItemSearch";

interface Profile {
  id?: number;
  name: string;
  structureType: string;
  security: string;
  rigs: Record<string, RigSetup>;
  solarSystemId: number | null;
  systemName?: string | null;
  facilityTax: number;
  isDefault: boolean;
}

const STRUCTURES = [
  ["sotiyo", "Sotiyo"],
  ["azbel", "Azbel"],
  ["raitaru", "Raitaru"],
  ["tatara", "Tatara (реакции)"],
  ["athanor", "Athanor (реакции)"],
  ["npc_station", "NPC-станция"],
] as const;
const SECURITY = [
  ["high", "хайсек"],
  ["low", "лоусек"],
  ["null", "нули / ВХ"],
] as const;
const TIERS: [RigTier, string][] = [
  ["none", "нет"],
  ["t1", "T1"],
  ["t2", "T2"],
];
const isRefinery = (t: string) => t === "tatara" || t === "athanor";

export function Presets() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/profiles").then((r) => r.json()).then(setProfiles).catch(() => {});
  }, []);

  const save = async (p: Profile) => {
    const r = await fetch("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
    const body = await r.json();
    if (!r.ok) return setError(body.error);
    setProfiles(body);
    setEditing(null);
    setError(null);
  };

  const remove = async (id: number) => {
    const r = await fetch(`/api/profiles?id=${id}`, { method: "DELETE" });
    if (r.ok) setProfiles(await r.json());
  };

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-3xl font-semibold">Структуры</h2>
        <button
          onClick={() =>
            setEditing({ name: "", structureType: "sotiyo", security: "null", rigs: {}, solarSystemId: null, facilityTax: 0, isDefault: false })
          }
          className="rounded bg-marker px-3 py-1.5 font-medium text-ink hover:bg-marker/90"
        >
          Добавить структуру
        </button>
      </div>
      <p className="max-w-[70ch] text-graphite">
        Система нужна для cost index: без неё стоимость джоб считается только из налогов. Риги задаются на тип работ: в игре они
        действуют на группы предметов, разбивка по группам будет позже.
      </p>

      <ul className="divide-y divide-line rounded border border-line bg-sheet/60">
        {profiles.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3">
            <span className="min-w-[12rem] font-medium">
              {p.name}
              {p.isDefault && <span className="ml-2 text-sm text-marker">по умолчанию</span>}
            </span>
            <span className="text-graphite">
              {STRUCTURES.find(([v]) => v === p.structureType)?.[1]}, {SECURITY.find(([v]) => v === p.security)?.[1]}
            </span>
            <span className={p.systemName || p.solarSystemId ? "text-graphite" : "text-loss"}>
              {p.systemName ?? (p.solarSystemId ? `система ${p.solarSystemId}` : "система не указана")}
            </span>
            <span className="text-graphite">{rigSummary(p)}</span>
            <span className="text-graphite">налог {(p.facilityTax * 100).toFixed(2)}%</span>
            <span className="ml-auto flex gap-3">
              <button onClick={() => setEditing(p)} className="text-marker hover:underline">
                Изменить
              </button>
              <button onClick={() => p.id && remove(p.id)} className="text-graphite hover:text-loss">
                Удалить
              </button>
            </span>
          </li>
        ))}
      </ul>

      {editing && <ProfileForm initial={editing} onCancel={() => setEditing(null)} onSave={save} error={error} />}
    </section>
  );
}

function rigSummary(p: Profile): string {
  const parts = Object.entries(p.rigs)
    .filter(([, r]) => r.material !== "none" || r.time !== "none")
    .map(([a, r]) => `${a === "reaction" ? "реакции" : a === "manufacturing" ? "произв." : a}: ME ${r.material.toUpperCase()}, TE ${r.time.toUpperCase()}`);
  return parts.length ? parts.join("; ") : "без ригов";
}

function ProfileForm({ initial, onSave, onCancel, error }: { initial: Profile; onSave: (p: Profile) => void; onCancel: () => void; error: string | null }) {
  const [p, setP] = useState<Profile>(initial);
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  const rigActivities = isRefinery(p.structureType) ? (["reaction"] as const) : (["manufacturing", "invention"] as const);
  const setRig = (activity: string, patch: Partial<RigSetup>) =>
    set({ rigs: { ...p.rigs, [activity]: { ...(p.rigs[activity] ?? { material: "none", time: "none" }), ...patch } } });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(p);
      }}
      className="space-y-4 rounded border border-marker/50 bg-sheet px-4 py-4"
    >
      <h3 className="font-display text-2xl">{p.id ? `Изменить «${initial.name}»` : "Новая структура"}</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <L label="Название">
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} required className={input} />
        </L>
        <L label="Тип">
          <select value={p.structureType} onChange={(e) => set({ structureType: e.target.value, rigs: {} })} className={input}>
            {STRUCTURES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </L>
        <L label="Зона">
          <select value={p.security} onChange={(e) => set({ security: e.target.value })} className={input}>
            {SECURITY.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </L>
        <L label="Налог структуры, %">
          <input
            type="number"
            step="0.01"
            min={0}
            max={50}
            value={+(p.facilityTax * 100).toFixed(4)}
            onChange={(e) => set({ facilityTax: Number(e.target.value) / 100 })}
            className={input}
          />
        </L>
        <L label="Система" className="sm:col-span-2">
          <Search
            endpoint="/api/systems"
            idKey="systemId"
            placeholder="Начни вводить название системы"
            value={p.solarSystemId ? { id: p.solarSystemId, name: p.systemName ?? String(p.solarSystemId) } : null}
            onPick={(s) => set({ solarSystemId: s.id, systemName: s.name })}
          />
        </L>
        <label className="flex items-center gap-2 self-end pb-2">
          <input type="checkbox" checked={p.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} className="accent-[var(--marker)]" />
          По умолчанию
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm text-graphite">Риги</legend>
        {rigActivities.map((a) => (
          <div key={a} className="flex flex-wrap items-center gap-4">
            <span className="w-28">{a === "reaction" ? "Реакции" : a === "manufacturing" ? "Производство" : "Инвент"}</span>
            {(["material", "time"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 whitespace-nowrap text-sm text-graphite">
                {k === "material" ? "ME-риг" : "TE-риг"}
                <select value={p.rigs[a]?.[k] ?? "none"} onChange={(e) => setRig(a, { [k]: e.target.value as RigTier })} className={`${input} w-24`}>
                  {TIERS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ))}
      </fieldset>

      {error && <p className="text-loss">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" className="rounded bg-marker px-4 py-1.5 font-medium text-ink hover:bg-marker/90">
          Сохранить
        </button>
        <button type="button" onClick={onCancel} className="rounded px-4 py-1.5 text-graphite ring-1 ring-line hover:text-chalk">
          Отмена
        </button>
      </div>
    </form>
  );
}

export function SettingsForm() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(setS).catch(() => {});
  }, []);
  if (!s) return null;
  const set = (patch: Partial<AppSettings>) => setS({ ...s, ...patch });
  const save = async () => {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    if (r.ok) {
      setS(await r.json());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const pctField = (label: string, key: "salesTax" | "brokerFee") => (
    <L label={label}>
      <input type="number" step="0.001" min={0} max={20} value={+(s[key] * 100).toFixed(4)} onChange={(e) => set({ [key]: Number(e.target.value) / 100 })} className={input} />
    </L>
  );
  const lvl = (label: string, value: number, onChange: (n: number) => void, max = 5) => (
    <L label={label}>
      <input type="number" min={0} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(0, Math.round(Number(e.target.value)))))} className={input} />
    </L>
  );

  return (
    <section className="space-y-4">
      <h2 className="font-display text-3xl font-semibold">Налоги, скиллы, чертежи</h2>
      <p className="max-w-[70ch] text-graphite">Пока задаются вручную. На этапе 2 подтянутся из скиллов персонажей через ESI.</p>
      <div className="grid gap-4 rounded border border-line bg-sheet/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
        {pctField("Налог с продаж, %", "salesTax")}
        {pctField("Брокерская комиссия, %", "brokerFee")}
        {lvl("ME чертежей компонентов", s.defaultMe, (n) => set({ defaultMe: n }), 10)}
        {lvl("TE чертежей компонентов", s.defaultTe, (n) => set({ defaultTe: n }), 20)}
        {lvl("Industry", s.industrySkills.industry, (n) => set({ industrySkills: { ...s.industrySkills, industry: n } }))}
        {lvl("Advanced Industry", s.industrySkills.advancedIndustry, (n) => set({ industrySkills: { ...s.industrySkills, advancedIndustry: n } }))}
        {lvl("Reactions", s.industrySkills.reactions, (n) => set({ industrySkills: { ...s.industrySkills, reactions: n } }))}
        <span />
        {lvl("Encryption Methods", s.inventionSkills.encryption, (n) => set({ inventionSkills: { ...s.inventionSkills, encryption: n } }))}
        {lvl("Наука 1 (инвент)", s.inventionSkills.science1, (n) => set({ inventionSkills: { ...s.inventionSkills, science1: n } }))}
        {lvl("Наука 2 (инвент)", s.inventionSkills.science2, (n) => set({ inventionSkills: { ...s.inventionSkills, science2: n } }))}
      </div>
      <button onClick={save} className="rounded bg-marker px-4 py-1.5 font-medium text-ink hover:bg-marker/90">
        {saved ? "Сохранено" : "Сохранить настройки"}
      </button>
    </section>
  );
}

const input = "w-full rounded border border-line bg-ink px-2 py-1.5 focus:border-marker focus:outline-none";

function L({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-sm text-graphite">{label}</span>
      {children}
    </label>
  );
}
