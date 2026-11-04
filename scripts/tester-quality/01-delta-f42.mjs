#!/usr/bin/env node
/**
 * 01 · DELTA F4.2 (monedas) — salud estructural, no estilo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * Los gates duros del delta (typecheck, tests, lint de los archivos tocados) y
 * las invariantes estructurales que el delta puede romper en silencio:
 *
 *   1. `tsc --noEmit` en 0.
 *   2. La suite completa en verde (y cuenta passed/failed/skipped).
 *   3. `eslint` sobre `git status` en 0 ERRORES (los warnings preexistentes no
 *      son de esta fase; el total del repo se informa aparte).
 *   4. La regla "misma moneda → amount / distinta moneda → toAmount" está
 *      escrita en 5 lugares y en los 5 existen LAS DOS patas. Una pata sola es
 *      el bug que la fase elimina (acreditar 120.000 USD donde llegaron 100).
 *   5. Los 5 endpoints de plata que aceptan `?currency=` la validan con el
 *      módulo único (`parseCurrencyParam`), no con un default local.
 *   6. Ningún `any` nuevo en las líneas agregadas.
 *   7. Los números de consultas que documentan los comentarios coinciden con
 *      las consultas que el código realmente dispara (8 por `getAccountBalances`
 *      y 97 por serie de 12 meses). Un comentario que miente sobre el costo es
 *      deuda: alguien lo va a usar para decidir si optimiza.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE CORRE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/tester-quality/01-delta-f42.mjs
 *   node scripts/tester-quality/01-delta-f42.mjs --sin-tests   (sólo estático)
 *
 * Sale con código 1 si algún check falla. Imprime `RESULT ok=N fail=M`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SIN_TESTS = process.argv.includes("--sin-tests");

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
    const out = execSync(command, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    });
    return { status: 0, out };
  } catch (error) {
    return {
      status: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Los archivos que el delta tocó (tracked modificados + untracked nuevos). */
function touchedFiles() {
  const out = run("git status --porcelain").out;
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => /\.(ts|tsx)$/.test(file));
}

/* ── 1 · Tipos ─────────────────────────────────────────────────────────────── */
const tsc = run("npx tsc --noEmit");
check("tsc --noEmit", tsc.status === 0, tsc.out.split(/\r?\n/).slice(0, 5).join(" | "));

/* ── 2 · Tests ─────────────────────────────────────────────────────────────── */
if (!SIN_TESTS) {
  const tests = run("npm test");
  const summary = tests.out.match(/Tests\s+(.+)/)?.[1]?.trim() ?? "sin resumen";
  check(
    `npm test verde (${summary})`,
    tests.status === 0 && /failed/i.test(summary) === false,
    summary,
  );
}

