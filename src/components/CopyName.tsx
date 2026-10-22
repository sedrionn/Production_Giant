"use client";

import { useState } from "react";

/** Small icon-only button that copies an item name (to paste into the in-game search). */
export function CopyName({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const label = copied ? "Скопировано" : `Скопировать «${name}»`;
  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      aria-label={label}
      className={`mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded align-[-3px] hover:text-marker focus-visible:outline focus-visible:outline-2 focus-visible:outline-marker ${copied ? "text-gain" : "text-graphite"}`}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
        </svg>
      )}
    </button>
  );
}
