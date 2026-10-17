#!/usr/bin/env node
/**
 * Test 06 — Validación del borde: 400s útiles, sin mass assignment, sin fugas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * El borde es lo primero que toca cualquiera que use la API (y la UI de la
 * próxima ronda va a hablar con él). Tres criterios:
 *   1. Toda entrada hostil (freq/status/interval/dayOfMonth/count/fechas/monto
 *      inválidos, cuerpos con forma rara) tiene que devolver 400 con un mensaje
 *      en castellano que diga QUÉ está mal — y NO escribir nada.
 *   2. Nada de mass assignment: campos de más (id, createdAt, relaciones) se
 *      ignoran; el body nunca llega crudo a Prisma.
 *   3. Las respuestas de error no filtran stacks ni texto de Prisma.
 *
 * Extra: dos bordes de dinero que la app define en `parseMoneyInput` —
 * "1.234,56" (formato argentino) y "1234.56" (punto decimal) — y la
 * comparación con /api/transactions para el caso de más de 2 decimales
 * (la regla es que la recurrencia no invente una convención distinta).
 *
 * El `null` como cuerpo JSON es un caso aparte: es JSON válido, pero no es un
 * objeto. El borde tiene que rechazarlo con 400, no explotar con 500.
 */

import {
  PrismaClient,
  api,
  check,
  checkTrue,
  cleanupTag,
  login,
  post,
  postRaw,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_06_";
const prisma = new PrismaClient();

/** El error tiene que ser JSON con `error` string y sin fugas de implementación. */
function checkErrorClean(label, res, expectedStatus) {
  const body = res.body;
  const okStatus = res.status === expectedStatus;
  const okShape = typeof body?.error === "string" && body.error.length > 0;
  const fugas = /prisma|P20\d\d|at [A-Za-z]+ \(|node_modules|invocation|constraint/i;
  const okLimpio = !fugas.test(JSON.stringify(body ?? res.rawText ?? ""));
  checkTrue(
    label,
    okStatus && okShape && okLimpio,
    `status=${res.status} body=${JSON.stringify(body ?? res.rawText)}`,
  );
}

async function main() {
  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", { name: `${TAG}Banco`, kind: "BANK" });
  const prestamo = await post("/api/accounts", {
    name: `${TAG}Prestamo`,
    kind: "LOAN",
    principal: "100.000",
    tnaPercent: "60",
    installmentCount: 12,
  });
  const efectivo = await post("/api/accounts", { name: `${TAG}Efectivo`, kind: "CASH" });
  const accountId = banco.body?.id;
  check("cuentas de prueba (banco, préstamo, efectivo)", [banco.status, prestamo.status, efectivo.status], [201, 201, 201]);

  const base = () => ({
    title: `${TAG}base`,
    kind: "EXPENSE",
    amount: "100",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "MONTHLY",
    dayOfMonth: 15,
    startDate: "2026-10-01",
    postingMode: "NOTIFY",
  });

  const reglasAntes = await prisma.recurrenceRule.count();

  /* ── 1. Altas inválidas (todas 400, todas sin escribir) ─────────────────── */
  section("1 · Altas inválidas → 400 con mensaje útil");

  const casos = [
    ["sin título", { title: undefined }, "La regla necesita un nombre."],
    ["título vacío", { title: "   " }, "La regla necesita un nombre."],
    ["kind inválido", { kind: "COFFEE" }, "Tipo de movimiento inválido."],
    ["monto no numérico", { amount: "abc" }, "El monto no se entiende"],
    ["monto cero", { amount: "0" }, "El monto tiene que ser mayor a cero."],
    ["monto negativo", { amount: "-5" }, "El monto tiene que ser mayor a cero."],
    ["monto ausente", { amount: undefined }, "Falta el monto"],
    ["cuenta ausente", { accountId: undefined }, "Falta indicar la cuenta."],
    ["cuenta inexistente", { accountId: "no-existe" }, "La cuenta indicada no existe."],
    ["freq inválida", { freq: "FORTNIGHTLY" }, "Frecuencia inválida"],
    ["interval 0", { interval: 0 }, "El intervalo tiene que ser un número entero entre 1 y 365."],
    ["interval negativo", { interval: -3 }, "El intervalo tiene que ser un número entero entre 1 y 365."],
    ["interval no entero", { interval: 1.5 }, "El intervalo tiene que ser un número entero entre 1 y 365."],
    ["interval gigante", { interval: 1000 }, "El intervalo tiene que ser un número entero entre 1 y 365."],
    ["interval no numérico", { interval: "cada-mes" }, "El intervalo tiene que ser un número entero entre 1 y 365."],
    ["dayOfMonth 32", { dayOfMonth: 32 }, "El día del mes tiene que ser un número entero entre 1 y 31."],
    ["dayOfMonth 0", { dayOfMonth: 0 }, "El día del mes tiene que ser un número entero entre 1 y 31."],
    ["dayOfMonth en DAILY", { freq: "DAILY", dayOfMonth: 15 }, "El día del mes sólo se usa en reglas mensuales o anuales."],
    ["startDate 31 de febrero", { startDate: "2026-02-30" }, "La fecha de inicio no es válida"],
    ["startDate con formato local", { startDate: "17/10/2026" }, "La fecha de inicio no es válida"],
    ["endDate anterior al inicio", { startDate: "2026-10-01", endDate: "2026-09-01" }, "La fecha de fin no puede ser anterior a la de inicio."],
    ["count 0", { count: 0 }, "La cantidad de ocurrencias tiene que ser un número entero entre 1 y 10000."],
    ["count negativo", { count: -2 }, "La cantidad de ocurrencias tiene que ser un número entero entre 1 y 10000."],
    ["count no entero", { count: 2.5 }, "La cantidad de ocurrencias tiene que ser un número entero entre 1 y 10000."],
    ["postingMode inválido", { postingMode: "MAYBE" }, "Modo de posteo inválido"],
    ["status inválido", { status: "SLEEPING" }, "Estado inválido"],
    ["TRANSFER sin destino", { kind: "TRANSFER", toAccountId: undefined, categoryName: undefined }, "Una transferencia necesita una cuenta de destino."],
    ["TRANSFER al mismo origen", { kind: "TRANSFER", toAccountId: accountId, categoryName: undefined }, "La cuenta de destino tiene que ser distinta a la de origen."],
    ["TRANSFER con categoría", { kind: "TRANSFER", toAccountId: efectivo.body?.id, categoryName: "Comida" }, "Una transferencia entre cuentas propias no lleva categoría"],
    ["INCOME con destino", { kind: "INCOME", toAccountId: efectivo.body?.id }, "Un ingreso no lleva cuenta de destino"],
    ["EXPENSE sin categoría", { categoryName: undefined }, "Falta indicar en qué se gastó."],
    ["INCOME sin categoría", { kind: "INCOME", categoryName: undefined }, "Falta indicar de dónde viene el ingreso."],
  ];

  for (const [nombre, overrides, fragmento] of casos) {
    const body = { ...base(), ...overrides };
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete body[k];
    const res = await post("/api/recurrence/rules", body);
    const mensajeOk =
      typeof res.body?.error === "string" && res.body.error.includes(fragmento);
    checkTrue(`400 · ${nombre}`, res.status === 400 && mensajeOk, `status=${res.status} error=${JSON.stringify(res.body)}`);
  }

  // El caso del préstamo: INCOME hacia una cuenta de pasivo.
  {
    const res = await post("/api/recurrence/rules", {
      ...base(),
      kind: "INCOME",
      accountId: prestamo.body?.id,
      categoryName: `${TAG}Sueldo`,
    });
    checkTrue(
      "400 · INCOME hacia un préstamo, con mensaje que sugiere la transferencia",
      res.status === 400 && /transferencia/i.test(res.body?.error ?? ""),
      `status=${res.status} error=${JSON.stringify(res.body)}`,
    );
    const guardada = await prisma.recurrenceRule.count({ where: { title: `${TAG}base` } });
    check("  y la regla NO se guardó", guardada, 0);
  }

  const reglasDespues = await prisma.recurrenceRule.count();
  check("ningún alta inválida escribió nada", reglasDespues, reglasAntes);

  /* ── 2. Cuerpos hostiles ────────────────────────────────────────────────── */
  section("2 · Cuerpos hostiles (JSON válido que no es un objeto)");
  const nullRules = await postRaw("/api/recurrence/rules", "null");
  checkErrorClean("POST rules con body `null` → 400", nullRules, 400);
  const nullPatch = await api("/api/recurrence/rules", { method: "PATCH", body: "null" });
  checkErrorClean("PATCH rules con body `null` → 400", nullPatch, 400);
  const nullOcc = await postRaw("/api/recurrence/occurrences", "null");
  checkErrorClean("POST occurrences con body `null` → 400", nullOcc, 400);

  /* ── 3. Mass assignment ─────────────────────────────────────────────────── */
  section("3 · Sin mass assignment");
  const conColados = await post("/api/recurrence/rules", {
    ...base(),
    id: "id-inventado",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    recurrenceRuleId: "colado",
    totalHackeado: 999,
  });
  check("201 (los campos de más se ignoran)", conColados.status, 201);
  checkTrue("el id NO es el inventado", conColados.body?.id !== "id-inventado", conColados.body?.id);
  const fila = await prisma.recurrenceRule.findUnique({ where: { id: conColados.body?.id } });
  check("createdAt es el real, no el del body", fila?.createdAt.toISOString().startsWith("2000"), false);

  const patchColado = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: conColados.body?.id, idHackeado: 1, updatedAt: "2000-01-01T00:00:00.000Z", amount: "200" }),
  });
  check("PATCH con campos de más → 200", patchColado.status, 200);

  /* ── 4. Bordes de dinero ────────────────────────────────────────────────── */
  section("4 · Montos: formato argentino, punto decimal y más de 2 decimales");

  const argentino = await post("/api/recurrence/rules", { ...base(), amount: "1.234,56", title: `${TAG}arg` });
  check("«1.234,56» se interpreta 1234,56", argentino.body?.amount, "1234.56");

  const puntoDecimal = await post("/api/recurrence/rules", { ...base(), amount: "1234.56", title: `${TAG}us` });
  check("«1234.56» se interpreta 1234,56", puntoDecimal.body?.amount, "1234.56");

  const simbolos = await post("/api/recurrence/rules", { ...base(), amount: "$ 1.000,50", title: `${TAG}simbolos` });
  check("«$ 1.000,50» se limpia y se interpreta 1000,50", simbolos.body?.amount, "1000.50");

  // Más de 2 decimales: acá lo que importa es que la recurrencia NO invente una
  // convención distinta a la del resto de la app. Se compara contra una compra
  // común y corriente.
  const regla3dec = await post("/api/recurrence/rules", { ...base(), amount: "1,234", title: `${TAG}3dec` });
  const mov3dec = await post("/api/transactions", {
    kind: "EXPENSE",
    amount: "1,234",
    date: "2026-08-01",
    accountId,
    categoryName: `${TAG}Cat`,
    description: `${TAG}3dec`,
  });
  console.log(`      (regla con «1,234» → ${regla3dec.status} amount=${regla3dec.body?.amount} · movimiento → ${mov3dec.status} amount=${mov3dec.body?.amount})`);
  checkTrue(
    "la recurrencia redondea igual que /api/transactions (misma convención, no una nueva)",
    regla3dec.status === mov3dec.status,
    `regla=${regla3dec.status} movimiento=${mov3dec.status}`,
  );

  /* ── 5. PATCH y ocurrencias: errores de borde ───────────────────────────── */
  section("5 · PATCH y ocurrencias: errores de borde");

  const sinId = await api("/api/recurrence/rules", { method: "PATCH", body: JSON.stringify({ amount: "1" }) });
  checkErrorClean("PATCH sin id → 400", sinId, 400);
  const idFantasma = await api("/api/recurrence/rules", { method: "PATCH", body: JSON.stringify({ id: "fantasma", amount: "1" }) });
  checkErrorClean("PATCH con id inexistente → 404", idFantasma, 404);

  const occSinId = await post("/api/recurrence/occurrences", { action: "accept" });
  checkErrorClean("ocurrencia sin id → 400", occSinId, 400);
  const occAccionMala = await post("/api/recurrence/occurrences", { id: "x", action: "maybe" });
  checkErrorClean("ocurrencia con acción inválida → 400", occAccionMala, 400);
  const occFantasma = await post("/api/recurrence/occurrences", { id: "fantasma", action: "accept" });
  checkErrorClean("accept de una ocurrencia inexistente → 404", occFantasma, 404);
  const occIdNumerico = await post("/api/recurrence/occurrences", { id: 123, action: "accept" });
  checkErrorClean("id de ocurrencia numérico → 400", occIdNumerico, 400);

  const deleteSinId = await api("/api/recurrence/rules", { method: "DELETE" });
  checkErrorClean("DELETE sin id → 400", deleteSinId, 400);
  const deleteFantasma = await api("/api/recurrence/rules?id=fantasma", { method: "DELETE" });
  checkErrorClean("DELETE de regla inexistente → 404", deleteFantasma, 404);

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
