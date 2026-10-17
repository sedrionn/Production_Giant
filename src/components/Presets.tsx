"use client";

import { useEffect, useState } from "react";
import type { AppSettings } from "@/db/seed";
import type { RigScope } from "@/engine/bonuses";
import type { RigRule } from "@/engine/facility";
import type { Activity, Decryptor } from "@/engine/types";
import { Search } from "./ItemSearch";

interface Profile {
  id?: number;
  name: string;
  structureType: string;
  security: string;
  rigs: RigRule[];
  solarSystemId: number | null;
  systemName?: string | null;
  facilityTax: number;
  systemJobBonus: number;
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
const SCOPES: [RigScope, string][] = [
  ["ships", "корабли"],
  ["components", "компоненты"],
  ["capital_components", "капитальные компоненты"],
  ["structures", "структуры"],
  ["equipment", "модули, дроны, патроны"],
  ["fuel", "топливо"],
  ["all", "всё"],
];
const RIG_ACTIVITIES: [Activity, string][] = [
  ["manufacturing", "производство"],
  ["reaction", "реакции"],
  ["invention", "инвент"],
  ["copying", "копирование"],
];
/** Starting points; base values must be checked against Show Info → Attributes on the rig. */
const STD_SECURITY = { high: 1, low: 1.9, null: 2.1 };
const THUKKER = { high: 0.1, low: 1.9, null: 0.1 };
const RIG_TEMPLATES: { label: string; rule: RigRule; extra?: RigRule[] }[] = [
  {
    label: "XL Thukker Structure & Component",
    rule: { name: "Standup XL-Set Thukker Structure and Component Manufacturing Efficiency I", activity: "manufacturing", scopes: ["components", "structures"], material: 0.02, time: 0.2, security: THUKKER },
    extra: [{ name: "Thukker: капитальные компоненты", activity: "manufacturing", scopes: ["capital_components"], material: 0.037, time: 0.2, security: THUKKER }],
  },
  { label: "XL Ship Manufacturing", rule: { name: "Standup XL-Set Ship Manufacturing Efficiency I", activity: "manufacturing", scopes: ["ships"], material: 0.02, time: 0.2 } },
  { label: "XL Structure & Component", rule: { name: "Standup XL-Set Structure and Component Manufacturing Efficiency I", activity: "manufacturing", scopes: ["components", "structures"], material: 0.02, time: 0.2 } },
  { label: "XL Equipment & Consumable", rule: { name: "Standup XL-Set Equipment and Consumable Manufacturing Efficiency I", activity: "manufacturing", scopes: ["equipment", "fuel"], material: 0.02, time: 0.2 } },
  {
    label: "XL Lab Optimization",
    rule: { name: "Standup XL-Set Laboratory Optimization I", activity: "invention", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 },
    extra: [{ name: "Standup XL-Set Laboratory Optimization I", activity: "copying", scopes: ["all"], material: 0, time: 0.2, cost: 0.1 }],
  },
  {
    label: "L Reactor Efficiency II",
    rule: { name: "Standup L-Set Reactor Efficiency II", activity: "reaction", scopes: ["all"], material: 0.024, time: 0.24, security: { high: 0, low: 1, null: 1.1 } },
  },
  { label: "Риг реакций", rule: { name: "", activity: "reaction", scopes: ["all"], material: 0.02, time: 0 } },
  { label: "Свой риг", rule: { name: "", activity: "manufacturing", scopes: ["all"], material: 0, time: 0 } },
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
            setEditing({ name: "", structureType: "sotiyo", security: "null", rigs: [], solarSystemId: null, facilityTax: 0, systemJobBonus: 0, isDefault: false })
          }
          className="rounded bg-marker px-3 py-1.5 font-medium text-ink hover:bg-marker/90"
        >
          Добавить структуру
        </button>
      </div>
      <p className="max-w-[70ch] text-graphite">
        Система нужна для cost index: без неё стоимость джоб считается только из налогов. Каждый риг действует на свою работу и
        свои группы предметов, как в игре.
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
            {p.systemJobBonus > 0 && <span className="text-gain">скидка системы −{Math.round(p.systemJobBonus * 100)}%</span>}
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
  if (!p.rigs.length) return "без ригов";
  return `${p.rigs.length} ${p.rigs.length === 1 ? "риг" : p.rigs.length < 5 ? "рига" : "ригов"}`;
}

const pctIn = (v: number) => +(v * 100).toFixed(3);

