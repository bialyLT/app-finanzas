#!/usr/bin/env node
/**
 * Batería 03 · Concurrencia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * Los bugs caros de una base viven en las carreras, no en el camino feliz:
 *
 *   1. **Cambiar la moneda de una cuenta MIENTRAS entra un movimiento.** El
 *      trigger de inmutabilidad pregunta "¿esta cuenta tiene historia?" con un
 *      SELECT. Bajo READ COMMITTED no ve la fila que la otra transacción todavía
 *      no commiteó: si el UPDATE gana la carrera, la cuenta termina en otra
 *      moneda CON un movimiento que se cargó cuando era la anterior. Es el
 *      estado que el trigger existe para impedir.
 *   2. **Dos altas simultáneas del mismo (nombre, moneda).** El índice único
 *      tiene que dejar pasar UNA sola, sin deadlock.
 *   3. **N transferencias entre monedas en paralelo.** Tienen que entrar todas,
 *      sin deadlock y con la suma exacta (ni una fila perdida ni duplicada).
 *   4. **Doble submit de la misma transferencia.** La base NO deduplica
 *      movimientos por diseño (la app avisa, no bloquea): se mide y se informa,
 *      no se cuenta como falla de esta fase.
 *
 * Dos `PrismaClient` distintos = dos conexiones reales. Dos queries en la misma
 * conexión se serializan solas y esconden el bug.
 */

import {
  check,
  checkMoney,
  checkTrue,
  db,
  makeAccount,
  makeCategory,
  makeMovement,
  newClient,
  newTag,
  runBattery,
  section,
  sqlBalance,
} from "./helpers.mjs";

const TAG = newTag("t03");
const day = (value) => new Date(`${value}T00:00:00.000Z`);

