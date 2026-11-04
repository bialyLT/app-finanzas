#!/usr/bin/env node
/**
 * Batería 09 · Fase 4.3 · Concurrencia del camino de escritura de monedas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA (dos peticiones REALES en paralelo contra la app)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Dos altas simultáneas del mismo (nombre, moneda): UNA gana, la otra 409,
 *      sin deadlock ni 500.
 *   2. Dos transferencias entre monedas simultáneas desde la misma cuenta: las
 *      dos entran y los saldos quedan exactos (ni una fila perdida ni duplicada).
 *   3. Dos lotes simultáneos con un ítem cross: los dos entran completos.
 *   4. Carrera PATCH-moneda vs transferencia entrante: sólo hay dos finales
 *      posibles y NINGUNO deja una cuenta en USD con un movimiento cargado
 *      cuando era ARS. Nada de 500.
 *   5. Doble submit de la misma transferencia: la base NO deduplica (decisión
 *      conocida del proyecto); se mide y se informa, no se cuenta como falla.
 *   6. Transferencias en las dos direcciones a la vez: sin deadlock y con la
 *      aritmética exacta.
 *   7. Dos importaciones CSV simultáneas del mismo archivo: el lock serializa y
 *      entra una sola vez.
 *
 * El arnés usa DOS conexiones reales sólo en los chequeos directos; los bordes
 * HTTP van por el pool del server, que es el que se despliega.
 */

import {
  api,
  check,
  checkIncluye,
  checkMoney,
  checkTrue,
  db,
  get,
  makeAccount,
  newClient,
  newTag,
  post,
  runBattery,
  section,
  sqlBalance,
} from "./helpers.mjs";

