#!/usr/bin/env node
/**
 * 04 · SALUD DEL DELTA F4.5 (monedas en el motor de voz).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ MIDE
 * ─────────────────────────────────────────────────────────────────────────────
 *   · TIPOS: `tsc --noEmit` en el proyecto entero.
 *   · TESTS: la suite del motor de voz + las sondas de contrato de F4.5.
 *   · COBERTURA ÚTIL: líneas ejecutadas de los módulos del delta por los tests
 *     de voz, con foco en el bloque de reglas de moneda y en el fallback de la
 *     ruta. Usa `@vitest/coverage-v8` (devDependency opcional: si no está, el
 *     script lo dice y NO lo cuenta como verde — lección D15).
 *   · MUTANTES: rompe a propósito cada regla nueva y exige que algún test la
 *     mate. Una mutación que sobrevive es una regla que nadie está cuidando:
 *     hay tests que pasan por casualidad, no por contrato.
 *   · COMPLEJIDAD: ramas por función en los archivos del delta (ESLint).
 *
 * No necesita base de datos. No reformatea. Restaura cada archivo que muta.
 *
 *   node scripts/tester-quality/04-f45-monedas.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

let ok = 0;
const fails = [];
const skips = [];

function check(name, condition, detail = "") {
  if (condition) {
    ok += 1;
    console.log(`ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function info(message) {
  console.log(`info ${message}`);
}

function run(command) {
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/* ── 0 · Archivos del delta ────────────────────────────────────────────────── */
const PROD_TESTED = [
  "app/api/parse/route.ts",
  "lib/voice-capture/resolve.ts",
  "lib/voice-capture/prompt.ts",
  "lib/voice-capture/provider.ts",
  "lib/voice-capture/schema.ts",
];
const LINT_FILES = [...PROD_TESTED, "app/page.tsx"];
const TEST_FILES = [
  "lib/voice-capture/schema.test.ts",
  "lib/voice-capture/resolve.test.ts",
  "lib/voice-capture/prompt.test.ts",
  "lib/voice-capture/route.test.ts",
];

/* ── 1 · Tipos ─────────────────────────────────────────────────────────────── */
const tsc = run("npx tsc --noEmit");
check("typecheck estricto (tsc --noEmit) sin errores", tsc.status === 0, tsc.out.slice(-1200));
info(`tsc exit=${tsc.status}`);

/* ── 2 · Tests del motor de voz ────────────────────────────────────────────── */
const voz = run("npx vitest run lib/voice-capture");
const resumen = voz.out.match(/Tests\s+(\d+) passed(?:\s+\|\s+(\d+) skipped)?\s+\((\d+)\)/);
info(
  `voice-capture: ${resumen?.[1] ?? "?"} passed, ${resumen?.[2] ?? "0"} skipped`,
);
check("la suite del motor de voz pasa completa", voz.status === 0, voz.out.slice(-1200));

const sondas = run(
  "npx vitest run --config scripts/tester-quality/vitest.f45.config.mts",
);
check(
  "las sondas de contrato de F4.5 pasan (prioridad y listas vacías)",
  sondas.status === 0,
  sondas.out.slice(-1500),
);

/* ── 3 · Cobertura útil ────────────────────────────────────────────────────── */
const COV_DIR = path.join(ROOT, "reports", "quality", "f45");
const coverageDisponible = fs.existsSync(
  path.join(ROOT, "node_modules", "@vitest", "coverage-v8"),
);

