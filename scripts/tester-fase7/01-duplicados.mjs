#!/usr/bin/env node
/**
 * 01 · DUPLICADOS — la red contra el doble toque (brief, ataque D).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * `GET /api/transactions/duplicates` es una PREGUNTA con efecto sobre una
 * escritura: el formulario la consulta antes de guardar y, si hay candidatos,
 * muestra "Guardar igual" / "Volver". Esta suite ataca el contrato completo:
 *
 *   1. El gemelo exacto (misma cuenta, monto, día y tipo) aparece — y es ESE,
 *      por id.
 *   2. Los casi-gemelos NO: otra cuenta, otro día, otro tipo, otro monto.
 *   3. El monto es el MISMO parser del POST: "12.345,67" y "12345.67" llegan
 *      al mismo decimal exacto (si divergieran, el chequeo compararía contra
 *      un número que no es el que se va a guardar).
 *   4. El «día» es de calendario: 2028-02-15 encuentra lo del 2028-02-15 y
 *      NADA del 14 ni del 16 (la regla `@db.Date`, sin corrimientos de zona).
 *   5. La base acepta duplicados A PROPÓSITO (dos cafés son dos cafés): el
 *      "Guardar igual" del formulario persiste una segunda fila idéntica y la
 *      consulta las devuelve a las dos.
 *   6. Parámetros hostiles: tipo inválido, cuenta ausente, monto ilegible,
 *      fecha con formato local — todos 400 CON mensaje, nunca 500.
 *   7. Tormenta de pool (la lección F4 r2): con el pool agotado de verdad, la
 *      ruta responde 503 con copy de reintento — nunca un 500 genérico. Y al
 *      liberarse, la ruta vuelve sola.
 *   8. La ruta es LECTURA: exige sesión (401 sin cookie) y no deja fantasmas.
 *
 * Los movimientos viven en 2028-02 (lejos del seed de octubre) y la limpieza
 * corre antes y después: una corrida muerta a mitad no envenena la siguiente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE CORRE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/tester-fase7/01-duplicados.mjs
 *
 * Requiere: server en :3000 con el build final y Postgres arriba.
 */

