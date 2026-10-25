import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import Header from "@/components/Header";
import "./globals.css";

/**
 * LA FUENTE DEL SISTEMA: ARCHIVO, NO LA DE NEXT
 *
 * Hasta la F0b la app usaba `Geist`, que es la fuente por defecto de Next.js:
 * una app donde la tipografía la eligió el framework. Archivo (Omnibus-Type,
 * 2019) es una grotesca de voz técnica/institucional que combina con el
 * «C · Noche» (fondo profundo, acento cian) y —lo que decide el modelo de
 * medidas— trae:
 *
 *   · eje de peso variable 100-900: el 800 de las tarjetas grandes es REAL
 *     (no un negrito sintetizado, que falsea el avance del monto);
 *   · cifras tabulares (`tnum`) de verdad: con `tabular-nums` el «0», el «1»
 *     y el «8» avanzan exactamente lo mismo (medido en el navegador,
 *     2026-10-22: 0,5681 / 0,5981 / 0,6270 em en peso 400 / 700 / 800), así
 *     que los montos no bailan cuando cambia un dígito.
 *
 * Se carga con `next/font/google`, que descarga el `.woff2` en el BUILD y lo
 * self-hospeda: en runtime el navegador no le pide nada a Google (y `display:
 * swap` + `adjustFontFallback` evitan el salto de layout). La evidencia de la
 * medición está en `docs/design-system.md` §3 y en `scripts/medir-fuente.mjs`.
 *
 * IBM Plex Mono es la monoespaciada: se usa en un solo lugar (el textarea del
 * CSV, donde los separadores tienen que alinear). No es variable, así que
 * declara sus pesos.
 */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mis Finanzas — Ingresos y Gastos",
  description: "Registra tus ingresos y gastos diarios y analízalos por semana, mes y año.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}
    >
      {/* `font-sans` es la fuente del design system: el `@theme` la mapea a
          Archivo (`--font-archivo`), la que carga el layout de arriba. Antes
          esta fuente venía de una regla `body { font-family: Arial }` escrita a
          mano en el CSS global: la app se veía en ARIAL y descargaba dos
          archivos de fuente al pedo. */}
      <body className="min-h-full flex flex-col font-sans bg-surface text-fg ">
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
        <footer className="text-center text-xs text-fg-muted py-6">
          Los movimientos viven en tu base de datos, no en este navegador.
        </footer>
      </body>
    </html>
  );
}
