"use client";

import { useState } from "react";
import type { NodeDTO } from "@/server/calculate";
import type { Decision } from "@/engine/tree";
import { full, isk, qty } from "@/lib/format";

const REASON: Record<string, string> = {
  root: "",
  cheaper: "дешевле",
  "below threshold": "выгода ниже порога",
  override: "вручную",
  "no recipe": "нет чертежа",
  "no market price": "нет на рынке",
  "build unpriced": "нет цен на компоненты",
  cycle: "цикл",
};

export function TreeView({
  nodes,
  rootTypeId,
  onDecide,
}: {
  nodes: NodeDTO[];
  rootTypeId: number;
  onDecide: (typeId: number, d: Decision | null) => void;
}) {
  const byId = new Map(nodes.map((n) => [n.typeId, n]));
  const root = byId.get(rootTypeId);
  const [open, setOpen] = useState<Set<number>>(() => new Set([rootTypeId]));
  if (!root) return null;
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[minmax(18rem,1fr)_7rem_9rem_6.5rem_6.5rem_5rem] gap-3 border-b border-line px-2 pb-2 text-sm text-graphite">
          <span>Предмет</span>
          <span className="text-right">Нужно</span>
          <span>Решение</span>
          <span className="text-right">Купить, шт</span>
          <span className="text-right">Строить, шт</span>
          <span className="text-right">Раны</span>
        </div>
        <ul>
          <Row node={root} quantity={root.demand} depth={0} byId={byId} open={open} toggle={toggle} onDecide={onDecide} path={[]} />
        </ul>
      </div>
    </div>
  );
}

function Row({
  node,
  quantity,
  depth,
  byId,
  open,
  toggle,
  onDecide,
  path,
}: {
  node: NodeDTO;
  quantity: number;
  depth: number;
  byId: Map<number, NodeDTO>;
  open: Set<number>;
  toggle: (id: number) => void;
  onDecide: (typeId: number, d: Decision | null) => void;
  path: number[];
}) {
  const built = node.decision === "build" && node.children.length > 0;
  const isOpen = built && open.has(node.typeId) && !path.includes(node.typeId);
  const canSwitch = depth > 0 && node.activity !== null && node.reason !== "cycle";
  const cheaper =
    node.buildUnitCost !== null && node.buyUnitCost !== null ? (node.buildUnitCost < node.buyUnitCost ? "build" : "buy") : null;

  return (
    <li className={depth ? "relative ml-4 border-l border-dashed border-line pl-3" : ""}>
      {depth > 0 && <span aria-hidden className="absolute top-[1.15rem] left-0 w-2.5 border-t border-dashed border-line" />}
      <div className="grid grid-cols-[minmax(18rem,1fr)_7rem_9rem_6.5rem_6.5rem_5rem] items-center gap-3 rounded px-2 py-1.5 hover:bg-sheet/70">
        <span className="flex min-w-0 items-center gap-2">
          {built ? (
            <button
              onClick={() => toggle(node.typeId)}
              aria-expanded={isOpen}
              aria-label={isOpen ? `Свернуть ${node.name}` : `Развернуть ${node.name}`}
              className="grid size-5 shrink-0 place-items-center rounded border border-line text-xs text-graphite hover:border-marker hover:text-marker"
            >
              {isOpen ? "−" : "+"}
            </button>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}
          <span className={`truncate ${depth === 0 ? "font-semibold" : ""}`} title={node.name}>
            {node.name}
          </span>
          {node.activity === "reaction" && built && <span className="shrink-0 text-xs text-job">реакция</span>}
        </span>
        <span className="text-right">{qty(quantity)}</span>
        <span className="flex items-center gap-2">
          {canSwitch ? (
            <button
              onClick={() => onDecide(node.typeId, node.decision === "build" ? "buy" : "build")}
              onContextMenu={(e) => {
                e.preventDefault();
                onDecide(node.typeId, null);
              }}
              title="Переключить. Правый клик — вернуть авто."
              className={`rounded px-2 py-0.5 text-sm ring-1 transition-colors ${
                node.decision === "build" ? "bg-marker/15 text-marker ring-marker/50" : "text-graphite ring-line hover:text-chalk"
              }`}
            >
              {node.decision === "build" ? "строить" : "купить"}
            </button>
          ) : (
            <span className="px-2 text-sm text-graphite">{depth === 0 ? "строить" : "купить"}</span>
          )}
          {REASON[node.reason] && (
            <span
              className="truncate text-xs text-graphite"
              title={node.buildSavingsPerHour !== null ? `Постройка вместо покупки: ${isk(node.buildSavingsPerHour, true)} ISK за час джобы` : undefined}
            >
              {REASON[node.reason]}
              {node.buildSavingsPerHour !== null && node.buildSavingsPerHour > 0 && `, ${isk(node.buildSavingsPerHour, true)}/ч`}
            </span>
          )}
        </span>
        <span className={`text-right ${cheaper === "buy" ? "text-chalk" : "text-graphite"}`} title={full(node.buyUnitCost)}>
          {isk(node.buyUnitCost)}
        </span>
        <span className={`text-right ${cheaper === "build" ? "text-chalk" : "text-graphite"}`} title={full(node.buildUnitCost)}>
          {node.activity ? isk(node.buildUnitCost) : ""}
        </span>
        <span className="text-right text-graphite">{node.job ? qty(node.job.runs) : ""}</span>
      </div>
      {isOpen && (
        <ul>
          {node.children.map((c) => {
            const child = byId.get(c.typeId);
            return child ? (
              <Row
                key={c.typeId}
                node={child}
                quantity={c.quantity}
                depth={depth + 1}
                byId={byId}
                open={open}
                toggle={toggle}
                onDecide={onDecide}
                path={[...path, node.typeId]}
              />
            ) : null;
          })}
        </ul>
      )}
    </li>
  );
}
