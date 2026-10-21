#!/usr/bin/env node
/**
 * Imprime el ESTADO de una base, con números. Sólo lee: no escribe ni borra.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 *
 * En esta instalación la base `finanzas_dev` tiene datos REALES de la persona
 * (una cuenta con saldo inicial, sus categorías, su regla de recurrencia y sus
 * movimientos). Los gates de la app siembran y borran: por eso corren contra
 * `finanzas_test`, en otra instancia (ver `scripts/gates.ps1`).
 *
 * Con dos bases en juego, la pregunta "el gate me borró los datos?" se responde
 * MIRANDO, no suponiendo. Este script imprime las cuatro tablas que importan y
 * su contenido, así que el antes y el después se comparan con números en la
 * mano.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USO
 *
 *     node scripts/db-state.mjs                      # la base de DATABASE_URL
 *     node scripts/db-state.mjs --env=DATABASE_URL_TEST
 *     node scripts/db-state.mjs --url="postgresql://…"
 *
 * Salida: un resumen por tabla (conteo) y el detalle de cada fila.
 */

import { PrismaClient } from "@prisma/client";

try {
  // Nativo desde Node 20.6. NO pisa lo que ya está en el entorno: si el
  // proceso tiene DATABASE_URL, ese manda (es lo que permite apuntar a la base
  // de tests sin tocar el `.env`).
  process.loadEnvFile();
} catch {
  // Sin `.env` se usan las variables del entorno.
}

const args = process.argv.slice(2);

function opt(name) {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : "";
}

const url = opt("url") || process.env[opt("env") || "DATABASE_URL"] || "";

/** El nombre de la base, para que el reporte diga contra QUÉ base se corrió. */
function databaseName(value) {
  try {
    const path = new URL(value).pathname.replace(/^\//, "");
    return path || "(sin nombre)";
  } catch {
    return "(no se pudo leer)";
  }
}

if (!url) {
  console.error(
    "\n  Falta la URL de la base.\n" +
      "  Usá --env=DATABASE_URL_TEST o --url=\"postgresql://…\".\n",
  );
  process.exit(1);
}

const db = new PrismaClient({ datasourceUrl: url });

function linea(vacio = "—") {
  return vacio && vacio !== "" ? vacio : "—";
}

async function main() {
  console.log(`\nBase: ${databaseName(url)}`);
  console.log(`URL:  ${url.replace(/:\/\/[^@]*@/, "://***@")}\n`);

  const [accounts, categories, rules, movements, occurrences] = await Promise.all([
    db.account.findMany({ orderBy: { createdAt: "asc" } }),
    db.category.findMany({ orderBy: { normalizedName: "asc" } }),
    db.recurrenceRule.findMany({
      orderBy: { createdAt: "asc" },
      include: { category: true, account: true },
    }),
    db.movement.findMany({
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: { category: true, account: true },
    }),
    db.recurrenceOccurrence.findMany({ orderBy: { dueDate: "asc" } }),
  ]);

  // ── Cuentas ────────────────────────────────────────────────────────────────
  console.log(`CUENTAS: ${accounts.length}`);
  for (const account of accounts) {
    console.log(
      `  · ${account.name} · ${account.kind} · saldo inicial ${account.openingBalance.toFixed(2)}` +
        `${account.archived ? " · archivada" : ""}` +
        // ─────────────────────────────────────────────────────────────────────
        // LA BANDERITA (el mes en el que el saldo inicial cuenta como ingreso)
        //
        // Esta línea NO es decorativa: la comparación "antes y después" de los
        // gates (ver `scripts/gates.ps1`) es una comparación de TEXTO. Si la
        // banderita no está en el texto, un gate que la apagara (o la
        // encendiera) daría «finanzas_dev quedó INTACTA» con la mentira
        // adentro. La banderita es una decisión de la persona: si se pierde, no
        // se puede recuperar (es una declaración, no un saldo).
        // ─────────────────────────────────────────────────────────────────────
        `${
          account.openingIncomeMonth
            ? ` · ingreso de ${account.openingIncomeMonth.toISOString().slice(0, 7)}`
            : ""
        }`,
    );
  }

  // ── Categorías ─────────────────────────────────────────────────────────────
  console.log(`\nCATEGORÍAS: ${categories.length}`);
  for (const category of categories) {
    console.log(`  · ${category.name} · ${category.kind}`);
  }

  // ── Reglas de recurrencia ──────────────────────────────────────────────────
  console.log(`\nREGLAS DE RECURRENCIA: ${rules.length}`);
  for (const rule of rules) {
    console.log(
      `  · ${rule.title} · ${rule.kind} · ${rule.amount.toFixed(2)} · ` +
        `${rule.freq}${rule.interval > 1 ? `×${rule.interval}` : ""} · ` +
        `${rule.postingMode} · ${rule.status} · ` +
        `cuenta ${linea(rule.account?.name)} · categoría ${linea(rule.category?.name)}` +
        `${rule.category ? ` (${rule.category.kind})` : ""}`,
    );
  }

  // ── Movimientos ────────────────────────────────────────────────────────────
  console.log(`\nMOVIMIENTOS: ${movements.length}`);
  for (const movement of movements) {
    const fecha = movement.date.toISOString().slice(0, 10);
    console.log(
      `  · ${fecha} · ${movement.kind.padEnd(8)} · ${movement.amount.toFixed(2).padStart(12)} · ` +
        `cuenta ${linea(movement.account?.name)} · ` +
        `categoría ${linea(movement.category?.name)}` +
        `${movement.category ? ` (${movement.category.kind})` : ""}` +
        `${movement.description ? ` · "${movement.description}"` : ""}`,
    );
  }

  // ── El invariante, a ojo ───────────────────────────────────────────────────
  const violadores = movements.filter(
    (movement) =>
      movement.category &&
      movement.kind !== "TRANSFER" &&
      movement.category.kind !== movement.kind,
  );
  console.log(`\nMOVIMIENTOS CON CATEGORÍA DE OTRO TIPO: ${violadores.length}`);
  for (const movement of violadores) {
    console.log(
      `  ! ${movement.date.toISOString().slice(0, 10)} · ${movement.kind} · ` +
        `${movement.amount.toFixed(2)} · categoría "${movement.category.name}" (${movement.category.kind})`,
    );
  }

  console.log(`\nOCURRENCIAS: ${occurrences.length}`);
  for (const occurrence of occurrences) {
    console.log(
      `  · ${occurrence.dueDate.toISOString().slice(0, 10)} · ${occurrence.status}` +
        `${occurrence.movementId ? " · tiene movimiento" : ""}`,
    );
  }

  console.log("");
}

main()
  .catch((error) => {
    console.error(`\n  No se pudo leer la base: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