/* ── 3 · Lint del delta ────────────────────────────────────────────────────── */
const touched = touchedFiles();
const lint = run(`npx eslint ${touched.map((f) => `"${f}"`).join(" ")}`);
const lintSummary = lint.out.match(/✖ (\d+) problems? \((\d+) errors?/);
const lintErrors = lintSummary ? Number(lintSummary[2]) : lint.status === 0 ? 0 : -1;
check(
  `eslint de los ${touched.length} archivos tocados: 0 errores`,
  lintErrors === 0,
  `errores=${lintErrors}`,
);

// El total del repo se informa, no se exige: los 15 errores son de UI y
// preexistentes a esta fase.
const lintRepo = run("npx eslint");
const repoSummary = lintRepo.out.match(/✖ (\d+) problems? \((\d+) errors?/);
console.log(
  `info eslint del repo entero: ${repoSummary ? `${repoSummary[1]} problemas / ${repoSummary[2]} errores (preexistentes)` : "sin problemas"}`,
);

/* ── 4 · La regla de las dos patas ─────────────────────────────────────────── */
// Cada sitio que suma transferencias ENTRANTES tiene que tener su pata
// same-currency (`amount`) y su pata cross-currency (`toAmount`).
const SITIOS = [
  { file: "lib/balance.ts", fn: "getAccountBalances", patas: ["amount", "toAmount"] },
  { file: "lib/queries.ts", fn: "movementCashFlow", patas: ["amount", "toAmount"] },
  { file: "lib/queries.ts", fn: "transferNetInCurrency", patas: ["amount", "toAmount"] },
  { file: "lib/queries.ts", fn: "getDebtReport", patas: ["amount", "toAmount"] },
  { file: "lib/loan-service.ts", fn: "capitalPaidByLoan", patas: ["amount", "toAmount"] },
];

for (const sitio of SITIOS) {
  const source = read(sitio.file);
  const start = source.indexOf(`function ${sitio.fn}`);
  const body = start === -1 ? "" : source.slice(start, start + 8000);
  const faltantes = sitio.patas.filter((pata) => !body.includes(`_sum: { ${pata}: true }`));
  check(
    `${sitio.file} · ${sitio.fn} tiene las dos patas`,
    start !== -1 && faltantes.length === 0,
    start === -1 ? "función no encontrada" : `faltan: ${faltantes.join(", ")}`,
  );
}

/* ── 5 · El borde HTTP usa el módulo único ─────────────────────────────────── */
const ENDPOINTS_CON_MONEDA = [
  "app/api/accounts/route.ts",
  "app/api/debts/route.ts",
  "app/api/reconciliation/route.ts",
  "app/api/reports/route.ts",
  "app/api/transactions/route.ts",
];
for (const file of ENDPOINTS_CON_MONEDA) {
  const source = read(file);
  check(
    `${file} valida ?currency= con parseCurrencyParam`,
    source.includes('from "@/lib/currency"') && source.includes("parseCurrencyParam("),
  );
}

// El sexto endpoint de plata (presupuestos) todavía no acepta moneda: se
// informa acá para que no se confunda con un olvido del delta.
const budgets = read("app/api/budgets/route.ts");
console.log(
  `info app/api/budgets/route.ts: ${budgets.includes("parseCurrencyParam") ? "acepta ?currency=" : "SIN ?currency= (ARS hardcodeado, comentario delega a F4.2)"}`,
);

/* ── 6 · Sin `any` nuevo ───────────────────────────────────────────────────── */
const diff = run("git diff -U0").out;
const anyNuevos = diff
  .split(/\r?\n/)
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .filter((line) => /\bany\b/.test(line));
check("sin `any` en las líneas agregadas del delta", anyNuevos.length === 0, anyNuevos.join(" | "));

/* ── 7 · El costo documentado es el real ───────────────────────────────────── */
const balanceSource = read("lib/balance.ts");
const queriesSource = read("lib/queries.ts");
const currencySource = read("lib/currency.ts");
const listaMonedas = currencySource.match(/export const CURRENCIES = \[([^\]]+)\]/)?.[1] ?? "";
const monedas = (listaMonedas.match(/"[A-Z]{3}"/g) ?? []).length;
const porMoneda = 2 * monedas; // same + cross, una consulta por moneda cada una
const fijas = 4; // accounts + income + expense + transferOut
const esperadas = fijas + porMoneda;

check(
  `lib/balance.ts documenta las ${esperadas} consultas que dispara (4 fijas + ${porMoneda} por moneda)`,
  monedas > 0 && balanceSource.includes(`${esperadas} consultas AGREGADAS`),
  `monedas=${monedas}`,
);
check(
  `la serie documenta 1 + ${esperadas}×12 = ${1 + esperadas * 12} consultas`,
  queriesSource.includes(
    `1 + ${esperadas} consultas agregadas por mes (12 meses = ${1 + esperadas * 12}`,
  ),
);

/* ── Cierre ────────────────────────────────────────────────────────────────── */
console.log(`\nRESULT ok=${ok} fail=${fails.length}`);
if (fails.length > 0) {
  for (const name of fails) console.log(`  ✗ ${name}`);
  process.exit(1);
}
