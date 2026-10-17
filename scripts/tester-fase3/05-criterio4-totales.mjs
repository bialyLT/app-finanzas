#!/usr/bin/env node
/**
 * Test 05 — Criterio de aceptación 4 del ROADMAP: lo proyectado y lo pendiente
 * JAMÁS entran en reportes de plata real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * Es el criterio más importante de la fase: una fecha futura de una regla no es
 * dinero, y una ocurrencia pendiente tampoco. Todo se mide por DELTAS EXACTOS
 * sobre el mes en curso (hoy = 2026-10-17):
 *
 *   total antes → crear la regla (la proyección existe: `upcoming`) → SIN cambio
 *   → materializar (la ocurrencia PENDING existe)                      → SIN cambio
 *   → aceptar (el movimiento existe)                                   → +5.000,00 exactos
 *
 * Y el mes siguiente (noviembre), donde sólo hay fechas proyectadas, no puede
 * moverse nunca. Si un día la proyección suma en un total, el bug es exactamente
 * el que motivó reescribir la app.
 */

import {
  PrismaClient,
  api,
  check,
  checkTrue,
  cleanupTag,
  localToday,
  login,
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_05_";
const prisma = new PrismaClient();

const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (cents) => (cents / 100).toFixed(2);

async function totals(from, to) {
  const { body } = await api(`/api/transactions?from=${from}&to=${to}`);
  return body?.totals;
}

async function netWorth(asOf) {
  const { body } = await api(`/api/accounts?asOf=${asOf}&includeArchived=false`);
  return body?.netWorth?.net;
}

async function main() {
  const hoy = localToday();
  const mes = hoy.slice(0, 7);
  const [anio, mm] = mes.split("-").map(Number);
  const ultimoDia = new Date(anio, mm, 0).getDate();
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(ultimoDia).padStart(2, "0")}`;
  const mesProximo = `${anio}-${String(mm + 1).padStart(2, "0")}-01`;
  const finProximo = `${anio}-${String(mm + 1).padStart(2, "0")}-${new Date(anio, mm + 1, 0).getDate()}`;

  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", { name: `${TAG}Banco`, kind: "BANK", openingBalance: "100.000" });
  const accountId = banco.body?.id;

  section(`Punto de partida (${desde} … ${hasta})`);
  const t0 = await totals(desde, hasta);
  const n0 = await netWorth(hasta);
  const t0Prox = await totals(mesProximo, finProximo);
  console.log(`      totales: ingresos=${t0?.income} gastos=${t0?.expenses} transferencias=${t0?.transfers} flujo=${t0?.cashFlow}`);
  console.log(`      patrimonio al ${hasta}: ${n0}`);
  console.log(`      mes próximo (${mesProximo} … ${finProximo}): gastos=${t0Prox?.expenses}`);

  /* ── 1. Crear la regla: existe la proyección, no existe la plata ───────── */
  section("1 · Crear la regla (con proyección futura) no mueve ningún total");
  const regla = await post("/api/recurrence/rules", {
    title: `${TAG}gasto`,
    kind: "EXPENSE",
    amount: "5000",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "MONTHLY",
    startDate: hoy,
    postingMode: "NOTIFY",
  });
  check("crea la regla (201)", regla.status, 201);
  const upcoming = regla.body?.upcoming ?? [];
  checkTrue("la regla proyecta fechas futuras (upcoming no está vacío)", upcoming.length > 0, JSON.stringify(upcoming));
  checkTrue(
    "y ninguna cae en el mes en curso más allá de hoy",
    upcoming.every((f) => f > hoy),
    JSON.stringify(upcoming),
  );

  check("los gastos del mes NO se movieron", (await totals(desde, hasta))?.expenses, t0?.expenses);
  check("el patrimonio NO se movió", await netWorth(hasta), n0);

  /* ── 2. Materializar (PENDING) tampoco ─────────────────────────────────── */
  section("2 · Materializar la ocurrencia no es plata");
  const corrida = await post("/api/recurrence/run", {});
  check("materializa 1 ocurrencia", corrida.body?.materialized, 1);
  check("queda pendiente (NOTIFY)", corrida.body?.pending, 1);

  const occ = await prisma.recurrenceOccurrence.findFirst({ where: { ruleId: regla.body?.id } });
  checkTrue("la fila PENDING existe en la base", occ?.status === "PENDING", occ?.status);

  check("los gastos del mes SIGUEN igual", (await totals(desde, hasta))?.expenses, t0?.expenses);
  check("el flujo de caja SIGUE igual", (await totals(desde, hasta))?.cashFlow, t0?.cashFlow);
  check("el patrimonio SIGUE igual", await netWorth(hasta), n0);
  check("no hay NINGÚN movimiento de la regla", await prisma.movement.count({ where: { recurrenceRuleId: regla.body?.id } }), 0);
  check("los gastos del mes próximo tampoco se movieron", (await totals(mesProximo, finProximo))?.expenses, t0Prox?.expenses);

  /* ── 3. Aceptar: recién ahí es plata, y por el monto exacto ────────────── */
  section("3 · Aceptar la ocurrencia suma EXACTAMENTE 5.000,00");
  const pendiente = (await api("/api/recurrence")).body?.pending?.find((o) => o.ruleId === regla.body?.id);
  const aceptar = await post("/api/recurrence/occurrences", { id: pendiente?.id, action: "accept" });
  check("accept → 201", aceptar.status, 201);

  const t1 = await totals(desde, hasta);
  const n1 = await netWorth(hasta);
  check("los gastos del mes subieron EXACTAMENTE 5.000,00", t1?.expenses, fromCents(toCents(t0?.expenses) + 500000));
  check("el flujo de caja bajó EXACTAMENTE 5.000,00", t1?.cashFlow, fromCents(toCents(t0?.cashFlow) - 500000));
  check("el patrimonio bajó EXACTAMENTE 5.000,00", n1, fromCents(toCents(n0) - 500000));
  check("el movimiento existe y está fechado HOY (el día de la ocurrencia)", aceptar.body?.occurrence?.movement?.date, hoy);
  check("el mes próximo sigue intacto (nada proyectado se materializó como plata)", (await totals(mesProximo, finProximo))?.expenses, t0Prox?.expenses);
  const pendientesAhora = (await api("/api/recurrence")).body?.pending?.filter((o) => o.ruleId === regla.body?.id).length ?? -1;
  check("ya no queda pendiente", pendientesAhora, 0);

  section("Limpieza");
  // Borrar el movimiento reabre la ocurrencia; el cleanup borra ocurrencias → movimientos → reglas en el orden correcto.
  const movId = aceptar.body?.occurrence?.movement?.id;
  const borrar = await api(`/api/transactions?id=${movId}`, { method: "DELETE" });
  check("el movimiento se puede borrar (204)", borrar.status, 204);
  await cleanupTag(prisma, TAG);
  check("quedan 0 reglas de prueba", await prisma.recurrenceRule.count({ where: { title: { startsWith: TAG } } }), 0);
  check("los totales volvieron al punto de partida", (await totals(desde, hasta))?.expenses, t0?.expenses);
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
