#!/usr/bin/env node
/**
 * 10 — Hostiles: sesión, Origin, cuerpos crudos, tipos y coerción laxa, ids
 *      imposibles y el tope de cuotas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (clase de ataque "entrada hostil", brief línea 38)
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. Las rutas nuevas cumplen el contrato de borde:
 *        sin sesión → 401 (y las viejas igual); Origin ajeno → 403 (CSRF).
 *   B. Cuerpos crudos (`null`, `"texto"`, `[1,2]`, `42`, `{}`, campos de otro
 *      tipo) → 400, NUNCA 500.
 *   C. Ids imposibles → el código correcto y el mensaje correcto:
 *        id NUL → 404 "no existe"; cash NUL → 400 "no existe"; id de 5000
 *        caracteres → 404; cuenta que no es préstamo → 400; cash = préstamo /
 *        tarjeta → 400.
 *   D. Coerción laxa (REPRO de los hallazgos de esta ronda):
 *        `installmentNumber: [1]` — `Number([1])` es 1 → HOY paga (201);
 *        `installmentNumber: true` — `Number(true)` es 1 → HOY paga;
 *        `extraCapital: [500]` — `String([500])` es "500" → HOY paga;
 *        `date: ["2029-01-10"]` — `String([...])` es la fecha → HOY avanza.
 *      Y la clase genérica NUL: `categoryName` con `\u0000` en una cuota CON
 *      interés → HOY 500 (Postgres 22021, error sin código que Prisma no tipa).
 *   E. Después de TODOS los hostiles, el préstamo quedó intacto: cero
 *      movimientos, capital 0, ninguna cuota cubierta.
 *   F. Preview: system inválido/IMPORTED/minúsculas, monto/tasa/cuotas basura
 *      → 400; el tope es 600 (600 OK, 601 → 400 también en el alta).
 *   G. asOf y month inválidos en las lecturas → 400.
 *   H. Alta de cuentas hostil: kind POTATO, LOAN sin parámetros (con el detalle
 *      de QUÉ falta), CASH con datos de préstamo, nombre de 61 → 400 sin crear
 *      nada; el NUL en un nombre (clase genérica) → 400 por la regla de base.
 */