await runBattery({
  tag: TAG,
  withHttp: false,
  main: async () => {
    const ars = await makeAccount(TAG, "ARS", { currency: "ARS", kind: "BANK" });
    const usd = await makeAccount(TAG, "USD", { currency: "USD", kind: "BANK" });
    const gastos = await makeCategory(TAG, "Gastos", "EXPENSE");
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");

    /* ── 0 · El caso simple: el trigger sí ve la historia commiteada ────── */
    section("Control · el trigger ve la historia ya commiteada");
    const conHistoria = await makeAccount(TAG, "ConHistoria", { currency: "ARS" });
    await makeMovement({
      kind: "INCOME",
      amount: "1000",
      date: day("2031-08-01"),
      accountId: conHistoria.id,
      categoryId: sueldo.id,
      description: `${TAG} historia`,
    });
    let rechazoSimple = false;
    try {
      await db.account.update({ where: { id: conHistoria.id }, data: { currency: "USD" } });
    } catch {
      rechazoSimple = true;
    }
    check("sin concurrencia, el cambio de moneda con historia se rechaza", rechazoSimple, true);

    /* ── 1 · La carrera: UPDATE de moneda vs INSERT de movimiento ───────── */
    section("Carrera · cambio de moneda vs movimiento entrante");
    const victima = await makeAccount(TAG, "Carrera", { currency: "ARS" });
    const c1 = newClient();
    const c2 = newClient();

    let liberarC1;
    const compuerta = new Promise((resolve) => {
      liberarC1 = resolve;
    });
    let avisarUpdate;
    const updateHecho = new Promise((resolve) => {
      avisarUpdate = resolve;
    });

    let updateError = null;
    const p1 = c1
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
          // Cambia la moneda de una cuenta SIN historia: el trigger la deja.
          await tx.account.update({ where: { id: victima.id }, data: { currency: "USD" } });
          avisarUpdate();
          // Se queda con la transacción abierta mientras la otra intenta escribir.
          await compuerta;
        },
        { timeout: 30_000, maxWait: 10_000 },
      )
      .catch((error) => {
        updateError = error;
      });

    await updateHecho;

    // El INSERT del movimiento referencia la cuenta por FK. Si la base serializa
    // contra el UPDATE en curso, este INSERT espera; con `lock_timeout` corto se
    // ve como 55P03 (lock_not_available) en vez de colgar el script.
    let insertBloqueado = false;
    let insertError = null;
    try {
      await c2.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2000ms'`);
        await tx.movement.create({
          data: {
            kind: "INCOME",
            amount: "5000",
            date: day("2031-08-02"),
            accountId: victima.id,
            categoryId: sueldo.id,
            description: `${TAG} movimiento en la carrera`,
          },
        });
      });
    } catch (error) {
      insertError = error;
      const text = `${error?.message ?? error}`;
      insertBloqueado = text.includes("55P03") || /lock timeout|lock_not_available/i.test(text);
    }

    liberarC1();
    await p1;

    const finalAccount = await db.account.findUnique({
      where: { id: victima.id },
      select: { currency: true },
    });
    const finalMovements = await db.movement.count({ where: { accountId: victima.id } });

    console.log(
      `        resultado: moneda=${finalAccount?.currency} · movimientos=${finalMovements}` +
        ` · updateError=${updateError ? "sí" : "no"} · insertBloqueado=${insertBloqueado}`,
    );
    if (updateError) {
      console.log(`        updateError: ${String(updateError.message).slice(0, 240)}`);
    }
    if (insertError && !insertBloqueado) {
      console.log(`        insertError: ${String(insertError.message).slice(0, 240)}`);
    }

    // La invariante se sostiene si el INSERT no pudo entrar mientras el UPDATE
    // estaba en curso (la FK lo serializa) y el UPDATE commitea sin ver historia.
    // Es la prueba de que NO se puede llegar al estado imposible: cuenta en USD
    // con un movimiento cargado cuando era ARS.
    check("el UPDATE de moneda commitea (no ve historia)", updateError, null);
    checkTrue(
      "el INSERT del movimiento queda serializado por la FK (bloquea)",
      insertBloqueado,
      String(insertError?.message).slice(0, 200),
    );
    check("la cuenta quedó en USD", finalAccount?.currency, "USD");
    check("no hay ningún movimiento cargado durante la ventana", finalMovements, 0);

    // Después del commit, el mismo INSERT entra: la cuenta YA es USD, así que el
    // movimiento es de dólares y el estado es consistente.
    const despues = await db.movement.create({
      data: {
        kind: "INCOME",
        amount: "5000",
        date: day("2031-08-02"),
        accountId: victima.id,
        categoryId: sueldo.id,
        description: `${TAG} movimiento posterior`,
      },
    });
    checkTrue("después del commit, el movimiento entra", Boolean(despues.id));
    check(
      "la cuenta conserva la moneda nueva",
      (await db.account.findUnique({ where: { id: victima.id }, select: { currency: true } }))
        ?.currency,
      "USD",
    );

    await c1.$disconnect();
    await c2.$disconnect();

    /* ── 2 · Dos altas simultáneas del mismo nombre y moneda ────────────── */
    section("Carrera · dos altas del mismo (nombre, moneda)");
    const c3 = newClient();
    const c4 = newClient();
    const nombreDup = `${TAG} Dup`;
    const results = await Promise.allSettled([
      c3.account.create({ data: { name: nombreDup, kind: "CASH", currency: "ARS" } }),
      c4.account.create({ data: { name: nombreDup, kind: "CASH", currency: "ARS" } }),
    ]);
    const creadas = results.filter((r) => r.status === "fulfilled").length;
    const rechazadas = results.filter((r) => r.status === "rejected").length;
    check("exactamente UNA de las dos altas entra", creadas, 1);
    check("la otra se rechaza por el índice único", rechazadas, 1);
    const dupCount = await db.account.count({ where: { name: nombreDup } });
    check("queda UNA sola fila con ese nombre", dupCount, 1);
    await c3.$disconnect();
    await c4.$disconnect();

    /* ── 3 · N transferencias entre monedas en paralelo ─────────────────── */
    section("Carrera · 10 transferencias ARS→USD en paralelo");
    const N = 10;
    const resultados = await Promise.allSettled(
      Array.from({ length: N }, (_, index) =>
        makeMovement({
          kind: "TRANSFER",
          amount: "1000",
          toAmount: "1",
          date: day("2031-08-03"),
          accountId: ars.id,
          toAccountId: usd.id,
          description: `${TAG} paralela ${index}`,
        }),
      ),
    );
    const okParalelas = resultados.filter((r) => r.status === "fulfilled").length;
    check(`${N} transferencias entran`, okParalelas, N);
    const fallidas = resultados.filter((r) => r.status === "rejected");
    check("ninguna falla (ni deadlock ni timeout)", fallidas.length, 0);
    if (fallidas.length > 0) {
      console.log(`        primer error: ${String(fallidas[0].reason?.message).slice(0, 200)}`);
    }

    // 10 × 1.000 salen de ARS y 10 × 1 entran a USD.
    checkMoney("el saldo ARS bajó exactamente 10.000", await sqlBalance(ars.id, "2031-08-31"), "-10000.00");
    checkMoney("el saldo USD subió exactamente 10", await sqlBalance(usd.id, "2031-08-31"), "10.00");

    /* ── 4 · Doble submit de la MISMA transferencia ─────────────────────── */
    section("Doble submit · la base no deduplica (diseño conocido)");
    const gemela = {
      kind: "TRANSFER",
      amount: "2000",
      toAmount: "2",
      date: day("2031-08-04"),
      accountId: ars.id,
      toAccountId: usd.id,
      description: `${TAG} doble submit`,
    };
    const [d1, d2] = await Promise.allSettled([
      makeMovement(gemela),
      makeMovement(gemela),
    ]);
    checkTrue("las dos inserciones se aceptan (no hay idempotencia en la base)", d1.status === "fulfilled" && d2.status === "fulfilled");
    const gemelas = await db.movement.count({ where: { description: `${TAG} doble submit` } });
    check("quedan DOS filas (la app avisa, no bloquea)", gemelas, 2);
    console.log(
      "        (No es un bug de F4.2: el proyecto decidió que el dedupe es advisory; ver Fase 7.)",
    );

    /* ── 5 · Sin deadlock entre las dos direcciones ─────────────────────── */
    section("Carrera · transferencias en las dos direcciones a la vez");
    const mixtas = await Promise.allSettled([
      ...Array.from({ length: 5 }, () =>
        makeMovement({
          kind: "TRANSFER",
          amount: "100",
          toAmount: "0.1",
          date: day("2031-08-05"),
          accountId: ars.id,
          toAccountId: usd.id,
          description: `${TAG} ida`,
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        makeMovement({
          kind: "TRANSFER",
          amount: "0.5",
          toAmount: "500",
          date: day("2031-08-05"),
          accountId: usd.id,
          toAccountId: ars.id,
          description: `${TAG} vuelta`,
        }),
      ),
    ]);
    check(
      "10 transferencias cruzadas en paralelo, todas entran",
      mixtas.filter((r) => r.status === "fulfilled").length,
      10,
    );
    check(
      "ningún deadlock",
      mixtas.filter((r) => r.status === "rejected").length,
      0,
    );
  },
});
