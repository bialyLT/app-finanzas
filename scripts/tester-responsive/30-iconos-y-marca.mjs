#!/usr/bin/env node
/**
 * 30-iconos-y-marca · el set de iconos, el cero emoji y el cero `dark:`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * La ronda F10 · F0a reemplazó 38 emoji por iconos de `lucide-react`. Eso
 * se puede hacer de dos maneras: con iconos que SIGNIFICAN lo mismo que el
 * emoji, o con iconos decorativos que están ahí porque «había que poner algo».
 *
 * Esta batería verifica, sobre el código real:
 *   1. CERO emoji en la interfaz (y que no queden en un texto de botón ni en
 *      un `aria-label`: un emoji es un icono de otra tipografía);
 *   2. que los tamaños estén en la escala del design system;
 *   3. que el GROSOR sea uno solo (el default de lucide) en todos los iconos;
 *   4. que el icono signifique lo mismo que el emoji que reemplazaba, y que
 *      dos etiquetas distintas no compartan el mismo icono;
 *   5. que el set esté completo y que ningún icono lleve color propio.
 *
 * Y de paso, el criterio transversal: NINGÚN `dark:` de color en el markup
 * (el token ya es el del esquema que está en pantalla).
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { correrBateria } from "./lib.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RAIZ = resolve(import.meta.dirname, "..", "..");
const archivos = [];
const recorrer = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) recorrer(p);
    else if (/\.(tsx|ts)$/.test(e.name)) archivos.push(p);
  }
};
["app", "components", "lib"].forEach((d) => recorrer(join(RAIZ, d)));

const fuentes = archivos.map((a) => ({
  rel: a.replace(`${RAIZ}\\`, ""),
  txt: readFileSync(a, "utf8"),
}));

/** El código SIN los comentarios (un emoji en un comentario no es un icono). */
function sinComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

