import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header";
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
      {/* `font-sans` es la fuente del design system: el `@theme` la mapea a
          Geist (`--font-geist-sans`), la que carga el layout de arriba. Antes
          esta fuente venía de una regla `body { font-family: Arial }` escrita a
          mano en el CSS global: la app se veía en ARIAL y descargaba dos
          archivos de fuente al pedo. */}
      <body className="min-h-full flex flex-col font-sans bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100">
        <Header />
        <div className="flex-1 w-full">{children}</div>
        {/* El footer es el único lugar de la app que le habla al usuario sobre
            DÓNDE viven sus datos, así que no puede mentir ni por omisión ni por
            exceso.

            Lo que decía antes: "Tus datos se guardan localmente en este
            servidor · SQLite + Next.js". Falso: los datos van a Postgres, que
            puede estar en tu máquina o en Neon. Después decía "en tu Postgres de
            Neon" — que también es falso ahora que la app corre contra el
            Postgres local (ver `npm run db:local:start`), y encima filtra el
            proveedor donde corrés.

            La versión de abajo es la única afirmación que es cierta en TODAS las
            configuraciones: los movimientos se guardan en una base de datos del
            lado del servidor, no en el navegador. Y esa distinción sí le importa
            a quien la lee, porque es la diferencia entre poder abrir la app
            desde otro dispositivo y no poder. */}
        <footer className="text-center text-xs text-zinc-500 py-6">
          Los movimientos viven en tu base de datos, no en este navegador.
        </footer>
      </body>
    </html>
  );
}
