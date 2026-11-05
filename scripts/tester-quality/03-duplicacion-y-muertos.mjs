#!/usr/bin/env node
/**
 * 03 · DUPLICACIÓN Y CÓDIGO MUERTO del delta F4.4b.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN SCRIPT PROPIO Y NO `jscpd` / `knip`
 * ─────────────────────────────────────────────────────────────────────────────
 * No están instalados y agregar dependencias para medir es cambiar el proyecto
 * que se mide. Las dos medidas que importan acá se hacen en 100 líneas:
 *
 *   · DUPLICACIÓN: ventanas de N líneas normalizadas (sin espacios, sin líneas
 *     de llaves sueltas ni comentarios) que aparecen en dos archivos distintos.
 *     Un bloque de 8+ líneas iguales en dos caminos es una definición repetida
 *     —el origen de los bugs de "un lado cambió y el otro no"—.
 *   · CÓDIGO MUERTO: cada `export` de los archivos del delta y cuántas veces se
 *     usa FUERA de su archivo (tests incluidos: un export que sólo usa su test
 *     está muerto para el producto).
 *
 * Corre en 1 s y no necesita base de datos.
 *   node scripts/tester-quality/03-duplicacion-y-muertos.mjs
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIN_LINEAS = 8;

let ok = 0;
const fails = [];

function check(name, condition, detail = "") {
  if (condition) {
    ok += 1;
    console.log(`ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(command) {
  try {
    return execSync(command, { cwd: ROOT, encoding: "utf8", shell: true });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Archivos del delta: los nuevos y los tocados, sin tests ni scripts. */
function deltaFiles() {
  const out = run("git status --porcelain");
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|repro)\.[tj]sx?$/.test(file))
    .filter((file) => !file.startsWith("scripts/"));
}

/** Línea normalizada, o `null` si no aporta a un bloque duplicado. */
function normalizar(linea) {
  const limpia = linea.trim();
  if (limpia === "" || limpia === "{" || limpia === "}" || limpia === ");") {
    return null;
  }
  if (limpia.startsWith("//") || limpia.startsWith("*") || limpia.startsWith("/*")) {
    return null;
  }
  return limpia;
}

/** Busca bloques normalizados de `minLineas` repetidos entre archivos. */
function buscarDuplicados(minLineas) {
  const ventanas = new Map();

  for (const archivo of archivos) {
    const lineas = read(archivo).split(/\r?\n/);
    const normalizadas = lineas.map(normalizar);
    for (let i = 0; i + minLineas <= normalizadas.length; i += 1) {
      const bloque = normalizadas.slice(i, i + minLineas);
      if (bloque.some((linea) => linea === null)) continue;
      const clave = bloque.join("\n");
      const previas = ventanas.get(clave) ?? [];
      // Sólo interesa la repetición ENTRE archivos: dentro del mismo archivo una
      // ventana se solapa consigo misma en cada corrida.
      if (!previas.some((p) => p.archivo === archivo)) {
        previas.push({ archivo, linea: i + 1 });
        ventanas.set(clave, previas);
      }
    }
  }

  return {
    ventanas: ventanas.size,
    grupos: [...ventanas.entries()].filter(([, sitios]) => sitios.length > 1),
  };
}

/* ── 1 · Duplicación entre archivos del delta ──────────────────────────────── */
const archivos = deltaFiles();

// Dos umbrales a propósito: 12 líneas es la frontera de "lógica repetida" (el
// bug de un lado que cambia y el otro no), 8 es la de "boilerplate" (JSX de una
// tarjeta, un literal de ceros). El gate exige 0 de la primera; la segunda se
// informa y se clasifica en el informe.
const duplicadosLargos = buscarDuplicados(12);
check(
  "sin bloques de 12+ líneas duplicados entre archivos del delta (lógica repetida)",
  duplicadosLargos.grupos.length === 0,
  duplicadosLargos.grupos
    .slice(0, 4)
    .map(([, sitios]) => sitios.map((s) => `${s.archivo}:${s.linea}`).join(" ↔ "))
    .join(" | "),
);

const duplicadosCortos = buscarDuplicados(MIN_LINEAS);
console.log(
  `info duplicación: ${archivos.length} archivos · ${MIN_LINEAS}+ líneas: ${duplicadosCortos.grupos.length} grupo(s) · 12+ líneas: ${duplicadosLargos.grupos.length} grupo(s)`,
);
for (const [, sitios] of duplicadosCortos.grupos) {
  console.log(`     ${sitios.map((s) => `${s.archivo}:${s.linea}`).join(" ↔ ")}`);
}

/* ── 2 · Código muerto: exports AGREGADOS por el delta ────────────────────── */
const EXPORT_RE =
  /^\+?\s*export\s+(?:default\s+)?(?:async\s+)?(function|const|let|class|interface|type)\s+([A-Za-z0-9_]+)/gm;

/** Un export con cuerpo (función, constante, clase) o sólo un tipo. */
const esValor = (kind) => ["function", "const", "let", "class"].includes(kind);

/**
 * Los archivos del repo (trackeados + nuevos, expandiendo carpetas nuevas).
 *
 * `git ls-files` no ve lo que todavía no está en el índice, y `git status`
 * colapsa una carpeta nueva en una sola entrada (`?? app/api/settings/`): sin
 * expandirla, todo lo que ese archivo nuevo importa parece muerto.
 */
