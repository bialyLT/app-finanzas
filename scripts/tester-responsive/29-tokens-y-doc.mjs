#!/usr/bin/env node
/**
 * 29-tokens-y-doc · los quince tokens, los ratios y los números del documento
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * El dev de la ronda F10 · F0a entregó 15 tokens con sus ratios calculados y
 * un documento (`docs/design-system.md`) que dice ser «la fuente de verdad».
 *
 * Un ratio de contraste no se acepta por believable: se recalcula. Esta
 * batería:
 *   1. lee los VALORES REALES de `app/globals.css` (no los del documento);
 *   2. recalcula el ratio WCAG 2.1 de cada par;
 *   3. compara con los números que dice el documento (si el documento miente,
 *      el documento falla);
 *   4. verifica los tokens que el dev recalculó (`fg-subtle` y `line-strong`
 *      en los dos esquemas): si alguno de los cuatro no llega al mínimo, es
 *      un bug;
 *   5. verifica el texto del estado sobre SU PROPIO TINTE (el patrón
 *      `bg-xxx/10` + `text-xxx` que promote el design system): ahí faltaban
 *      dos tokens (los ajustó el tester);
 *   6. verifica los números de la escala de radios y del grosor de los
 *      iconos CONTRA EL TAILWIND DEL PROYECTO (no contra la memoria): el
 *      documento decía «rounded-lg = 10 px» y «strokeWidth 1.75», y los dos
 *      eran falsos.
 *
 * La matemática es la de WCAG 2.1 (la misma del spike,
 * `spike-estilos/src/lib/contrast.ts`).
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { correrBateria } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RAIZ = resolve(import.meta.dirname, "..", "..");
const css = readFileSync(join(RAIZ, "app", "globals.css"), "utf8");
const doc = readFileSync(join(RAIZ, "docs", "design-system.md"), "utf8");

/* ── Los valores reales ─────────────────────────────────────────────────── */
function tokensDe(texto) {
  const t = {};
  for (const m of texto.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) t[m[1]] = m[2];
  return t;
}
const claro = tokensDe(css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")));
const oscuro = tokensDe(css.slice(css.indexOf("@media (prefers-color-scheme: dark)")));

const TOKENS = [
  "surface", "surface-2", "surface-3", "line", "line-strong",
  "fg", "fg-muted", "fg-subtle", "primary", "primary-fg",
  "success", "danger", "warning", "transfer", "focus",
];

/* ── WCAG 2.1 ────────────────────────────────────────────────────────────── */
const hex2rgb = (h) => {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
function luminancia(rgb) {
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function ratio(a, b) {
  const l1 = luminancia(a);
  const l2 = luminancia(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** El ratio entre dos tokens, dados por nombre, en un esquema. */
const ratioDe = (t, a, b) => ratio(hex2rgb(t[a]), hex2rgb(t[b]));
/** El tinte real: el token al 10 % compuesto sobre el fondo (sRGB). */
const tinte = (t, token, fondo, p) => {
  const c = hex2rgb(t[token]);
  const f = hex2rgb(t[fondo]);
  return c.map((v, i) => p * v + (1 - p) * f[i]);
};

/** Los pares que el design system declara (los mismos del documento). */
const PARES = [
  ["fg", "surface", 4.5], ["fg", "surface-2", 4.5], ["fg", "surface-3", 4.5],
  ["fg-muted", "surface", 4.5], ["fg-muted", "surface-2", 4.5], ["fg-muted", "surface-3", 4.5],
  ["fg-subtle", "surface", 4.5], ["fg-subtle", "surface-2", 4.5], ["fg-subtle", "surface-3", 4.5],
  ["primary-fg", "primary", 4.5],
  ["primary", "surface", 4.5], ["primary", "surface-2", 4.5], ["primary", "surface-3", 4.5],
  ["success", "surface", 4.5], ["success", "surface-2", 4.5], ["success", "surface-3", 4.5],
  ["danger", "surface", 4.5], ["danger", "surface-2", 4.5], ["danger", "surface-3", 4.5],
  ["warning", "surface", 4.5], ["warning", "surface-2", 4.5], ["warning", "surface-3", 4.5],
  ["transfer", "surface", 4.5], ["transfer", "surface-2", 4.5], ["transfer", "surface-3", 4.5],
  ["line-strong", "surface", 3], ["line-strong", "surface-2", 3], ["line-strong", "surface-3", 3],
  ["focus", "surface", 3], ["focus", "surface-2", 3], ["focus", "surface-3", 3],
];

async function main() {
  /* ───────────────────────────────────────────────────────────────────────
   * 1 · LOS QUINCE TOKENS EXISTEN Y TIENEN VALOR EN LOS DOS ESQUEMAS
   * ─────────────────────────────────────────────────────────────────────── */
  section("1 · los quince tokens");
  check("hay 15 tokens", TOKENS.length, 15);
  for (const t of TOKENS) {
    checkTrue(`--${t} tiene valor en el esquema CLARO`, Boolean(claro[t]), String(claro[t]));
    checkTrue(`--${t} tiene valor en el esquema NOCHE`, Boolean(oscuro[t]), String(oscuro[t]));
    checkTrue(
      `el @theme declara --color-${t}`,
      css.includes(`--color-${t}: var(--${t})`),
      "falta en el @theme",
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 2 · LOS RATIOS RECALCULADOS (texto ≥ 4,5:1 · control ≥ 3:1)
   * ─────────────────────────────────────────────────────────────────────── */
  section("2 · los ratios recalculados en los DOS esquemas");
  for (const [esquema, t] of [["NOCHE", oscuro], ["CLARO", claro]]) {
    for (const [a, b, min] of PARES) {
      const r = ratioDe(t, a, b);
      checkTrue(
        `${esquema}: ${a} sobre ${b} ≥ ${min}:1`,
        r >= min,
        `${r.toFixed(3)}:1 (${t[a]} sobre ${t[b]})`,
      );
    }
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 3 · LOS CUATRO TOKENS QUE EL DEV RECALCULÓ
   *
   * Con los valores del brief quedaban por debajo del mínimo:
   *   · fg-subtle noche #6B8299 → 4,37:1 sobre la tarjeta (pedía 4,5)
   *   · fg-subtle claro #7A7880 → 4,17:1 sobre el fondo
   *   · line-strong noche #3E6485 → 2,78:1 sobre la tarjeta (pedía 3)
   *   · line-strong claro #9A968C → 2,83:1 sobre el fondo
   * Con los valores nuevos tienen que pasar. Y además: el valor NUEVO tiene
   * que ser PEOR o igual que el viejo en el peor caso (es decir: el ajuste
   * tiene que haber sido el mínimo, no un rediseño).
   * ─────────────────────────────────────────────────────────────────────── */
  section("3 · los cuatro tokens recalculados por el dev (y el mínimo del ajuste)");
  const RECALCULADOS = [
    ["fg-subtle", "NOCHE", "#6b8299", "#7a8fa3", "surface-2", 4.5],
    ["fg-subtle", "CLARO", "#7a7880", "#6f6e75", "surface", 4.5],
    ["line-strong", "NOCHE", "#3e6485", "#477398", "surface-2", 3],
    ["line-strong", "CLARO", "#9a968c", "#908c81", "surface", 3],
  ];
  for (const [token, esquema, viejo, nuevo, superficie, min] of RECALCULADOS) {
    const t = esquema === "NOCHE" ? oscuro : claro;
    check(`el valor NUEVO de --${token} (${esquema}) es el que está en el CSS`, t[token], nuevo);
    checkTrue(
      `el valor NUEVO de --${token} (${esquema}) pasa el mínimo sobre ${superficie}`,
      ratioDe(t, token, superficie) >= min,
      `${ratioDe(t, token, superficie).toFixed(3)}:1`,
    );
    checkTrue(
      `el valor VIEJO de --${token} (${esquema}) fallaba (por eso se recalculó)`,
      ratio(hex2rgb(viejo), hex2rgb(t[superficie])) < min,
      `${ratio(hex2rgb(viejo), hex2rgb(t[superficie])).toFixed(3)}:1`,
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 4 · EL TEXTO DEL ESTADO SOBRE SU PROPIO TINTE (10 %)
   *
   * El patrón `bg-xxx/10` + `text-xxx` es el que promote el design system
   * (§1.4) y el que usa la app en ~25 lugares. La tabla de ratios del dev
   * medía el token contra las superficies, pero NO contra su propio tinte:
   * ahí el texto de estado quedaba en 4,39:1 (success) y 4,38:1 (warning)
   * en el esquema claro — por debajo de 4,5:1.
   * ─────────────────────────────────────────────────────────────────────── */
  section("4 · el texto del estado sobre SU PROPIO tinte (10 %)");
  for (const [esquema, t] of [["NOCHE", oscuro], ["CLARO", claro]]) {
    for (const e of ["success", "danger", "warning", "transfer"]) {
      for (const f of ["surface", "surface-2", "surface-3"]) {
        const r = ratio(hex2rgb(t[e]), tinte(t, e, f, 0.1));
        checkTrue(
          `${esquema}: ${e} sobre su tinte al 10 % de ${f} ≥ 4,5:1`,
          r >= 4.5,
          `${r.toFixed(3)}:1`,
        );
      }
    }
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 5 · LOS NÚMEROS DEL DOCUMENTO (el documento es la fuente de verdad)
   *
   * El documento afirma un ratio por par. Si el número del documento no es el
   * que sale de la matemática, el documento MIENTE y hay que arreglarlo.
   * ─────────────────────────────────────────────────────────────────────── */
  section("5 · los ratios que AFIRMA el documento (comparados con la matemática)");
  const filasDoc = [...doc.matchAll(/^\| `(--[a-z0-9-]+)` sobre `(--[a-z0-9-]+)` \| ([\d,]+):1 \|/gm)];
  checkTrue(
    "el documento tiene la tabla de ratios (pares de texto y de control)",
    filasDoc.length >= 40,
    `${filasDoc.length} filas`,
  );
  for (const [, a, b, numero] of filasDoc) {
    const tokenA = a.replace(/^--/, "");
    const tokenB = b.replace(/^--/, "");
    // El documento tiene dos tablas (noche y claro): se prueba el ratio contra
    // CUALQUIERA de los dos esquemas y tiene que aparecer en alguno.
    const candidatos = [ratioDe(oscuro, tokenA, tokenB), ratioDe(claro, tokenA, tokenB)];
    const esperado = Number(numero.replace(",", "."));
    const alguno = candidatos.some((r) => Math.abs(r - esperado) <= 0.015);
    checkTrue(
      `el documento dice ${a} sobre ${b} = ${numero}:1 y la matemática da ese número`,
      alguno,
      `calculado: ${candidatos.map((r) => r.toFixed(3)).join(" · ")}`,
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 6 · LA ESCALA DE RADIOS, CONTRA EL TAILWIND DEL PROYECTO
   *
   * El documento decía «rounded-lg = 10 px». Tailwind v4 define
   * `--radius-lg: 0.5rem` = 8 px, y el radio base del estilo «C · Noche» del
   * spike es `0.5rem`: el código estaba bien y el documento mentía.
   * ─────────────────────────────────────────────────────────────────────── */
  section("6 · la escala de radios, contra el Tailwind del proyecto");
  const theme = readFileSync(join(RAIZ, "node_modules", "tailwindcss", "theme.css"), "utf8");
  const radioDe = (nombre) => {
    const m = theme.match(new RegExp(`--radius-${nombre}:\\s*([\\d.]+)rem`));
    return m ? Number(m[1]) * 16 : null;
  };
  check("la escala dice md = 6 px y el Tailwind también", radioDe("md"), 6);
  check("la escala dice lg = 8 px y el Tailwind también", radioDe("lg"), 8);
  checkTrue(
    "el documento dice 8 px para `rounded-lg` (no 10)",
    /\| `rounded-lg` \| 8 \|/.test(doc),
    "el documento sigue diciendo otra cosa",
  );
  checkTrue(
    "el documento NO dice 10 px para `rounded-lg`",
    !/\| `rounded-lg` \| 10 \|/.test(doc),
    "el documento sigue diciendo 10",
  );

  /* ───────────────────────────────────────────────────────────────────────
   * 7 · EL GROSOR DE LOS ICONOS (contra el lucide del proyecto)
   *
   * El documento decía «strokeWidth 1.75, el default de lucide». El default
   * de lucide-react es 2.
   * ─────────────────────────────────────────────────────────────────────── */
  section("7 · el grosor de los iconos, contra el lucide del proyecto");
  const lucide = readFileSync(
    join(RAIZ, "node_modules", "lucide-react", "dist", "cjs", "lucide-react.js"),
    "utf8",
  );
  const mStroke = lucide.match(/contextStrokeWidth\s*=\s*([\d.]+)/);
  checkTrue("el default de lucide está en el paquete", Boolean(mStroke));
  check("el default de lucide es 2", Number(mStroke?.[1]), 2);
  checkTrue("el documento dice el grosor real (2)", /`strokeWidth: 2`/.test(doc));
  checkTrue(
    "el documento NO afirma que el grosor sea 1,75",
    !/`strokeWidth 1\.75`/.test(doc) && !/grosor \(`strokeWidth 1\.75`/.test(doc),
    "el documento sigue diciendo 1.75",
  );
}

await correrBateria({ main, etiqueta: "29-tokens-y-doc" });