import {
  apiForeignOrigin,
  apiNoAuth,
  check,
  checkDeep,
  checkIncluye,
  checkSin500,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  deudaDelMes,
  pagarPrestamo,
  post,
  postRaw,
  prestamoDe,
  runScript,
  section,
  vistaPrestamos,
  vistasPreview,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_10";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ────────────────────────────────────────────────────────────────────────
     * A — Sin sesión y con Origin ajeno
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · 401 sin sesión y 403 con Origin ajeno");

    const cuerpoPay = JSON.stringify({ accountId: "x", cashAccountId: "y" });
    const sinSesion = [
      await apiNoAuth("/api/loans"),
      await apiNoAuth(
        "/api/loans/preview?principal=100000&tnaPercent=0&installmentCount=12",
      ),
      await apiNoAuth("/api/loans/pay", { method: "POST", body: cuerpoPay }),
      await apiNoAuth("/api/accounts"),
    ];
    checkDeep(
      "las 3 rutas nuevas y accounts: 401 sin sesión",
      sinSesion.map((r) => r.status),
      [401, 401, 401, 401],
    );
    checkSin500("sin sesión: nunca 500", sinSesion);

    const ajeno = [
      await apiForeignOrigin("/api/loans/pay", cuerpoPay),
      await apiForeignOrigin(
        "/api/accounts",
        JSON.stringify({ name: `${TAG}_Ajeno`, kind: "CASH" }),
      ),
    ];
    checkDeep(
      "Origin ajeno: 403 (CSRF)",
      ajeno.map((r) => r.status),
      [403, 403],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * B — Cuerpos crudos
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · Cuerpos crudos: 400, nunca 500");

    const crudos = [];
    for (const raw of [
      null,
      '"texto"',
      "[1,2]",
      "42",
      "{}",
      '{"accountId":7,"cashAccountId":9}',
      '{"accountId":"   ","cashAccountId":"x"}',
    ]) {
      crudos.push(await postRaw("/api/loans/pay", raw));
    }
    checkSin500("cuerpos crudos en /pay: nunca 500", crudos);
    checkDeep(
      "cuerpos crudos en /pay: todo 400",
      crudos.map((r) => r.status),
      [400, 400, 400, 400, 400, 400, 400],
    );

    const crudosCuenta = [];
    for (const raw of [null, '"texto"', "[1]", "{}"]) {
      crudosCuenta.push(await postRaw("/api/accounts", raw));
    }
    checkSin500("cuerpos crudos en /accounts: nunca 500", crudosCuenta);
    checkDeep(
      "cuerpos crudos en /accounts: todo 400",
      crudosCuenta.map((r) => r.status),
      [400, 400, 400, 400],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * C — Ids imposibles
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · Ids imposibles: 404 el que no existe, 400 el que no sirve");

    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco 201", banco.status, 201);
    const caja = await crearCuenta(`${TAG}_Caja`, "CASH", "0");
    check("alta de la caja 201", caja.status, 201);
    const tarjeta = await post("/api/accounts", {
      name: `${TAG}_Tarjeta`,
      kind: "CREDIT_CARD",
    });
    check("alta de la tarjeta 201", tarjeta.status, 201);
    // Con interés (> 0) para que el pago tenga categoría: es lo que hace NUL
    // en `categoryName` alcanzable. 10.000 al 12% TNA → i = 1% → c1 = 100,00.
    const prestamo = await crearPrestamo({
      name: `${TAG}_Prestamo`,
      kind: "LOAN",
      principal: "10000",
      tnaPercent: "12",
      installmentCount: 12,
      firstInstallmentDate: "2029-01-10",
    });
    check("alta del préstamo 201", prestamo.status, 201);

    const bancoId = banco.body?.id;
    const cajaId = caja.body?.id;
    const tarjetaId = tarjeta.body?.id;
    const loanId = prestamo.body?.id;

    const base = { accountId: loanId, cashAccountId: bancoId, date: "2029-01-10" };

    // REPRO del hallazgo NUL: HOY el lock/findUnique con \u0000 muere con 500
    // (Postgres 22021 "invalid byte sequence").
    const nulPrestamo = await pagarPrestamo({ ...base, accountId: "abc\u0000def" });
    check("NUL en el id del préstamo: 404", nulPrestamo.status, 404);
    checkIncluye(
      "NUL en el id del préstamo: 'no existe'",
      nulPrestamo.body?.error,
      "no existe",
    );
    const nulCaja = await pagarPrestamo({ ...base, cashAccountId: "ca\u0000ja" });
    check("NUL en la cuenta de dinero: 400", nulCaja.status, 400);
    checkIncluye(
      "NUL en la cuenta de dinero: 'no existe'",
      nulCaja.body?.error,
      "no existe",
    );

    const idsHostiles = [
      await pagarPrestamo({ ...base, accountId: "no-existe-esta-id" }),
      await pagarPrestamo({ ...base, cashAccountId: "no-existe-esta-id" }),
      await pagarPrestamo({ ...base, accountId: bancoId }),
      await pagarPrestamo({ ...base, accountId: cajaId }),
      await pagarPrestamo({ ...base, accountId: tarjetaId }),
      await pagarPrestamo({ ...base, cashAccountId: loanId }),
      await pagarPrestamo({ ...base, cashAccountId: tarjetaId }),
      await pagarPrestamo({ ...base, accountId: "z".repeat(5000) }),
    ];
    checkSin500("ids hostiles: nunca 500", idsHostiles);
    checkDeep(
      "ids hostiles: 404 el inexistente, 400 el que no es préstamo/dinero",
      idsHostiles.map((r) => r.status),
      [404, 400, 400, 400, 400, 400, 400, 404],
    );
    checkIncluye(
      "el banco no es un préstamo",
      idsHostiles[2].body?.error,
      "no es un préstamo",
    );
    checkIncluye(
      "la misma cuenta de los dos lados",
      idsHostiles[5].body?.error,
      "distinta",
    );
    checkIncluye(
      "la tarjeta no es cuenta de dinero",
      idsHostiles[6].body?.error,
      "cuenta de dinero",
    );

    /* ────────────────────────────────────────────────────────────────────────
     * D — Coerción laxa (los REPRO de esta ronda)
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · Coerción y NUL: lo que HOY pasa de largo (repro)");

    const categoriaNul = await pagarPrestamo({
      ...base,
      installmentNumber: 1,
      categoryName: "Int\u0000ereses",
    });
    check("categoryName con NUL: 400 (hoy 500)", categoriaNul.status, 400);

    const cuotaArray = await pagarPrestamo({ ...base, installmentNumber: [1] });
    check("installmentNumber [1]: 400 (Number([1]) es 1)", cuotaArray.status, 400);

    const cuotaBool = await pagarPrestamo({ ...base, installmentNumber: true });
    check("installmentNumber true: 400 (Number(true) es 1)", cuotaBool.status, 400);

    const extraArray = await pagarPrestamo({
      ...base,
      installmentNumber: 2,
      extraCapital: [500],
    });
    check("extraCapital [500]: 400 (String([500]) es 500)", extraArray.status, 400);

    const fechaArray = await pagarPrestamo({ ...base, date: ["2029-01-10"] });
    check('date ["2029-01-10"]: 400 (String([...]) es la fecha)', fechaArray.status, 400);

    const tiposRaros = [
      await pagarPrestamo({ ...base, installmentNumber: 0 }),
      await pagarPrestamo({ ...base, installmentNumber: -1 }),
      await pagarPrestamo({ ...base, installmentNumber: 1.5 }),
      await pagarPrestamo({ ...base, installmentNumber: "abc" }),
      await pagarPrestamo({ ...base, installmentNumber: "1.5" }),
      await pagarPrestamo({ ...base, installmentNumber: 999, categoryName: 7 }),
      await pagarPrestamo({ ...base, date: "2028-13-45" }),
      await pagarPrestamo({ ...base, date: "2028-02-30" }),
      await pagarPrestamo({ ...base, date: "31-12-2028" }),
      await pagarPrestamo({ ...base, cancel: "si" }),
      await pagarPrestamo({ ...base, extraCapital: true }),
      await pagarPrestamo({ ...base, extraCapital: "  " }),
    ];
    checkSin500("tipos raros: nunca 500", tiposRaros);
    checkDeep(
      "tipos raros: todo 400",
      tiposRaros.map((r) => r.status),
      [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * E — El préstamo quedó intacto: ningún hostil escribió
     * ──────────────────────────────────────────────────────────────────────── */
    section("E · Después de los hostiles: cero movimientos, capital 0");

    const movimientos = await prisma.movement.count({
      where: {
        OR: [
          { toAccountId: loanId },
          { accountId: loanId },
          { accountId: bancoId, description: { startsWith: "Cuota" } },
        ],
      },
    });
    check("ningún hostil escribió movimientos", movimientos, 0);

    const vistaFinal = prestamoDe(await vistaPrestamos("?asOf=2029-01-10"), loanId);
    check("capital pagado 0.00", vistaFinal?.capitalPaid, "0.00");
    check(
      "ninguna cuota cubierta",
      (vistaFinal?.installments ?? []).filter((f) => f.covered).length,
      0,
    );

    /* ────────────────────────────────────────────────────────────────────────
     * F — Preview hostil y tope de 600
     * ──────────────────────────────────────────────────────────────────────── */
    section("F · Preview: system/monto/tasa/cuotas inválidos y el tope 600");

    const previewHostiles = [];
    for (const query of [
      "system=POTATO&principal=100&tnaPercent=0&installmentCount=3",
      "system=IMPORTED&principal=100&tnaPercent=0&installmentCount=3",
      "system=french&principal=100&tnaPercent=0&installmentCount=3",
      "principal=0&tnaPercent=0&installmentCount=3",
      "principal=abc&tnaPercent=0&installmentCount=3",
      "principal=100&tnaPercent=0&installmentCount=0",
      "principal=100&tnaPercent=0&installmentCount=601",
      "principal=100&tnaPercent=0&installmentCount=1.5",
      "principal=100&tnaPercent=-1&installmentCount=3",
    ]) {
      previewHostiles.push(await vistasPreview(query));
    }
    checkSin500("preview hostil: nunca 500", previewHostiles);
    checkDeep(
      "preview hostil: todo 400",
      previewHostiles.map((r) => r.status),
      [400, 400, 400, 400, 400, 400, 400, 400, 400],
    );

    const tope = await vistasPreview(
      "principal=600&tnaPercent=0&installmentCount=600",
    );
    check("600 cuotas: 200", tope.status, 200);
    check("600 filas en el plan", (tope.body?.schedule ?? []).length, 600);
    check("600/600 al 0% → 1.00 por cuota", tope.body?.schedule?.[599]?.payment, "1.00");

    const altaTope = await crearPrestamo({
      name: `${TAG}_Tope`,
      kind: "LOAN",
      principal: "601",
      tnaPercent: "0",
      installmentCount: 601,
      firstInstallmentDate: "2029-01-10",
    });
    check("alta con 601 cuotas: 400", altaTope.status, 400);
    check(
      "la cuenta de 601 cuotas no quedó creada",
      await prisma.account.count({ where: { name: `${TAG}_Tope` } }),
      0,
    );

    /* ────────────────────────────────────────────────────────────────────────
     * G — Lecturas: asOf y month inválidos
     * ──────────────────────────────────────────────────────────────────────── */
    section("G · asOf y month inválidos: 400");

    const asOfs = [
      await vistaPrestamos("?asOf=asura"),
      await vistaPrestamos("?asOf=2028-02-30"),
      await deudaDelMes("2028-13"),
      await deudaDelMes("2028-1"),
    ];
    checkSin500("asOf/month inválidos: nunca 500", asOfs);
    checkDeep(
      "asOf/month inválidos: todo 400",
      asOfs.map((r) => r.status),
      [400, 400, 400, 400],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * H — Alta de cuentas hostil + la clase genérica NUL fuera de /pay
     * ──────────────────────────────────────────────────────────────────────── */
    section("H · Cuentas: kind/params/nombre hostiles y NUL genérico");

    const cuentaHostil = [
      await post("/api/accounts", { name: `${TAG}_Basura`, kind: "POTATO" }),
      await post("/api/accounts", { name: `${TAG}_SinParams`, kind: "LOAN" }),
      await post("/api/accounts", {
        name: `${TAG}_Mixta`,
        kind: "CASH",
        principal: "100",
        amortizationSystem: "FRENCH",
      }),
      await post("/api/accounts", { name: "L".repeat(61), kind: "CASH" }),
    ];
    checkSin500("alta de cuentas hostil: nunca 500", cuentaHostil);
    checkDeep(
      "alta de cuentas hostil: todo 400",
      cuentaHostil.map((r) => r.status),
      [400, 400, 400, 400],
    );
    checkIncluye(
      "LOAN sin parámetros dice QUÉ falta (el monto)",
      cuentaHostil[1].body?.error,
      "el monto",
    );
    checkIncluye(
      "LOAN sin parámetros dice QUÉ falta (la tasa)",
      cuentaHostil[1].body?.error,
      "la tasa (TNA)",
    );
    checkIncluye(
      "datos de préstamo sólo en cuentas de préstamo",
      cuentaHostil[2].body?.error,
      "sólo se cargan en cuentas de tipo préstamo",
    );
    check(
      "el LOAN sin params no quedó creado",
      await prisma.account.count({ where: { name: `${TAG}_SinParams` } }),
      0,
    );
    check(
      "la CASH con params de préstamo no quedó creada",
      await prisma.account.count({ where: { name: `${TAG}_Mixta` } }),
      0,
    );

    // Clase genérica del hallazgo NUL: cualquier campo de texto con \u0000
    // muere en Postgres (22021). La regla de base lo convierte en 400.
    const nulNombre = await post("/api/accounts", {
      name: `${TAG}_NUL\u0000caja`,
      kind: "CASH",
    });
    check("NUL en el nombre de una cuenta: 400 (clase genérica)", nulNombre.status, 400);
    check(
      "la cuenta con NUL no quedó creada",
      await prisma.account.count({ where: { name: { startsWith: `${TAG}_NUL` } } }),
      0,
    );

    const nulDesc = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100",
      date: "2029-01-10",
      description: "de\u0000sc",
      accountId: bancoId,
      toAccountId: cajaId,
    });
    check("NUL en la descripción de un movimiento: 400 (clase genérica)", nulDesc.status, 400);
    check(
      "la transferencia con NUL no quedó",
      await prisma.movement.count({ where: { toAccountId: cajaId } }),
      0,
    );
  },
});
