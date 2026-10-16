"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ago } from "@/lib/format";

interface Char {
  characterId: number;
  name: string;
  corporationId: number | null;
  lastSyncAt: string | null;
  lastSyncNotes: string[];
  skills: number;
  blueprints: number;
  jobs: number;
}
interface Bp {
  blueprintTypeId: number;
  name: string;
  productId: number | null;
  me: number;
  te: number;
  isBpo: boolean;
  runs: number;
  copies: number;
}
interface Data {
  ssoReady: boolean;
  characters: Char[];
  blueprints: Bp[];
}

const SCOPES = [
  "esi-skills.read_skills.v1",
  "esi-characters.read_blueprints.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-assets.read_assets.v1",
  "esi-corporations.read_blueprints.v1",
  "esi-industry.read_corporation_jobs.v1",
  "esi-assets.read_corporation_assets.v1",
];

export function Characters() {
  const [data, setData] = useState<Data | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [industryChar, setIndustryChar] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/characters");
    setData(await r.json());
  }, []);

  useEffect(() => {
    load();
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setIndustryChar(s.industryCharacterId ?? null))
      .catch(() => {});
    const q = new URLSearchParams(window.location.search);
    if (q.get("added")) setBanner({ ok: true, text: `Добавлен ${q.get("added")}, данные синхронизированы.` });
    if (q.get("error")) setBanner({ ok: false, text: q.get("error")! });
    if (q.get("added") || q.get("error")) window.history.replaceState(null, "", "/characters");
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/characters/sync", { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      const failed = (body as { error?: string; name: string }[]).filter((x) => x.error);
      setBanner(
        failed.length
          ? { ok: false, text: `Не синхронизировались: ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}` }
          : { ok: true, text: "Синхронизировано." },
      );
      await load();
    } catch (e) {
      setBanner({ ok: false, text: `ESI недоступен: ${(e as Error).message}` });
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (c: Char) => {
    if (!window.confirm(`Удалить ${c.name} из приложения? Чертежи и скиллы этого персонажа пропадут из расчётов.`)) return;
    await fetch(`/api/characters?id=${c.characterId}`, { method: "DELETE" });
    await load();
  };

  const chooseIndustry = async (v: string) => {
    const id = v ? Number(v) : null;
    setIndustryChar(id);
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ industryCharacterId: id }) });
  };

  const bps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.blueprints ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [data, filter]);

  if (!data) return null;

  return (
    <div className="mx-auto max-w-[1100px] space-y-10 px-4 py-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="font-display text-4xl font-semibold tracking-wide">Персонажи</h1>
          <div className="flex gap-3">
            {data.characters.length > 0 && (
              <button onClick={sync} disabled={syncing} className="rounded px-3 py-2 text-chalk ring-1 ring-line hover:ring-marker disabled:opacity-50">
                {syncing ? "Синхронизирую…" : "Синхронизировать всех"}
              </button>
            )}
            {data.ssoReady && (
              // Full navigation: the SSO flow leaves the app and comes back to /api/auth/callback.
              <a href="/api/auth/login" className="rounded bg-marker px-3 py-2 font-medium text-ink hover:bg-marker/90">
                Добавить персонажа
              </a>
            )}
          </div>
        </div>

        {banner && (
          <p className={`rounded border px-4 py-3 ${banner.ok ? "border-gain/50 bg-gain/10" : "border-loss/50 bg-loss/10 text-loss"}`}>{banner.text}</p>
        )}

        {!data.ssoReady && <SsoSetup />}

        {data.characters.length > 0 && (
          <>
            <ul className="divide-y divide-line rounded border border-line bg-sheet/60">
              {data.characters.map((c) => (
                <li key={c.characterId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=64`} alt="" width={40} height={40} className="rounded" />
                  <span className="min-w-[10rem] font-medium">{c.name}</span>
                  <span className="text-graphite">
                    {c.skills} скиллов, {c.blueprints} чертежей, {c.jobs} джоб
                  </span>
                  <span className="text-graphite">синхр. {ago(c.lastSyncAt)}</span>
                  <button onClick={() => remove(c)} className="ml-auto text-graphite hover:text-loss">
                    Удалить
                  </button>
                  {c.lastSyncNotes.length > 0 && <p className="w-full text-sm text-marker">{c.lastSyncNotes.join(". ")}</p>}
                </li>
              ))}
            </ul>
            <label className="flex flex-wrap items-center gap-3">
              <span className="text-graphite">Скиллы для расчёта времени и инвента</span>
              <select
                value={industryChar ?? ""}
                onChange={(e) => chooseIndustry(e.target.value)}
                className="rounded border border-line bg-sheet px-2 py-1.5 focus:border-marker focus:outline-none"
              >
                <option value="">лучший уровень среди всех персонажей</option>
                {data.characters.map((c) => (
                  <option key={c.characterId} value={c.characterId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </section>

      {data.blueprints.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="font-display text-3xl font-semibold">Чертежи ({data.blueprints.length})</h2>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Фильтр"
              className="w-64 rounded border border-line bg-sheet px-3 py-1.5 focus:border-marker focus:outline-none"
            />
          </div>
          <p className="text-graphite">Лучший экземпляр каждого чертежа среди персонажей и корпорации: BPO важнее BPC, потом выше ME.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] whitespace-nowrap text-left">
              <thead className="border-b border-line text-sm text-graphite">
                <tr>
                  <th className="py-2 pr-4 font-normal">Чертёж</th>
                  <th className="py-2 pr-4 font-normal">Тип</th>
                  <th className="py-2 pr-4 text-right font-normal">ME / TE</th>
                  <th className="py-2 pr-4 text-right font-normal">Раны</th>
                  <th className="py-2 text-right font-normal">Экземпляров</th>
                </tr>
              </thead>
              <tbody>
                {bps.map((b) => (
                  <tr key={b.blueprintTypeId} className="border-b border-line/40 hover:bg-sheet/70">
                    <td className="py-1.5 pr-4">
                      {b.productId ? (
                        <Link href={`/?typeId=${b.productId}&name=${encodeURIComponent(b.name.replace(/ (Blueprint|Reaction Formula)$/, ""))}&runs=${b.isBpo ? 10 : b.runs}`} className="hover:text-marker">
                          {b.name}
                        </Link>
                      ) : (
                        b.name
                      )}
                    </td>
                    <td className="py-1.5 pr-4 text-graphite">{b.isBpo ? "BPO" : "BPC"}</td>
                    <td className="py-1.5 pr-4 text-right">
                      {b.me} / {b.te}
                    </td>
                    <td className="py-1.5 pr-4 text-right text-graphite">{b.isBpo ? "∞" : b.runs}</td>
                    <td className="py-1.5 text-right text-graphite">{b.copies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function SsoSetup() {
  return (
    <div className="space-y-3 rounded border border-marker/50 bg-sheet px-5 py-4">
      <h2 className="font-display text-2xl">Один раз: зарегистрируй приложение в EVE</h2>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Открой{" "}
          <a href="https://developers.eveonline.com/applications" target="_blank" rel="noreferrer" className="text-marker underline">
            developers.eveonline.com/applications
          </a>{" "}
          и создай приложение (Create new application).
        </li>
        <li>Тип: «Authentication &amp; API Access».</li>
        <li>
          Callback URL: <code className="rounded bg-ink px-1.5 py-0.5">http://localhost:3000/api/auth/callback</code>
        </li>
        <li>
          Скоупы (Permissions):
          <code className="mt-1 block whitespace-pre-wrap rounded bg-ink px-2 py-1.5 text-sm">{SCOPES.join("\n")}</code>
        </li>
        <li>
          В корне проекта создай файл <code className="rounded bg-ink px-1.5 py-0.5">.env.local</code>:
          <code className="mt-1 block whitespace-pre rounded bg-ink px-2 py-1.5 text-sm">{"EVE_CLIENT_ID=твой_client_id\nEVE_CLIENT_SECRET=твой_secret"}</code>
        </li>
        <li>Перезапусти <code className="rounded bg-ink px-1.5 py-0.5">npm run dev</code> и обнови эту страницу.</li>
      </ol>
    </div>
  );
}
