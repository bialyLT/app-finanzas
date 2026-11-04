#!/usr/bin/env node
/**
 * Batería 08 · Fase 4.3 · El camino de ESCRITURA de las monedas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA (con la app real, por HTTP, contra `finanzas_test`)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Alta de cuentas: dos "Efectivo" (ARS/USD) conviven; la tercera choca con
 *      409 por (name, currency); una moneda inválida no escribe nada.
 *   2. La BICONDICIONAL de `toAmount` en las cuatro combinaciones y en las dos
 *      direcciones: 400 legible (no el trigger crudo, nunca 500).
 *   3. Atomicidad del lote: pre-check y, sobre todo, fallo DESPUÉS de la primera
 *      escritura (categoría del tipo contrario) → 0 filas nuevas.
 *   4. PATCH de moneda: limpia 200, con historia 409, colisión de nombre 409.
 *   5. Saldos y reconciliación al CENTAVO, con SQL propio como verdad
 *      independiente (no se llama a la función que se está probando).
 *   6. CSV: sólo-ARS, rechazo por fila con el nombre de la moneda y 0 filas.
 *   7. La base sigue siendo la red: los CHECK/triggers/índices de la migración
 *      `20261104120000_fase4_monedas`, probados por escritura directa.
 *   8. Recurrencia entre monedas: el camino que F4.3 volvió alcanzable (antes la
 *      API sólo creaba cuentas en pesos). Una regla así no se puede postear y
 *      NO puede tumbar la corrida entera.
 *
 * Los números esperados se calculan a mano o con SQL propio. Datos con prefijo
 * único y limpieza por id; al cerrar se exige 0.
 */

import { readFileSync } from "node:fs";
import {
  api,
  cents,
  centsToMoney,
  check,
  checkIncluye,
  checkMoney,
  checkRejects,
  checkTrue,
  db,
  get,
  newTag,
  post,
  runBattery,
  section,
  sqlBalance,
} from "./helpers.mjs";

const TAG = newTag("f43");
const DIA = (value) => new Date(`${value}T00:00:00.000Z`);
const MONTH = "2032-03";
const AS_OF = "2032-03-31";

