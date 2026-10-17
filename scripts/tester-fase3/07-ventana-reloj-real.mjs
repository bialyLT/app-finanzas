#!/usr/bin/env node
/**
 * Test 07 — La puesta al día con el reloj REAL: UNA corrida materializa toda la
 * ventana vencida, inclusive la ocurrencia de HOY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * El generador promete "desde la última vez, sin cursor": si la app no se corrió
 * por tres meses, la primera corrida tiene que materializar las ocurrencias de
 * esos tres meses Y la de hoy. Si el borde `<= today` fuera `< today`, la del
 * día de hoy se postergaría a mañana — el sueldo que se acredita hoy no
 * aparecería hasta el día siguiente.
 *
 * Escenario (reloj real, hoy = 2026-10-17):
 *   · regla A: MONTHLY ancla 17, startDate 2026-07-01 → vencidas: 07-17, 08-17, 09-17, 10-17 (4)
 *   · regla B: MONTHLY ancla 1,  startDate 2026-08-01 → vencidas: 08-01, 09-01, 10-01 (3)
 *   · UNA sola corrida → materialized = 7 (las dos reglas, toda la ventana)
 */

import {
  PrismaClient,
  api,
  check,
  checkDeep,
  checkTrue,
  cleanupTag,
  localToday,
  login,
  occurrenceDates,
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_07_";
const prisma = new PrismaClient();

async function main() {
  const hoy = localToday();
  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", { name: `${TAG}Banco`, kind: "BANK", openingBalance: "0" });
  const accountId = banco.body?.id;

  const mk = (title, dayOfMonth, startDate) =>
    post("/api/recurrence/rules", {
      title: `${TAG}${title}`,
      kind: "EXPENSE",
      amount: "100",
      accountId,
      categoryName: `${TAG}Cat`,
      freq: "MONTHLY",
      dayOfMonth,
      startDate,
      postingMode: "NOTIFY",
    });

  section(`Puesta al día con el reloj real (hoy = ${hoy})`);
  const reglaA = await mk("A", 17, "2026-07-01");
  const reglaB = await mk("B", 1, "2026-08-01");
  check("regla A creada (201)", reglaA.status, 201);
  check("regla B creada (201)", reglaB.status, 201);

  const corrida = await post("/api/recurrence/run", {});
  check("UNA corrida materializa las 7 (4 + 3)", corrida.body?.materialized, 7);
  check("la corrida reporta dos reglas", corrida.body?.rules?.length, 2);
  const porRegla = Object.fromEntries((corrida.body?.rules ?? []).map((r) => [r.ruleId, r.materialized]));
  check("la regla A materializó 4", porRegla[reglaA.body?.id], 4);
  check("la regla B materializó 3", porRegla[reglaB.body?.id], 3);
  check("todas quedaron pendientes (NOTIFY)", corrida.body?.pending, 7);

  checkDeep("fechas de la regla A (mes a mes, con la de HOY inclusive)", await occurrenceDates(prisma, reglaA.body?.id), [
    "2026-07-17",
    "2026-08-17",
    "2026-09-17",
    hoy,
  ]);
  checkDeep("fechas de la regla B", await occurrenceDates(prisma, reglaB.body?.id), [
    "2026-08-01",
    "2026-09-01",
    "2026-10-01",
  ]);
  checkTrue("la ocurrencia de HOY está (<= today, no < today)", (await occurrenceDates(prisma, reglaA.body?.id)).includes(hoy));

  const segunda = await post("/api/recurrence/run", {});
  check("la corrida siguiente no materializa nada", segunda.body?.materialized, 0);

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
