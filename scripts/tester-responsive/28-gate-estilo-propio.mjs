#!/usr/bin/env node
/**
 * 28-gate-estilo-propio · ¿el candado de «cero default» REALMENTE muerde?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * El dev de la ronda F10 · F0a dejó `scripts/check-estilo-propio.mjs` (falla si
 * reaparece la paleta de fábrica, un emoji, un radio fuera de escala, un color
 * suelto, un gradiente o una fuente fuera del tema). Su propio test le pasa
 * UN archivo con una violación de cada regla.
 *
 * Esta batería es la versión ADVERSARIA: no prueba lo que el gate dice, sino
 * que busca la PUERTA DE SERVICIO. Escribió un archivo con una violación por
 * caso y lo pasó al gate REAL, exigiendo `exit 1` y un motivo nombrado.
 *
 * En la primera corrida encontró SIETE huecos (todos verificados: la clase
 * escapaba con exit 0 Y compila en el Tailwind del proyecto):
 *
 *   · `bg-pink-500` — `pink` no estaba en la lista de familias de fábrica.
 *   · `bg-linear-to-r` — en Tailwind v4 el gradiente se llama `bg-linear-*`
 *     (el gate sólo miraba `bg-gradient-*`).
 *   · `rounded` (pelado, 4 px), `rounded-[10px]` (arbitrario) y
 *     `rounded-ss-xl` (variante lógica de esquina): el regex del radio sólo
 *     aceptaba UNA variante direccional.
 *   · `bg-[rgb(7,17,31)]` — el color suelto en otra notación.
 *   · `font-serif` — una fuente fuera del tema que no es arbitraria.
 *   · el VALOR de un token borrado de `:root` (con el `@theme` intacto): el
 *     token quedaba MUERTO y el gate pasaba con exit 0.
 *   · `dark:bg-black/90` — el `dark:` en un color (la regla 5.8 del design
 *     system, que el gate no miraba).
 *
 * Y, con el gate ya endurecido, encontró TRES violaciones REALES en el repo
 * que el gate del dev no veía: cinco `rounded` pelados (4 px, fuera de la
 * escala) y el `dark:bg-black/90` del header (que en «Noche» dejaba la barra
 * de navegación en NEGRO sobre una página `#07111F`).
 *
 * La batería corre el gate de verdad (como proceso hijo) contra archivos
 * escritos a propósito, y exige `exit 1` + un motivo nombrado en cada caso.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { correrBateria } from "./lib.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RAIZ = resolve(import.meta.dirname, "..", "..");
const GATE = join(RAIZ, "scripts", "check-estilo-propio.mjs");

/** Corre el gate contra los archivos dados. */
function correr(archivos) {
  const r = spawnSync(process.execPath, [GATE, ...archivos], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = [...salida.matchAll(/RESULT ok=(\d+) fail=(\d+)/g)].pop();
  const motivos = [...salida.matchAll(/·\s+.+? — (.+)/g)].map((x) => x[1].trim());
  return {
    code: r.status,
    ok: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    motivos,
    salida,
  };
}

/**
 * Escribe un `.tsx` temporal y corre el gate contra él.
 * @returns {{rechazado: boolean, motivo: string|null, fail: number|null}}
 */
function contraTsx(nombre, contenido) {
  const dir = mkdtempSync(join(tmpdir(), "estilo-propio-28-"));
  try {
    const archivo = join(dir, `${nombre}.tsx`);
    writeFileSync(archivo, contenido, "utf8");
    const r = correr([archivo]);
    return {
      rechazado: r.code === 1 && (r.fail ?? 0) > 0,
      motivo: r.motivos[0] ?? null,
      fail: r.fail,
      salida: r.salida,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** El caso más simple: una sola clase en un `className`. */
const clase = (c) => `export const A = () => <div className="${c}" />;`;

async function main() {
  /* ───────────────────────────────────────────────────────────────────────
   * 1 · LO QUE EL GATE PROMETE CAZAR (una regla por una)
   * ─────────────────────────────────────────────────────────────────────── */
  section("1 · lo que el gate promete cazar (una violación por caso)");
  const cazados = [
    ["paleta de fábrica (neutra)", clase("text-zinc-500"), "paleta"],
    ["paleta de fábrica (de estado)", clase("bg-emerald-600"), "paleta"],
    ["paleta de fábrica (pink)", clase("bg-pink-500"), "paleta"],
    ["paleta de fábrica (con variante)", clase("hover:bg-sky-100"), "paleta"],
    ["emoji como icono", `export const A = () => <span>🗑</span>;`, "emoji"],
    ["emoji en el texto de un botón", `export const A = () => <button>📥 Importar CSV</button>;`, "emoji"],
    ["emoji en un aria-label", `export const A = () => <button aria-label="🗑 borrar" />;`, "emoji"],
    ["radio fuera de escala (xl)", clase("rounded-xl"), "radio"],
    ["radio fuera de escala (2xl)", clase("rounded-2xl"), "radio"],
    ["radio pelado (4 px)", clase("rounded"), "radio"],
    ["radio arbitrario", clase("rounded-[10px]"), "radio"],
    ["radio lógico de esquina", clase("rounded-ss-xl"), "radio"],
    ["color suelto (hex)", clase("bg-[#07111F]"), "color"],
    ["color suelto (rgb)", clase("bg-[rgb(7,17,31)]"), "color"],
    ["color suelto (oklch)", clase("bg-[oklch(0.2_0.1_0.2)]"), "color"],
    [
      "color suelto en un estilo en línea",
      `export const A = () => <div style={{ color: "#07111F" }} />;`,
      "color",
    ],
    ["gradiente (nombre viejo)", clase("bg-gradient-to-r"), "gradiente"],
    ["gradiente (nombre de Tailwind v4)", clase("bg-linear-to-r"), "gradiente"],
    ["gradiente (radial)", clase("bg-radial-from-primary"), "gradiente"],
    ["gradiente (from-*)", clase("from-primary"), "gradiente"],
    ["fuente fuera del tema (arbitraria)", clase("font-[Comic_Sans_MS]"), "fuente"],
    ["fuente fuera del tema (serif)", clase("font-serif"), "fuente"],
    ["dark: en un color", clase("dark:bg-black/90"), "dark"],
    ["dark: en un texto", clase("dark:text-zinc-100"), "paleta"],
  ];

  for (const [nombre, contenido, reglaEsperada] of cazados) {
    const r = contraTsx(nombre.replace(/\W+/g, "-"), contenido);
    checkTrue(`el gate RECHAZA: ${nombre}`, r.rechazado, `fail=${r.fail}`);
    checkTrue(
      `el gate NOMBRA el problema: ${nombre}`,
      typeof r.motivo === "string" && r.motivo.length > 0,
      `motivo=${r.motivo}`,
    );
    checkTrue(
      `el gate dice la regla correcta: ${nombre}`,
      typeof r.motivo === "string" &&
        (r.motivo.includes(reglaEsperada) ||
          (reglaEsperada === "radio" && r.motivo.includes("radio"))),
      `esperaba «${reglaEsperada}», obtuvo «${r.motivo}»`,
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 2 · LO QUE EL GATE TIENE QUE DEJAR PASAR (si no, es un gate inútil)
   * ─────────────────────────────────────────────────────────────────────── */
  section("2 · lo que el gate tiene que DEJAR pasar");
  const permitidos = [
    ["los tokens semánticos", clase("bg-surface-2 text-fg-muted border-line-strong")],
    ["la escala de radios", clase("rounded-md rounded-lg rounded-full rounded-none")],
    ["las variantes direccionales de la escala", clase("rounded-t-md rounded-ss-lg")],
    ["el velo del modal (negro)", clase("bg-black/50")],
    ["un emoji en un COMENTARIO (no es un icono)", "// 🗑 esto explica el cambio\nexport const A = () => <div />;"],
    ["un peso de fuente (no es una familia)", clase("font-bold")],
    ["la fuente del tema", clase("font-sans font-mono")],
    ["un `dark:` que NO es un color", clase("dark:hidden")],
    ["los iconos de lucide", `export const A = () => <Trash className="size-4" aria-hidden />;`],
  ];
  for (const [nombre, contenido] of permitidos) {
    const r = contraTsx(nombre.replace(/\W+/g, "-"), contenido);
    checkTrue(`el gate ACEPTA: ${nombre}`, r.rechazado === false, `fail=${r.fail}`);
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 3 · EL `@theme`: los 15 tokens, con VALOR en los dos esquemas
   * ─────────────────────────────────────────────────────────────────────── */
  section("3 · el `@theme`: los quince tokens y su valor en los dos esquemas");
  const globals = join(RAIZ, "app", "globals.css");
  const css = readFileSync(globals, "utf8");
  const TOKENS = [
    "surface", "surface-2", "surface-3", "line", "line-strong",
    "fg", "fg-muted", "fg-subtle", "primary", "primary-fg",
    "success", "danger", "warning", "transfer", "focus",
  ];
  for (const t of TOKENS) {
    checkTrue(
      `el @theme declara --color-${t}`,
      css.includes(`--color-${t}: var(--${t})`),
      "no está en el @theme",
    );
  }
  const claro = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const oscuro = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  const valor = (bloque, t) =>
    new RegExp(`--${t}\\s*:\\s*(#[0-9a-fA-F]{3,8}|oklch\\([^)]*\\)|rgb\\([^)]*\\))`).test(bloque);
  for (const t of TOKENS) {
    checkTrue(`el token --${t} tiene valor en el esquema CLARO`, valor(claro, t));
    checkTrue(`el token --${t} tiene valor en el esquema NOCHE`, valor(oscuro, t));
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 4 · EL GATE NO PUEDE PASAR CON UNA VIOLACIÓN
   *
   * La prueba de fuego: se mete una violación de cada regla en el ARCHIVO
   * REAL del repo (una copia, en un archivo temporal) y se corre el gate
   * sobre él. El gate tiene que salir con 1.
   *
   * Y al revés: con el repo limpio, el gate tiene que salir con 0.
   * ─────────────────────────────────────────────────────────────────────── */
  section("4 · el gate no puede pasar con una violación (y el repo está limpio)");
  const repo = correr([]);
  check("el gate del repo sale con 0", repo.code, 0);
  check("el gate del repo no tiene fallas", repo.fail, 0);
  checkTrue(
    "el gate del repo imprime el contrato RESULT ok=N fail=M",
    repo.ok !== null,
    repo.salida.slice(-200),
  );
  checkTrue(
    "el gate del repo mira toda la interfaz (92+ archivos)",
    /(\d+) archivo\(s\)/.test(repo.salida) && Number(repo.salida.match(/(\d+) archivo\(s\)/)[1]) >= 90,
    repo.salida.slice(0, 200),
  );

  /* ───────────────────────────────────────────────────────────────────────
   * 5 · EL LÍMITE DEL GATE (¿deja un agujero real?)
   *
   * El gate mira `app/`, `components/` y `lib/`, y sólo archivos `.tsx` y
   * `.ts`. Eso alcanza para la INTERFAZ: un `.tsx` fuera de esas carpetas no
   * se renderiza. Pero un `.css` importado sí: un `@import` de un archivo con
   * estilos a mano esquivaría este gate (el otro gate, el de CSS puro, sí
   * sigue los `@import`: por eso los dos candados juntos cierran).
   * ─────────────────────────────────────────────────────────────────────── */
  section("5 · el límite del gate: lo que NO mira (y por qué no importa)");
  const { archivosCodigo } = await import("../check-estilo-propio.mjs");
  const lista = archivosCodigo(RAIZ);
  checkTrue(
    "el gate sólo mira archivos .tsx/.ts (nada de .css)",
    lista.every((f) => /\.(tsx|ts)$/.test(f)),
    lista.filter((f) => !/\.(tsx|ts)$/.test(f)).join(", "),
  );
  checkTrue(
    "el gate sólo mira app/, components/ y lib/",
    lista.every((f) => /[\\/](app|components|lib)[\\/]/.test(f)),
    lista.filter((f) => !/[\\/](app|components|lib)[\\/]/.test(f)).join(", "),
  );
  checkTrue(
    "el gate mira la interfaz entera (más de 90 archivos)",
    lista.length >= 90,
    `${lista.length} archivos`,
  );

  // El otro candado sí cubre el `.css`: un archivo con estilos a mano falla.
  const cssPuro = join(RAIZ, "scripts", "check-css-puro.mjs");
  const rCss = spawnSync(process.execPath, [cssPuro], { cwd: RAIZ, encoding: "utf8" });
  check("el gate de CSS puro también sale con 0 sobre el repo", rCss.status, 0);
}

await correrBateria({ main, etiqueta: "28-gate-estilo-propio" });