const TAG = newTag("f43c");
const AS_OF = "2032-05-31";
const DIA = (value) => new Date(`${value}T00:00:00.000Z`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await runBattery({
  tag: TAG,
  main: async () => {
    async function createAccount(name, currency, openingBalance = "0", kind = "CASH") {
      const res = await post("/api/accounts", { name, kind, currency, openingBalance });
      if (res.status !== 201) throw new Error(`No se pudo crear «${name}»: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.id;
    }

    function estados(resultados) {
      return resultados
        .map((result) => (result.status === "fulfilled" ? result.value.status : "EXCEPCIÓN"))
        .sort();
    }

    function sinDeadlock(resultados) {
      return resultados.every((result) => {
        if (result.status === "rejected") return !/deadlock/i.test(String(result.reason?.message ?? ""));
        const text = `${result.value?.body?.error ?? ""}`;
        return !/deadlock|40P01/i.test(text);
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 1 · DOS ALTAS SIMULTÁNEAS DEL MISMO (NOMBRE, MONEDA)
     * ══════════════════════════════════════════════════════════════════════ */
    section("1 · Dos altas simultáneas del mismo (nombre, moneda)");

    for (let ronda = 0; ronda < 5; ronda += 1) {
      const nombre = `${TAG} Carrera ${ronda}`;
      const cuerpo = { name: nombre, kind: "CASH", currency: "ARS" };
      const resultados = await Promise.allSettled([
        post("/api/accounts", cuerpo),
        post("/api/accounts", cuerpo),
      ]);

      const statuses = estados(resultados);
      check(`ronda ${ronda}: exactamente un 201 y un 409`, statuses.join(","), "201,409");
      checkTrue(`ronda ${ronda}: sin deadlock ni excepción`, sinDeadlock(resultados));
      check(
        `ronda ${ronda}: queda UNA sola fila`,
        await db.account.count({ where: { name: nombre } }),
        1,
      );

      const perdedor = resultados
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value)
        .find((value) => value.status === 409);
      checkIncluye(
        `ronda ${ronda}: el 409 nombra la moneda`,
        perdedor?.body?.error,
        "en pesos",
      );
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 2 · DOS TRANSFERENCIAS CROSS SIMULTÁNEAS
     * ══════════════════════════════════════════════════════════════════════ */
    section("2 · Dos transferencias ARS→USD simultáneas desde la misma cuenta");

    const origen = await createAccount(`${TAG} origen`, "ARS", "1000000");
    const destino = await createAccount(`${TAG} destino`, "USD", "0");

    const dos = await Promise.allSettled([
      post("/api/transactions", {
        kind: "TRANSFER", amount: "1000", toAmount: "10", date: "2032-05-10",
        accountId: origen, toAccountId: destino, description: `${TAG} dos a`,
      }),
      post("/api/transactions", {
        kind: "TRANSFER", amount: "1000", toAmount: "10", date: "2032-05-10",
        accountId: origen, toAccountId: destino, description: `${TAG} dos b`,
      }),
    ]);

    check("las dos transferencias entran (201,201)", estados(dos).join(","), "201,201");
    checkTrue("sin deadlock", sinDeadlock(dos));
    check(
      "hay exactamente DOS movimientos",
      await db.movement.count({ where: { description: { startsWith: `${TAG} dos` } } }),
      2,
    );
    checkMoney("el origen baja 2.000 en total", await sqlBalance(origen, AS_OF), "998000.00");
    checkMoney("el destino sube 20 en total", await sqlBalance(destino, AS_OF), "20.00");

    /* ══════════════════════════════════════════════════════════════════════
     * 3 · DOS LOTES SIMULTÁNEOS
     * ══════════════════════════════════════════════════════════════════════ */
    section("3 · Dos lotes simultáneos con un ítem cross");

    const lotesPar = await Promise.allSettled([
      post("/api/transactions/batch", {
        movements: [{ kind: "TRANSFER", amount: 500, toAmount: 5, date: "2032-05-11", fromAccountId: origen, toAccountId: destino, description: `${TAG} lote par a` }],
      }),
      post("/api/transactions/batch", {
        movements: [{ kind: "TRANSFER", amount: 500, toAmount: 5, date: "2032-05-11", fromAccountId: origen, toAccountId: destino, description: `${TAG} lote par b` }],
      }),
    ]);
    check("los dos lotes entran (201,201)", estados(lotesPar).join(","), "201,201");
    checkTrue("sin deadlock", sinDeadlock(lotesPar));
    check(
      "cada lote escribió su fila (2)",
      await db.movement.count({ where: { description: { startsWith: `${TAG} lote par` } } }),
      2,
    );
    checkMoney("saldo ARS: -1.000 adicionales", await sqlBalance(origen, AS_OF), "997000.00");
    checkMoney("saldo USD: +10 adicionales", await sqlBalance(destino, AS_OF), "30.00");

    /* ══════════════════════════════════════════════════════════════════════
     * 4 · CARRERA: PATCH DE MONEDA vs TRANSFERENCIA ENTRANTE
     * ══════════════════════════════════════════════════════════════════════ */
    section("4 · Carrera: PATCH moneda vs transferencia (5 rondas)");

    for (let ronda = 0; ronda < 5; ronda += 1) {
      const victima = await createAccount(`${TAG} Racer ${ronda}`, "ARS", "100000");
      const usdDestino = await createAccount(`${TAG} Racer USD ${ronda}`, "USD", "0");

      const resultados = await Promise.allSettled([
        api("/api/accounts", {
          method: "PATCH",
          body: JSON.stringify({ id: victima, currency: "USD" }),
        }),
        post("/api/transactions", {
          kind: "TRANSFER", amount: "1000", toAmount: "10", date: "2032-05-12",
          accountId: victima, toAccountId: usdDestino, description: `${TAG} racer ${ronda}`,
        }),
      ]);

      const [patch, transfer] = resultados.map((result) =>
        result.status === "fulfilled" ? result.value : { status: "EXCEPCIÓN" },
      );
      const par = [patch.status, transfer.status].sort().join(",");
      checkTrue(
        `ronda ${ronda}: finales permitidos (200+400 o 409+201), obtenidos ${par}`,
        par === "200,400" || par === "201,409",
        `${par} (patch=${JSON.stringify(patch.body)}, transfer=${JSON.stringify(transfer.body)})`,
      );
      checkTrue(
        `ronda ${ronda}: nunca un 5xx`,
        patch.status < 500 && transfer.status < 500,
        `${patch.status}/${transfer.status}`,
      );

      const fila = await db.account.findUnique({
        where: { id: victima },
        select: { currency: true },
      });
      const movimientos = await db.movement.count({
        where: { description: `${TAG} racer ${ronda}` },
      });
      const [{ n: violaciones }] = await db.$queryRawUnsafe(
        `SELECT count(*)::int AS n
           FROM "Movement" m
           JOIN "Account" s ON s.id = m."accountId"
           JOIN "Account" d ON d.id = m."toAccountId"
          WHERE m.description = $1
            AND ((s.currency <> d.currency AND m."toAmount" IS NULL)
              OR (s.currency = d.currency AND m."toAmount" IS NOT NULL))`,
        `${TAG} racer ${ronda}`,
      );
      check(
        `ronda ${ronda}: la bicondicional se cumple en el estado final`,
        violaciones,
        0,
      );

      if (transfer.status === 201) {
        check(
          `ronda ${ronda}: si la transferencia entró, la cuenta sigue en ARS`,
          fila?.currency,
          "ARS",
        );
        check(`ronda ${ronda}: y hay 1 movimiento`, movimientos, 1);
      } else {
        check(
          `ronda ${ronda}: si el PATCH ganó, la cuenta quedó en USD`,
          fila?.currency,
          "USD",
        );
        check(`ronda ${ronda}: y no hay movimiento`, movimientos, 0);
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 4b · LA MISMA CARRERA, DETERMINISTA, CONTRA LA BASE SOLA
     * ══════════════════════════════════════════════════════════════════════
     * La versión HTTP es intermitente (depende del scheduling). Esta usa dos
     * conexiones y una compuerta para que el UPDATE de moneda ya haya corrido
     * su trigger (sin ver historia) y todavía no haya commiteado. El INSERT es
     * un TRANSFER que era válido con la moneda VIEJA (ARS). Si la base no
     * serializa, el estado FINAL viola su propia bicondicional:
     *
     *   · ARS→USD con toAmount, y la cuenta termina en USD → USD→USD con
     *     toAmount (prohibido).
     *   · ARS→ARS sin toAmount, y la cuenta termina en USD → USD→ARS sin
     *     toAmount (obligatorio).
     *
     * La consulta final no depende de quién ganó: mira la fila y las monedas
     * actuales, exactamente lo que el trigger debería custodiar.
     */
    section("4b · La misma carrera, determinista, contra la base sola");

    async function carreraBicondicional(etiqueta, destinoEsUsd, conToAmount) {
      const src = await makeAccount(TAG, `RaceDB ${etiqueta}`, {
        currency: "ARS",
        openingBalance: "100000",
      });
      const dst = await makeAccount(TAG, `RaceDB ${etiqueta} dst`, {
        currency: destinoEsUsd ? "USD" : "ARS",
      });
      const c1 = newClient();
      const c2 = newClient();

      let liberar;
      const compuerta = new Promise((resolve) => {
        liberar = resolve;
      });
      let avisar;
      const monedaActualizada = new Promise((resolve) => {
        avisar = resolve;
      });

      const p1 = c1
        .$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
            await tx.account.update({ where: { id: src.id }, data: { currency: "USD" } });
            avisar();
            await compuerta;
          },
          { timeout: 30_000, maxWait: 10_000 },
        )
        .catch((error) => ({ error }));

      await monedaActualizada;

      const descripcion = `${TAG} carrera ${etiqueta}`;
      const p2 = c2
        .$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
            return tx.movement.create({
              data: {
                kind: "TRANSFER",
                amount: "1000",
                date: DIA("2032-06-03"),
                accountId: src.id,
                toAccountId: dst.id,
                description: descripcion,
                ...(conToAmount ? { toAmount: "10" } : {}),
              },
            });
          },
          { timeout: 30_000, maxWait: 10_000 },
        )
        .catch((error) => ({ error }));

      await sleep(600);
      liberar();
      const update = await p1;
      const insert = await p2;

      const filas = await db.$queryRawUnsafe(
        `
        SELECT m."toAmount"::text AS "toAmount",
               s.currency::text AS src,
               d.currency::text AS dst
          FROM "Movement" m
          JOIN "Account" s ON s.id = m."accountId"
          JOIN "Account" d ON d.id = m."toAccountId"
         WHERE m.description = $1
        `,
        descripcion,
      );
      const violaciones = filas.filter(
        (row) =>
          (row.src !== row.dst && row.toAmount === null) ||
          (row.src === row.dst && row.toAmount !== null),
      );

      console.log(
        `        ${etiqueta}: update=${update?.error ? "rechazado" : "ok"} · ` +
          `insert=${insert?.error ? "rechazado" : "ok"} · final=${JSON.stringify(filas)}`,
      );
      const saldoOrigen = await sqlBalance(src.id, "2032-06-30");
      const saldoDestino = await sqlBalance(dst.id, "2032-06-30");
      console.log(
        `        saldos SQL (definición del dominio): origen=${saldoOrigen} · destino=${saldoDestino}` +
          ` (apertura origen 100.000, destino 0)`,
      );
      check(
        `${etiqueta}: la bicondicional se cumple en el estado FINAL`,
        violaciones.length,
        0,
      );
      checkTrue(
        `${etiqueta}: la base serializa (rechaza una de las dos)`,
        Boolean(update?.error) || Boolean(insert?.error),
        `update=${update?.error ? "rechazado" : "ok"} insert=${insert?.error ? "rechazado" : "ok"}`,
      );

      await c1.$disconnect();
      await c2.$disconnect();
    }

    await carreraBicondicional("cross-con-toAmount", true, true);
    await carreraBicondicional("misma-sin-toAmount", false, false);

    /* ══════════════════════════════════════════════════════════════════════
     * 5 · DOBLE SUBMIT (comportamiento conocido, no un bug de la fase)
     * ══════════════════════════════════════════════════════════════════════ */
    section("5 · Doble submit de la misma transferencia");

    const gemela = {
      kind: "TRANSFER", amount: "2000", toAmount: "2", date: "2032-05-13",
      accountId: origen, toAccountId: destino, description: `${TAG} doble submit`,
    };
    const doble = await Promise.allSettled([
      post("/api/transactions", gemela),
      post("/api/transactions", gemela),
    ]);
    check("las dos inserciones se aceptan (sin idempotencia por diseño)", estados(doble).join(","), "201,201");
    check(
      "quedan DOS filas idénticas",
      await db.movement.count({ where: { description: `${TAG} doble submit` } }),
      2,
    );
    console.log(
      "        (No es una falla de F4.3: el proyecto decidió que el dedupe es advisory; ver Fase 7.)",
    );

    /* ══════════════════════════════════════════════════════════════════════
     * 6 · LAS DOS DIRECCIONES A LA VEZ
     * ══════════════════════════════════════════════════════════════════════ */
    section("6 · Transferencias en las dos direcciones a la vez");

    const idaArs = await createAccount(`${TAG} ida ARS`, "ARS", "0");
    const idaUsd = await createAccount(`${TAG} ida USD`, "USD", "0");

    const mixtas = await Promise.allSettled([
      ...Array.from({ length: 5 }, (_, index) =>
        post("/api/transactions", {
          kind: "TRANSFER", amount: "100", toAmount: "0.1", date: "2032-05-14",
          accountId: idaArs, toAccountId: idaUsd, description: `${TAG} ida ${index}`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        post("/api/transactions", {
          kind: "TRANSFER", amount: "0.5", toAmount: "500", date: "2032-05-14",
          accountId: idaUsd, toAccountId: idaArs, description: `${TAG} vuelta ${index}`,
        }),
      ),
    ]);
    check(
      "las 10 entran",
      mixtas.filter((result) => result.status === "fulfilled" && result.value.status === 201).length,
      10,
    );
    checkTrue("ningún deadlock", sinDeadlock(mixtas));
    // 5 × (-100 + 500) = +2.000 ARS; 5 × (+0,1 - 0,5) = -2,00 USD.
    checkMoney("saldo ARS exacto tras el ida y vuelta", await sqlBalance(idaArs, AS_OF), "2000.00");
    checkMoney("saldo USD exacto tras el ida y vuelta", await sqlBalance(idaUsd, AS_OF), "-2.00");

    /* ══════════════════════════════════════════════════════════════════════
     * 7 · DOS IMPORTACIONES CSV SIMULTÁNEAS DEL MISMO ARCHIVO
     * ══════════════════════════════════════════════════════════════════════ */
    section("7 · Dos importaciones CSV simultáneas del mismo archivo");

    const csvArs = await createAccount(`${TAG} CSV ARS`, "ARS", "0");
    const texto = [
      "fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion",
      `2032-05-15,gasto,123,${TAG} CSV ARS,,,${TAG} csv concurrente`,
    ].join("\n");
    const preview = await post("/api/import/csv/preview", { text: texto });
    check("preview del archivo → 200", preview.status, 200);

    const importaciones = await Promise.allSettled([
      post("/api/import/csv", { text: texto, expected: preview.body?.totals }),
      post("/api/import/csv", { text: texto, expected: preview.body?.totals }),
    ]);
    const exitos = importaciones.filter(
      (result) => result.status === "fulfilled" && result.value.status === 201,
    ).length;
    check("exactamente UNA importación entra", exitos, 1);
    check(
      "la otra se rechaza como duplicada (4xx), no como 500",
      importaciones.filter(
        (result) => result.status === "fulfilled" && result.value.status >= 400 && result.value.status < 500,
      ).length,
      1,
    );
    check(
      "el archivo dejó UNA sola fila",
      await db.movement.count({ where: { accountId: csvArs, description: `${TAG} csv concurrente` } }),
      1,
    );

    /* ══════════════════════════════════════════════════════════════════════
     * 8 · LECTURA FINAL: los saldos de la API coinciden con SQL
     * ══════════════════════════════════════════════════════════════════════ */
    section("8 · Cierre: API vs SQL al centavo");

    const cuentas = await get(`/api/accounts?currency=ARS&asOf=${AS_OF}`);
    check("lectura final ARS → 200", cuentas.status, 200);
    const origenDto = cuentas.body?.accounts?.find((account) => account.id === origen);
    checkMoney(
      "la API y el SQL coinciden en el saldo ARS",
      origenDto?.balance ?? "x",
      await sqlBalance(origen, AS_OF),
    );
  },
});
