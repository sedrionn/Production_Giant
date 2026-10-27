"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { LoginSheet } from "@/server/loginSheet";
import type { SavedLogin } from "@/server/savedPlan";
import { ago, duration, full, isk, qty } from "@/lib/format";
import { BuyList } from "./BuyList";
import { CopyName } from "./CopyName";
import { useOnRefreshed } from "./FullRefresh";

/** One page for a login: deliver, start, sell, fix orders, buy. */
export function LoginSheetView() {
  const [sheet, setSheet] = useState<LoginSheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (day?: number) => {
    try {
      const r = await fetch(`/api/plan/login${day === undefined ? "" : `?day=${day}`}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setSheet(b.sheet);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Fresh data after "Обновить всё" in the header.
  useOnRefreshed(useCallback(() => { load(sheet?.logins[sheet.current]?.day); }, [sheet, load]));

  if (error) return <p className="rounded border border-loss/50 bg-loss/10 px-4 py-3 text-loss">{error}</p>;
  if (!sheet) return <p className="text-graphite">Загружаю…</p>;

  const login = sheet.logins[sheet.current];
  const next = sheet.logins[sheet.current + 1];
  const dateOf = (day: number) =>
    sheet.plan ? new Date(Date.parse(sheet.plan.createdAt) + day * 86_400_000).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }) : "";
  const sellValue = sheet.sell.reduce((s, x) => s + (x.price ?? 0) * x.quantity, 0);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-3xl font-semibold">Заход</h1>
        </div>
        <p className="text-graphite">
          {sheet.plan ? (
            <>
              План «{sheet.plan.title}», сегодня день {Math.floor(sheet.planDay)} из {sheet.plan.horizonDays}. Данные из игры {ago(sheet.syncedAt)}.
            </>
          ) : (
            <>
              Сохранённого плана нет: составь его на <Link className="text-marker" href="/plan">«Плане недели»</Link> и нажми «Запускаю этот план». Ниже — то, что видно из игры.
            </>
          )}
        </p>
        {sheet.plan?.rampUp && (
          <p className="rounded border border-marker/50 bg-marker/10 px-3 py-2 text-sm">
            Разгон: на этой неделе корпусов нет, ставятся компоненты и реакции под следующую неделю. Со следующей недели конвейер идёт на полную.
          </p>
        )}
        {sheet.logins.length > 1 && (
          <div className="flex flex-wrap gap-2 text-sm">
            {sheet.logins.map((l, i) => (
              <button
                key={l.day}
                onClick={() => load(l.day)}
                className={`rounded border px-2 py-0.5 ${i === sheet.current ? "border-marker text-marker" : "border-line text-graphite hover:text-chalk"}`}
              >
                день {l.day} · {dateOf(l.day)}
              </button>
            ))}
          </div>
        )}
      </section>

      <Block title="1. Сдать готовые джобы" empty="Готовых джоб нет.">
        {sheet.deliver.map((d) => (
          <li key={d.owner}>
            <span className="text-marker">{d.owner}</span> — {d.items.map((x) => `${x.name} × ${qty(x.runs)}${x.jobs > 1 ? ` (${x.jobs} джоб)` : ""}`).join(", ")}
          </li>
        ))}
      </Block>

      <section className="space-y-2">
        <h2 className="font-display text-2xl font-semibold">2. Поставить{login ? ` (день ${login.day} по плану)` : ""}</h2>
        <p className="text-sm text-graphite">
          Свободно сейчас:{" "}
          {sheet.slots
            .map((s) => `${s.owner} — производство ${s.manufacturing.total - s.manufacturing.busy}, реакции ${s.reaction.total - s.reaction.busy}, лаборатории ${s.science.total - s.science.busy}`)
            .join(" · ") || "нет персонажей"}
          . Готовые, но не сданные джобы слот ещё держат: сначала сдай.
        </p>
        {login ? <Starts login={login} /> : <p className="text-graphite">По плану в этот заход ставить нечего.</p>}
      </section>

      <Block title={`3. Продать${sellValue ? ` (~${isk(sellValue)} по Jita)` : ""}`} empty="Готовых корпусов из плана в ангарах нет.">
        {sheet.sell.map((x) => (
          <li key={x.typeId}>
            <CopyName name={x.name} /> × {qty(x.quantity)}
            {x.price !== null && (
              <span className="text-graphite" title={full(x.price)}>
                {" "}
                — по {isk(x.price)}, всего {isk(x.price * x.quantity)}
              </span>
            )}
          </li>
        ))}
      </Block>

      <Block title="4. Перебитые ордера в Jita" empty="Твои ордера никто не перебил.">
        {sheet.undercut.map((o) => (
          <li key={o.orderId}>
            <CopyName name={o.name} /> — {o.isBuy ? "покупка" : "продажа"} по {isk(o.myPrice)}, лучшая {isk(o.bestPrice)}, осталось {qty(o.volumeRemain)}
          </li>
        ))}
      </Block>

      {sheet.plan && sheet.plan.nextWeek.length > 0 && (
        <p className="text-sm text-graphite">
          <span className="text-job">Заготовка под следующую неделю:</span> компоненты и реакции этой недели идут на{" "}
          {sheet.plan.nextWeek.map((x) => `${x.name} × ${qty(x.runs)}${x.batches > 1 ? ` (${x.batches} партии)` : ""}`).join(", ")}. Корпуса поставишь по плану следующей недели.
        </p>
      )}
      {sheet.plan && sheet.plan.carried.length > 0 && (
        <p className="text-sm text-graphite">
          Не влезло в неделю, перейдёт в следующий план: {sheet.plan.carried.map((x) => `${x.name} × ${qty(x.runs)} (${x.jobs} джоб)`).join(", ")}.
        </p>
      )}

      {next && (
        <p className="text-sm text-graphite">
          Следующий заход — день {next.day} ({dateOf(next.day)}): {next.finish.length ? `забрать ${summarize(next.finish)}` : "забирать нечего"}
          {next.start.length ? `, поставить ${summarize(next.start)}` : ""}.
        </p>
      )}

      {sheet.buy && (
        <BuyList stages={sheet.buy} stockNote={<span>5. Закупка всего плана, как она была при сохранении. Что уже куплено, отметь сам.</span>} />
      )}
    </div>
  );
}

function Block({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-2">
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      {children.length ? <ul className="space-y-0.5">{children}</ul> : <p className="text-graphite">{empty}</p>}
    </section>
  );
}

const PREP: Record<string, string> = {
  copying: "Копии T1 (лаборатория)",
  invention: "Инвент (лаборатория)",
  manufacturing: "Компоненты",
  reaction: "Реакции",
};

function Starts({ login }: { login: SavedLogin }) {
  const owners = new Map<string, SavedLogin["start"]>();
  for (const j of login.start) owners.set(j.owner, [...(owners.get(j.owner) ?? []), j]);
  const prep = ["copying", "invention", "reaction", "manufacturing"].map((a) => [a, login.prep.filter((p) => p.activity === a)] as const).filter(([, x]) => x.length);
  return (
    <ul className="space-y-0.5">
      {[...owners.entries()].map(([owner, jobs]) => (
        <li key={owner}>
          <span className="text-marker">{owner}</span> — {summarize(jobs)}
        </li>
      ))}
      {prep.map(([a, items]) => (
        <li key={a}>
          <span className="text-job">{PREP[a]}:</span>{" "}
          {items.map((p) => `${p.name.replace(" (инвент)", "")} × ${qty(p.runs)}${p.jobs > 1 ? ` (${p.jobs} джоб по ~${duration(p.seconds / p.jobs)})` : ` (${duration(p.seconds)})`}`).join(", ")}
        </li>
      ))}
    </ul>
  );
}

function summarize(jobs: { name: string; runs: number; part?: { index: number; of: number } }[]): string {
  const m = new Map<string, { runs: number; jobs: number }>();
  for (const j of jobs) {
    const name = j.part ? `${j.name} (часть ${j.part.index} из ${j.part.of})` : j.name;
    const x = m.get(name) ?? { runs: 0, jobs: 0 };
    x.runs += j.runs;
    x.jobs++;
    m.set(name, x);
  }
  return [...m.entries()].map(([n, x]) => `${n} × ${qty(x.runs)}${x.jobs > 1 ? ` (${x.jobs} джоб)` : ""}`).join(", ");
}
