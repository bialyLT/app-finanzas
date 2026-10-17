#!/usr/bin/env node
/**
 * Test 03 — Tope de 500 y `capped` honesto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * Una regla diaria abandonada tiene cientos de fechas vencidas. El generador
 * corta en 500 por corrida y lo dice (`capped: true`): un tope mudo perdería
 * fechas en silencio — el pecado clásico del truncado sin aviso.
 *
 * El caso exacto: regla DAILY NOTIFY con startDate = hoy − 600 días.
 * Fechas vencidas (hoy inclusive) = 601 (cálculo a mano: 600 días hacia atrás
 * más el de hoy). Entonces:
 *   · corrida 1 → 500 materializadas, capped=true;
 *   · corrida 2 → las 101 restantes, capped=false;
 *   · corrida 3 → 0, y el total sigue siendo 601 (SIN duplicados).
 */

import {
  PrismaClient,
  addDaysCal,
  api,
  check,
  checkTrue,
  cleanupTag,
  localToday,
  login,
  occurrenceDates,
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_03_";
const prisma = new PrismaClient();

async function main() {
  const hoy = localToday();
  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", {
    name: `${TAG}Banco`,
    kind: "BANK",
    openingBalance: "0",
  });
  const accountId = banco.body?.id;

  const startDate = addDaysCal(hoy, -600);
  section(`Escenario: DAILY desde ${startDate} hasta hoy (${hoy}) → 601 fechas vencidas`);

  const regla = await post("/api/recurrence/rules", {
    title: `${TAG}diaria abandonada`,
    kind: "EXPENSE",
    amount: "100",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "DAILY",
    startDate,
    postingMode: "NOTIFY",
  });
  check("crea la regla (201)", regla.status, 201);
  const ruleId = regla.body?.id;

  /* ── Corrida 1: tope de 500 ────────────────────────────────────────────── */
  section("Corrida 1 · materializa 500 y avisa");
  const run1 = await post("/api/recurrence/run", {});
  check("materialized = 500 (el tope)", run1.body?.materialized, 500);
  check("pending = 500 (NOTIFY: no postea)", run1.body?.pending, 500);
  check("capped = true (quedan fechas)", run1.body?.capped, true);
  const count1 = await prisma.recurrenceOccurrence.count({ where: { ruleId } });
  check("en la base hay 500 filas", count1, 500);

  /* ── Corrida 2: completa la puesta al día ──────────────────────────────── */
  section("Corrida 2 · completa sin duplicar");
  const run2 = await post("/api/recurrence/run", {});
  check("materialized = 101 (las que faltaban)", run2.body?.materialized, 101);
  check("capped = false (ya está al día)", run2.body?.capped, false);

  const fechas = await occurrenceDates(prisma, ruleId);
  check("total de ocurrencias = 601", fechas.length, 601);
  check("fechas únicas = 601 (sin duplicados)", new Set(fechas).size, 601);
  check("la primera es el startDate", fechas[0], startDate);
  check("la última es hoy (inclusive)", fechas[fechas.length - 1], hoy);
  check("cada fecha es exactamente un día después de la anterior", fechas.every((f, i) => i === 0 || f === addDaysCal(fechas[i - 1], 1)), true);

  /* ── Corrida 3: nada nuevo ─────────────────────────────────────────────── */
  section("Corrida 3 · sin nada nuevo");
  const run3 = await post("/api/recurrence/run", {});
  check("materialized = 0", run3.body?.materialized, 0);
  check("capped = false", run3.body?.capped, false);
  const count3 = await prisma.recurrenceOccurrence.count({ where: { ruleId } });
  check("sigue habiendo 601 filas", count3, 601);

  /* ── La vista no miente con la bandeja truncada ────────────────────────── */
  section("La bandeja de la vista está truncada a 500 y lo dice");
  const { body: vista } = await api("/api/recurrence");
  check("pending.length = 500 (tope de la bandeja)", vista?.pending?.length, 500);
  check("truncated = true", vista?.truncated, true);
  const pendientesDeLaRegla = vista.pending.filter((o) => o.ruleId === ruleId).length;
  check("las 500 de la bandeja son de la regla", pendientesDeLaRegla, 500);
  checkTrue("la más vieja primero (la bandeja se resuelve en orden)", vista.pending[0]?.dueDate === startDate, vista.pending[0]?.dueDate);

  section("Limpieza");
  await cleanupTag(prisma, TAG);
  check("quedan 0 reglas de prueba", await prisma.recurrenceRule.count({ where: { title: { startsWith: TAG } } }), 0);
}

main()
  .then(() => {
    const ok = summary();
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
