import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mis Finanzas — Ingresos y Gastos",
  description: "Registra tus ingresos y gastos diarios y analízalos por semana, mes y año.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100">
        <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-black/90 backdrop-blur">
          <nav className="mx-auto max-w-5xl flex items-center justify-between px-4 py-3">
            <Link href="/" className="font-extrabold text-lg tracking-tight">
              💰 <span className="text-emerald-600">Mis</span>Finanzas
            </Link>
            <div className="flex gap-2">
              <Link
                href="/"
                className="px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Inicio
              </Link>
              <Link
                href="/analisis"
                className="px-4 py-2 rounded-full text-sm font-medium bg-zinc-900 text-white dark:bg-white dark:text-black hover:opacity-90"
              >
                📊 Análisis
              </Link>
            </div>
          </nav>
        </header>
        <div className="flex-1 w-full">{children}</div>
        <footer className="text-center text-xs text-zinc-500 py-6">
          Tus datos se guardan localmente en este servidor · SQLite + Next.js
        </footer>
      </body>
    </html>
  );
}
