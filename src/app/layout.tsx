import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Production Giant",
  description: "Personal EVE Online industry planner",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
