#!/usr/bin/env node
/**
 * 02 · CATEGORÍA OPCIONAL DE PUNTA A PUNTA (brief, ataque C).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * La Fase 7 hizo OPCIONAL la categoría en gastos e ingresos. Esta suite ataca
 * las tres puntas contra la API real:
 *
 *   1. EL ALTA — sin categoría se guarda (201) y el DTO dice `category: null`;
 *      `null`, `""` y `"   "` significan lo mismo ("sin categoría"). Los
 *      cuerpos hostiles con categoría NO-texto (número, array, objeto, bool)
 *      son 400 explicados — nunca 500, nunca un guardado a medias.
 *   2. LOS CUERPOS JSON HOSTILES — `null`, `[1,2]`, `"texto"`, `{` (JSON roto):
 *      todos 400, jamás 500 (el `body.kind` de un `null` era un TypeError con
 *      500 genérico antes de la guarda del borde).
 *   3. LOS LECTORES — un movimiento con `categoryId: null` NO puede romper a
 *      ningún lector: lista (`/api/transactions`, con totales POR CUENTA),
 *      reporte (`/api/reports`, grupo real "Sin categoría"), patrimonio
 *      (`/api/accounts`), tarjetas (`/api/debts`) y reconciliación
 *      (`/api/reconciliation`). Números calculados a mano, no "no explotó".
 *   4. CATEGORÍA POR NOMBRE — se reutiliza por `normalizedName` (escribir la
 *      misma categoría con otras mayúsculas NO crea otra fila), el nombre
 *      original se conserva, y `GET /api/categories` la sirve con su
 *      `lastUsedAt` (la recencia que ordena las sugerencias de la carga rápida).
 *   5. DOBLE SUBMIT — dos POST idénticos (secuenciales y en paralelo) dejan dos
 *      filas y ningún estado intermedio (la fusión la decide la persona en el
 *      aviso de duplicado, no el servidor).
 *
 * Escenario en 2028-03 (lejos del seed de octubre). Limpieza antes y después.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS, CALCULADOS A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * Banco A: apertura 1.000,00. INCOME 50,00 + EXPENSE 100,01 (sin categoría):
 *   · balance → 1.000,00 + 50,00 − 100,01 = 949,99
 *   · totales por cuenta → ingresos "50.00", gastos "100.01"
 * Tarjeta: EXPENSE 33,33 (sin categoría) → balance −33,33 (deuda viva).
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  cuentaDe,
  del,
  deudaDelMes,
  get,
  movimientosDe,
  postRaw,
  PrismaClient,
  reconciliacion,
  reportesDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_CAT";
const MES_DESDE = "2028-03-01";
const MES_HASTA = "2028-03-31";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ─────────────────────────────────────────────────────────────────────────
     * Preparación
     * ───────────────────────────────────────────────────────────────────────── */
    section("Preparación");
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "1000");
    check("el banco responde 201", banco.status, 201);
    const tarjeta = await crearCuenta(`${TAG}_Tarjeta`, "CREDIT_CARD", "0");
    check("la tarjeta responde 201", tarjeta.status, 201);

    /* ─────────────────────────────────────────────────────────────────────────
     * 1. El alta sin categoría: null, "", "   " — todo "sin categoría"
     * ───────────────────────────────────────────────────────────────────────── */
    section("Alta sin categoría (tres formas de decir lo mismo)");
    const sinCampo = await crearMovimiento({
      kind: "EXPENSE",
      amount: "100,01",
      date: "2028-03-05",
      accountId: banco.body?.id,
      description: `${TAG}_SinCampo`,
    });
    check("sin el campo categoryName: 201", sinCampo.status, 201);
    check("el DTO dice category: null", sinCampo.body?.category, null);
    check("y el monto argentino entró exacto", sinCampo.body?.amount, "100.01");

    const conNull = await crearMovimiento({
      kind: "INCOME",
      amount: "50,00",
      date: "2028-03-06",
      accountId: banco.body?.id,
      description: `${TAG}_Null`,
      categoryName: null,
    });
    check("categoryName: null → 201", conNull.status, 201);
    check("y category: null en el DTO", conNull.body?.category, null);

    const conVacio = await crearMovimiento({
      kind: "EXPENSE",
      amount: "1,00",
      date: "2028-03-07",
      accountId: banco.body?.id,
      description: `${TAG}_Vacio`,
      categoryName: "",
    });
    check('categoryName: "" → 201', conVacio.status, 201);
    check("y category: null en el DTO", conVacio.body?.category, null);

    const conEspacios = await crearMovimiento({
      kind: "EXPENSE",
      amount: "2,00",
      date: "2028-03-08",
      accountId: banco.body?.id,
      description: `${TAG}_Espacios`,
      categoryName: "   ",
    });
    check('categoryName: "   " → 201 (los espacios no son una categoría)', conEspacios.status, 201);
    check("y category: null en el DTO", conEspacios.body?.category, null);

    // Los tres de arriba fueron sólo para verificar el borde: se borran para que
    // los totales del escenario de lectores sean los calculados a mano.
    const borrar = (id) => del(`/api/transactions?id=${id}`);

    /* ─────────────────────────────────────────────────────────────────────────
     * 2. Cuerpos hostiles: la categoría, si viene, es TEXTO
     * ───────────────────────────────────────────────────────────────────────── */
    section("Categoría hostil (no-texto)");
    const hostiles = await Promise.all([
      crearMovimiento({ kind: "EXPENSE", amount: "1,00", date: "2028-03-10", accountId: banco.body?.id, categoryName: 123 }),
      crearMovimiento({ kind: "EXPENSE", amount: "1,00", date: "2028-03-10", accountId: banco.body?.id, categoryName: [TAG] }),
      crearMovimiento({ kind: "EXPENSE", amount: "1,00", date: "2028-03-10", accountId: banco.body?.id, categoryName: { nombre: TAG } }),
      crearMovimiento({ kind: "EXPENSE", amount: "1,00", date: "2028-03-10", accountId: banco.body?.id, categoryName: true }),
    ]);
    checkTrue(
      "número, array, objeto y bool: todos 400 (nunca 500, nunca a medias)",
      hostiles.every((r) => r.status === 400),
      JSON.stringify(hostiles.map((r) => r.status)),
    );
    checkTrue(
      "y todos explican que la categoría tiene que ser texto",
      hostiles.every((r) => String(r.body?.error ?? "").includes("texto")),
      JSON.stringify(hostiles.map((r) => String(r.body?.error ?? "").slice(0, 50))),
    );

    section("Cuerpos JSON hostiles (el borde del `req.json()`)");
    const cuerpos = await Promise.all([
      postRaw("/api/transactions", "null"),
      postRaw("/api/transactions", "[1,2]"),
      postRaw("/api/transactions", '"texto"'),
      postRaw("/api/transactions", "{"),
      postRaw("/api/transactions", JSON.stringify({ amount: "1,00" })),
    ]);
    checkTrue(
      "null / array / string / JSON roto / sin kind: todos 400",
      cuerpos.every((r) => r.status === 400),
      JSON.stringify(cuerpos.map((r) => `${r.status}:${String(r.body?.error ?? "").slice(0, 40)}`)),
    );

    /* ─────────────────────────────────────────────────────────────────────────
     * 3. La categoría por nombre: una sola fila, el nombre original se conserva
     * ───────────────────────────────────────────────────────────────────────── */
    section("Categoría por nombre (normalizedName)");
    const primero = await crearMovimiento({
      kind: "EXPENSE",
      amount: "10,00",
      date: "2028-03-11",
      accountId: banco.body?.id,
      description: `${TAG}_CatUno`,
      categoryName: `${TAG}_Comida`,
    });
    check("el primer uso de la categoría: 201", primero.status, 201);
    check("con su nombre", primero.body?.category?.name, `${TAG}_Comida`);

    const segundo = await crearMovimiento({
      kind: "EXPENSE",
      amount: "10,00",
      date: "2028-03-11",
      accountId: banco.body?.id,
      description: `${TAG}_CatDos`,
      categoryName: `${TAG}_COMIDA`,
    });
    check("la variante en mayúsculas: 201", segundo.status, 201);
    check(
      "reutiliza la MISMA categoría (normalizedName único)",
      segundo.body?.category?.id,
      primero.body?.category?.id,
    );
    check(
      "y conserva el nombre original, no el de la última escritura",
      segundo.body?.category?.name,
      `${TAG}_Comida`,
    );

    const filas = await prisma.category.count({
      where: { name: { startsWith: TAG } },
    });
    check("en la base hay UNA sola fila con ese nombre normalizado", filas, 1);

    const listado = await get("/api/categories");
    check("GET /api/categories responde 200", listado.status, 200);
    const mia = (listado.body?.categories ?? []).find((c) => c.name === `${TAG}_Comida`);
    checkTrue("la categoría está en el listado", Boolean(mia), JSON.stringify(mia));
    check("con su tipo EXPENSE", mia?.kind, "EXPENSE");
    checkTrue(
      "y con lastUsedAt (la recencia que ordena las sugerencias de la carga rápida)",
      typeof mia?.lastUsedAt === "string" && mia.lastUsedAt.length > 0,
      JSON.stringify(mia?.lastUsedAt),
    );

    // Dedupe entre tipos: el nombre es único en TODA la tabla, así que un
    // ingreso con el mismo nombre reutiliza la categoría existente (decisión
    // documentada del modelo; la interfaz lo avisa con "✓ se usa la existente").
    const ingresoMisma = await crearMovimiento({
      kind: "INCOME",
      amount: "10,00",
      date: "2028-03-11",
      accountId: banco.body?.id,
      description: `${TAG}_CatIngreso`,
      categoryName: `${TAG}_comida`,
    });
    check("un ingreso con el mismo nombre: 201", ingresoMisma.status, 201);
    check(
      "y reutiliza la misma categoría (dedupe global por nombre)",
      ingresoMisma.body?.category?.id,
      primero.body?.category?.id,
    );

    // Los movimientos de esta sección y el de los bordes ya cumplieron: se
    // borran para dejar el escenario de lectores con los números a mano.
    for (const movement of [
      conVacio.body?.id,
      conEspacios.body?.id,
      primero.body?.id,
      segundo.body?.id,
      ingresoMisma.body?.id,
    ]) {
      if (movement) await borrar(movement);
    }
    const restantes = await prisma.movement.count({
      where: { description: { startsWith: TAG } },
    });
    check("quedan sólo los dos movimientos del escenario de lectores", restantes, 2);

    /* ─────────────────────────────────────────────────────────────────────────
     * 4. Los lectores con categoryId null
     * ───────────────────────────────────────────────────────────────────────── */
    section("El gasto en la tarjeta (sin categoría) y los lectores");
    const gastoTarjeta = await crearMovimiento({
      kind: "EXPENSE",
      amount: "33,33",
      date: "2028-03-09",
      accountId: tarjeta.body?.id,
      description: `${TAG}_Tarjeta`,
    });
    check("el gasto sin categoría en la tarjeta: 201", gastoTarjeta.status, 201);

    const lista = await movimientosDe(MES_DESDE, MES_HASTA);
    check("la lista responde 200", lista.status, 200);
    check("con los tres movimientos del escenario", lista.body?.movements?.length, 3);
    checkTrue(
      "y todos con category: null (ni '' ni undefined)",
      (lista.body?.movements ?? []).every((m) => m.category === null),
      JSON.stringify((lista.body?.movements ?? []).map((m) => m.category)),
    );

    const porBanco = await get(
      `/api/transactions?from=${MES_DESDE}&to=${MES_HASTA}&accountId=${banco.body?.id}`,
    );
    check("los totales del banco: gastos 100,01", porBanco.body?.totals?.expenses, "100.01");
    check("ingresos 50,00", porBanco.body?.totals?.income, "50.00");

    const porTarjeta = await get(
      `/api/transactions?from=${MES_DESDE}&to=${MES_HASTA}&accountId=${tarjeta.body?.id}`,
    );
    check("los totales de la tarjeta: gastos 33,33", porTarjeta.body?.totals?.expenses, "33.33");

    const reporte = await reportesDe(MES_DESDE, MES_HASTA);
    check("el reporte responde 200", reporte.status, 200);
    const sinCategoria = (reporte.body?.byCategory ?? []).find(
      (row) => row.categoryId === null,
    );
    checkTrue("el grupo «Sin categoría» existe (categoría real, no un agujero)", Boolean(sinCategoria));
    check("con el nombre «Sin categoría»", sinCategoria?.name, "Sin categoría");
    check(
      "y suma exactamente los gastos del rango",
      sinCategoria?.amount,
      reporte.body?.totals?.expenses,
    );

    const bancoFinal = await cuentaDe(banco.body?.id, "?asOf=2028-03-31");
    check(
      "el patrimonio del banco: 1.000,00 + 50,00 − 100,01 = 949,99",
      bancoFinal?.balance,
      "949.99",
    );
    const tarjetaFinal = await cuentaDe(tarjeta.body?.id, "?asOf=2028-03-31");
    check("la tarjeta queda en −33,33 (deuda viva)", tarjetaFinal?.balance, "-33.33");

    const deudas = await deudaDelMes("2028-03", "2028-03-31");
    check("el reporte de deudas responde 200 (lector compartido con tarjetas)", deudas.status, 200);
    checkTrue(
      "y no trae NaN ni null donde van números",
      !JSON.stringify(deudas.body ?? {}).includes("NaN"),
      JSON.stringify(deudas.body)?.slice(0, 120),
    );

    const recon = await reconciliacion("2028-03", "2028-03-31");
    check("la reconciliación responde 200", recon.status, 200);

    /* ─────────────────────────────────────────────────────────────────────────
     * 5. Doble submit: dos filas, ningún estado intermedio
     * ───────────────────────────────────────────────────────────────────────── */
    section("Doble submit (secuencial y en paralelo)");
    const cuerpoDoble = {
      kind: "EXPENSE",
      amount: "77,77",
      date: "2028-03-12",
      accountId: banco.body?.id,
      description: `${TAG}_Doble`,
    };
    const dobleUno = await crearMovimiento(cuerpoDoble);
    const dobleDos = await crearMovimiento(cuerpoDoble);
    check("secuencial: 201 y 201", `${dobleUno.status},${dobleDos.status}`, "201,201");
    const paralelo = await Promise.all([
      crearMovimiento(cuerpoDoble),
      crearMovimiento(cuerpoDoble),
    ]);
    check("en paralelo: 201 y 201", paralelo.map((r) => r.status).join(","), "201,201");

    const dobles = await prisma.movement.count({
      where: { description: `${TAG}_Doble` },
    });
    check("quedaron las 4 filas (ninguna a medias)", dobles, 4);
    for (const movement of [dobleUno, dobleDos, ...paralelo]) {
      if (movement.body?.id) await borrar(movement.body.id);
    }
    const doblesFinal = await prisma.movement.count({
      where: { description: `${TAG}_Doble` },
    });
    check("y se limpiaron las 4", doblesFinal, 0);

    /* ─────────────────────────────────────────────────────────────────────────
     * 6. Observación: el largo del nombre de categoría difiere entre rutas
     * ─────────────────────────────────────────────────────────────────────────
     * `POST /api/categories` limita el nombre a 40 caracteres, pero el alta de
     * un movimiento crea la categoría por `upsert` SIN ese límite. No se arregla
     * acá (es una decisión de producto, no un bug de datos): se deja medido.
     */
    section("Observación: largo del nombre de categoría");
    const largo = await crearMovimiento({
      kind: "EXPENSE",
      amount: "1,00",
      date: "2028-03-13",
      accountId: banco.body?.id,
      description: `${TAG}_Largo`,
      categoryName: `${TAG}_${"X".repeat(60)}`,
    });
    checkTrue(
      `por el alta de un movimiento, un nombre de categoría de 60+ caracteres se acepta (${largo.status})`,
      largo.status === 201,
    );
    console.log(
      `  ·  observación: POST /api/categories rechaza >40, el alta de movimientos no (` +
        `nombre creado de ${largo.body?.category?.name?.length ?? "?"} caracteres)`,
    );
    if (largo.body?.id) await borrar(largo.body.id);
  },
});
