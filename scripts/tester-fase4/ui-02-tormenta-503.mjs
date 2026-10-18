#!/usr/bin/env node
/**
 * ui-02 - La tormenta de concurrencia: P2024/P2028 -> 503 con copy de reintento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, criterio 7 + "área caliente 4")
 * ─────────────────────────────────────────────────────────────────────────────
 * El servidor de la ronda configuró `TRANSACTION_OPTIONS` GLOBAL (maxWait 15 s)
 * para que un pico no mate una transacción con el P2028 del default (2 s). La
 * otra mitad del contrato es qué ve la persona cuando el pool SE AGOTA igual:
 * un 503 con copy de reintento — nunca un 500 genérico, y sin auto-retry (el
 * pedido no se reintenta solo: si se hubiera creado, la cuenta fantasma lo
 * delataría).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE REPRODUCE LA TORMENTA (determinista, sin depender de la máquina)
 * ─────────────────────────────────────────────────────────────────────────────
 * No alcanza con tirar 50 pedidos: las transacciones de esta app duran
 * milisegundos y el pool las va drenando. El pool se agota de verdad cuando
 * sus conexiones quedan OCUPADAS esperando. El script lo fuerza así:
 *
 *   1. Un cliente aparte toma `LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`
 *      y lo mantiene ~35 s (su propia transacción, con timeout explícito).
 *   2. Se lanzan 24 GET /api/loans CON LA SESIÓN REAL ("bloqueadores"): el
 *      pool del servidor las atiende y cada consulta se queda BLOQUEADA en
 *      Postgres contra el lock. Así las 9 conexiones del pool (2×núcleos+1)
 *      quedan ocupadas de verdad. (Sin cookie, la ruta responde 401 al
 *      instante sin tocar la base: no ocuparía ni una conexión.)
 *   3. Recién ahí se lanzan los pedidos medidos: alta de préstamo, pago y
 *      transferencia (rutas con transacción interactiva -> maxWait 15 s) más un
 *      GET /api/accounts y un GET /api/loans (consultas -> espera de pool).
 *   4. Se libera el lock y se verifica que el camino normal vuelve a andar.
 *
 * Con la configuración VIEJA los POST morían a los ~2,5 s con un P2028
 * genérico (el 500 mentiroso); con la de la ronda la espera efectiva la corta
 * el `pool_timeout` del pool (~10 s, P2024 — es el menor entre el maxWait de
 * 15 s y ese timeout) y la respuesta es el 503 con su copy. La duración se
 * mide a propósito: es la evidencia de que la espera es la del pool y de que
 * NO hubo auto-retry (un retry habría esperado sentado hasta la liberación y
 * respondido 201 a los ~35 s).
 *
 * Después, el contrapeso: 25 altas concurrentes SIN tormenta (el pico real del
 * uso normal) no pueden dar ni un 503 falso: todas 201, todas con su
 * cronograma, 25 cuentas y ni una más.
 */