const cobertura = new Map();
if (!coverageDisponible) {
  skips.push("cobertura no medida: falta @vitest/coverage-v8");
  console.log(
    "SKIP cobertura: falta `@vitest/coverage-v8` (npm i -D @vitest/coverage-v8@5.0.4). NO se cuenta como verde.",
  );
} else {
  fs.rmSync(COV_DIR, { recursive: true, force: true });
  const corrida = run(
    `npx vitest run ${TEST_FILES.join(" ")} --coverage --coverage.provider=v8 --coverage.reporter=json --coverage.reportsDirectory=${path
      .relative(ROOT, COV_DIR)
      .replace(/\\/g, "/")} --coverage.include="lib/voice-capture/**" --coverage.include="app/api/parse/**" --coverage.exclude="**/*.test.ts"`,
  );
  check("los 4 archivos de test del delta pasan (base de la cobertura)", corrida.status === 0, corrida.out.slice(-1200));

  const archivo = path.join(COV_DIR, "coverage-final.json");
  if (!fs.existsSync(archivo)) {
    skips.push("cobertura no medida: el reporte JSON no se generó");
    console.log("SKIP cobertura: el reporte JSON no se generó.");
  } else {
    const crudo = JSON.parse(fs.readFileSync(archivo, "utf8"));
    for (const [ruta, datos] of Object.entries(crudo)) {
      const relativa = path.relative(ROOT, ruta).replace(/\\/g, "/");
      if (!PROD_TESTED.includes(relativa)) continue;
      const lineas = new Map(); // línea → ¿alguna sentencia ejecutada?
      for (const [id, sentencia] of Object.entries(datos.statementMap ?? {})) {
        const linea = sentencia?.start?.line;
        if (!linea) continue;
        const previo = lineas.get(linea) ?? false;
        lineas.set(linea, previo || (datos.s?.[id] ?? 0) > 0);
      }
      const total = lineas.size;
      const cubiertas = [...lineas.values()].filter(Boolean).length;
      cobertura.set(relativa, {
        total,
        cubiertas,
        lineas: lineas, // línea → cubierta
      });
    }
  }
}

for (const [file, datos] of cobertura) {
  const pct = datos.total > 0 ? ((datos.cubiertas / datos.total) * 100).toFixed(1) : "0.0";
  info(`cobertura ${file}: ${datos.cubiertas}/${datos.total} líneas con sentencia (${pct}%)`);
}

/** Cobertura de un rango de líneas (1-based, inclusive). */
function coberturaRegion(file, desde, hasta) {
  const datos = cobertura.get(file);
  if (!datos) return null;
  const enRango = [...datos.lineas.entries()].filter(
    ([linea]) => linea >= desde && linea <= hasta,
  );
  const faltantes = enRango.filter(([, cubierta]) => !cubierta).map(([linea]) => linea);
  return { total: enRango.length, faltantes };
}

const resolveLines = read("lib/voice-capture/resolve.ts").split(/\r?\n/);
const desdeMonedas = resolveLines.findIndex((l) => l.includes("── MONEDAS ──")) + 1;
const hastaMonedas = resolveLines.findIndex((l) => l.includes("── FECHA EN EL FUTURO ──")) + 1;
const monedas = coberturaRegion("lib/voice-capture/resolve.ts", desdeMonedas, hastaMonedas - 1);
check(
  "bloque de reglas de moneda de resolve.ts cubierto por los tests",
  monedas !== null && monedas.faltantes.length === 0,
  monedas ? `líneas sin cubrir: ${monedas.faltantes.join(", ")}` : "sin datos de cobertura",
);
if (monedas) {
  info(
    `cobertura bloque MONEDAS resolve.ts (${desdeMonedas}-${hastaMonedas - 1}): ${
      monedas.total - monedas.faltantes.length
    }/${monedas.total}`,
  );
}

const routeLines = read("app/api/parse/route.ts").split(/\r?\n/);
const desdeFallback = routeLines.findIndex((l) => l.includes("async function loadEnabledCurrencies")) + 1;
const hastaFallback = routeLines.findIndex((l) => l.includes("export async function POST")) + 1;
const fallback = coberturaRegion("app/api/parse/route.ts", desdeFallback, hastaFallback - 1);
check(
  "fallback de loadEnabledCurrencies cubierto por los tests de la ruta",
  fallback !== null && fallback.faltantes.length === 0,
  fallback ? `líneas sin cubrir: ${fallback.faltantes.join(", ")}` : "sin datos de cobertura",
);
if (fallback) {
  info(
    `cobertura fallback /api/parse (${desdeFallback}-${hastaFallback - 1}): ${
      fallback.total - fallback.faltantes.length
    }/${fallback.total}`,
  );
}