await runBattery({
  tag: TAG,
  main: async () => {
    const accountIds = [];
    const remember = (id) => {
      accountIds.push(id);
      return id;
    };

    async function createAccount(name, body, expected = 201) {
      const res = await post("/api/accounts", {
        name,
        kind: "CASH",
        ...body,
      });
      check(`alta «${name}» → ${expected}`, res.status, expected);
      if (res.status === 201) remember(res.body.id);
      return res;
    }

    /** Movimientos que tocan CUALQUIERA de las cuentas de esta corrida. */
    async function movementCount() {
      return db.movement.count({
        where: {
          OR: [
            { accountId: { in: accountIds } },
            { toAccountId: { in: accountIds } },
          ],
        },
      });
    }

    async function accountIdsByName(name) {
      const rows = await db.account.findMany({
        where: { name },
        select: { id: true, currency: true },
      });
      return rows;
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 1 · ALTA DE CUENTAS · la moneda es parte de la identidad
     * ══════════════════════════════════════════════════════════════════════ */
    section("1 · Alta de cuentas y unicidad POR MONEDA");

    const efectivoArs = await createAccount(`${TAG} Efectivo`, { currency: "ARS" });
    const efectivoUsd = await createAccount(`${TAG} Efectivo`, { currency: "USD" });
    check("ARS y USD conviven: la de pesos es ARS", efectivoArs.body?.currency, "ARS");
    check("ARS y USD conviven: la de dólares es USD", efectivoUsd.body?.currency, "USD");

    const terceraArs = await post("/api/accounts", {
      name: `${TAG} Efectivo`,
      kind: "CASH",
      currency: "ARS",
    });
    check("la tercera en pesos es 409", terceraArs.status, 409);
    checkIncluye("el 409 nombra la moneda del choque", terceraArs.body?.error, "en pesos");

    const terceraUsd = await post("/api/accounts", {
      name: `${TAG} Efectivo`,
      kind: "CASH",
      currency: "USD",
    });
    check("la tercera en dólares es 409", terceraUsd.status, 409);
    checkIncluye("el 409 nombra dólares", terceraUsd.body?.error, "en dólares");

    check(
      "quedan exactamente DOS «Efectivo» (una por moneda)",
      (await accountIdsByName(`${TAG} Efectivo`)).length,
      2,
    );

    // La moneda ausente y `null` son el default documentado (ARS); `""` también.
    const sinCampo = await post("/api/accounts", { name: `${TAG} sin moneda`, kind: "CASH" });
    check("sin `currency` → 201", sinCampo.status, 201);
    check("sin `currency` → ARS", sinCampo.body?.currency, "ARS");
    if (sinCampo.body?.id) remember(sinCampo.body.id);

    const conNull = await post("/api/accounts", {
      name: `${TAG} moneda null`,
      kind: "CASH",
      currency: null,
    });
    check("`currency: null` en el ALTA → 201 (default documentado)", conNull.status, 201);
    check("`currency: null` en el ALTA → ARS", conNull.body?.currency, "ARS");
    if (conNull.body?.id) remember(conNull.body.id);

    const antesInvalidas = (await accountIdsByName(`${TAG} moneda inválida`)).length;
    for (const currency of ["EUR", "usd", "USD ", 3, true, ["USD"], {}, 0]) {
      const res = await post("/api/accounts", {
        name: `${TAG} moneda inválida`,
        kind: "CASH",
        currency,
      });
      check(`currency hostil ${JSON.stringify(currency)} → 400`, res.status, 400);
      checkIncluye(
        `currency hostil ${JSON.stringify(currency)} explica ARS/USD`,
        res.body?.error,
        "ARS o USD",
      );
    }
    check(
      "ninguna moneda inválida creó una cuenta",
      (await accountIdsByName(`${TAG} moneda inválida`)).length,
      antesInvalidas,
    );

    // Un préstamo también nace en la moneda pedida, con su cronograma.
    const prestamoUsd = await post("/api/accounts", {
      name: `${TAG} Préstamo USD`,
      kind: "LOAN",
      currency: "USD",
      principal: "1000",
      tnaPercent: "0",
      installmentCount: 3,
      firstInstallmentDate: "2032-04-15",
    });
    check("préstamo USD → 201", prestamoUsd.status, 201);
    check("préstamo USD guarda su moneda", prestamoUsd.body?.currency, "USD");
    if (prestamoUsd.body?.id) {
      remember(prestamoUsd.body.id);
      check(
        "préstamo USD materializa sus 3 cuotas",
        await db.installment.count({ where: { accountId: prestamoUsd.body.id } }),
        3,
      );
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 2 · LA BICONDICIONAL, EN LAS CUATRO COMBINACIONES
     * ══════════════════════════════════════════════════════════════════════ */
    section("2 · Transferencias: `toAmount` obligatorio si y sólo si las monedas difieren");

    const P = (await createAccount(`${TAG} P`, { currency: "ARS", openingBalance: "1000000" })).body.id;
    const D = (await createAccount(`${TAG} D`, { currency: "USD", openingBalance: "1000" })).body.id;
    const P2 = (await createAccount(`${TAG} P2`, { currency: "ARS" })).body.id;
    const D2 = (await createAccount(`${TAG} D2`, { currency: "USD" })).body.id;

    // ARS → USD sin toAmount
    let antes = await movementCount();
    const sinMonto = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "120000",
      date: "2032-03-10",
      accountId: P,
      toAccountId: D,
      description: `${TAG} cross sin monto`,
    });
    check("ARS→USD sin `toAmount` → 400", sinMonto.status, 400);
    checkIncluye(
      "el 400 es el de la API (nombra las dos monedas), no el genérico del trigger",
      sinMonto.body?.error,
      "origen está en pesos y la de destino en dólares",
    );
    check("no guardó ninguna fila", await movementCount(), antes);

    // ARS → USD con toAmount
    const conMonto = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "120000",
      toAmount: "100.50",
      date: "2032-03-10",
      accountId: P,
      toAccountId: D,
      description: `${TAG} cross con monto`,
    });
    check("ARS→USD con `toAmount` → 201", conMonto.status, 201);
    check("el DTO devuelve `amount` de origen", conMonto.body?.amount, "120000.00");
    check("el DTO devuelve `toAmount` de destino", conMonto.body?.toAmount, "100.50");
    const filaCross = conMonto.body?.id
      ? await db.movement.findUnique({ where: { id: conMonto.body.id } })
      : null;
    checkMoney("la base guardó exactamente 100,50 de destino", filaCross?.toAmount?.toFixed(2) ?? "x", "100.50");

    // USD → ARS con toAmount (la otra dirección)
    const vuelta = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "50",
      toAmount: "60000",
      date: "2032-03-11",
      accountId: D,
      toAccountId: P,
      description: `${TAG} cross vuelta`,
    });
    check("USD→ARS con `toAmount` → 201", vuelta.status, 201);
    const filaVuelta = vuelta.body?.id
      ? await db.movement.findUnique({ where: { id: vuelta.body.id } })
      : null;
    checkMoney("USD→ARS guarda 60.000 en la pata de destino", filaVuelta?.toAmount?.toFixed(2) ?? "x", "60000.00");

    // Misma moneda: con toAmount prohibido, sin toAmount permitido.
    antes = await movementCount();
    const mismaCon = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "10000",
      toAmount: "10000",
      date: "2032-03-12",
      accountId: P,
      toAccountId: P2,
      description: `${TAG} misma con monto`,
    });
    check("ARS→ARS con `toAmount` → 400", mismaCon.status, 400);
    checkIncluye("el 400 explica que no corresponde", mismaCon.body?.error, "no corresponde");
    check("la fila prohibida no se escribió", await movementCount(), antes);

    const mismaSin = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "10000",
      date: "2032-03-12",
      accountId: P,
      toAccountId: P2,
      description: `${TAG} misma sin monto`,
    });
    check("ARS→ARS sin `toAmount` → 201", mismaSin.status, 201);
    check("ARS→ARS sin `toAmount` → null", mismaSin.body?.toAmount, null);

    const usdCon = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "5",
      toAmount: "5",
      date: "2032-03-12",
      accountId: D,
      toAccountId: D2,
      description: `${TAG} usd con monto`,
    });
    check("USD→USD con `toAmount` → 400", usdCon.status, 400);
    const usdSin = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "5",
      date: "2032-03-12",
      accountId: D,
      toAccountId: D2,
      description: `${TAG} usd sin monto`,
    });
    check("USD→USD sin `toAmount` → 201", usdSin.status, 201);
    check("USD→USD sin `toAmount` → null", usdSin.body?.toAmount, null);

    // INCOME / EXPENSE: prohibido aunque el valor sea válido.
    antes = await movementCount();
    const gastoCon = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "5000",
      toAmount: "5",
      date: "2032-03-12",
      accountId: P,
      description: `${TAG} gasto con monto`,
    });
    check("EXPENSE con `toAmount` → 400", gastoCon.status, 400);
    checkIncluye("el 400 dice que sólo existe en una transferencia", gastoCon.body?.error, "sólo existe en una transferencia");
    const ingresoCon = await post("/api/transactions", {
      kind: "INCOME",
      amount: "5000",
      toAmount: "5",
      date: "2032-03-12",
      accountId: P,
      description: `${TAG} ingreso con monto`,
    });
    check("INCOME con `toAmount` → 400", ingresoCon.status, 400);
    check("ninguno de los dos escribió", await movementCount(), antes);

    // Hostiles: 400 con mensaje, nunca 500, 0 filas.
    const hostiles = [0, -100, "0", "-0.01", "abc", [100], {}, true, "12345678901234567890"];
    for (const [index, toAmount] of hostiles.entries()) {
      const res = await post("/api/transactions", {
        kind: "TRANSFER",
        amount: "120000",
        toAmount,
        date: "2032-03-13",
        accountId: P,
        toAccountId: D,
        description: `${TAG} hostil ${index}`,
      });
      check(`toAmount hostil ${JSON.stringify(toAmount)} → 400`, res.status, 400);
      checkTrue(
        `toAmount hostil ${JSON.stringify(toAmount)} trae mensaje`,
        Boolean(res.body?.error),
      );
    }
    check(
      "ningún toAmount hostil dejó una fila",
      await db.movement.count({ where: { description: { startsWith: `${TAG} hostil` } } }),
      0,
    );

    // Puntas inexistentes y NUL: 400 accionable, no el 409 de FK.
    const sinDestino = await post("/api/transactions", {
      kind: "TRANSFER", amount: "1000", toAmount: "1", date: "2032-03-13",
      accountId: P, toAccountId: "no-existe",
    });
    check("destino inexistente → 400", sinDestino.status, 400);
    checkIncluye("dice que falta el destino", sinDestino.body?.error, "destino no existe");
    const sinOrigen = await post("/api/transactions", {
      kind: "TRANSFER", amount: "1000", toAmount: "1", date: "2032-03-13",
      accountId: "no-existe", toAccountId: D,
    });
    check("origen inexistente → 400", sinOrigen.status, 400);
    checkIncluye("dice que falta el origen", sinOrigen.body?.error, "origen no existe");
    const conNul = await post("/api/transactions", {
      kind: "TRANSFER", amount: "1000", toAmount: "1", date: "2032-03-13",
      accountId: `${P}\u0000`, toAccountId: D,
    });
    checkTrue("id con NUL → 4xx con mensaje (nunca 500)", conNul.status >= 400 && conNul.status < 500, String(conNul.status));
    checkTrue("id con NUL trae mensaje", Boolean(conNul.body?.error));

    /*
     * Observación (no bloqueante): un string de TRES decimales que parece
     * formato de miles ("100.005") lo interpreta `parseMoneyInput` como cien
     * mil cinco. El número 100.005 (number) se fija a 2 decimales y da 100,00.
     * Es el comportamiento histórico del parser de montos, no de F4.3; acá sólo
     * se documenta y se comprueba que nunca es un 500 ni un estado imposible.
     */
    const tresDecimales = await post("/api/transactions", {
      kind: "TRANSFER", amount: "1000", toAmount: "100.005", date: "2032-03-14",
      accountId: P, toAccountId: D, description: `${TAG} tres decimales`,
    });
    console.log(
      `        observación: toAmount "100.005" → HTTP ${tresDecimales.status}` +
        (tresDecimales.status === 201 ? `, guardado ${tresDecimales.body?.toAmount}` : ` (${tresDecimales.body?.error})`),
    );
    checkTrue("un monto de 3 decimales no produce 500", tresDecimales.status !== 500);

    /* ══════════════════════════════════════════════════════════════════════
     * 3 · LOTE ATÓMICO
     * ══════════════════════════════════════════════════════════════════════ */
    section("3 · Lote: o se escribe entero, o no se escribe nada");

    // 3.a El pre-check de moneda: el ítem #2 inválido tumba al #1 válido.
    antes = await movementCount();
    const lotePre = await post("/api/transactions/batch", {
      movements: [
        { kind: "EXPENSE", amount: 2500, date: "2032-03-15", description: `${TAG} lote pre 1`, accountId: P },
        { kind: "TRANSFER", amount: 120000, date: "2032-03-15", description: `${TAG} lote pre 2`, fromAccountId: P, toAccountId: D },
      ],
    });
    check("lote con cross sin toAmount → 400", lotePre.status, 400);
    checkIncluye("el error numera el ítem #2", lotePre.body?.error, "Movimiento #2");
    checkIncluye("y explica qué falta", lotePre.body?.error, "cuánto llega");
    check("el ítem #1 válido NO quedó escrito", await movementCount(), antes);

    // 3.b Fallo DESPUÉS de la primera escritura: categoría del tipo contrario.
    //     Prueba el rollback real de la transacción, no sólo el pre-check.
    const categoriaIngreso = await db.category.create({
      data: {
        name: `${TAG} CatIng`,
        normalizedName: `${TAG} cating`.toLowerCase(),
        kind: "INCOME",
      },
    });
    checkTrue("categoría de ingreso creada para el ítem #2", Boolean(categoriaIngreso.id));
    antes = await movementCount();
    const loteTarde = await post("/api/transactions/batch", {
      movements: [
        { kind: "EXPENSE", amount: 100, date: "2032-03-16", description: `${TAG} lote tarde 1`, accountId: P },
        {
          kind: "EXPENSE", amount: 200, date: "2032-03-16", description: `${TAG} lote tarde 2`,
          accountId: P, categoryId: categoriaIngreso.id,
        },
      ],
    });
    check("lote que falla en el ítem #2 → 400", loteTarde.status, 400);
    check("rollback: el ítem #1 escrito antes del fallo también se fue", await movementCount(), antes);

    // 3.c Formas hostiles del ítem: 400 con su número, 0 filas.
    antes = await movementCount();
    const loteBasura = await post("/api/transactions/batch", {
      movements: [
        null,
        { kind: "EXPENSE", amount: 100, date: "2032-03-16", accountId: P },
      ],
    });
    check("ítem `null` → 400", loteBasura.status, 400);
    checkIncluye("numera el ítem #1", loteBasura.body?.error, "Movimiento #1");
    check("0 filas tras el ítem basura", await movementCount(), antes);

    // 3.d Lote válido con un cross: escribe las dos filas y el toAmount.
    antes = await movementCount();
    const loteOk = await post("/api/transactions/batch", {
      movements: [
        { kind: "TRANSFER", amount: 50000, toAmount: "42.25", date: "2032-03-17", description: `${TAG} lote ok cross`, fromAccountId: P, toAccountId: D },
        { kind: "EXPENSE", amount: 300, date: "2032-03-17", description: `${TAG} lote ok gasto`, accountId: P },
      ],
    });
    check("lote válido → 201", loteOk.status, 201);
    check("el lote reporta 2 ítems", loteOk.body?.count, 2);
    check("el lote escribió exactamente 2 movimientos", await movementCount(), antes + 2);
    const loteCross = await db.movement.findFirst({ where: { description: `${TAG} lote ok cross` } });
    checkMoney("el toAmount del lote llegó a la fila", loteCross?.toAmount?.toFixed(2) ?? "x", "42.25");

    // 3.e `toAmount` presente en misma moneda / gasto: rechaza el lote entero.
    antes = await movementCount();
    for (const [label, movement] of [
      ["misma moneda", { kind: "TRANSFER", amount: 100, toAmount: 100, date: "2032-03-18", fromAccountId: P, toAccountId: P2 }],
      ["gasto", { kind: "EXPENSE", amount: 100, toAmount: 1, date: "2032-03-18", accountId: P }],
      ["lote con toAmount no numérico", { kind: "TRANSFER", amount: 100, toAmount: [1], date: "2032-03-18", fromAccountId: P, toAccountId: D }],
    ]) {
      const res = await post("/api/transactions/batch", { movements: [movement] });
      check(`lote con toAmount en ${label} → 400`, res.status, 400);
    }
    check("ninguna de las variantes escribió", await movementCount(), antes);

    /* ══════════════════════════════════════════════════════════════════════
     * 4 · PATCH DE MONEDA
     * ══════════════════════════════════════════════════════════════════════ */
    section("4 · PATCH de moneda: se corrige sólo mientras no hay historia");

    const limpia = (await createAccount(`${TAG} limpia`, { currency: "ARS" })).body.id;
    const patchLimpia = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: limpia, currency: "USD" }),
    });
    check("cuenta limpia → 200", patchLimpia.status, 200);
    check("la moneda quedó en USD", (await db.account.findUnique({ where: { id: limpia } }))?.currency, "USD");

    // Con un movimiento de salida.
    const conSalida = (await createAccount(`${TAG} con salida`, { currency: "ARS" })).body.id;
    await db.movement.create({
      data: { kind: "INCOME", amount: "1000", date: DIA("2032-03-01"), accountId: conSalida, description: `${TAG} historia salida` },
    });
    const patchSalida = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: conSalida, currency: "USD" }),
    });
    check("con movimiento de salida → 409", patchSalida.status, 409);
    checkIncluye("dice por qué (la cuenta ya tiene historia)", patchSalida.body?.error, "ya tiene historia");
    check("la fila NO cambió", (await db.account.findUnique({ where: { id: conSalida } }))?.currency, "ARS");

    // Con SOLO una transferencia entrante (toAccountId).
    const conEntrada = (await createAccount(`${TAG} con entrada`, { currency: "ARS" })).body.id;
    await db.movement.create({
      data: {
        kind: "TRANSFER", amount: "10", toAmount: "1000", date: DIA("2032-03-02"),
        accountId: D, toAccountId: conEntrada, description: `${TAG} historia entrada`,
      },
    });
    const patchEntrada = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: conEntrada, currency: "USD" }),
    });
    check("con traspaso entrante → 409", patchEntrada.status, 409);
    check("la fila NO cambió", (await db.account.findUnique({ where: { id: conEntrada } }))?.currency, "ARS");

    // Con una REGLA de recurrencia (la base también la considera historia).
    const conRegla = (await createAccount(`${TAG} con regla`, { currency: "ARS" })).body.id;
    const categoriaRegla = await db.category.create({
      data: {
        name: `${TAG} CatRegla`,
        normalizedName: `${TAG} catregla`.toLowerCase(),
        kind: "EXPENSE",
      },
    });
    const reglaDirecta = await db.recurrenceRule.create({
      data: {
        title: `${TAG} regla historia`, kind: "EXPENSE", amount: "100",
        accountId: conRegla, categoryId: categoriaRegla.id,
        freq: "MONTHLY", startDate: DIA("2032-01-01"),
      },
    });
    const patchRegla = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: conRegla, currency: "USD" }),
    });
    check("con RecurrenceRule → 409", patchRegla.status, 409);
    check("la fila NO cambió", (await db.account.findUnique({ where: { id: conRegla } }))?.currency, "ARS");
    await db.recurrenceRule.delete({ where: { id: reglaDirecta.id } });

    // Misma moneda en una cuenta con historia: no es un cambio, se acepta.
    const patchIgual = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: conSalida, currency: "ARS" }),
    });
    check("PATCH a la MISMA moneda con historia → 200", patchIgual.status, 200);

    // Formas inválidas en la edición: 400, nunca “borrar” el campo.
    for (const currency of ["EUR", null, ""]) {
      const res = await api("/api/accounts", {
        method: "PATCH",
        body: JSON.stringify({ id: limpia, currency }),
      });
      check(`PATCH currency ${JSON.stringify(currency)} → 400`, res.status, 400);
      checkIncluye("explica ARS/USD", res.body?.error, "ARS o USD");
    }
    check("la cuenta sigue en USD tras los rechazos", (await db.account.findUnique({ where: { id: limpia } }))?.currency, "USD");

    // Colisión de nombre AL CAMBIAR de moneda: el 409 dice en cuál chocó.
    const choqueBase = (await createAccount(`${TAG} ocupado`, { currency: "USD" })).body.id;
    const choque = (await createAccount(`${TAG} choque`, { currency: "ARS" })).body.id;
    const patchChoque = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: choque, name: `${TAG} ocupado`, currency: "USD" }),
    });
    check("renombrar+cambiar a un (nombre, moneda) ocupado → 409", patchChoque.status, 409);
    checkIncluye("el mensaje nombra la moneda del choque", patchChoque.body?.error, "en dólares");
    const choqueFila = await db.account.findUnique({ where: { id: choque } });
    check("nombre y moneda quedaron intactos", `${choqueFila?.name}|${choqueFila?.currency}`, `${TAG} choque|ARS`);
    checkTrue("la cuenta ocupada sigue existiendo", Boolean(choqueBase));

    // Un préstamo con cuotas es historia: cambiar su moneda reescribiría el plan.
    if (prestamoUsd.body?.id) {
      const patchPrestamo = await api("/api/accounts", {
        method: "PATCH",
        body: JSON.stringify({ id: prestamoUsd.body.id, currency: "ARS" }),
      });
      check("préstamo con cuotas → 409", patchPrestamo.status, 409);
      check(
        "el préstamo sigue en USD",
        (await db.account.findUnique({ where: { id: prestamoUsd.body.id } }))?.currency,
        "USD",
      );
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 5 · SALDOS Y RECONCILIACIÓN AL CENTAVO
     * ══════════════════════════════════════════════════════════════════════ */
    section("5 · Saldos reales y reconciliación (SQL propio como verdad)");

    const SA = (await createAccount(`${TAG} saldo ARS`, { currency: "ARS", openingBalance: "1000000" })).body.id;
    const SD = (await createAccount(`${TAG} saldo USD`, { currency: "USD", openingBalance: "1000" })).body.id;

    const antesArs = (await get("/api/accounts?currency=ARS&asOf=2032-03-31")).body.netWorth.net;
    const antesUsd = (await get("/api/accounts?currency=USD&asOf=2032-03-31")).body.netWorth.net;

    const transferencia = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "120000",
      toAmount: "100.50",
      date: "2032-03-20",
      accountId: SA,
      toAccountId: SD,
      description: `${TAG} saldo cross`,
    });
    check("transferencia de control → 201", transferencia.status, 201);

    const cuentasArs = (await get("/api/accounts?currency=ARS&asOf=2032-03-31")).body;
    const cuentasUsd = (await get("/api/accounts?currency=USD&asOf=2032-03-31")).body;
    const saldoArs = cuentasArs.accounts.find((account) => account.id === SA);
    const saldoUsd = cuentasUsd.accounts.find((account) => account.id === SD);
    checkMoney("origen ARS baja exactamente `amount`", saldoArs?.balance ?? "x", "880000.00");
    checkMoney("destino USD sube exactamente `toAmount`", saldoUsd?.balance ?? "x", "1100.50");
    checkMoney("SQL independiente: saldo ARS", await sqlBalance(SA, AS_OF), "880000.00");
    checkMoney("SQL independiente: saldo USD", await sqlBalance(SD, AS_OF), "1100.50");

    const despArs = cuentasArs.netWorth.net;
    const despUsd = cuentasUsd.netWorth.net;
    checkMoney("patrimonio ARS: delta -120.000,00", centsToMoney(cents(despArs) - cents(antesArs)), "-120000.00");
    checkMoney("patrimonio USD: delta +100,50", centsToMoney(cents(despUsd) - cents(antesUsd)), "100.50");

    const lista = await get(
      `/api/transactions?currency=ARS&from=2032-03-20&to=2032-03-20`,
    );
    check("lista ARS → 200", lista.status, 200);
    const movCross = (lista.body?.movements ?? []).find(
      (movement) => movement.id === transferencia.body?.id,
    );
    checkTrue("la lista trae la transferencia", Boolean(movCross));
    check("el DTO de la transferencia lleva toAmount string", movCross?.toAmount, "100.50");
    check("el DTO dice la moneda de origen", movCross?.account?.currency, "ARS");
    check("el DTO dice la moneda de destino", movCross?.toAccount?.currency, "USD");

    for (const currency of ["ARS", "USD"]) {
      const rec = await get(
        `/api/reconciliation?month=${MONTH}&asOf=${AS_OF}&currency=${currency}`,
      );
      check(`reconciliación ${currency} → 200`, rec.status, 200);
      checkMoney(
        `reconciliación ${currency}: diferencia al centavo`,
        rec.body?.reconciliation?.difference ?? "x",
        "0.00",
      );
      check(`reconciliación ${currency}: balanced`, rec.body?.reconciliation?.balanced, true);
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 6 · CSV SÓLO-ARS
     * ══════════════════════════════════════════════════════════════════════ */
    section("6 · CSV: sólo cuentas en pesos");

    const csvArs = (await createAccount(`${TAG} CSV Pesos`, { currency: "ARS" })).body.id;
    const csvUsd = (await createAccount(`${TAG} CSV Dolares`, { currency: "USD" })).body.id;
    const csvHeader = "fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion";

    const mixto = [
      csvHeader,
      `2032-03-21,gasto,100,${TAG} CSV Dolares,,,${TAG} csv usd`,
      `2032-03-21,gasto,200,${TAG} CSV Pesos,,,${TAG} csv ars`,
    ].join("\n");

    antes = await movementCount();
    const previewMixto = await post("/api/import/csv/preview", { text: mixto });
    check("preview mixto → 200", previewMixto.status, 200);
    check("fila USD → INVALID", previewMixto.body?.rows?.[0]?.status, "INVALID");
    checkIncluye(
      "la fila USD explica que está en dólares",
      previewMixto.body?.rows?.[0]?.errors?.[0],
      "está en dólares",
    );
    check("fila ARS → VALID", previewMixto.body?.rows?.[1]?.status, "VALID");
    check("el total declara ARS", previewMixto.body?.totals?.currency, "ARS");
    checkMoney("el total sólo suma la fila en pesos", previewMixto.body?.totals?.expenses ?? "x", "200.00");

    const importMixto = await post("/api/import/csv", {
      text: mixto,
      expected: previewMixto.body?.totals,
    });
    check("import mixto → 422", importMixto.status, 422);
    checkIncluye("el 422 explica que no se importó nada", importMixto.body?.error, "No se importó nada");
    check("import mixto no dejó NINGUNA fila", await movementCount(), antes);
    check(
      "la cuenta ARS del archivo rechazado quedó vacía",
      await db.movement.count({ where: { accountId: csvArs } }),
      0,
    );

    // Archivo sólo-USD: no hay nada importable y la moneda del total es null.
    const soloUsd = [
      csvHeader,
      `2032-03-22,gasto,100,${TAG} CSV Dolares,,,${TAG} csv sólo usd`,
    ].join("\n");
    const previewSoloUsd = await post("/api/import/csv/preview", { text: soloUsd });
    check("preview sólo-USD → 200", previewSoloUsd.status, 200);
    check("no hay filas importables", previewSoloUsd.body?.importableRows, 0);
    check("no hay moneda que declarar", previewSoloUsd.body?.totals?.currency, null);
    const importSoloUsd = await post("/api/import/csv", {
      text: soloUsd,
      expected: previewSoloUsd.body?.totals,
    });
    check("import sólo-USD → 422", importSoloUsd.status, 422);
    check("0 filas", await movementCount(), antes);

    // TRANSFER con destino USD: también se rechaza por fila.
    const transferUsd = [
      csvHeader,
      `2032-03-23,transferencia,1000,${TAG} CSV Pesos,${TAG} CSV Dolares,,${TAG} csv transfer`,
    ].join("\n");
    const previewTransfer = await post("/api/import/csv/preview", { text: transferUsd });
    check("preview TRANSFER a USD → 200", previewTransfer.status, 200);
    check("fila TRANSFER a USD → INVALID", previewTransfer.body?.rows?.[0]?.status, "INVALID");
    checkIncluye(
      "nombra la moneda del destino",
      previewTransfer.body?.rows?.[0]?.errors?.join(" "),
      "dólares",
    );
    check("total sin moneda (no hay filas válidas)", previewTransfer.body?.totals?.currency, null);
    const importTransfer = await post("/api/import/csv", {
      text: transferUsd,
      expected: previewTransfer.body?.totals,
    });
    check("import TRANSFER a USD → 422", importTransfer.status, 422);
    check("0 filas", await movementCount(), antes);

    // "Efectivo" en las dos monedas: la fila resuelve la de PESOS.
    const efectivoCsvUsd = (await createAccount(`${TAG} Efectivo CSV`, { currency: "USD" })).body.id;
    const efectivoCsvArs = (await createAccount(`${TAG} Efectivo CSV`, { currency: "ARS" })).body.id;
    const conEfectivo = [
      csvHeader,
      `2032-03-24,gasto,777,${TAG} Efectivo CSV,,,${TAG} csv efectivo`,
    ].join("\n");
    const previewEfectivo = await post("/api/import/csv/preview", { text: conEfectivo });
    check("«Efectivo» en dos monedas: la fila es VALID", previewEfectivo.body?.rows?.[0]?.status, "VALID");
    check("el total es en pesos", previewEfectivo.body?.totals?.currency, "ARS");
    const importEfectivo = await post("/api/import/csv", {
      text: conEfectivo,
      expected: previewEfectivo.body?.totals,
    });
    check("import de «Efectivo» → 201", importEfectivo.status, 201);
    check("importó 1 fila", importEfectivo.body?.imported, 1);
    const movEfectivo = await db.movement.findFirst({
      where: { description: `${TAG} csv efectivo` },
      include: { account: true },
    });
    check("la fila entró en la cuenta en PESOS", movEfectivo?.accountId, efectivoCsvArs);
    checkTrue("y NO en la de dólares", movEfectivo?.accountId !== efectivoCsvUsd);
    check("el resultado declara ARS", importEfectivo.body?.totals?.currency, "ARS");
    check("la cuenta USD no recibió nada", await db.movement.count({ where: { accountId: csvUsd } }), 0);

    /* ══════════════════════════════════════════════════════════════════════
     * 7 · LA BASE COMO RED
     * ══════════════════════════════════════════════════════════════════════ */
    section("7 · La base se niega a guardar lo imposible");

    // Un par recién creado para las escrituras directas.
    const BA = (await createAccount(`${TAG} base ARS`, { currency: "ARS" })).body.id;
    const BD = (await createAccount(`${TAG} base USD`, { currency: "USD" })).body.id;
    const BA2 = (await createAccount(`${TAG} base ARS2`, { currency: "ARS" })).body.id;

    await checkRejects(
      "DB · TRANSFER ARS→USD sin toAmount",
      () =>
        db.movement.create({
          data: { kind: "TRANSFER", amount: "10", date: DIA("2032-04-01"), accountId: BA, toAccountId: BD },
        }),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );
    await checkRejects(
      "DB · TRANSFER ARS→USD con toAmount = 0",
      () =>
        db.movement.create({
          data: { kind: "TRANSFER", amount: "10", toAmount: "0", date: DIA("2032-04-01"), accountId: BA, toAccountId: BD },
        }),
      "movement_to_amount_positive",
    );
    await checkRejects(
      "DB · TRANSFER ARS→ARS con toAmount",
      () =>
        db.movement.create({
          data: { kind: "TRANSFER", amount: "10", toAmount: "10", date: DIA("2032-04-01"), accountId: BA, toAccountId: BA2 },
        }),
      "[finanzas:monto_destino_en_misma_moneda]",
    );
    await checkRejects(
      "DB · EXPENSE con toAmount",
      () =>
        db.movement.create({
          data: { kind: "EXPENSE", amount: "10", toAmount: "1", date: DIA("2032-04-01"), accountId: BA },
        }),
      "movement_to_amount_only_on_transfer",
    );
    await checkRejects(
      "DB · INCOME con toAmount",
      () =>
        db.movement.create({
          data: { kind: "INCOME", amount: "10", toAmount: "1", date: DIA("2032-04-01"), accountId: BA },
        }),
      "movement_to_amount_only_on_transfer",
    );
    await checkRejects(
      "DB · transferencia a la MISMA cuenta",
      () =>
        db.movement.create({
          data: { kind: "TRANSFER", amount: "10", date: DIA("2032-04-01"), accountId: BA, toAccountId: BA },
        }),
      "movement_transfer_to_other_account",
    );

    // El UPDATE también está custodiado (el trigger es INSERT OR UPDATE).
    const crossOk = await db.movement.create({
      data: {
        kind: "TRANSFER", amount: "10", toAmount: "1", date: DIA("2032-04-02"),
        accountId: BA, toAccountId: BD, description: `${TAG} base update cross`,
      },
    });
    await checkRejects(
      "DB · UPDATE que borra el toAmount de una cross",
      () => db.movement.update({ where: { id: crossOk.id }, data: { toAmount: null } }),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );
    const sameOk = await db.movement.create({
      data: {
        kind: "TRANSFER", amount: "10", date: DIA("2032-04-02"),
        accountId: BA, toAccountId: BA2, description: `${TAG} base update same`,
      },
    });
    await checkRejects(
      "DB · UPDATE que agrega toAmount a una misma-moneda",
      () => db.movement.update({ where: { id: sameOk.id }, data: { toAmount: "10" } }),
      "[finanzas:monto_destino_en_misma_moneda]",
    );
    await checkRejects(
      "DB · UPDATE que mueve el origen a otra moneda sin toAmount",
      () => db.movement.update({ where: { id: sameOk.id }, data: { accountId: BD } }),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );

    // El único de cuenta es POR (name, currency).
    await checkRejects(
      "DB · dos cuentas iguales en la MISMA moneda",
      () => db.account.create({ data: { name: `${TAG} base única`, kind: "CASH", currency: "ARS" } }).then(async (created) => {
        await db.account.create({ data: { name: `${TAG} base única`, kind: "CASH", currency: "ARS" } });
        return created;
      }),
      "Unique constraint",
    );
    const mismaNombreOtraMoneda = await db.account.create({
      data: { name: `${TAG} base única`, kind: "CASH", currency: "USD" },
    });
    check("el mismo nombre en OTRA moneda sí entra", mismaNombreOtraMoneda.currency, "USD");
    remember(mismaNombreOtraMoneda.id);

    // Metadata: los candados están y están validados.
    const constraints = await db.$queryRawUnsafe(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = '"Movement"'::regclass
          AND conname IN ('movement_to_amount_positive','movement_to_amount_only_on_transfer','movement_transfer_to_other_account')`,
    );
    check("los 3 CHECK de toAmount/self-transfer existen", constraints.length, 3);
    checkTrue("los 3 están validados", constraints.every((row) => row.convalidated));

    const triggers = await db.$queryRawUnsafe(
      `SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE tgname IN ('movement_currency_shape_check','account_currency_immutable_check')`,
    );
    check("los 2 triggers de moneda existen", triggers.length, 2);
    checkTrue(
      "el de la forma corre en INSERT y UPDATE",
      String(triggers.find((row) => row.tgname === "movement_currency_shape_check")?.def ?? "").includes("INSERT OR UPDATE"),
    );
    checkTrue("los dos triggers están habilitados", triggers.every((row) => row.tgenabled === "O"));

    const funciones = await db.$queryRawUnsafe(
      `SELECT proname, prosrc FROM pg_proc
        WHERE proname IN ('check_movement_currency_shape','check_account_currency_immutable')`,
    );
    const cuerpoCuenta = String(
      funciones.find((row) => row.proname === "check_account_currency_immutable")?.prosrc ?? "",
    );
    for (const tabla of ["Movement", "RecurrenceRule", "FavoriteTemplate", "CardPlan", "Statement", "Installment"]) {
      checkTrue(`la inmutabilidad de moneda mira ${tabla}`, cuerpoCuenta.includes(`"${tabla}"`));
    }

    const indices = await db.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('Account','Budget')`,
    );
    const indexNames = new Set(indices.map((row) => row.indexname));
    checkTrue("existe Account_name_currency_key", indexNames.has("Account_name_currency_key"));
    checkTrue("ya NO existe Account_name_key (unique global)", !indexNames.has("Account_name_key"));
    checkTrue(
      "el único de cuenta es (name, currency)",
      String(indices.find((row) => row.indexname === "Account_name_currency_key")?.indexdef ?? "").includes("(name, currency)"),
    );
    checkTrue(
      "el único de presupuesto incluye la moneda",
      String(indices.find((row) => row.indexname === "Budget_categoryId_month_currency_key")?.indexdef ?? "").includes("currency"),
    );

    // Los candados están en la MIGRACIÓN que los creó, no sólo en la base.
    const sql = readFileSync(
      new URL("../../prisma/migrations/20261104120000_fase4_monedas/migration.sql", import.meta.url),
      "utf8",
    );
    for (const needle of [
      '"Account_name_currency_key"',
      '"movement_to_amount_positive"',
      '"movement_to_amount_only_on_transfer"',
      "movement_currency_shape_check",
      "account_currency_immutable_check",
      "movement_to_amount_positive",
    ]) {
      checkTrue(`la migración de monedas contiene ${needle}`, sql.includes(needle));
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 8 · RECURRENCIA ENTRE MONEDAS (el borde que abrió F4.3)
     * ══════════════════════════════════════════════════════════════════════ */
    section("8 · Recurrencia entre monedas: no se puede crear y no tumba la corrida");

    const recArs = (await createAccount(`${TAG} rec ARS`, { currency: "ARS", openingBalance: "100000" })).body.id;
    const recUsd = (await createAccount(`${TAG} rec USD`, { currency: "USD", openingBalance: "100" })).body.id;
    const recBanco = (await createAccount(`${TAG} rec banco`, { currency: "ARS" })).body.id;

    const reglaCruzada = await post("/api/recurrence/rules", {
      title: `${TAG} regla cruzada`,
      kind: "TRANSFER",
      amount: "1000",
      accountId: recArs,
      toAccountId: recUsd,
      freq: "MONTHLY",
      startDate: "2026-01-01",
      postingMode: "AUTO",
    });
    check("crear una regla TRANSFER ARS→USD → 400", reglaCruzada.status, 400);
    checkIncluye(
      "explica que no puede unir monedas distintas",
      reglaCruzada.body?.error,
      "monedas distintas",
    );
    check(
      "no quedó la regla cruzada",
      await db.recurrenceRule.count({ where: { title: `${TAG} regla cruzada` } }),
      0,
    );

    // Defensa en profundidad: una regla sembrada por fuera de la API no puede
    // tumbar la materialización de las demás.
    const cruzadaDirecta = await db.recurrenceRule.create({
      data: {
        title: `${TAG} cruzada directa`, kind: "TRANSFER", amount: "1000",
        accountId: recArs, toAccountId: recUsd, freq: "MONTHLY",
        startDate: DIA("2026-01-01"), postingMode: "AUTO",
      },
    });
    const categoriaRec = await post("/api/categories", {
      name: `${TAG} CatRec`,
      kind: "EXPENSE",
    });
    check("categoría corta creada → 201", categoriaRec.status, 201);
    const valida = await post("/api/recurrence/rules", {
      title: `${TAG} regla válida`, kind: "EXPENSE", amount: "500",
      accountId: recBanco, freq: "MONTHLY", startDate: "2026-01-01",
      postingMode: "AUTO", categoryName: `${TAG} CatRec`,
    });
    check("la regla válida → 201", valida.status, 201);

    const run = await post("/api/recurrence/run", {});
    check("la corrida NO se cae por la regla cruzada → 200", run.status, 200);
    checkTrue(
      "la regla cruzada aparece en `blocked` con su motivo",
      (run.body?.blocked ?? []).some((item) => item.ruleId === cruzadaDirecta.id),
    );
    check(
      "la cruzada no posteó ningún movimiento",
      await db.movement.count({ where: { recurrenceRuleId: cruzadaDirecta.id } }),
      0,
    );
    checkTrue(
      "la regla válida de la MISMA corrida sí posteó",
      (await db.movement.count({ where: { recurrenceRuleId: valida.body?.id } })) > 0,
    );
    checkTrue("la categoría de prueba existe", Boolean(categoriaRec.body?.id));

    /* ══════════════════════════════════════════════════════════════════════
     * 9 · LATENCIA Y PLANES DE LAS CONSULTAS CRÍTICAS
     * ══════════════════════════════════════════════════════════════════════ */
    section("9 · Latencia de escritura y planes");

    const tiempos = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const res = await post("/api/transactions", {
        kind: "TRANSFER",
        amount: "1000",
        toAmount: "1",
        date: "2032-03-25",
        accountId: SA,
        toAccountId: SD,
        description: `${TAG} latencia ${index}`,
      });
      tiempos.push(performance.now() - started);
      if (res.status !== 201) {
        check(`escritura de latencia #${index} → 201`, res.status, 201);
      }
    }
    tiempos.sort((a, b) => a - b);
    const p50 = tiempos[Math.floor(tiempos.length / 2)];
    const peor = tiempos.at(-1);
    console.log(`        POST cross: p50 ${p50.toFixed(1)} ms · peor ${peor.toFixed(1)} ms (n=20)`);
    checkTrue("p50 de una transferencia cross < 1000 ms", p50 < 1000, `${p50.toFixed(1)} ms`);

    // En una tabla de ~40 cuentas el planner elige Seq Scan (es más barato que
    // el índice). Se fuerza `enable_seqscan = off` para comprobar que el índice
    // único del lookup (name, currency) EXISTE y es usable; no se mide velocidad
    // de un plan que a este volumen no la representa.
    const planCuenta = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe(
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT id FROM "Account" WHERE name = $1 AND currency = $2::"Currency"`,
        `${TAG} base única`,
        "ARS",
      );
    });
    const planTexto = JSON.stringify(planCuenta);
    checkTrue(
      "el lookup por (name, currency) usa el índice único",
      /Account_name_currency_key|Index Scan/i.test(planTexto),
      planTexto.slice(0, 180),
    );
  },
});
