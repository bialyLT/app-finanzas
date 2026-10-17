#!/usr/bin/env node
/**
 * Test 02 — Clamp de fin de mes, fechas UTC−3, bordes del motor y GET quieto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. CLAMP CON ANCLA: "el 31" tiene que caer el 30/28 en los meses cortos y
 *    VOLVER al 31 en el mes siguiente. Si el ancla se "pega" al 28, el
 *    vencimiento se corre tres días y nadie entiende por qué (el bug clásico
 *    que el dev dice haber evitado).
 * 2. FECHAS UTC−3: la fecha de un movimiento posteado tiene que ser la fecha
 *    LOCAL de la ocurrencia. Con `toISOString()` un movimiento de hoy se
 *    guardaría como ayer (UTC−3 negativo), que es el bug B1/B2/B3 del ROADMAP.
 * 3. BORDES DEL MOTOR por la API: `endDate == startDate` (una sola ocurrencia),
 *    `count: 1`, ancla POSTERIOR al día de inicio (se pospone, no se adelanta),
 *    intervalo, YEARLY 29/02.
 * 4. `GET /api/recurrence` NO materializa: N recargas de la vista no crean
 *    ocurrencias (un GET que escribe postearía movimientos en un precargado).
 *
 * Cálculos a mano (hoy = 2026-10-17, verificado contra el reloj):
 *   · ancla 31 con inicio 2026-01-31 → próximas 5: 10-31, 11-30, 12-31, 01-31, 02-28
 *   · ancla 31 con inicio 2027-02-01 → 2027-02-28, 2027-03-31 (VUELVE al 31), 04-30, 05-31, 06-30
 *   · YEARLY 29/02 desde 2024-02-29 → 2027-02-28, 2028-02-29 (bisiesto), 2029-02-28…
 *   · MONTHLY ancla 3 con inicio 2026-09-15 → primera ocurrencia 2026-10-03
 *     (la de septiembre se pospone; adelantarla al 15 sería mentir el día).
 */

