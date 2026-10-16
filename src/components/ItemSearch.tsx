"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface Picked {
  id: number;
  name: string;
}

/** Autocomplete over an API that returns [{ <idKey>, name }]. */
export function Search({
  endpoint,
  idKey,
  placeholder,
  value,
  onPick,
  className = "",
}: {
  endpoint: string;
  idKey: string;
  placeholder: string;
  value: Picked | null;
  onPick: (p: Picked) => void;
  className?: string;
}) {
  const [q, setQ] = useState(value?.name ?? "");
  const [items, setItems] = useState<Picked[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setQ(value?.name ?? ""), [value]);

  useEffect(() => {
    if (q.trim().length < 2 || q === value?.name) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${endpoint}?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((rows: Record<string, unknown>[]) => {
          setItems(rows.map((r) => ({ id: r[idKey] as number, name: r.name as string })));
          setActive(0);
          setOpen(true);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, endpoint, idKey, value?.name]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (p: Picked) => {
    onPick(p);
    setQ(p.name);
    setOpen(false);
  };

  return (
    <div ref={box} className={`relative ${className}`}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={(e) => {
          e.target.select();
          if (items.length) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || !items.length) return;
          if (e.key === "Escape") return setOpen(false);
          if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
          e.preventDefault();
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
          if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          if (e.key === "Enter") pick(items[active]);
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="w-full rounded border border-line bg-sheet px-3 py-2 text-chalk placeholder:text-graphite/70 focus:border-marker focus:outline-none"
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded border border-line bg-sheet-2 py-1 shadow-xl shadow-black/40">
          {items.map((it, i) => (
            <li
              key={it.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), pick(it))}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? "bg-line/60 text-chalk" : "text-graphite"}`}
            >
              {it.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