/* ── 4 · Mutantes ──────────────────────────────────────────────────────────── */
const MUTANTES = [
  {
    nombre: "regla 1: completa currency nula desde la cuenta",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: "if (currency === null && sourceAccount) {",
    reemplazar: "if (false && currency === null && sourceAccount) {",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "regla 2: moneda fuera de las habilitadas",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: "if (currency !== null && !context.currencies.includes(currency)) {",
    reemplazar: "if (false) {",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "regla 3: transferencia cruzada",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: 'kind === "TRANSFER" &&\n      sourceAccount &&\n      targetAccount &&',
    reemplazar: 'false &&\n      sourceAccount &&\n      targetAccount &&',
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "regla 4: moneda distinta de la cuenta",
    archivo: "lib/voice-capture/resolve.ts",
    buscar:
      "currency !== null &&\n      sourceAccount &&\n      currency !== sourceAccount.currency",
    reemplazar: "false &&\n      sourceAccount &&\n      currency !== sourceAccount.currency",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "dedupe: una sola aclaración currency por movimiento",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: "if (existing) {",
    reemplazar: "if (false) {",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "enriquecimiento de options de una aclaración existente",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: "if (options && !existing.options?.length) existing.options = options;",
    reemplazar:
      "if (false && options && !existing.options?.length) existing.options = options;",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "el movimiento resuelto lleva currency",
    archivo: "lib/voice-capture/resolve.ts",
    buscar: "      ...item,\n      kind,\n      currency,\n",
    reemplazar: "      ...item,\n      kind,\n",
    tests: ["lib/voice-capture/resolve.test.ts"],
  },
  {
    nombre: "schema: default null de currency",
    archivo: "lib/voice-capture/schema.ts",
    buscar: "currency: z.string().nullable().default(null),",
    reemplazar: "currency: z.string().nullable(),",
    tests: ["lib/voice-capture/schema.test.ts"],
  },
  {
    nombre: "prompt: nombre llano de cada moneda habilitada",
    archivo: "lib/voice-capture/prompt.ts",
    buscar: "isCurrency(code) ? `- ${code} (${currencyNoun(code)})` : `- ${code}`,",
    reemplazar: "`- ${code}`,",
    tests: ["lib/voice-capture/prompt.test.ts"],
  },
  {
    nombre: "ruta: fallback a ARS cuando settings no tiene fila o lista",
    archivo: "app/api/parse/route.ts",
    buscar: "return currencies.length > 0 ? currencies : [DEFAULT_CURRENCY];",
    reemplazar: "return currencies;",
    tests: ["lib/voice-capture/route.test.ts"],
  },
];

const sobrevivientes = [];
for (const mutante of MUTANTES) {
  const absolute = path.join(ROOT, mutante.archivo);
  const original = fs.readFileSync(absolute);
  try {
    const texto = original.toString("utf8");
    if (!texto.includes(mutante.buscar)) {
      sobrevivientes.push(`${mutante.nombre} (no aplicable)`);
      fails.push(`mutante no aplicable: ${mutante.nombre}`);
      console.log(`FAIL mutante no aplicable: ${mutante.nombre}`);
      continue;
    }
    fs.writeFileSync(absolute, texto.replace(mutante.buscar, mutante.reemplazar), "utf8");
    const resultado = run(`npx vitest run ${mutante.tests.join(" ")}`);
    if (resultado.status !== 0) {
      ok += 1;
      console.log(`ok   mutante matado: ${mutante.nombre}`);
    } else {
      sobrevivientes.push(mutante.nombre);
      fails.push(`mutante sobrevive: ${mutante.nombre}`);
      console.log(`FAIL mutante SOBREVIVE: ${mutante.nombre}`);
    }
  } finally {
    fs.writeFileSync(absolute, original);
    if (!fs.readFileSync(absolute).equals(original)) {
      console.log(`FAIL no se pudo restaurar ${mutante.archivo}`);
      process.exit(2);
    }
  }
}
info(`mutantes: ${MUTANTES.length - sobrevivientes.length}/${MUTANTES.length} matados`);

/* ── 5 · Complejidad de los archivos del delta ─────────────────────────────── */
const eslint = run(
  `npx eslint ${LINT_FILES.filter((f) => f.endsWith(".ts")).join(
    " ",
  )} --rule "{\\"complexity\\":[\\"warn\\",15]}" --format json`,
);
const complejidad = [];
try {
  const inicio = eslint.out.indexOf("[");
  const parsed = JSON.parse(eslint.out.slice(inicio));
  for (const file of parsed) {
    for (const message of file.messages) {
      if (message.ruleId === "complexity") {
        complejidad.push(
          `${path.relative(ROOT, file.filePath)}:${message.line} ${message.message}`,
        );
      }
    }
  }
} catch {
  info("complejidad: no se pudo parsear la salida de ESLint");
}
info(`complejidad: ${complejidad.length} función(es) con >15 ramas`);
for (const item of complejidad) info(`  ${item}`);

/* ── Cierre ────────────────────────────────────────────────────────────────── */
console.log(`\nRESULT ok=${ok} fail=${fails.length}`);
for (const skip of skips) console.log(`  … ${skip}`);
if (fails.length > 0) {
  for (const name of fails) console.log(`  ✗ ${name}`);
  process.exit(1);
}
