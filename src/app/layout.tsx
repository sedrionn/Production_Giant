import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Production Giant",
  description: "Личный планировщик производства EVE Online",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@500;600&display=swap"
        />
      </head>
      <body className="antialiased">
        <header className="border-b border-line bg-ink/90">
          <nav className="mx-auto flex max-w-[1400px] items-baseline gap-6 px-4 py-3">
            <Link href="/" className="font-display text-xl font-semibold tracking-wide text-chalk">
              Production Giant
            </Link>
            <Link href="/" className="text-graphite hover:text-chalk">
              Калькулятор
            </Link>
            <Link href="/overview" className="text-graphite hover:text-chalk">
              Что выгодно
            </Link>
            <Link href="/presets" className="text-graphite hover:text-chalk">
              Структуры и настройки
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
