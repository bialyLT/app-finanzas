#!/usr/bin/env node
/**
 * 21-banderita-cuerpos-hostiles.mjs — los cuerpos hostiles de `openingIncomeMonth`
 * y la máquina de estados del toggle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (los riesgos 4 y 5 que el dev deja en su §9)
 *
 * 1. CUERPOS HOSTILES: `null`, `""`, 42, `true`, `["2026-10"]`, `{"month":…}`,
 *    `"2026-13"`, `"2026-00"`, `"basura"`, `"10/2026"`, `"2026-1"`,
 *    `"2026-02-30"`, un texto con `\u0000`, un número decimal, un array vacío…
 *    → 4xx CON MENSAJE, NUNCA 500, y **la cuenta no cambia**.
 * 2. LAS REGLAS: una tarjeta o un préstamo (su saldo es una DEUDA) no pueden
 *    declarar; una cuenta sin plata (saldo 0) tampoco.
 * 3. LA BASE SIGUE SIENDO LA ÚLTIMA DEFENSA: si alguien escribe la columna por
 *    afuera de la app, el CHECK de la base lo rechaza.
 * 4. EL DOBLE TOQUE: dos PATCHes seguidos (encender→apagar, encender→encender)
 *    no dejan la cuenta en un estado raro ni pierden datos.
 * 5. LA CARRERA: dos PATCHes SIMULTÁNEOS (encender y apagar a la vez) no
 *    pueden dejar la cuenta en un tercer estado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS MENSAJES
 *
 * Un 400 sin mensaje (o con un mensaje en inglés, o con el error crudo de
 * Prisma) es un 400 que la persona no puede usar: no sabe qué corregir. Por
 * eso el battery exige que el mensaje mencione el formato o la regla.
 */

import {
  correrBateria,
  crearEscenario,
  banderita,
  limpiarYVerificar,
  limpiarEscenario,
  check,
  checkTrue,
  checkIncluye,
  section,
  api,
  post,
  patch,
  sql,
  TAG,
  MES,
} from "./lib-fase9r5.mjs";

/** Los cuerpos que NO tienen que ser un mes: o se rechazan o se leen como «apagada». */
const HOSTILES = [
  { valor: 42, etiqueta: "42" },
  { valor: 42.5, etiqueta: "42.5" },
  { valor: true, etiqueta: "true" },
  { valor: false, etiqueta: "false" },
  { valor: ["2026-10"], etiqueta: '["2026-10"]' },
  { valor: [], etiqueta: "[]" },
  { valor: { month: "2026-10" }, etiqueta: '{"month":"2026-10"}' },
  { valor: "2026-13", etiqueta: '"2026-13"' },
  { valor: "2026-00", etiqueta: '"2026-00"' },
  { valor: "2026-1", etiqueta: '"2026-1"' },
  { valor: "2026-02-30", etiqueta: '"2026-02-30"' },
  { valor: "basura", etiqueta: '"basura"' },
  { valor: "10/2026", etiqueta: '"10/2026"' },
  { valor: "2026-10\u0000", etiqueta: '"2026-10\\u0000"' },
  { valor: "2026-10-15x", etiqueta: '"2026-10-15x"' },
  { valor: "2026-10-01T00:00:00Z", etiqueta: '"2026-10-01T00:00:00Z"' },
  { valor: "0000-10", etiqueta: '"0000-10"' },
  { valor: "2026-10-01-01", etiqueta: '"2026-10-01-01"' },
  { valor: "99999-10", etiqueta: '"99999-10"' },
];