function ProfileForm({ initial, onSave, onCancel, error }: { initial: Profile; onSave: (p: Profile) => void; onCancel: () => void; error: string | null }) {
  const [p, setP] = useState<Profile>(initial);
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  const setRig = (i: number, patch: Partial<RigRule>) => set({ rigs: p.rigs.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const templates = RIG_TEMPLATES.filter((t) => (isRefinery(p.structureType) ? t.rule.activity === "reaction" || !t.rule.name : t.rule.activity !== "reaction"));

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
          <select value={p.structureType} onChange={(e) => set({ structureType: e.target.value })} className={input}>
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
        <L label="Скидка системы на джобы, %">
          <input
            type="number"
            step="1"
            min={0}
            max={100}
            value={+(p.systemJobBonus * 100).toFixed(2)}
            onChange={(e) => set({ systemJobBonus: Math.min(100, Math.max(0, Number(e.target.value))) / 100 })}
            className={input}
          />
          <span className="block text-xs text-graphite">Например, бонус ФВ. Уменьшает часть джобы от cost index.</span>
        </L>
        <L label="Система">
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

      <fieldset className="space-y-3">
        <legend className="text-sm text-graphite">Риги</legend>
        <p className="max-w-[75ch] text-sm text-graphite">
          Бонусы и множители зон вводи как в игре: Show Info → Attributes у самого рига. Приложение берёт множитель зоны
          структуры. Группы предметов смотри в описании рига.
        </p>
        {p.rigs.map((r, i) => (
          <div key={i} className="space-y-2 rounded border border-line bg-ink/40 px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <L label="Риг" className="min-w-[16rem] flex-1">
                <input value={r.name ?? ""} onChange={(e) => setRig(i, { name: e.target.value })} placeholder="Название рига" className={input} />
              </L>
              <L label="Работа">
                <select value={r.activity} onChange={(e) => setRig(i, { activity: e.target.value as Activity })} className={input}>
                  {RIG_ACTIVITIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </L>
              <L label="Материалы, %" className="w-28">
                <input type="number" step="0.1" min={0} max={50} value={pctIn(r.material)} onChange={(e) => setRig(i, { material: Number(e.target.value) / 100 })} className={input} />
              </L>
              <L label="Время, %" className="w-28">
                <input type="number" step="1" min={0} max={50} value={pctIn(r.time)} onChange={(e) => setRig(i, { time: Number(e.target.value) / 100 })} className={input} />
              </L>
              <L label="Стоимость, %" className="w-28">
                <input type="number" step="1" min={0} max={50} value={pctIn(r.cost ?? 0)} onChange={(e) => setRig(i, { cost: Number(e.target.value) / 100 })} className={input} />
              </L>
              <button type="button" onClick={() => set({ rigs: p.rigs.filter((_, k) => k !== i) })} className="pb-2 text-graphite hover:text-loss">
                Убрать
              </button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {SCOPES.map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-[var(--marker)]"
                    checked={r.scopes.includes(v)}
                    onChange={(e) => setRig(i, { scopes: e.target.checked ? [...r.scopes, v] : r.scopes.filter((x) => x !== v) })}
                  />
                  {l}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-graphite">
              Множители зон
              {(["high", "low", "null"] as const).map((z) => (
                <label key={z} className="flex items-center gap-1.5 whitespace-nowrap">
                  {z === "high" ? "хай" : z === "low" ? "лоу" : "нули/ВХ"}
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={5}
                    value={r.security?.[z] ?? STD_SECURITY[z]}
                    onChange={(e) => setRig(i, { security: { ...STD_SECURITY, ...r.security, [z]: Number(e.target.value) } })}
                    className={`${input} w-20`}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-graphite">Добавить:</span>
          {templates.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() =>
                set({ rigs: [...p.rigs, ...[t.rule, ...(t.extra ?? [])].map((r) => ({ ...r, scopes: [...r.scopes], security: r.security && { ...r.security } }))] })
              }
              className="rounded px-2 py-1 text-chalk ring-1 ring-line hover:ring-marker"
            >
              {t.label}
            </button>
          ))}
        </div>
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
  const [decryptors, setDecryptors] = useState<Decryptor[]>([]);
  const [hiddenNames, setHiddenNames] = useState<Record<number, string>>({});
  useEffect(() => {
    fetch("/api/blacklist")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items: { typeId: number; name: string }[] }) => setHiddenNames(Object.fromEntries(b.items.map((i) => [i.typeId, i.name]))))
      .catch(() => {});
    fetch("/api/settings").then((r) => r.json()).then(setS).catch(() => {});
    fetch("/api/decryptors").then((r) => (r.ok ? r.json() : [])).then(setDecryptors).catch(() => {});
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
      <p className="max-w-[70ch] text-graphite">Скиллы отсюда используются, пока не добавлены персонажи. Потом берутся реальные уровни из ESI.</p>
      <div className="grid gap-4 rounded border border-line bg-sheet/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
        {pctField("Налог с продаж, %", "salesTax")}
        {pctField("Брокерская комиссия, %", "brokerFee")}
        <L label="Строить компонент, если выгода от, ISK/ч">
          <input
            type="number"
            step={10000}
            min={0}
            value={s.minBuildIskPerHour}
            onChange={(e) => set({ minBuildIskPerHour: Math.max(0, Math.round(Number(e.target.value))) })}
            className={input}
          />
        </L>
        {lvl("Длина джобы в обзоре, дней", s.targetJobDays, (n) => set({ targetJobDays: Math.max(1, n) }), 30)}
        <L label="Доставка материалов на завод, ISK/м³">
          <input type="number" min={0} step={10} value={s.freightInPerM3} onChange={(e) => set({ freightInPerM3: Math.max(0, Number(e.target.value)) })} className={input} />
        </L>
        <L label="Доставка продукта на рынок, ISK/м³">
          <input type="number" min={0} step={10} value={s.freightOutPerM3} onChange={(e) => set({ freightOutPerM3: Math.max(0, Number(e.target.value)) })} className={input} />
        </L>
        <L label="Свои BPC в расчёте">
          <select value={s.ownBpcValue} onChange={(e) => set({ ownBpcValue: e.target.value as AppSettings["ownBpcValue"] })} className={input}>
            <option value="free">бесплатные (уже оплачены)</option>
            <option value="invention">по стоимости инвента</option>
          </select>
        </L>
        <L label="Декриптор для инвента">
          <select
            value={s.inventionDecryptorId ?? ""}
            onChange={(e) => set({ inventionDecryptorId: e.target.value ? Number(e.target.value) : null })}
            className={input}
          >
            <option value="">Без декриптора</option>
            {decryptors.map((d) => (
              <option key={d.typeId} value={d.typeId}>
                {d.name.replace(" Decryptor", "")} (×{d.probabilityMultiplier}, ME {signed(d.me)}, TE {signed(d.te)}, раны {signed(d.runs)})
              </option>
            ))}
          </select>
        </L>
        {lvl("ME чертежей компонентов", s.defaultMe, (n) => set({ defaultMe: n }), 10)}
        {lvl("TE чертежей компонентов", s.defaultTe, (n) => set({ defaultTe: n }), 20)}
        {lvl("Industry", s.industrySkills.industry, (n) => set({ industrySkills: { ...s.industrySkills, industry: n } }))}
        {lvl("Advanced Industry", s.industrySkills.advancedIndustry, (n) => set({ industrySkills: { ...s.industrySkills, advancedIndustry: n } }))}
        {lvl("Reactions", s.industrySkills.reactions, (n) => set({ industrySkills: { ...s.industrySkills, reactions: n } }))}
        {lvl("Скиллы из требований чертежа", s.industrySkills.blueprintSkills, (n) => set({ industrySkills: { ...s.industrySkills, blueprintSkills: n } }))}
        {lvl("Encryption Methods", s.inventionSkills.encryption, (n) => set({ inventionSkills: { ...s.inventionSkills, encryption: n } }))}
        {lvl("Наука 1 (инвент)", s.inventionSkills.science1, (n) => set({ inventionSkills: { ...s.inventionSkills, science1: n } }))}
        {lvl("Наука 2 (инвент)", s.inventionSkills.science2, (n) => set({ inventionSkills: { ...s.inventionSkills, science2: n } }))}
      </div>
      <div className="space-y-2 rounded border border-line bg-sheet/60 px-4 py-4">
        <h3 className="font-display text-xl font-semibold">Блэклист</h3>
        <p className="text-sm text-graphite">Скрыто из обзора и плана недели. Отдельные предметы скрываются кнопкой «скрыть» в строке обзора.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ["boosters", "Бустеры (делаются только в нулях)"],
              ["triglavian", "Триглавское"],
              ["edencom", "EDENCOM"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--marker)]" checked={s.blacklist[k]} onChange={(e) => set({ blacklist: { ...s.blacklist, [k]: e.target.checked } })} />
              {label}
            </label>
          ))}
        </div>
        {s.blacklist.typeIds.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-sm">
            {s.blacklist.typeIds.map((id) => (
              <li key={id} className="flex items-center gap-1.5 rounded border border-line px-2 py-0.5">
                {hiddenNames[id] ?? `#${id}`}
                <button
                  onClick={() => set({ blacklist: { ...s.blacklist, typeIds: s.blacklist.typeIds.filter((x) => x !== id) } })}
                  className="text-graphite hover:text-marker"
                  aria-label={`Вернуть ${hiddenNames[id] ?? id}`}
                  title="Вернуть (сохранится кнопкой ниже)"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button onClick={save} className="rounded bg-marker px-4 py-1.5 font-medium text-ink hover:bg-marker/90">
        {saved ? "Сохранено" : "Сохранить настройки"}
      </button>
    </section>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

const input = "w-full rounded border border-line bg-ink px-2 py-1.5 focus:border-marker focus:outline-none";

function L({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-sm text-graphite">{label}</span>
      {children}
    </label>
  );
}
