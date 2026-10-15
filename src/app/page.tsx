import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openAppDb } from "@/db/client";
import { structureProfiles } from "@/db/schema";

export const dynamic = "force-dynamic";

function sdeStatus(): { ok: boolean; text: string } {
  const file = path.resolve("data/sde.sqlite");
  if (!fs.existsSync(file)) return { ok: false, text: "нет data/sde.sqlite — запусти npm run sde:download" };
  const db = new Database(file, { readonly: true });
  try {
    const build = db.prepare("SELECT value FROM sde_meta WHERE key='build'").get() as { value: string } | undefined;
    const n = db.prepare("SELECT COUNT(*) n FROM sde_blueprints").get() as { n: number };
    return { ok: true, text: `build ${build?.value ?? "?"}, ${n.n.toLocaleString("ru-RU")} чертежей` };
  } finally {
    db.close();
  }
}

function fixturesStatus(): { ok: boolean; text: string } {
  const file = path.resolve("fixtures/sde/subset.json");
  if (!fs.existsSync(file)) return { ok: false, text: "нет fixtures — запусти npm run fixtures:capture" };
  const meta = JSON.parse(fs.readFileSync(file, "utf8")).meta as { capturedAt: string };
  return { ok: true, text: `сняты ${meta.capturedAt.slice(0, 16).replace("T", " ")}` };
}

export default function Home() {
  const sde = sdeStatus();
  const fixtures = fixturesStatus();
  const profiles = openAppDb().select().from(structureProfiles).all();

  const Row = ({ label, s }: { label: string; s: { ok: boolean; text: string } }) => (
    <div className="flex items-baseline justify-between gap-6 border-b border-border py-3">
      <span className="text-muted">{label}</span>
      <span className={s.ok ? "text-ok" : "text-bad"}>{s.text}</span>
    </div>
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <p className="text-xs uppercase tracking-[0.2em] text-accent">Production Giant · этап 1a</p>
      <h1 className="mt-2 text-3xl font-semibold">Состояние</h1>
      <p className="mt-2 text-muted">Калькулятор появится на этапе 1c. Пока — проверка, что данные на месте.</p>

      <section className="mt-10 rounded-lg border border-border bg-surface px-5">
        <Row label="SDE" s={sde} />
        <Row label="Фикстуры" s={fixtures} />
        <div className="py-3">
          <span className="text-muted">Пресеты структур</span>
          <ul className="mt-2 space-y-1 font-mono text-sm">
            {profiles.map((p) => (
              <li key={p.id}>
                {p.name} <span className="text-muted">— {p.structureType}, {p.security}{p.isDefault ? ", по умолчанию" : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