await correrBateria({
  etiqueta: "21 · cuerpos hostiles y la máquina de estados del toggle",
  limpiar: async (prisma) => {
    await limpiarYVerificar(prisma);
  },
  main: async (prisma) => {
    let ids = null;

    try {
      /* ── 1 · El POST con cuerpos hostiles ────────────────────────────── */
      section("1 · POST /api/accounts con cuerpos hostiles");
      for (const caso of HOSTILES) {
        const nombre = `${TAG} Hostil`;
        const r = await post("/api/accounts", {
          name: nombre,
          kind: "CASH",
          openingBalance: "7000",
          openingIncomeMonth: caso.valor,
        });
        checkTrue(
          `POST con ${caso.etiqueta} NO es un 5xx`,
          r.status < 500,
          `status=${r.status} body=${JSON.stringify(r.body)}`,
        );
        check(
          `POST con ${caso.etiqueta} es un 4xx`,
          r.status >= 400 && r.status < 500,
          true,
        );
        checkTrue(
          `POST con ${caso.etiqueta} explica el motivo`,
          typeof r.body?.error === "string" && r.body.error.trim().length > 0,
          `body=${JSON.stringify(r.body)}`,
        );
        checkTrue(
          `el mensaje de ${caso.etiqueta} habla del mes o de la fecha`,
          /mes|fecha/i.test(String(r.body?.error ?? "")),
          `body=${JSON.stringify(r.body)}`,
        );
        // La cuenta NO se crea: un cuerpo inválido no puede dejar una cuenta
        // con datos a medio camino.
        const creada = await prisma.account.findMany({
          where: { name: nombre },
          select: { id: true },
        });
        check(`con ${caso.etiqueta} no queda ninguna cuenta creada`, creada.length, 0);
      }

      /* ── 2 · Los tres valores que el dev declara como «apagada» ───────── */
      section("2 · null, ausente y \"\": la bandera apagada (no un error)");
      // El diseño del dev: `undefined`/`null`/`""` = «no lo mandaron» = la
      // bandera apagada (el estado de TODAS las cuentas que ya existían). No es
      // un error: es el default. Lo que hay que verificar es que la cuenta se
      // cree y quede con la banderita apagada.
      //
      // OJO con la limpieza: la cuenta se borra POR ID (el que volvió del
      // POST), nunca por nombre. `cleanName` normaliza el nombre (recorta y
      // colapsa los espacios), así que dos cuentas con el mismo nombre limpio
      // son dos filas y borrar «por nombre» deja una viva. (La primera versión
      // de esta batería borraba por nombre y por eso una cuenta de 7.000 con la
      // banderita de julio sobrevivió y contaminó el mes de julio: el fallo
      // parecía del producto y era de la batería.)
      for (const caso of [
        { valor: null, etiqueta: "null" },
        { valor: "", etiqueta: '""' },
      ]) {
        const nombre = `${TAG} Apagada ${caso.etiqueta}`;
        const r = await post("/api/accounts", {
          name: nombre,
          kind: "CASH",
          openingBalance: "7000",
          openingIncomeMonth: caso.valor,
        });
        check(`POST con ${caso.etiqueta} crea la cuenta (201)`, r.status, 201);
        check(`la cuenta con ${caso.etiqueta} vuelve apagada`, r.body?.openingIncomeMonth, null);
        await prisma.account.deleteMany({ where: { id: r.body.id } });
      }
      // Y el campo AUSENTE: la cuenta se crea igual, apagada.
      const sinCampo = await post("/api/accounts", {
        name: `${TAG} Sin campo`,
        kind: "CASH",
        openingBalance: "7000",
      });
      check("POST sin el campo crea la cuenta (201)", sinCampo.status, 201);
      check("y la cuenta queda apagada", sinCampo.body?.openingIncomeMonth, null);
      await prisma.account.deleteMany({ where: { id: sinCampo.body.id } });

      /* ── 3 · Los meses VÁLIDOS (y sus formas aceptadas) ──────────────── */
      section("3 · Las formas válidas del mes");
      for (const caso of [
        { valor: "2026-07", esperado: "2026-07" },
        { valor: "2026-07-01", esperado: "2026-07" },
        { valor: "2026-07-15", esperado: "2026-07" },
        { valor: " 2026-07 ", esperado: "2026-07" },
      ]) {
        const r = await post("/api/accounts", {
          name: `${TAG} Mes ${caso.valor}`,
          kind: "CASH",
          openingBalance: "7000",
          openingIncomeMonth: caso.valor,
        });
        check(`POST con "${caso.valor}" crea la cuenta (201)`, r.status, 201);
        check(`"${caso.valor}" se reduce al mes`, r.body?.openingIncomeMonth, caso.esperado);
        await prisma.account.deleteMany({ where: { id: r.body.id } });
      }

      /* ── 4 · Las reglas: tarjeta, préstamo y saldo cero ──────────────── */
      section("4 · Las reglas (una deuda no es un ingreso)");
      const tarjeta = await post("/api/accounts", {
        name: `${TAG} Tarjeta`,
        kind: "CREDIT_CARD",
        openingBalance: "0",
        openingIncomeMonth: MES,
      });
      check("una tarjeta no puede declarar (400)", tarjeta.status, 400);
      checkIncluye("y el mensaje dice por qué", tarjeta.body?.error, "deuda");

      const prestamo = await post("/api/accounts", {
        name: `${TAG} Prestamo`,
        kind: "LOAN",
        openingBalance: "0",
        principal: "100000",
        installmentCount: 12,
        firstInstallmentDate: "2026-12-01",
        tnaPercent: "60",
        openingIncomeMonth: MES,
      });
      check("un préstamo no puede declarar (400)", prestamo.status, 400);
      checkIncluye("y el mensaje dice por qué", prestamo.body?.error, "deuda");
      const prestamos = await prisma.account.findMany({ where: { name: `${TAG} Prestamo` } });
      check("y no queda ningún préstamo creado", prestamos.length, 0);

      const enCero = await post("/api/accounts", {
        name: `${TAG} EnCero`,
        kind: "CASH",
        openingBalance: "0",
        openingIncomeMonth: MES,
      });
      check("una cuenta sin plata no puede declarar (400)", enCero.status, 400);
      checkIncluye("y el mensaje dice por qué", enCero.body?.error, "mayor a cero");

      const enNegativo = await post("/api/accounts", {
        name: `${TAG} EnNegativo`,
        kind: "CASH",
        openingBalance: "-5000",
        openingIncomeMonth: MES,
      });
      check("una cuenta en negativo no puede declarar (400)", enNegativo.status, 400);
      checkIncluye("y el mensaje dice por qué", enNegativo.body?.error, "mayor a cero");

      /* ── 5 · El PATCH con cuerpos hostiles: la cuenta NO cambia ──────── */
      section("5 · PATCH con cuerpos hostiles (la cuenta no cambia)");
      ids = await crearEscenario();
      await banderita(ids.cuentaId, MES);
      const antes = await api("/api/accounts");
      const cuentaAntes = antes.body?.accounts?.find((a) => a.id === ids.cuentaId);

      for (const caso of HOSTILES) {
        const r = await patch("/api/accounts", {
          id: ids.cuentaId,
          openingIncomeMonth: caso.valor,
        });
        checkTrue(
          `PATCH con ${caso.etiqueta} NO es un 5xx`,
          r.status < 500,
          `status=${r.status}`,
        );
        check(`PATCH con ${caso.etiqueta} es un 4xx`, r.status >= 400 && r.status < 500, true);
        checkTrue(
          `PATCH con ${caso.etiqueta} explica el motivo`,
          typeof r.body?.error === "string" && r.body.error.trim().length > 0,
          `body=${JSON.stringify(r.body)}`,
        );
      }
      const despues = await api("/api/accounts");
      const cuentaDespues = despues.body?.accounts?.find((a) => a.id === ids.cuentaId);
      check("la cuenta sigue con la banderita de antes", cuentaDespues?.openingIncomeMonth, cuentaAntes?.openingIncomeMonth);
      check("el nombre no cambió", cuentaDespues?.name, cuentaAntes?.name);
      check("el saldo no cambió", cuentaDespues?.balance, cuentaAntes?.balance);

      // Un PATCH que mezcla un mes inválido con un nombre válido: se rechaza
      // TODO (la cuenta no cambia, ni en el mes ni en el nombre).
      const mixto = await patch("/api/accounts", {
        id: ids.cuentaId,
        name: `${TAG} Renombrada`,
        openingIncomeMonth: "basura",
      });
      check("un PATCH con un mes inválido se rechaza (400)", mixto.status, 400);
      const trasMixto = await api("/api/accounts");
      check(
        "y el nombre tampoco cambió (la cuenta no cambia)",
        trasMixto.body?.accounts?.find((a) => a.id === ids.cuentaId)?.name,
        cuentaAntes?.name,
      );

      /* ── 6 · El PATCH sobre cuentas que no pueden declarar ───────────── */
      section("6 · El PATCH sobre una cuenta que no puede declarar");
      const tarjetaId = "no-existe";
      const r404 = await patch("/api/accounts", {
        id: tarjetaId,
        openingIncomeMonth: MES,
      });
      check("una cuenta que no existe da 404", r404.status, 404);
      checkIncluye("y lo dice", r404.body?.error, "no existe");

      const pTarjeta = await patch("/api/accounts", {
        id: ids.cuentaId,
        openingIncomeMonth: null,
      });
      check("apagar la banderita funciona (200)", pTarjeta.status, 200);

      // Una cuenta de dinero con saldo 0 no puede declarar (la regla del dev).
      const cero = await post("/api/accounts", {
        name: `${TAG} Cero`,
        kind: "CASH",
        openingBalance: "0",
      });
      const pCero = await patch("/api/accounts", {
        id: cero.body.id,
        openingIncomeMonth: MES,
      });
      check("una cuenta con saldo 0 no puede declarar (400)", pCero.status, 400);
      checkIncluye("y el mensaje dice por qué", pCero.body?.error, "mayor a cero");
      await prisma.account.deleteMany({ where: { id: cero.body.id } });

      /* ── 7 · La base es la última defensa ────────────────────────────── */
      section("7 · El CHECK de la base (escritura por afuera de la app)");
      const tarjetaReal = await post("/api/accounts", {
        name: `${TAG} TarjetaDefensa`,
        kind: "CREDIT_CARD",
        openingBalance: "0",
      });
      const escritura = await sql(
        prisma,
        `UPDATE "Account" SET "openingIncomeMonth" = DATE '2026-07-01' WHERE id = $1`,
        [tarjetaReal.body.id],
      );
      checkTrue(
        "la base rechaza declarar en una tarjeta",
        escritura.ok === false,
        `la escritura pasó: ${JSON.stringify(escritura)}`,
      );
      console.log(`  · mensaje de la base: ${String(escritura.error).split("\n")[0]}`);
      await prisma.account.deleteMany({ where: { id: tarjetaReal.body.id } });

      const negativo = await post("/api/accounts", {
        name: `${TAG} NegativoDefensa`,
        kind: "CASH",
        openingBalance: "-1",
      });
      const escritura2 = await sql(
        prisma,
        `UPDATE "Account" SET "openingIncomeMonth" = DATE '2026-07-01' WHERE id = $1`,
        [negativo.body.id],
      );
      checkTrue(
        "la base rechaza declarar con saldo negativo",
        escritura2.ok === false,
        `la escritura pasó: ${JSON.stringify(escritura2)}`,
      );
      await prisma.account.deleteMany({ where: { id: negativo.body.id } });

      // Y una escritura VÁLIDA pasa: el CHECK no es una barrera para lo bueno.
      const okDefensa = await post("/api/accounts", {
        name: `${TAG} ValidaDefensa`,
        kind: "CASH",
        openingBalance: "100",
      });
      const escritura3 = await sql(
        prisma,
        `UPDATE "Account" SET "openingIncomeMonth" = DATE '2026-07-01' WHERE id = $1`,
        [okDefensa.body.id],
      );
      checkTrue("la base acepta una declaración válida", escritura3.ok === true, escritura3.error);
      await prisma.account.deleteMany({ where: { id: okDefensa.body.id } });

      /* ── 8 · El doble toque del toggle ───────────────────────────────── */
      section("8 · El doble toque (dos PATCHes seguidos)");
      const cuenta = async () => {
        const r = await api("/api/accounts");
        return r.body?.accounts?.find((a) => a.id === ids.cuentaId);
      };

      // (a) Encender → apagar: el estado final es APAGADA.
      await banderita(ids.cuentaId, MES);
      await banderita(ids.cuentaId, null);
      check("encender y apagar termina apagada", (await cuenta())?.openingIncomeMonth, null);

      // (b) Encender → encender: el estado final es ENCENDIDA (idempotente).
      await banderita(ids.cuentaId, MES);
      await banderita(ids.cuentaId, MES);
      check("encender dos veces termina encendida", (await cuenta())?.openingIncomeMonth, MES);

      // (c) Apagar → apagar: sigue apagada.
      await banderita(ids.cuentaId, null);
      await banderita(ids.cuentaId, null);
      check("apagar dos veces termina apagada", (await cuenta())?.openingIncomeMonth, null);

      // (d) Encender → apagar → encender: el último manda.
      await banderita(ids.cuentaId, MES);
      await banderita(ids.cuentaId, null);
      await banderita(ids.cuentaId, MES);
      check("encender, apagar y encender termina encendida", (await cuenta())?.openingIncomeMonth, MES);

      // (e) Cambiar de mes: el mes viejo no queda.
      await banderita(ids.cuentaId, "2026-08");
      check("cambiar de mes deja el mes nuevo", (await cuenta())?.openingIncomeMonth, "2026-08");
      await banderita(ids.cuentaId, MES);

      /* ── 9 · La carrera: dos PATCHes SIMULTÁNEOS ─────────────────────── */
      section("9 · La carrera (dos PATCHes simultáneos)");
      await banderita(ids.cuentaId, null);
      const [rOn, rOff] = await Promise.all([
        banderita(ids.cuentaId, MES),
        banderita(ids.cuentaId, null),
      ]);
      checkTrue("ninguno de los dos PATCHes es un 5xx", rOn.status < 500 && rOff.status < 500, `${rOn.status}/${rOff.status}`);
      checkTrue(
        "los dos PATCHes responden OK",
        rOn.status === 200 && rOff.status === 200,
        `${rOn.status}/${rOff.status}`,
      );
      const trasCarrera = await cuenta();
      checkTrue(
        "la cuenta queda en UNO de los dos estados pedidos (no en un tercero)",
        trasCarrera?.openingIncomeMonth === null || trasCarrera?.openingIncomeMonth === MES,
        `estado=${trasCarrera?.openingIncomeMonth}`,
      );
      check("el nombre no se perdió en la carrera", trasCarrera?.name, `${TAG} Efectivo`);
      check("el saldo no se perdió en la carrera", trasCarrera?.balance, "600.00");

      // Y una carrera de dos encendidos: el estado final tiene que ser ENCENDIDA.
      await banderita(ids.cuentaId, null);
      await Promise.all([banderita(ids.cuentaId, MES), banderita(ids.cuentaId, MES)]);
      check("dos encendidos simultáneos dejan la cuenta encendida", (await cuenta())?.openingIncomeMonth, MES);

      /* ── 10 · Un mes pasado y un mes futuro (lo que el brief marca) ───── */
      section("10 · Un mes pasado y un mes futuro");
      const pasado = await banderita(ids.cuentaId, "2020-01");
      check("un mes pasado se acepta (200)", pasado.status, 200);
      check("y queda con ese mes", (await cuenta())?.openingIncomeMonth, "2020-01");
      const futuro = await banderita(ids.cuentaId, "2099-12");
      check("un mes futuro se acepta (200)", futuro.status, 200);
      check("y queda con ese mes", (await cuenta())?.openingIncomeMonth, "2099-12");
      // Lo que importa: un mes futuro NO inventa plata en el mes que se mira.
      const ahora = await api("/api/reconciliation?month=2026-07");
      check(
        "un mes futuro no cambia los números de hoy",
        ahora.body?.reconciliation?.declaredIncome,
        "0.00",
      );
      check("y la reconciliación de hoy sigue cuadrando", ahora.body?.reconciliation?.difference, "0.00");
      await banderita(ids.cuentaId, MES);
    } finally {
      await limpiarEscenario(prisma, ids);
    }
  },
});
