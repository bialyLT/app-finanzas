#!/usr/bin/env node
/**
 * 16-gate-css-puro · ¿el candado de «cero CSS a mano» REALMENTE muerde?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * Un gate que no puede fallar no es un gate. El dev de la Fase 9 dejó
 * `scripts/check-css-puro.mjs` (falla si vuelve un selector suelto, un
 * `@media` de nivel superior, un `@layer components` o una `font-family`
 * fuera del `@theme`). Su propio test le pasa CSS roto a propósito.
 *
 * Esta batería es la versión ADVERSARIA: no prueba lo que el gate dice, sino
 * que busca la PUERTA DE SERVICIO. En la primera corrida encontró DOS huecos
 * que el test del dev no cubría:
 *
 *   · `@layer base` estaba declarado «libre»: cualquiera podía esconder ahí
 *     el estilo de un componente (`.mi-estilo { color: red }`) y el gate lo
 *     aceptaba con exit 0. PROBADO DE VERDAD: con ese bloque en el CSS
 *     global, el build lo aplicaba (los montos de las fichas salían en
 *     rojo: `getComputedStyle(.monto-ficha).color` = rgb(255, 0, 0)) y el
 *     gate decía «CSS puro · RESULT ok=11 fail=0».
 *   · `@theme` y `@utility` también estaban «libres»: un selector de clase
 *     dentro de ellos pasaba igual.
 *   · el gate escaneaba los `.css` del repo pero NO seguía los `@import`:
 *     el CSS a mano podía esconderse en el archivo importado.
 *
 * La batería corre el gate de verdad (como proceso hijo) contra CSS escrito
 * a propósito, y exige `exit 1` + un motivo nombrado.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { correrBateria } from "./lib.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RAIZ = resolve(import.meta.dirname, "..", "..");
const GATE = join(RAIZ, "scripts", "check-css-puro.mjs");

/** Corre el gate contra los archivos dados. */
function correr(archivos) {
  const r = spawnSync(process.execPath, [GATE, ...archivos], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = [...salida.matchAll(/RESULT ok=(\d+) fail=(\d+)/g)].pop();
  return {
    code: r.status,
    ok: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    salida,
  };
}

/**
 * Escribe un CSS temporal y corre el gate contra él.
 * @returns {{rechazado: boolean, motivo: string|null, fail: number|null}}
 */
function contraCss(nombre, contenido, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "css-puro-16-"));
  try {
    const archivo = join(dir, `${nombre}.css`);
    writeFileSync(archivo, contenido, "utf8");
    const otros = Object.entries(extra).map(([n, c]) => {
      const p = join(dir, `${n}.css`);
      writeFileSync(p, c, "utf8");
      return p;
    });
    const r = correr([archivo, ...otros]);
    const motivos = [...r.salida.matchAll(/·\s+.+? — (.+)/g)].map((m) => m[1].trim());
    return {
      rechazado: r.code === 1 && (r.fail ?? 0) > 0,
      motivo: motivos[0] ?? null,
      fail: r.fail,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  /* ───────────────────────────────────────────────────────────────────────
   * 1 · LO QUE EL GATE DICE QUE CAZA (y tiene que cazar)
   * ─────────────────────────────────────────────────────────────────────── */
  section("1 · lo que el gate promete cazar");
  const cazados = [
    ["selector de clase suelto", `@import "tailwindcss";\n.algo { color: red; }\n`],
    ["regla de elemento suelta", `@import "tailwindcss";\nbody { color: red; }\n`],
    [
      "@media de nivel superior",
      `@import "tailwindcss";\n@media (min-width: 640px) { .algo { color: red; } }\n`,
    ],
    [
      "@layer components",
      `@import "tailwindcss";\n@layer components { .algo { color: red; } }\n`,
    ],
    [
      "font-family fuera del @theme",
      `@import "tailwindcss";\n.algo { font-family: Arial; }\n`,
    ],
    [
      "font-family dentro de @layer base",
      `@import "tailwindcss";\n@layer base { body { font-family: Arial; } }\n`,
    ],
  ];
  for (const [nombre, css] of cazados) {
    const r = contraCss(nombre.replace(/\W+/g, "-"), css);
    checkTrue(`el gate RECHAZA: ${nombre}`, r.rechazado, `fail=${r.fail}`);
    checkTrue(
      `el gate NOMBRA el problema: ${nombre}`,
      typeof r.motivo === "string" && r.motivo.length > 0,
      `motivo=${r.motivo}`,
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 2 · LOS ÁNGULOS (la puerta de servicio)
   * ─────────────────────────────────────────────────────────────────────── */
  section("2 · los ángulos: ¿se puede esquivar el gate?");
  const angulos = [
    [
      "una clase DENTRO de @layer base (el hueco que encontró esta ronda)",
      `@import "tailwindcss";\n@layer base {\n  .mi-estilo-a-mano {\n    color: rgb(255, 0, 0);\n    font-size: 40px;\n  }\n}\n`,
    ],
    [
      "una clase dentro de @layer base y de un @media",
      `@import "tailwindcss";\n@layer base { @media (min-width: 640px) { .mi-estilo { color: red; } } }\n`,
    ],
    ["un id DENTRO de @layer base", `@import "tailwindcss";\n@layer base { #mi-id { color: red; } }\n`],
    ["una clase DENTRO de @theme", `@import "tailwindcss";\n@theme { .mi-estilo { color: red; } }\n`],
    ["una clase DENTRO de @utility", `@import "tailwindcss";\n@utility monto-ficha { .mi-estilo { color: red; } }\n`],
    [
      "una clase DENTRO de @layer components (dentro de @layer base)",
      `@import "tailwindcss";\n@layer base { @layer components { .mi-estilo { color: red; } } }\n`,
    ],
  ];
  for (const [nombre, css] of angulos) {
    const r = contraCss(nombre.replace(/\W+/g, "-"), css);
    checkTrue(`el gate RECHAZA: ${nombre}`, r.rechazado, `fail=${r.fail}`);
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 3 · EL `@import`: el CSS a mano en OTRO archivo
   * ─────────────────────────────────────────────────────────────────────── */
  section("3 · el `@import` a otro archivo (con estilos a mano)");
  const conImport = contraCss(
    "principal",
    `@import "tailwindcss";\n@import "./estilos.css";\n`,
    { estilos: `.mi-estilo-a-mano { color: rgb(255, 0, 0); }\n` },
  );
  checkTrue(
    "el gate sigue el `@import` y rechaza el CSS a mano del archivo importado",
    conImport.rechazado,
    `fail=${conImport.fail}`,
  );

  /* ───────────────────────────────────────────────────────────────────────
   * 4 · LO QUE EL GATE TIENE QUE DEJAR PASAR (si no, es un gate inútil)
   * ─────────────────────────────────────────────────────────────────────── */
  section("4 · lo que el gate tiene que DEJAR pasar");
  const permitidos = [
    [
      "la configuración del proyecto (theme + variantes + utilidades + capa base)",
      `@import "tailwindcss";\n@custom-variant touch { @media (any-pointer: coarse) { @slot; } }\n@theme inline { --font-sans: var(--font-geist-sans); }\n@layer base { @media (any-pointer: coarse) { button { min-height: 44px; min-width: 44px; } } }\n@utility monto-ficha { font-size: clamp(0.5rem, 0.875rem, 0.875rem); }\n`,
    ],
    [
      "un default de ELEMENTO en la capa base (el objetivo táctil)",
      `@import "tailwindcss";\n@layer base { button, input, select, textarea { min-height: 44px; min-width: 44px; } }\n`,
    ],
  ];
  for (const [nombre, css] of permitidos) {
    const r = contraCss(nombre.replace(/\W+/g, "-"), css);
    checkTrue(`el gate ACEPTA: ${nombre}`, r.rechazado === false, `fail=${r.fail}`);
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 5 · EL CSS DEL PROYECTO
   * ─────────────────────────────────────────────────────────────────────── */
  section("5 · el CSS del proyecto");
  const repo = correr([]);
  check("el gate del repo sale con 0", repo.code, 0);
  check("el gate del repo no tiene fallas", repo.fail, 0);
  checkTrue(
    "el gate del repo imprime el contrato RESULT ok=N fail=M",
    repo.ok !== null,
    repo.salida.slice(-200),
  );
}

await correrBateria({ main, etiqueta: "16-gate-css-puro" });