async function main() {
  /* ───────────────────────────────────────────────────────────────────────
   * 1 · CERO EMOJI EN LA INTERFAZ
   * ─────────────────────────────────────────────────────────────────────── */
  section("1 · cero emoji en la interfaz");
  let emojiTotal = 0;
  for (const f of fuentes) {
    const limpio = sinComentarios(f.txt);
    const m = [...limpio.matchAll(/\p{Extended_Pictographic}/gu)];
    if (m.length > 0) {
      emojiTotal += m.length;
      const lineas = limpio.split(/\r?\n/);
      lineas.forEach((linea, i) => {
        if (/\p{Extended_Pictographic}/u.test(linea)) {
          console.log(`      ${f.rel}:${i + 1}: ${linea.trim().slice(0, 120)}`);
        }
      });
    }
  }
  check("cero emoji en el código de la interfaz (sin comentarios)", emojiTotal, 0);

  // Los emoji en comentarios NO son iconos, pero se cuentan y se informan.
  let enComentarios = 0;
  for (const f of fuentes) {
    const limpio = sinComentarios(f.txt);
    enComentarios += (f.txt.match(/\p{Extended_Pictographic}/gu) ?? []).length -
      (limpio.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  }
  console.log(`      (informativo: ${enComentarios} emoji quedan en COMENTARIOS: no son iconos)`);

  /* ───────────────────────────────────────────────────────────────────────
   * 2 · EL SET DE ICONOS: tamaño, grosor y color
   * ─────────────────────────────────────────────────────────────────────── */
  section("2 · el set de iconos: tamaños, grosor y color");
  const ESCALA = ["4", "5", "6", "8", "10"];
  const usos = new Map();
  const importados = new Set();
  for (const f of fuentes) {
    for (const m of f.txt.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
      for (const n of m[1].split(",")) {
        const limpio = n.trim().replace(/^type\s+/, "");
        if (limpio) importados.add(limpio);
      }
    }
    // Los iconos: `<Icono ... />`, aunque el JSX esté partido en varias
    // líneas (el `Star` de la plantilla lo está: un escaneo por línea se lo
    // perdía, y con él se perdía el inventario del dev).
    for (const m of f.txt.matchAll(/<([A-Z][A-Za-z0-9]*)((?:[^<>]|\{[^{}]*\})*?)\/>/g)) {
      const [, nombre, props] = m;
      if (!importados.has(nombre)) continue;
      const tam = (props.match(/\bsize-(\d+(?:\.\d+)?)\b/) ?? [])[1] ?? null;
      const stroke = (props.match(/strokeWidth=\{?([\d.]+)\}?/) ?? [])[1] ?? null;
      // `fill-current` NO es un color propio: es «rellená con el color del
      // texto». Un color propio es cualquier otra cosa.
      const conColor = /\b(text|bg|border|fill|stroke|ring)-[a-z]/.test(
        props.replace(/\b(fill|text|stroke)-current\b/g, ""),
      );
      const sinAria = !/aria-hidden/.test(props);
      if (!usos.has(nombre)) usos.set(nombre, { n: 0, tamanos: new Map(), strokes: new Set(), color: 0, sinAria: [] });
      const u = usos.get(nombre);
      u.n += 1;
      if (tam) u.tamanos.set(tam, (u.tamanos.get(tam) ?? 0) + 1);
      if (stroke) u.strokes.add(stroke);
      if (conColor) u.color += 1;
      if (sinAria) u.sinAria.push(f.rel);
    }
  }
  checkTrue("hay iconos de lucide en la app", usos.size >= 15, `${usos.size} iconos distintos`);
  for (const [nombre, u] of usos) {
    checkTrue(
      `${nombre}: los tamaños están en la escala (16/20/24/32/40)`,
      [...u.tamanos.keys()].every((t) => ESCALA.includes(t)),
      [...u.tamanos.keys()].join(","),
    );
    checkTrue(
      `${nombre}: un solo grosor (el default de lucide)`,
      u.strokes.size === 0,
      [...u.strokes].join(","),
    );
    checkTrue(`${nombre}: ningún icono lleva color propio`, u.color === 0, `${u.color} con color`);
    checkTrue(
      `${nombre}: todos los iconos decorativos llevan aria-hidden`,
      u.sinAria.length === 0,
      u.sinAria.join(", "),
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * 3 · EL SIGNIFICADO: el icono dice lo mismo que el emoji
   *
   * El mapa está en `docs/design-system.md` §4. Lo que se verifica acá es que
   * el código y el documento NO SE CONTRADIGAN, y que dos etiquetas que
   * significan cosas distintas no compartan el mismo icono.
   * ─────────────────────────────────────────────────────────────────────── */
  section("3 · el significado del icono");
  const doc = readFileSync(join(RAIZ, "docs", "design-system.md"), "utf8");
  const texto = (archivo) => fuentes.find((f) => f.rel === archivo)?.txt ?? "";

  // La flecha tiene un signo: ↓ entra, ↑ sale. Y en las dos pantallas.
  const prestamos = texto("app\\prestamos\\page.tsx");
  const loanForm = texto("components\\LoanForm.tsx");
  checkTrue(
    "«Debo» (sale plata) usa la flecha que SALE",
    /<ArrowUpRight[^>]*\/>\s*Debo/.test(prestamos) || /ArrowUpRight[\s\S]{0,80}Debo/.test(prestamos),
    "no encuentra ArrowUpRight junto a «Debo»",
  );
  checkTrue(
    "«Me deben» (entra plata) usa la flecha que ENTRA",
    /ArrowDownLeft[\s\S]{0,80}Me deben/.test(prestamos),
    "no encuentra ArrowDownLeft junto a «Me deben»",
  );
  checkTrue(
    "«Recibí un préstamo» (entra plata) usa la flecha que ENTRA",
    /ArrowDownLeft[\s\S]{0,80}Recibí un préstamo/.test(loanForm),
    "no encuentra ArrowDownLeft junto a «Recibí un préstamo»",
  );
  checkTrue(
    "«Presté plata» (sale plata) usa la flecha que SALE",
    /ArrowUpRight[\s\S]{0,80}Presté plata/.test(loanForm),
    "no encuentra ArrowUpRight junto a «Presté plata»",
  );
  checkTrue(
    "el título «Préstamos» NO comparte icono con «Me deben»",
    !/Handshake[^>]*\/>Me deben/.test(prestamos),
    "«Me	deben» usa el mismo icono que el título",
  );
  checkTrue(
    "«Importar CSV» usa el icono de IMPORTAR (no el de descargar)",
    /<Import[^>]*\/>\s*Importar CSV/.test(texto("app\\page.tsx")),
    "el botón de importar no usa el icono `Import`",
  );
  checkTrue(
    "no queda ningún icono `Download` (significa descargar)",
    !/Download/.test(texto("app\\page.tsx")),
    "quedó un `Download`",
  );
  // El documento tiene que decir lo mismo que el código.
  checkTrue(
    "el documento dice que `Importar CSV` usa `Import`",
    /\| Importar CSV \| `Import` \|/.test(doc),
    "el documento no menciona `Import`",
  );
  checkTrue(
    "el documento dice que la flecha es el signo de la plata",
    /↓.*entra|entra.*↓/s.test(doc) && /↑.*sale|sale.*↑/s.test(doc),
    "el documento no explica el signo de las flechas",
  );

  /* ───────────────────────────────────────────────────────────────────────
   * 4 · EL CRITERIO TRANSVERSAL: ni un `dark:` de color
   * ─────────────────────────────────────────────────────────────────────── */
  section("4 · criterio transversal: ni un `dark:` de color en el markup");
  const UTILIDADES = "bg|text|border|ring|fill|stroke|divide|outline|decoration|accent|caret|placeholder";
  let leftovers = 0;
  for (const f of fuentes) {
    const limpio = sinComentarios(f.txt);
    const m = [...limpio.matchAll(new RegExp(`dark:(?:${UTILIDADES})-[a-z0-9\\[\\]#/]+`, "g"))];
    for (const x of m) {
      leftovers += 1;
      console.log(`      ${f.rel}: ${x[0]}`);
    }
  }
  check("cero `dark:` de color en el markup", leftovers, 0);

  /* ───────────────────────────────────────────────────────────────────────
   * 5 · EL MARCADOR: la marca de la app
   * ─────────────────────────────────────────────────────────────────────── */
  section("5 · la marca");
  checkTrue(
    "la marca usa el icono `Wallet` (no un emoji)",
    /<Wallet[^>]*\/>[\s\S]{0,120}Mis/.test(texto("components\\Header.tsx")),
    "la marca no usa `Wallet`",
  );
  checkTrue(
    "la marca usa el token `success` (no un color de fábrica)",
    /text-success/.test(texto("components\\Header.tsx")),
    "la marca no usa `text-success`",
  );
}

await correrBateria({ main, etiqueta: "30-iconos-y-marca" });
