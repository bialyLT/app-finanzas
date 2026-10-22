#!/usr/bin/env node
/**
 * Batería 25 · LA API: el discriminante de modo y los cuerpos hostiles
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * El contrato nuevo tiene un discriminante EXPLÍCITO: `mode: RATE | PAYMENT |
 * TOTAL` (sin `mode` = `RATE`, así que el camino viejo no se rompe).
 *
 * Lo que se verifica:
 *
 *   1. El discriminante DESAMBIGUA: un modo inválido, un modo ausente con
 *      `payment`/`total` presentes, y `payment` + `total` juntos → 4xx con un
 *      mensaje (nunca un 500, nunca una tasa inventada).
 *   2. COMPATIBILIDAD: un cuerpo SIN `mode` sigue funcionando como `RATE`.
 *   3. UN SOLO CAMINO DE ALTA: el préstamo se crea por `POST /api/accounts` con
 *      `kind: LOAN`. No puede existir un segundo endpoint que haga lo mismo
 *      (dos fuentes de verdad).
 *   4. CUERPOS HOSTILES: `null`, array, string, `payment`/`total` nulos, vacíos,
 *      en array, de 20 dígitos, con NUL, en cero, negativos, 601 cuotas,
 *      `principal` inválido → 4xx con mensaje, NUNCA un 500, y NINGÚN préstamo
 *      creado.
 *   5. La tasa GUARDADA es la CUANTIZADA (la del cronograma que cierra en 0).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL NOMBRE DE LA CUENTA ES ÚNICO (una restricción de la base)
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/accounts` responde 409 si el nombre ya existe. Cada caso hostil
 * usa un nombre PROPIO: si no, el 409 taparía el 4xx que se quiere ver (un
 * test que pasa por el motivo equivocado es peor que uno que falla).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE TOCA NADA DE LA BASE DE LA PERSONA
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib-fase9r3.mjs` verifica el destino ANTES de escribir: base `finanzas_test`
 * e instancia `:3101`. Si algo no cuadra, la batería se cae sin escribir.
 */

import {
  api,
  check,
  checkTrue,
  correrBateria,
  post,
  postRaw,
  section,
} from "./lib-fase9r3.mjs";