import os from "node:os";
import {
  BASE_URL,
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  duplicadosDe,
  fetchConSesion,
  PrismaClient,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_DUP";

/**
 * Mes y día del escenario: 2028-02, lejísimos del seed (octubre 2026).
 * Nada de hoy: una sonda de duplicados con fecha de hoy podría chocar con un
 * movimiento real del usuario y volver ambiguo el "1 esperado".
 */
const MES_DESDE = "2028-02-01";
const MES_HASTA = "2028-02-29";
const DIA = "2028-02-15";
const MONTO_ARG = "12.345,67";
const MONTO_US = "12345.67";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ─────────────────────────────────────────────────────────────────────────
     * Preparación: dos cuentas de dinero (una para el escenario, otra para el
     * caso "otra cuenta") y un gasto de referencia.
     * ───────────────────────────────────────────────────────────────────────── */
    section("Preparación");
    const bancoA = await crearCuenta(`${TAG}_A`, "BANK", "1000000");
    check("la cuenta A responde 201", bancoA.status, 201);
    const bancoB = await crearCuenta(`${TAG}_B`, "BANK", "1000000");
    check("la cuenta B responde 201", bancoB.status, 201);

    const referencia = await crearMovimiento({
      kind: "EXPENSE",
      amount: MONTO_ARG,
      date: DIA,
      accountId: bancoA.body?.id,
      description: `${TAG}_Referencia`,
    });
    check("el gasto de referencia responde 201", referencia.status, 201);
    check("el monto argentino se interpretó exacto", referencia.body?.amount, "12345.67");

    /* ─────────────────────────────────────────────────────────────────────────
     * 1. El gemelo exacto (y nada más que él)
     * ───────────────────────────────────────────────────────────────────────── */
    section("El gemelo exacto");
    const gemelos = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("la consulta responde 200", gemelos.status, 200);
    check("aparece exactamente 1 candidato", gemelos.body?.duplicates?.length, 1);
    check(
      "y es el movimiento de referencia, por id",
      gemelos.body?.duplicates?.[0]?.id,
      referencia.body?.id,
    );

    // El MISMO monto con la otra notación: "12.345,67" == "12345.67" para el
    // parser compartido del POST. Si la ruta tuviera un parser propio, acá
    // aparecerían cero candidatos y el doble toque pasaría sin aviso.
    const gemelosUs = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_US,
      date: DIA,
    });
    check(
      "el mismo monto en notación con punto también lo encuentra",
      gemelosUs.body?.duplicates?.[0]?.id,
      referencia.body?.id,
    );

    /* ─────────────────────────────────────────────────────────────────────────
     * 2. Los casi-gemelos: la consulta no puede ser un detector de humo
     * ───────────────────────────────────────────────────────────────────────── */
    section("Los casi-gemelos");
    const otraCuenta = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoB.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("misma fecha y monto pero OTRA cuenta: 0", otraCuenta.body?.duplicates?.length, 0);

    const otroDia = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: "2028-02-16",
    });
    check("misma cuenta y monto pero OTRO día: 0", otroDia.body?.duplicates?.length, 0);

    const diaAnterior = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: "2028-02-14",
    });
    check("el día ANTERIOR tampoco (dos lados del calendario): 0", diaAnterior.body?.duplicates?.length, 0);

    const otroTipo = await duplicadosDe({
      kind: "INCOME",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("mismo todo pero OTRO tipo: 0", otroTipo.body?.duplicates?.length, 0);

    const otroMonto = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: "12.345,68",
      date: DIA,
    });
    check("un centavo de diferencia ya no es duplicado: 0", otroMonto.body?.duplicates?.length, 0);

    // Un movimiento del MISMO día pero cargado a las apuradas con otro monto
    // no debe ensuciar: se crea un segundo gasto en el mismo día con otro monto
    // y el gemelo exacto sigue siendo uno solo.
    const vecino = await crearMovimiento({
      kind: "EXPENSE",
      amount: "1,00",
      date: DIA,
      accountId: bancoA.body?.id,
      description: `${TAG}_Vecino`,
    });
    check("el vecino del mismo día responde 201", vecino.status, 201);
    const gemelosTrasVecino = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check(
      "el vecino (mismo día, otro monto) no engorda la lista",
      gemelosTrasVecino.body?.duplicates?.length,
      1,
    );

    /* ─────────────────────────────────────────────────────────────────────────
     * 3. «Guardar igual» persiste: la base acepta dos idénticos A PROPÓSITO
     * ───────────────────────────────────────────────────────────────────────── */
    section("Guardar igual (el doble toque aceptado a propósito)");
    const igual = await crearMovimiento({
      kind: "EXPENSE",
      amount: MONTO_ARG,
      date: DIA,
      accountId: bancoA.body?.id,
      description: `${TAG}_Igual`,
    });
    check("la segunda fila idéntica responde 201 (no hay índice único)", igual.status, 201);
    checkTrue("y es OTRA fila", igual.body?.id !== referencia.body?.id);

    const trasIgual = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("ahora la consulta devuelve las DOS", trasIgual.body?.duplicates?.length, 2);
    checkTrue(
      "con los ids de referencia e igual",
      [referencia.body?.id, igual.body?.id].every((id) =>
        (trasIgual.body?.duplicates ?? []).some((d) => d.id === id),
      ),
    );

    // Doble pestaña / doble submit en paralelo: dos POST idénticos simultáneos
    // no pueden perder una fila ni tumbar la ruta (la decisión de fusionarlas
    // es de la persona, no del servidor).
    const enParalelo = await Promise.all([
      crearMovimiento({
        kind: "EXPENSE",
        amount: "77,77",
        date: DIA,
        accountId: bancoA.body?.id,
        description: `${TAG}_Paralelo1`,
      }),
      crearMovimiento({
        kind: "EXPENSE",
        amount: "77,77",
        date: DIA,
        accountId: bancoA.body?.id,
        description: `${TAG}_Paralelo2`,
      }),
    ]);
    check("los dos POST simultáneos responden 201", enParalelo.map((r) => r.status).join(","), "201,201");
    const paralelos = await prisma.movement.count({
      where: { description: { startsWith: `${TAG}_Paralelo` } },
    });
    check("y quedaron las dos filas (ninguna se perdió)", paralelos, 2);

    /* ─────────────────────────────────────────────────────────────────────────
     * 4. Parámetros hostiles: 400 con mensaje, jamás 500
     * ───────────────────────────────────────────────────────────────────────── */
    section("Parámetros hostiles");
    const sinTipo = await duplicadosDe({
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("sin `kind`: 400", sinTipo.status, 400);

    const tipoBasura = await duplicadosDe({
      kind: "GARBAGE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("`kind` inválido: 400", tipoBasura.status, 400);

    const sinCuenta = await duplicadosDe({ kind: "EXPENSE", amount: MONTO_ARG, date: DIA });
    check("sin `accountId`: 400", sinCuenta.status, 400);
    checkIncluye("con el mensaje de la cuenta", sinCuenta.body?.error, "cuenta");

    const montoIlegible = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: "abc",
      date: DIA,
    });
    check("monto ilegible: 400", montoIlegible.status, 400);
    checkIncluye("con el mensaje del monto", montoIlegible.body?.error, "monto");

    const fechaLocal = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: "15/02/2028",
    });
    check("fecha en formato local: 400", fechaLocal.status, 400);

    const fechaImposible = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: "2028-02-31",
    });
    check("29/02/31 no existe (el calendario se valida de verdad): 400", fechaImposible.status, 400);

    const cuentaFantasma = await duplicadosDe({
      kind: "EXPENSE",
      accountId: "00000000-0000-0000-0000-000000000000",
      amount: MONTO_ARG,
      date: DIA,
    });
    check("una cuenta que no existe NO es un error del server: 200", cuentaFantasma.status, 200);
    check("y no encuentra nada: 0", cuentaFantasma.body?.duplicates?.length, 0);

    /* ─────────────────────────────────────────────────────────────────────────
     * 5. La ruta es LECTURA: sin sesión no se consulta
     * ───────────────────────────────────────────────────────────────────────── */
    section("Autenticación");
    // fetch crudo SIN cookie: el proxy/DAL tienen que frenarlo con 401, no con
    // datos. (Con la sesión real, la misma URL responde 200 — ya verificado.)
    const sinSesion = await fetch(
      `${BASE_URL}/api/transactions/duplicates?kind=EXPENSE&accountId=${bancoA.body?.id}&amount=1&date=${DIA}`,
    );
    check("sin cookie de sesión: 401", sinSesion.status, 401);

    /* ─────────────────────────────────────────────────────────────────────────
     * 6. Tormenta de pool — determinista (el mismo método de F4 r2)
     * ─────────────────────────────────────────────────────────────────────────
     *   1. Un cliente aparte toma LOCK TABLE "Movement" ACCESS EXCLUSIVE y lo
     *      mantiene HOLD_MS. La ruta de duplicados LEE Movement: sus consultas
     *      quedan esperando el lock.
     *   2. Se lanzan 24 GET /api/transactions CON SESIÓN ("bloqueadores"):
     *      cada uno ocupa una conexión del pool y se bloquea contra el lock.
     *      El pool (2×núcleos+1) queda agotado de verdad.
     *   3. Recién ahí, las consultas medidas: el duplicado queda en la COLA del
     *      pool, el `pool_timeout` (~10 s) lo corta con P2024 y la ruta lo
     *      traduce a 503 con copy de reintento — nunca un 500 genérico.
     *   4. Se libera el lock y la ruta vuelve sola.
     */
    section("Tormenta de pool");
    const HOLD_MS = 20000;
    const RETRY_COPY = "volvé a intentar";
    const storm = new PrismaClient({
      transactionOptions: { maxWait: 60000, timeout: 120000 },
    });

    let lockAcquiredAt = 0;
    const hold = storm
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('LOCK TABLE "Movement" IN ACCESS EXCLUSIVE MODE');
          lockAcquiredAt = Date.now();
          await sleep(HOLD_MS);
        },
        { maxWait: 60000, timeout: HOLD_MS + 30000 },
      )
      .catch((error) => ({ lockError: String(error?.message ?? error) }));
    while (lockAcquiredAt === 0) await sleep(25);

    const bloqueadores = Math.max(24, os.cpus().length * 2 + 2);
    const t0 = Date.now();
    const blockers = Array.from({ length: bloqueadores }, () =>
      fetchConSesion(`/api/transactions?from=${MES_DESDE}&to=${MES_HASTA}`).then(
        async (res) => ({
          status: res.status,
          ms: Date.now() - t0,
          body: await res.json().catch(() => null),
        }),
        () => null,
      ),
    );

    await sleep(600);

    const timed = async (promise) => {
      const start = Date.now();
      const res = await promise;
      return { res, ms: Date.now() - start };
    };

    const [dupHostil, dupNormal] = await Promise.all([
      timed(
        duplicadosDe({
          kind: "EXPENSE",
          accountId: bancoA.body?.id,
          amount: MONTO_ARG,
          date: DIA,
        }),
      ),
      timed(
        duplicadosDe({
          kind: "INCOME",
          accountId: bancoB.body?.id,
          amount: "1,00",
          date: DIA,
        }),
      ),
    ]);

    // La evidencia doble: estado 503 (no 500) + el reloj prueba que la espera
    // fue la del pool (~10 s), ni un rechazo instantáneo ni un retry sentado
    // hasta la liberación del lock (~20 s).
    for (const [nombre, { res, ms }] of [
      ["consulta medida 1", dupHostil],
      ["consulta medida 2", dupNormal],
    ]) {
      check(`${nombre} bajo tormenta: 503 (no 500)`, res.status, 503);
      checkIncluye(
        `${nombre} bajo tormenta: la copy invita a reintentar`,
        res.body?.error,
        RETRY_COPY,
      );
      checkTrue(
        `${nombre} esperó el pool (ni instantáneo ni retry a los ${HOLD_MS / 1000}s)`,
        ms >= 9000 && ms < HOLD_MS,
        `tardó ${ms} ms`,
      );
    }

    await hold;
    const resueltos = (await Promise.all(blockers)).filter((r) => r !== null);

    /* ── Los bloqueadores: QUÉ SON y qué NO se les exige ─────────────────────
     * Son combustible de la tormenta (GET /api/transactions, la ruta vieja),
     * no el sujeto del test. El sujeto es la ruta NUEVA de duplicados (arriba:
     * 503 con copy, medido). Esta ruta vieja tiene un GAP CONOCIDO y YA
     * DOCUMENTADO en la F4 r2: sus GET no traducen P2024 → 500 genérico bajo
     * tormenta (la traducción se barrió sólo en las rutas reproadas entonces —
     * `documented, not swept`). F7 no la tocó (git diff: el GET quedó intacto).
     * Por eso acá se OBSERVA y se imprime, en vez de fallar: fallar sería
     * re-litigar una decisión de otra ronda; ocultarlo sería mentir.
     */
    const histograma = new Map();
    for (const { status } of resueltos) {
      histograma.set(status, (histograma.get(status) ?? 0) + 1);
    }
    const detalle = [...histograma.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${status}×${count}`)
      .join(" · ");
    const esperaronLock = resueltos.filter(({ status }) => status === 200);
    console.log(`  ·  bloqueadores (${bloqueadores}): ${detalle}`);
    for (const { ms } of esperaronLock) {
      console.log(`  ·  uno esperó el lock y salió 200 a los ${Math.round(ms / 1000)} s`);
    }
    if (resueltos.some(({ status }) => status === 500)) {
      console.log(
        "  ·  AVISO: los 500 de los bloqueadores son el gap conocido de los GET viejos",
      );
      console.log(
        "     bajo tormenta (documentado en F4 r2, no barrido; F7 no tocó esa ruta).",
      );
      console.log(
        "     La ruta de duplicados de esta ronda SÍ traduce: 503 + copy, medido arriba.",
      );
    }

    // La única exigencia a los bloqueadores es de REALISMO: que la tormenta
    // haya sido una tormenta. Si un bloqueador llegó a la base, esperó el lock
    // a la fuerza: su tiempo tiene que rondar la liberación (~HOLD). Y si el
    // lock se hubiera tomado mal, los medidos no habrían esperado el pool —
    // esa evidencia ya está arriba.
    checkTrue(
      "la tormenta fue real: los bloqueadores que llegaron a la base esperaron el lock (≥ HOLD − 3 s)",
      esperaronLock.length === 0 || esperaronLock.every(({ ms }) => ms >= HOLD_MS - 3000),
      JSON.stringify(esperaronLock.map(({ ms }) => ms)),
    );

    checkTrue(
      "ningún bloqueador traicionó la evidencia del pool (si hubo 503, trae copy)",
      resueltos
        .filter(({ status }) => status === 503)
        .every(({ body }) => String(body?.error ?? "").includes(RETRY_COPY)),
      JSON.stringify(
        resueltos.filter((r) => r.status === 503).map((r) => String(r.body?.error ?? "").slice(0, 60)),
      ),
    );
    await storm.$disconnect();

    section("La tormenta no dejó fantasmas y la ruta se recupera");
    const fantasmas = await prisma.movement.count({
      where: { description: { startsWith: `${TAG}_Tormenta` } },
    });
    check("ninguna fila nueva de la tormenta (eran lecturas)", fantasmas, 0);

    const recuperada = await duplicadosDe({
      kind: "EXPENSE",
      accountId: bancoA.body?.id,
      amount: MONTO_ARG,
      date: DIA,
    });
    check("liberado el lock, la ruta vuelve sola: 200", recuperada.status, 200);
    check("y encuentra el gemelo otra vez: 2", recuperada.body?.duplicates?.length, 2);
  },
});
