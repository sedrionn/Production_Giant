"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Калькулятор" },
  { href: "/overview", label: "Что выгодно" },
  { href: "/plan", label: "План недели" },
  { href: "/plan/stages", label: "Этапы" },
  { href: "/ledger", label: "Учёт" },
  { href: "/characters", label: "Персонажи" },
  { href: "/presets", label: "Структуры и настройки" },
];

/** Top menu with the current page marked: the longest link that matches the path wins. */
export function NavLinks() {
  const path = usePathname() ?? "/";
  const current = LINKS.filter((l) => (l.href === "/" ? path === "/" : path === l.href || path.startsWith(l.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <>
      {LINKS.map((l) => {
        const on = l.href === current;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={on ? "page" : undefined}
            className={on ? "border-b-2 border-marker pb-0.5 text-chalk" : "border-b-2 border-transparent pb-0.5 text-graphite hover:text-chalk"}
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