const TAG = "T9R6";
const FECHAS = (() => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setDate(15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-15`;
})();

/** Un cuerpo de préstamo válido, para probar las variantes. */
function base(extra = {}) {
  return {
    name: `${TAG} hostil`,
    kind: "LOAN",
    principal: "500000",
    installmentCount: 12,
    firstInstallmentDate: FECHAS,
    amortizationSystem: "FRENCH",
    ...extra,
  };
}

/** El POST de la preview (mismo contrato que el GET). */
async function previewPost(body) {
  return api("/api/loans/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function main(prisma) {
  /* ─────────────────────────────────────────────────────────────────────────
   * 1 · EL DISCRIMINANTE DESAMBIGUA
   * ───────────────────────────────────────────────────────────────────────── */
  section("El discriminante de modo");

  const modoInvalido = await previewPost({
    principal: "500000",
    installmentCount: 12,
    mode: "BANANA",
    payment: "56412.71",
  });
  check("modo invalido (BANANA): responde 4xx", modoInvalido.status, 400);
  checkTrue(
    "modo invalido: el mensaje dice que modos hay",
    /RATE/.test(modoInvalido.body?.error ?? "") &&
      /PAYMENT/.test(modoInvalido.body?.error ?? "") &&
      /TOTAL/.test(modoInvalido.body?.error ?? ""),
    modoInvalido.body?.error,
  );

  const modoNumerico = await previewPost({
    principal: "500000",
    installmentCount: 12,
    mode: 1,
    payment: "56412.71",
  });
  check("modo numerico: responde 4xx", modoNumerico.status, 400);

  const modoMinuscula = await previewPost({
    principal: "500000",
    installmentCount: 12,
    mode: "payment",
    payment: "56412.71",
  });
  check(
    "modo en minuscula: responde 4xx (el contrato es en mayusculas)",
    modoMinuscula.status,
    400,
  );

  const sinModoConPago = await previewPost({
    principal: "500000",
    installmentCount: 12,
    payment: "56412.71",
  });
  check(
    "modo ausente con `payment`: responde 4xx (no puede adivinar)",
    sinModoConPago.status,
    400,
  );
  checkTrue(
    "modo ausente con `payment`: el mensaje dice que falta la tasa",
    /tasa/i.test(sinModoConPago.body?.error ?? ""),
    sinModoConPago.body?.error,
  );

  const sinModoConTotal = await previewPost({
    principal: "500000",
    installmentCount: 12,
    total: "676952.44",
  });
  check(
    "modo ausente con `total`: responde 4xx (no puede adivinar)",
    sinModoConTotal.status,
    400,
  );

  // `payment` y `total` JUNTOS: el cuerpo es ambiguo y tiene que rechazarse.
  const ambos = await previewPost({
    principal: "500000",
    installmentCount: 12,
    mode: "PAYMENT",
    payment: "56412.71",
    total: "676952.44",
  });
  check(
    "`payment` y `total` juntos: responde 4xx (el cuerpo es ambiguo)",
    ambos.status,
    400,
  );
  checkTrue(
    "`payment` y `total` juntos: el mensaje explica la ambiguedad",
    (ambos.body?.error ?? "").length > 0,
    ambos.body?.error,
  );

  // Y en el ALTA (que es el camino que de verdad escribe).
  const ambosAlta = await post("/api/accounts", {
    ...base({ mode: "PAYMENT", payment: "56412.71", total: "676952.44" }),
    name: `${TAG} ambiguo`,
  });
  check(
    "`payment` y `total` juntos en el ALTA: responde 4xx",
    ambosAlta.status,
    400,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 2 · COMPATIBILIDAD: sin `mode` es RATE (el camino viejo)
   * ───────────────────────────────────────────────────────────────────────── */
  section("Compatibilidad · el cuerpo viejo (sin mode) sigue siendo RATE");

  const viejoPreview = await previewPost({
    principal: "500000",
    installmentCount: 12,
    tnaPercent: "60",
  });
  check("cuerpo viejo (preview): responde 200", viejoPreview.status, 200);
  check("cuerpo viejo (preview): el mode es RATE", viejoPreview.body?.mode, "RATE");
  check(
    "cuerpo viejo (preview): la cuota es 56.412,71",
    viejoPreview.body?.payment,
    "56412.71",
  );
  check(
    "cuerpo viejo (preview): la tasa es 60,0000 %",
    viejoPreview.body?.tnaPercent,
    "60.0000",
  );

  const viejoAlta = await post("/api/accounts", {
    ...base({ tnaPercent: "60" }),
    name: `${TAG} viejo sin mode`,
  });
  check("cuerpo viejo (alta): responde 201", viejoAlta.status, 201);
  if (viejoAlta.status === 201) {
    const dbViejo = await prisma.account.findUnique({
      where: { id: viejoAlta.body.id },
    });
    check(
      "cuerpo viejo (alta): la tasa guardada es 60,0000 %",
      dbViejo.tnaPercent.toFixed(4),
      "60.0000",
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 3 · UN SOLO CAMINO DE ALTA
   * ───────────────────────────────────────────────────────────────────────── */
  section("Un solo camino de alta");

  const loansRaiz = await postRaw(
    "/api/loans",
    JSON.stringify(base({ tnaPercent: "60" })),
  );
  checkTrue(
    "POST /api/loans NO existe (el alta es POST /api/accounts)",
    loansRaiz.status >= 400,
    `status ${loansRaiz.status}`,
  );
  const previewRaiz = await postRaw(
    "/api/loans/preview",
    JSON.stringify({ principal: "1" }),
  );
  checkTrue(
    "POST /api/loans/preview existe (el contrato del brief)",
    previewRaiz.status !== 404,
    `status ${previewRaiz.status}`,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 4 · CUERPOS HOSTILES (la preview y el alta): 4xx, nunca 500
   * ───────────────────────────────────────────────────────────────────────── */
  section("Cuerpos hostiles · POST /api/loans/preview");

  const hostilesPreview = [
    ["cuerpo null", "null"],
    ["cuerpo array", "[]"],
    ["cuerpo string", '"hola"'],
    ["cuerpo numero", "42"],
    ["cuerpo sin llaves", "{"],
    ["payment null", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: null })],
    ["payment vacio", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "" })],
    ["payment en array", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: ["56412.71"] })],
    ["payment objeto", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: { a: 1 } })],
    ["payment booleano", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: true })],
    ["payment no numerico", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "abc" })],
    ["payment negativo", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "-1" })],
    ["payment cero", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "0" })],
    ["payment de 20 digitos", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "99999999999999999999" })],
    ["payment con NUL", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT", payment: "56412.71\u0000" })],
    ["total en array", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "TOTAL", total: ["676952.44"] })],
    ["total objeto", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "TOTAL", total: { a: 1 } })],
    ["total no numerico", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "TOTAL", total: "abc" })],
    ["total negativo", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "TOTAL", total: "-100" })],
    ["total cero", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "TOTAL", total: "0" })],
    ["principal invalido", JSON.stringify({ principal: "abc", installmentCount: 12, mode: "PAYMENT", payment: "56412.71" })],
    ["principal en array", JSON.stringify({ principal: ["500000"], installmentCount: 12, mode: "PAYMENT", payment: "56412.71" })],
    ["principal cero", JSON.stringify({ principal: "0", installmentCount: 12, mode: "PAYMENT", payment: "56412.71" })],
    ["cuotas 0", JSON.stringify({ principal: "500000", installmentCount: 0, mode: "PAYMENT", payment: "56412.71" })],
    ["cuotas 601", JSON.stringify({ principal: "500000", installmentCount: 601, mode: "PAYMENT", payment: "56412.71" })],
    ["cuotas fraccionarias", JSON.stringify({ principal: "500000", installmentCount: 12.5, mode: "PAYMENT", payment: "56412.71" })],
    ["sin cuotas", JSON.stringify({ principal: "500000", mode: "PAYMENT", payment: "56412.71" })],
    ["sistema invalido", JSON.stringify({ principal: "500000", installmentCount: 12, system: "FLAT", mode: "PAYMENT", payment: "56412.71" })],
    ["tna negativa en RATE", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "RATE", tnaPercent: "-1" })],
    ["sin el dato del modo", JSON.stringify({ principal: "500000", installmentCount: 12, mode: "PAYMENT" })],
  ];

  for (const [etiqueta, crudo] of hostilesPreview) {
    const r = await postRaw("/api/loans/preview", crudo);
    check(
      `preview · ${etiqueta}: NO es un 500`,
      r.status !== 500,
      true,
    );
    checkTrue(
      `preview · ${etiqueta}: es un 4xx con mensaje`,
      r.status >= 400 &&
        r.status < 500 &&
        typeof r.body?.error === "string" &&
        r.body.error.length > 0,
      `status ${r.status} · ${String(r.rawText).slice(0, 120)}`,
    );
  }

  section("Cuerpos hostiles · POST /api/accounts (el alta)");

  const antes = await prisma.account.count({
    where: { name: { startsWith: `${TAG} ` } },
  });

  // Cada caso con un nombre PROPIO: el nombre es único en la base y un 409
  // taparía el 4xx que se quiere ver.
  const hostilesAlta = [
    ["cuerpo null", "null"],
    ["cuerpo array", "[]"],
    ["cuerpo string", '"hola"'],
    ["payment en array", JSON.stringify(base({ mode: "PAYMENT", payment: ["56412.71"] }))],
    ["payment objeto", JSON.stringify(base({ mode: "PAYMENT", payment: { a: 1 } }))],
    ["payment booleano", JSON.stringify(base({ mode: "PAYMENT", payment: true }))],
    ["payment no numerico", JSON.stringify(base({ mode: "PAYMENT", payment: "abc" }))],
    ["payment negativo", JSON.stringify(base({ mode: "PAYMENT", payment: "-1" }))],
    ["payment cero", JSON.stringify(base({ mode: "PAYMENT", payment: "0" }))],
    ["payment de 20 digitos", JSON.stringify(base({ mode: "PAYMENT", payment: "99999999999999999999" }))],
    ["payment con NUL", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71\u0000" }))],
    ["total en array", JSON.stringify(base({ mode: "TOTAL", total: ["676952.44"] }))],
    ["total objeto", JSON.stringify(base({ mode: "TOTAL", total: { a: 1 } }))],
    ["cuotas 601", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", installmentCount: 601 }))],
    ["cuotas 0", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", installmentCount: 0 }))],
    ["principal invalido", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", principal: "abc" }))],
    ["principal en array", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", principal: ["500000"] }))],
    ["principal cero", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", principal: "0" }))],
    ["modo invalido", JSON.stringify(base({ mode: "BANANA", payment: "56412.71" }))],
    ["sistema invalido", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", amortizationSystem: "FLAT" }))],
    ["cuota insuficiente", JSON.stringify(base({ mode: "PAYMENT", payment: "41666.66" }))],
    ["total menor que el capital", JSON.stringify(base({ mode: "TOTAL", total: "1000" }))],
    ["payment y total juntos", JSON.stringify(base({ mode: "PAYMENT", payment: "56412.71", total: "676952.44" }))],
  ];

  let indice = 0;
  for (const [etiqueta, crudo] of hostilesAlta) {
    indice += 1;
    // El nombre propio: sin esto, el 409 de "ya existe" tapa el 4xx real.
    const conNombre = crudo.replace(
      '"name":"T9R6 hostil"',
      `"name":"T9R6 h${indice}"`,
    );
    const r = await postRaw("/api/accounts", conNombre);
    check(
      `alta · ${etiqueta}: NO es un 500`,
      r.status !== 500,
      true,
    );
    checkTrue(
      `alta · ${etiqueta}: es un 4xx con mensaje`,
      r.status >= 400 &&
        r.status < 500 &&
        typeof r.body?.error === "string" &&
        r.body.error.length > 0,
      `status ${r.status} · ${String(r.rawText).slice(0, 140)}`,
    );
  }

  const despues = await prisma.account.count({
    where: { name: { startsWith: `${TAG} ` } },
  });
  check(
    "los cuerpos hostiles NO crearon ningun prestamo",
    despues - antes,
    0,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 5 · LA TASA GUARDADA ES LA CUANTIZADA (la del cronograma que cierra en 0)
   * ───────────────────────────────────────────────────────────────────────── */
  section("La tasa guardada es la cuantizada");

  const altaCuantizada = await post("/api/accounts", {
    ...base({ mode: "PAYMENT", payment: "56412.71" }),
    name: `${TAG} cuantizada`,
  });
  check("alta por cuota: responde 201", altaCuantizada.status, 201);
  if (altaCuantizada.status === 201) {
    const db = await prisma.account.findUnique({
      where: { id: altaCuantizada.body.id },
    });
    check(
      "la tasa guardada tiene 4 decimales (60,0000 %)",
      db.tnaPercent.toFixed(4),
      "60.0000",
    );
    const filas = await prisma.installment.findMany({
      where: { accountId: altaCuantizada.body.id },
      orderBy: { number: "asc" },
    });
    check(
      "el cronograma guardado cierra en 0 EXACTO",
      filas[filas.length - 1].remainingBalance.toFixed(2),
      "0.00",
    );
    check(
      "el cronograma guardado amortiza exactamente el capital",
      filas
        .reduce((acc, i) => acc + Number(i.principal.toFixed(2)), 0)
        .toFixed(2),
      "500000.00",
    );
  }
}

correrBateria({
  etiqueta: "bateria 25 (API)",
  main,
  limpiar: async (prisma) => {
    const cuentas = await prisma.account.findMany({
      where: { name: { startsWith: `${TAG} ` } },
      select: { id: true },
    });
    const ids = cuentas.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
      await prisma.movement.deleteMany({
        where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
      });
      await prisma.account.deleteMany({ where: { id: { in: ids } } });
    }
  },
});