import {
  PrismaClient,
  addDaysCal,
  addMonthsCal,
  api,
  check,
  checkDeep,
  checkTrue,
  cleanupTag,
  login,
  localToday,
  occurrenceDates,
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_02_";
const prisma = new PrismaClient();

function ruleBody(accountId, overrides = {}) {
  return {
    title: `${TAG}regla`,
    kind: "EXPENSE",
    amount: "100",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "MONTHLY",
    startDate: "2026-01-31",
    postingMode: "NOTIFY",
    ...overrides,
  };
}

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
  check("cuenta de prueba creada (201)", banco.status, 201);

  const upcomingOf = async (ruleId) => {
    const { body } = await api("/api/recurrence");
    return (body?.rules ?? []).find((r) => r.id === ruleId)?.upcoming ?? null;
  };
  const deleteRule = async (ruleId) => {
    const res = await api(`/api/recurrence/rules?id=${ruleId}`, { method: "DELETE" });
    return res.status;
  };

  /* ── 1. Clamp de fin de mes ────────────────────────────────────────────── */
  section(`1 · Clamp 31 → 28/30 y VUELTA al 31 (hoy = ${hoy})`);

  const r31 = await post("/api/recurrence/rules", ruleBody(accountId, { dayOfMonth: 31 }));
  check("regla con ancla 31 (201)", r31.status, 201);
  checkDeep("upcoming del ancla 31", await upcomingOf(r31.body?.id), [
    "2026-10-31",
    "2026-11-30", // noviembre tiene 30
    "2026-12-31",
    "2027-01-31",
    "2027-02-28", // febrero 2027 no es bisiesto
  ]);

  const r31b = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { dayOfMonth: 31, startDate: "2027-02-01" }),
  );
  checkDeep("el ancla NO se queda pegada al 28: vuelve al 31 en marzo", await upcomingOf(r31b.body?.id), [
    "2027-02-28",
    "2027-03-31", // ← la prueba de que el ancla sigue siendo 31
    "2027-04-30",
    "2027-05-31",
    "2027-06-30",
  ]);

  const rFeb29 = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { freq: "YEARLY", dayOfMonth: 29, startDate: "2024-02-29" }),
  );
  checkDeep("YEARLY 29/02: 28 en no bisiestos y 29 en el próximo bisiesto", await upcomingOf(rFeb29.body?.id), [
    "2027-02-28",
    "2028-02-29", // ← bisiesto: vuelve al 29
    "2029-02-28",
    "2030-02-28",
    "2031-02-28",
  ]);

  check("las tres reglas de clamp se borran (204)", await deleteRule(r31.body?.id), 204);
  await deleteRule(r31b.body?.id);
  await deleteRule(rFeb29.body?.id);

  /* ── 2. Fechas UTC−3 ───────────────────────────────────────────────────── */
  section("2 · La fecha del movimiento es la LOCAL, no la de UTC");

  const ayer = addDaysCal(hoy, -1);
  const rDiaria = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { freq: "DAILY", startDate: ayer, dayOfMonth: undefined }),
  );
  const corrida = await post("/api/recurrence/run", {});
  check("la corrida reporta el hoy LOCAL", corrida.body?.today, hoy);

  const fechas = await occurrenceDates(prisma, rDiaria.body?.id);
  checkDeep("ocurrencias de ayer y hoy con la fecha CALENDARIO correcta", fechas, [
    addDaysCal(hoy, -1),
    hoy,
  ]);

  const { body: bandeja } = await api("/api/recurrence");
  const mias = (bandeja?.pending ?? []).filter((o) => o.ruleId === rDiaria.body?.id);
  const aceptadas = [];
  for (const ocurrencia of mias) {
    const res = await post("/api/recurrence/occurrences", { id: ocurrencia.id, action: "accept" });
    aceptadas.push(res);
  }
  const fechasMov = await prisma.movement.findMany({
    where: { recurrenceRuleId: rDiaria.body?.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const fechasMovCal = fechasMov.map((m) => {
    const d = m.date;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  });
  checkDeep("los movimientos quedaron con las MISMAS fechas (ayer, hoy)", fechasMovCal, [
    addDaysCal(hoy, -1),
    hoy,
  ]);
  check(
    "la fecha posteada es la de la OCURRENCIA, no la de la corrida (ayer ≠ hoy)",
    fechasMovCal[0] !== fechasMovCal[1],
    true,
  );

  /* ── 3. Bordes del motor ───────────────────────────────────────────────── */
  section("3 · Bordes del motor");

  // 3a. endDate == startDate → exactamente UNA ocurrencia.
  const rUnaFecha = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { startDate: hoy, endDate: hoy, dayOfMonth: undefined }),
  );
  await post("/api/recurrence/run", {});
  checkDeep("endDate == startDate → una ocurrencia (hoy)", await occurrenceDates(prisma, rUnaFecha.body?.id), [hoy]);
  const rUnaFecha2 = await post("/api/recurrence/run", {});
  check("correr de nuevo no la duplica", rUnaFecha2.body?.materialized, 0);

  // 3b. count: 1.
  const rCount1 = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { freq: "DAILY", startDate: hoy, count: 1, dayOfMonth: undefined }),
  );
  await post("/api/recurrence/run", {});
  checkDeep("count 1 → una ocurrencia", await occurrenceDates(prisma, rCount1.body?.id), [hoy]);
  await post("/api/recurrence/run", {});
  const fechasCount1 = await occurrenceDates(prisma, rCount1.body?.id);
  check("no genera una segunda (el calendario terminó)", fechasCount1.length, 1);

  // 3c. dayOfMonth ANTERIOR al día de inicio → se pospone al mes siguiente.
  const rPosponer = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { startDate: "2026-09-15", dayOfMonth: 3 }),
  );
  await post("/api/recurrence/run", {});
  checkDeep(
    "ancla 3 con inicio 2026-09-15 → primera ocurrencia 2026-10-03 (no 09-03 ni 09-15)",
    await occurrenceDates(prisma, rPosponer.body?.id),
    ["2026-10-03"],
  );

  // 3d. interval: cada 2 meses.
  const rIntervalo = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { startDate: hoy, interval: 2, dayOfMonth: undefined }),
  );
  const upcomingIntervalo = await upcomingOf(rIntervalo.body?.id);
  checkDeep("interval 2 → salta un mes entero", upcomingIntervalo, [
    addMonthsCal(hoy, 2),
    addMonthsCal(hoy, 4),
    addMonthsCal(hoy, 6),
    addMonthsCal(hoy, 8),
    addMonthsCal(hoy, 10),
  ]);

  /* ── 4. GET /api/recurrence no materializa ─────────────────────────────── */
  section("4 · GET /api/recurrence no escribe");

  const rQuieta = await post(
    "/api/recurrence/rules",
    ruleBody(accountId, { startDate: hoy, dayOfMonth: undefined }),
  );
  const antes = await prisma.recurrenceOccurrence.count({ where: { ruleId: rQuieta.body?.id } });
  check("la regla nace sin ocurrencias (no materializa el alta)", antes, 0);

  for (let i = 0; i < 5; i += 1) await api("/api/recurrence");
  const despues = await prisma.recurrenceOccurrence.count({ where: { ruleId: rQuieta.body?.id } });
  check("tras 5 GET sigue con 0 ocurrencias", despues, 0);
  const movsQuieta = await prisma.movement.count({ where: { recurrenceRuleId: rQuieta.body?.id } });
  check("y 0 movimientos", movsQuieta, 0);
  check("la regla aparece en la vista con su proyección", (await upcomingOf(rQuieta.body?.id))?.[0], addMonthsCal(hoy, 1));

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
