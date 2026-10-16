/** Compact ISK: 945 → "945", 12 400 → "12.4k", 1 234 567 → "1.23M", 2.5e9 → "2.50B". */
export function isk(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const a = Math.abs(n);
  const body =
    a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` :
    a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M` :
    a >= 1e4 ? `${(a / 1e3).toFixed(1)}k` :
    a >= 100 ? a.toFixed(0) :
    a.toFixed(2);
  return sign + body;
}

export function full(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ISK";
}

export function qty(n: number): string {
  return n.toLocaleString("ru-RU");
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  return `${m}м`;
}

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