import {
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  cuentaDe,
  fetchConSesion,
  get,
  post,
  prestamoDe,
  PrismaClient,
  runScript,
  section,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4R2_02";
const FIRST = "2028-06-20";
const RETRY_COPY = "volvé a intentar";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ───────────────────────────────────────────────────────────────────────
     * Preparación: un banco y dos préstamos fuera de la tormenta
     * ─────────────────────────────────────────────────────────────────────── */
    section("Preparación");
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "5000000");
    check("el banco responde 201", banco.status, 201);

    const loanParaPagar = await crearPrestamo({
      name: `${TAG}_Pagar`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "24",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("el préstamo a pagar responde 201", loanParaPagar.status, 201);

    // El préstamo que se va a pagar TIENE que estar desembolsado: el desembolso
    // es la transferencia que SALE del préstamo hacia el banco (criterio 6).
    // Sin él, el pago dejaría la deuda en "a favor" y el número final no diría
    // nada del contrato.
    const desembolso = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-06-01",
      accountId: loanParaPagar.body?.id,
      toAccountId: banco.body?.id,
      description: `${TAG}_Desembolso`,
    });
    check("el desembolso del préstamo a pagar responde 201", desembolso.status, 201);

    /* ───────────────────────────────────────────────────────────────────────
     * Tormenta: se bloquea el pool con el lock de la tabla Account
     * ─────────────────────────────────────────────────────────────────────── */
    section("Tormenta: 24 bloqueadores + 3 rutas transaccionales + 2 GET");
    const storm = new PrismaClient({
      transactionOptions: { maxWait: 60_000, timeout: 120_000 },
    });

    const HOLD_MS = 35_000;
    let lockAcquiredAt = 0;
    const hold = storm
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`);
          lockAcquiredAt = Date.now();
          await sleep(HOLD_MS);
        },
        { maxWait: 60_000, timeout: HOLD_MS + 30_000 },
      )
      .catch((error) => ({ lockError: String(error?.message ?? error) }));

    // El lock tiene que estar tomado ANTES de lanzar los bloqueadores.
    while (lockAcquiredAt === 0) await sleep(25);

    // Bloqueadores: 24 GET AUTENTICADOS → cada consulta ocupa su conexión del
    // pool y se queda esperando el lock de la tabla. (Sin cookie serían 401
    // instantáneos que no ocupan nada: un "bloqueador" de mentira.)
    const tBloqueadores = Date.now();
    const blockers = Array.from({ length: 24 }, () =>
      fetchConSesion("/api/loans")
        .then((res) => ({ res, ms: Date.now() - tBloqueadores }))
        .catch(() => null),
    );

    await sleep(600);

    const timed = async (promise) => {
      const start = Date.now();
      const res = await promise;
      return { res, ms: Date.now() - start };
    };

    const [
      altaTormenta,
      pagoTormenta,
      transferenciaTormenta,
      getAccountsTormenta,
      getLoansTormenta,
    ] = await Promise.all([
      timed(
        post("/api/accounts", {
          name: `${TAG}_Tormenta`,
          kind: "LOAN",
          principal: "100000",
          tnaPercent: "24",
          installmentCount: 6,
          firstInstallmentDate: FIRST,
        }),
      ),
      timed(
        post("/api/loans/pay", {
          accountId: loanParaPagar.body?.id,
          cashAccountId: banco.body?.id,
          date: "2028-07-01",
          installmentNumber: 1,
        }),
      ),
      timed(
        post("/api/transactions", {
          kind: "TRANSFER",
          amount: "10000",
          date: "2028-07-01",
          accountId: banco.body?.id,
          toAccountId: loanParaPagar.body?.id,
          description: "Transferencia bajo tormenta",
        }),
      ),
      timed(get("/api/accounts")),
      timed(get("/api/loans")),
    ]);

    // ── Los tres POST (transacciones interactivas): 503 con copy, y el reloj
    //    por pedido es la evidencia de la espera. La cola del pool corta a los
    //    ~10 s (pool_timeout → P2024, ver el log del server); con el default
    //    viejo del maxWait (2 s) habrían muerto a los ~2,5 s, y un auto-retry
    //    habría esperado la liberación del lock (~35 s) y respondido 201. El
    //    rango [9 s, 25 s) prueba las dos cosas de una.
    for (const [nombre, { res, ms }] of [
      ["alta", altaTormenta],
      ["pago", pagoTormenta],
      ["transferencia", transferenciaTormenta],
    ]) {
      check(`${nombre} bajo tormenta: 503 (no 500)`, res.status, 503);
      checkIncluye(
        `${nombre} bajo tormenta: la copy invita a reintentar`,
        res.body?.error,
        RETRY_COPY,
      );
      checkTrue(
        `${nombre} bajo tormenta esperó el pool (ni 2 s ni un retry a los 35 s)`,
        ms >= 9000 && ms < 25000,
        `tardó ${ms} ms`,
      );
    }

    // ── Los GET (consulta simple): la misma clase de error, la misma
    //    traducción. La consulta queda en la cola del pool, P2024 la corta a
    //    los ~10 s y la ruta responde 503 con copy. Nunca un 500 genérico:
    //    ESE fue exactamente el bug que este bloque reproduce (antes del fix,
    //    con la tormenta real: 500 pelado).
    for (const [nombre, { res, ms }] of [
      ["GET /api/accounts", getAccountsTormenta],
      ["GET /api/loans", getLoansTormenta],
    ]) {
      check(`${nombre} bajo tormenta: 503 con copy (nunca 500)`, res.status, 503);
      checkIncluye(
        `${nombre} bajo tormenta: la copy invita a reintentar`,
        res.body?.error,
        RETRY_COPY,
      );
      checkTrue(
        `${nombre} esperó el pool (ni 2 s ni un retry a los 35 s)`,
        ms >= 9000 && ms < 25000,
        `tardó ${ms} ms`,
      );
    }

    // ── Se libera el lock: los bloqueadores tienen que salir SIN 5xx.
    //    Los que consiguieron conexión esperaron el lock en Postgres y salen
    //    200 (~35 s). Los que quedaron en la cola del pool mueren con P2024 a
    //    los ~10 s (pool_timeout): después del fix eso es un 503 CON la copy de
    //    reintento, nunca el 500 genérico.
    await hold;
    const bloqueadores = (await Promise.all(blockers)).filter((r) => r !== null);
    const resumenBloqueadores = [];
    for (const { res, ms } of bloqueadores) {
      const error =
        res.status === 200
          ? null
          : ((await res.json().catch(() => null))?.error ?? null);
      resumenBloqueadores.push({ status: res.status, ms, error });
    }
    console.log(
      `  ·  bloqueadores: ${resumenBloqueadores
        .map(({ status, ms }) => `${status}@${Math.round(ms / 1000)}s`)
        .join(" ")}`,
    );
    checkTrue(
      "los 24 bloqueadores responden sin 5xx (los que esperan el lock salen 200; los que el pool deja afuera, 503)",
      bloqueadores.length === 24 &&
        resumenBloqueadores.every(({ status }) => status === 200 || status === 503),
      JSON.stringify(resumenBloqueadores.map(({ status }) => status)),
    );
    checkTrue(
      "los bloqueadores que llegaron al lock esperaron ≥ 30 s (la conexión estaba ocupada de verdad)",
      resumenBloqueadores
        .filter(({ status }) => status === 200)
        .every(({ ms }) => ms >= 30000),
      JSON.stringify(
        resumenBloqueadores.filter(({ status }) => status === 200).map(({ ms }) => ms),
      ),
    );
    checkTrue(
      "los bloqueadores que el pool dejó afuera traen la copy y esperaron el pool_timeout",
      resumenBloqueadores
        .filter(({ status }) => status === 503)
        .every(
          ({ ms, error }) =>
            ms >= 9000 && ms < 25000 && String(error ?? "").includes(RETRY_COPY),
        ),
      JSON.stringify(
        resumenBloqueadores
          .filter(({ status }) => status === 503)
          .map(({ ms, error }) => `${ms}:${String(error ?? "").slice(0, 40)}`),
      ),
    );
    await storm.$disconnect();

    /* ───────────────────────────────────────────────────────────────────────
     * Sin auto-retry: el alta de la tormenta NO quedó escrita
     * ─────────────────────────────────────────────────────────────────────── */
    section("Sin auto-retry");
    const fantasmas = await prisma.account.count({
      where: { name: `${TAG}_Tormenta` },
    });
    check("la tormenta NO dejó ninguna cuenta fantasma (sin auto-retry)", fantasmas, 0);

    const reintento = await post("/api/accounts", {
      name: `${TAG}_Tormenta`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "24",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("el reintento manual del alta responde 201", reintento.status, 201);
    const cuentasReintento = await prisma.account.count({
      where: { name: `${TAG}_Tormenta` },
    });
    check("quedó UNA sola cuenta (el reintento no duplicó)", cuentasReintento, 1);
    const cuotasReintento = await prisma.installment.count({
      where: { accountId: reintento.body?.id },
    });
    check("el alta salió completa: 6 cuotas materializadas", cuotasReintento, 6);

    // Y el pago que falló también se puede reintentar limpio: la cuota 1.
    // Los números a mano: principal 100.000 al 24% TNA (2% mensual) en 6 cuotas
    // FRENCH → cuota 17.852,58 = interés 2.000,00 + capital 15.852,58. El pago
    // reintentado tiene que dejar EXACTAMENTE esas patas y la deuda viva
    // (desembolsada) 100.000 − 15.852,58 = 84.147,42.
    const pagoReintento = await post("/api/loans/pay", {
      accountId: loanParaPagar.body?.id,
      cashAccountId: banco.body?.id,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("el pago reintentado responde 201 (created true)", pagoReintento.status, 201);
    check("el pago reintentado creó", pagoReintento.body?.created, true);
    check("el pago reintentado cubrió la cuota 1", pagoReintento.body?.installment?.number, 1);
    check("la pata de capital del pago es 15.852,58", pagoReintento.body?.principalPaid, "15852.58");
    check("la pata de interés del pago es 2.000,00", pagoReintento.body?.interestPaid, "2000.00");

    // El intento que murió en la tormenta NO escribió nada: si hubiera escrito,
    // habría DOS patas de capital para la misma cuota.
    const patasCapital = await prisma.movement.count({
      where: {
        toAccountId: loanParaPagar.body?.id,
        kind: "TRANSFER",
        description: { startsWith: "Cuota 1 · capital" },
      },
    });
    check("quedó UNA sola pata de capital de la cuota 1 (sin fantasma)", patasCapital, 1);

    const vistaPago = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), loanParaPagar.body?.id);
    check("la deuda viva tras pagar la cuota 1 es 84.147,42 (100.000 − capital)", vistaPago?.debt, "84147.42");

    // La vereda del banco: apertura 5.000.000 + desembolso 100.000 − capital
    // 15.852,58 − interés 2.000,00 = 5.082.147,42. Si la transferencia de la
    // tormenta hubiera quedado a medias, acá no daría.
    const bancoFinal = await cuentaDe(banco.body?.id, "?asOf=2028-07-31");
    check("el banco queda en 5.082.147,42 (desembolso − cuota completa)", bancoFinal?.balance, "5082147.42");

    /* ───────────────────────────────────────────────────────────────────────
     * El pico normal: 25 altas en paralelo, todas 201
     * ─────────────────────────────────────────────────────────────────────── */
    section("Pico normal: 25 altas concurrentes");
    const altas = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        post("/api/accounts", {
          name: `${TAG}_Pico_${String(index + 1).padStart(2, "0")}`,
          kind: "LOAN",
          principal: "100000",
          tnaPercent: "24",
          installmentCount: 6,
          firstInstallmentDate: FIRST,
        }),
      ),
    );
    const codigos = altas.map((r) => r.status);
    checkTrue(
      "las 25 altas concurrentes responden 201 (ni un 503 falso)",
      codigos.every((status) => status === 201),
      `estados: ${codigos.join(",")}`,
    );
    const cuentaPico = await prisma.account.count({
      where: { name: { startsWith: `${TAG}_Pico_` } },
    });
    check("quedaron exactamente 25 cuentas del pico", cuentaPico, 25);
    const idsPico = altas.map((r) => r.body?.id);
    const cuotasPico = await prisma.installment.groupBy({
      by: ["accountId"],
      where: { accountId: { in: idsPico.filter(Boolean) } },
      _count: { _all: true },
    });
    checkTrue(
      "las 25 traen sus 6 cuotas materializadas",
      cuotasPico.length === 25 && cuotasPico.every((row) => row._count._all === 6),
      JSON.stringify(cuotasPico.map((row) => row._count._all)),
    );
  },
});