function archivosDelRepo() {
  const lista = [
    ...run("git ls-files").split(/\r?\n/).filter(Boolean),
    ...run("git status --porcelain")
      .split(/\r?\n/)
      .filter((linea) => linea.startsWith("??"))
      .map((linea) => linea.slice(3).trim()),
  ];

  const completo = [];
  for (const entrada of lista) {
    const ruta = path.join(ROOT, entrada);
    if (!fs.existsSync(ruta)) continue;
    if (fs.statSync(ruta).isDirectory()) {
      for (const hijo of fs.readdirSync(ruta, { recursive: true })) {
        completo.push(`${entrada.replace(/\/$/, "")}/${String(hijo).replace(/\\/g, "/")}`);
      }
    } else {
      completo.push(entrada);
    }
  }

  return [...new Set(completo)]
    .filter((file) => /\.(ts|tsx|mjs)$/.test(file))
    .filter((file) => !file.startsWith("scripts/tester-quality/"));
}

/** Los exports que el DELTA agregó: `{ archivo, nombre, tipo }`. */
function exportsDelDelta() {
  const trackeados = new Set(
    run("git ls-files").split(/\r?\n/).filter(Boolean),
  );
  const diff = run("git diff -U0");
  const encontrados = [];
  let actual = null;

  for (const linea of diff.split(/\r?\n/)) {
    if (linea.startsWith("+++ b/")) {
      actual = linea.slice(6).trim();
      continue;
    }
    if (!actual || !linea.startsWith("+") || linea.startsWith("+++")) continue;
    for (const match of linea.matchAll(EXPORT_RE)) {
      encontrados.push({ archivo: actual, nombre: match[2], tipo: match[1] });
    }
  }

  // Los archivos nuevos no aparecen en `git diff`: se leen enteros.
  for (const archivo of archivos) {
    if (!trackeados.has(archivo)) {
      for (const match of read(archivo).matchAll(EXPORT_RE)) {
        encontrados.push({ archivo, nombre: match[2], tipo: match[1] });
      }
    }
  }

  return encontrados;
}

const todos = archivosDelRepo();
const cache = new Map();
const texto = (file) => {
  if (!cache.has(file)) cache.set(file, read(file));
  return cache.get(file);
};

const muertos = [];
const soloTests = [];
const tiposSinConsumidor = [];
for (const { archivo, nombre, tipo } of exportsDelDelta()) {
  const usos = todos
    .filter((otro) => otro !== archivo)
    .filter((otro) => new RegExp(`\\b${nombre}\\b`).test(texto(otro)));
  const delProducto = usos.filter(
    (otro) => !/\.(test|repro)\.[tj]sx?$/.test(otro),
  );

  if (usos.length === 0) {
    if (esValor(tipo)) muertos.push(`${archivo}:${nombre}`);
    else tiposSinConsumidor.push(`${archivo}:${nombre}`);
  } else if (delProducto.length === 0 && esValor(tipo)) {
    soloTests.push(`${archivo}:${nombre}`);
  }
}

check(
  "ningún valor exportado por el delta quedó sin ningún consumidor (código muerto)",
  muertos.length === 0,
  muertos.join(", "),
);
console.log(
  `info exports que sólo consumen los tests (superficie muerta para el producto): ${
    soloTests.length === 0 ? "ninguno" : soloTests.join(", ")
  }`,
);
console.log(
  `info tipos exportados sin consumidor externo (sólo documentan la firma): ${
    tiposSinConsumidor.length === 0 ? "ninguno" : tiposSinConsumidor.join(", ")
  }`,
);

/* ── 3 · Sin `any` nuevo en las líneas agregadas ───────────────────────────── */
const diff = run("git diff -U0");
const cualquierAny = diff
  .split(/\r?\n/)
  .filter((linea) => linea.startsWith("+") && !linea.startsWith("+++"))
  .filter((linea) => /:\s*any\b|\bas any\b|<any>/.test(linea));
check("sin `any` en las líneas agregadas del delta", cualquierAny.length === 0, cualquierAny.join(" | "));

/* ── 4 · Las claves de advisory lock tienen dueño único ────────────────────── */
// Un número mágico repetido en dos lugares es un deadlock esperando la fecha:
// el segundo dueño cree que serializa y en realidad se serializa CONTRA el
// primero. Resuelve también la forma con constante (`${SETTINGS_LOCK_KEY}`).
const claves = new Map();
for (const archivo of todos) {
  const fuente = texto(archivo);
  const constantes = new Map();
  for (const match of fuente.matchAll(/([A-Z0-9_]+_LOCK_KEY)\s*=\s*([0-9]+)/g)) {
    constantes.set(match[1], match[2]);
  }

  for (const match of fuente.matchAll(
    /pg_advisory_xact_lock\(\s*\$?\{?\s*(?:([0-9]+)|([A-Za-z0-9_]+))/g,
  )) {
    const clave = match[1] ?? constantes.get(match[2]) ?? `?${match[2]}`;
    if (!claves.has(clave)) claves.set(clave, []);
    claves.get(clave).push(archivo);
  }
}
const colisiones = [...claves.entries()].filter(([, dueños]) => dueños.length > 1);
check(
  "cada clave de pg_advisory_xact_lock tiene un solo dueño (sin colisión)",
  colisiones.length === 0,
  colisiones.map(([clave, dueños]) => `${clave}: ${dueños.join(", ")}`).join(" | "),
);
console.log(
  `info locks: ${[...claves.entries()].map(([clave, dueños]) => `${clave} → ${dueños[0]}`).join(" · ")}`,
);

/* ── Cierre ────────────────────────────────────────────────────────────────── */
console.log(`\nRESULT ok=${ok} fail=${fails.length}`);
if (fails.length > 0) {
  for (const name of fails) console.log(`  ✗ ${name}`);
  process.exit(1);
}
