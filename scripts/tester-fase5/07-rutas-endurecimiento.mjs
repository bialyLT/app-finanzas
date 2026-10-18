#!/usr/bin/env node
/**
 * 07 — Endurecimiento de las rutas de la fase: 401 sin sesión, 403 de origen
 * ajeno, cuerpos hostiles (nunca 500), parámetros hostiles de la vista previa,
 * validación de DELETE de planes y de PATCH de días de tarjeta, y regresión de
 * DELETE /api/transactions (el gasto de un plan no se borra: 409 accionable).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta C1 (cierre 25, vence 5) con un plan de 120.000 en 12 del 10/09; se
 * corre el resumen de septiembre (10.000) y se paga → el plan P queda con un
 * resumen pagado: borrarlo DEBE dar 409.
 * Tarjeta C2 (sin cierre) para las validaciones de PATCH.
 * Cuenta de efectivo para comprobar que los campos de tarjeta no se editan ahí.
 * Plan Q de 3.000 en 3 del 16/10 (sin resumen pagado) → borrarlo DEBE dar 204.
 *
 * Los dos hallazgos que este script reproduce primero (y que se arreglan
 * después) son:
 *   F2 — un monto de 20 dígitos desborda NUMERIC(18,2): 22003 sin traducir → 500.
 *   F3 — DELETE /api/transactions/[id] devuelve 404 "No encontrado" para el
 *        gasto protegido de un plan, en vez del 409 accionable de la colección.
 */

import {
  api,
  apiNoAuth,
  check,
  checkIncluye,
  checkTrue,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearPlan,
  crearTarjeta,
  del,
  guardToday,
  pagarResumen,
  patch,
  postRaw,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_07";
guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "100000");
    const bancoId = banco.body.id;

    const c1 = await crearTarjeta(`${TAG}_C1`, { closingDay: 25, dueDay: 5 });
    const c1Id = c1.body.id;
    const planP = await crearPlan({
      cardId: c1Id,
      label: `${TAG}_P 12`,
      totalAmount: "120000",
      installments: 12,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("plan P creado (201)", planP.status, 201);
    const planPId = planP.body.plan.id;
    const planPMovementId = planP.body.plan.movement.id;

    const run = await correrResumenes(c1Id);
    const resultado = (run.body?.results ?? []).find((r) => r.card.id === c1Id);
    const sep = (resultado?.statements ?? []).find((s) => s.month === 9);
    const pago = await pagarResumen(sep.id, bancoId);
    check("se paga el resumen de septiembre (201)", pago.status, 201);

    const c2 = await crearTarjeta(`${TAG}_C2`, {});
    const c2Id = c2.body.id;

    const efectivo = await crearCuenta(`${TAG}_EFECTIVO`, "CASH", "0");
    const efectivoId = efectivo.body.id;

    /* ── 401 sin sesión ───────────────────────────────────────────────────── */

    section("Sin sesión: 401 en todas las rutas de tarjetas");
    const sinSesion = [
      ["GET", "/api/cards"],
      ["POST", "/api/cards/statements"],
      ["POST", "/api/cards/statements/pay"],
      ["POST", "/api/cards/plans"],
      ["DELETE", "/api/cards/plans?id=x"],
      ["GET", "/api/cards/plans/preview?total=1000&installments=3"],
    ];
    for (const [method, path] of sinSesion) {
      const res = await apiNoAuth(path, { method });
      check(`${method} ${path.split("?")[0]}: 401`, res.status, 401);
      checkIncluye(`${method} ${path.split("?")[0]}: "No autenticado"`, res.body?.error, "No autenticado");
    }

    /* ── 403 de origen ajeno ──────────────────────────────────────────────── */

    section("Origen ajeno: 403 en toda mutación");
    const origenAjeno = (path, method, body) =>
      api(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { Origin: "https://evil.example" },
      });

    const mutaciones = [
      ["POST", "/api/cards/statements", {}],
      ["POST", "/api/cards/statements/pay", {}],
      ["POST", "/api/cards/plans", {}],
      ["DELETE", "/api/cards/plans?id=x", undefined],
      ["PATCH", "/api/accounts", {}],
    ];
    for (const [method, path, body] of mutaciones) {
      const res = await origenAjeno(path, method, body);
      check(`${method} ${path.split("?")[0]}: 403`, res.status, 403);
      checkIncluye(
        `${method} ${path.split("?")[0]}: explica el origen`,
        res.body?.error,
        "origen",
      );
    }

    const sinOrigin = await api("/api/cards/statements", {
      method: "POST",
      body: "{}",
      headers: { Origin: "" },
    });
    check("POST statements sin Origin: 403 (falla cerrado)", sinOrigin.status, 403);
    checkIncluye("y dice que falta el header", sinOrigin.body?.error, "Falta el header Origin");

    const lecturaOrigenAjeno = await api("/api/cards", {
      headers: { Origin: "https://evil.example" },
    });
    check("GET /api/cards con origen ajeno: 200 (lectura sin CSRF)", lecturaOrigenAjeno.status, 200);

    /* ── Cuerpos hostiles ─────────────────────────────────────────────────── */

    section("Cuerpos hostiles: 400, nunca 500");
    const cuerpos = [
      ["null", "null"],
      ["string", '"hola"'],
      ["number", "42"],
      ["array", "[1,2]"],
      ["JSON roto", "{"],
    ];
    const rutasPost = [
      "/api/cards/statements",
      "/api/cards/statements/pay",
      "/api/cards/plans",
    ];
    for (const path of rutasPost) {
      for (const [nombre, raw] of cuerpos) {
        const res = await postRaw(path, raw);
        check(`${path.split("/").slice(-1)[0]} con ${nombre}: 400`, res.status, 400);
      }
    }

    /* ── Vista previa: parámetros hostiles ────────────────────────────────── */

    section("Vista previa: parámetros hostiles");
    const previewCasos = [
      ["sin total", ""],
      ["total abc", "total=abc&installments=3"],
      ["total 0", "total=0&installments=3"],
      ["total negativo", "total=-100&installments=3"],
      ["installments abc", "total=1000&installments=abc"],
      ["installments 0", "total=1000&installments=0"],
      ["installments 121", "total=1000&installments=121"],
      ["installments 1.5", "total=1000&installments=1.5"],
      ["cashPrice abc", "total=1000&installments=3&cashPrice=abc"],
      ["cashPrice 0", "total=1000&installments=3&cashPrice=0"],
    ];
    for (const [nombre, query] of previewCasos) {
      const res = await api(`/api/cards/plans/preview?${query}`);
      check(`preview ${nombre}: 400`, res.status, 400);
      checkTrue(`preview ${nombre}: trae mensaje`, typeof res.body?.error === "string" && res.body.error.length > 0);
    }
    const previewOk = await api(
      "/api/cards/plans/preview?total=1000&installments=3&cashPrice=900",
    );
    check("preview válida: 200", previewOk.status, 200);
    // 1.000 / 3 = 333,333… → base floor 333,33; última = 1.000 − 2 × 333,33 = 333,34.
    check("preview válida: cuota 333,33 (floor)", previewOk.body?.installmentAmount, "333.33");
    check("preview válida: última 333,34 (absorbe el resto)", previewOk.body?.lastInstallmentAmount, "333.34");

    /* ── DELETE de planes ─────────────────────────────────────────────────── */

    section("DELETE de planes: id, inexistente y plan con resumen pagado");
    const sinId = await del("/api/cards/plans");
    check("sin id: 400", sinId.status, 400);
    checkIncluye("dice qué falta", sinId.body?.error, "Falta el id del plan");

    const planFantasma = await del("/api/cards/plans?id=no-existe-999");
    check("plan inexistente: 404", planFantasma.status, 404);
    checkIncluye("dice que no existe", planFantasma.body?.error, "no existe");

    const planProtegido = await del(`/api/cards/plans?id=${planPId}`);
    check("plan con resumen pagado: 409", planProtegido.status, 409);
    checkIncluye("lo explica", planProtegido.body?.error, "resumen ya pagado");
    checkIncluye("ofrece la salida (gasto negativo)", planProtegido.body?.error, "gasto negativo");
    check(
      "el plan protegido sigue en la base",
      await prisma.cardPlan.count({ where: { id: planPId } }),
      1,
    );
    check(
      "y su gasto también",
      await prisma.movement.count({ where: { id: planPMovementId } }),
      1,
    );

    const planQ = await crearPlan({
      cardId: c1Id,
      label: `${TAG}_Q 3`,
      totalAmount: "3000",
      installments: 3,
      purchaseDate: "2026-10-16",
      categoryName: `${TAG}_CAT`,
    });
    check("plan Q (sin resumen pagado) creado (201)", planQ.status, 201);
    const planQId = planQ.body.plan.id;
    const planQMovementId = planQ.body.plan.movement.id;

    const borrarQ = await del(`/api/cards/plans?id=${planQId}`);
    check("borrar Q: 204", borrarQ.status, 204);
    check("Q ya no está", await prisma.cardPlan.count({ where: { id: planQId } }), 0);
    check(
      "su gasto tampoco",
      await prisma.movement.count({ where: { id: planQMovementId } }),
      0,
    );
    const borrarQ2 = await del(`/api/cards/plans?id=${planQId}`);
    check("borrar Q otra vez: 404 (no 500)", borrarQ2.status, 404);

    /* ── PATCH de días ────────────────────────────────────────────────────── */

    section("PATCH de días de tarjeta");
    const patchDias = (body) => patch("/api/accounts", { id: c2Id, ...body });

    const setOk = await patchDias({ closingDay: 25, dueDay: 5 });
    check("25/5: 200", setOk.status, 200);
    check("devuelve closingDay 25", setOk.body?.closingDay, 25);
    check("devuelve dueDay 5", setOk.body?.dueDay, 5);

    const invalidos = [
      ["cierre 0", { closingDay: 0, dueDay: 5 }],
      ["cierre 32", { closingDay: 32, dueDay: 5 }],
      ["cierre -1", { closingDay: -1, dueDay: 5 }],
      ["cierre 1.5", { closingDay: 1.5, dueDay: 5 }],
      ["cierre abc", { closingDay: "abc", dueDay: 5 }],
    ];
    for (const [nombre, body] of invalidos) {
      const res = await patchDias(body);
      check(`PATCH ${nombre}: 400`, res.status, 400);
      checkIncluye(`PATCH ${nombre}: explica el rango`, res.body?.error, "entre 1 y 31");
    }

    const soloCierre = await patchDias({ closingDay: 25, dueDay: 31 });
    check("25/31: 200 (vence el 31, permitido)", soloCierre.status, 200);
    check("devuelve dueDay 31", soloCierre.body?.dueDay, 31);

    const soloUno = await patchDias({ closingDay: 25 });
    check("sólo closingDay: 400 (van juntos)", soloUno.status, 400);
    checkIncluye("dice que van juntos", soloUno.body?.error, "juntos");

    const limpiar = await patchDias({ closingDay: null, dueDay: null });
    check("null/null: 200 (limpia los días)", limpiar.status, 200);
    check("closingDay null", limpiar.body?.closingDay, null);
    check("dueDay null", limpiar.body?.dueDay, null);

    const enEfectivo = await patch("/api/accounts", {
      id: efectivoId,
      closingDay: 25,
      dueDay: 5,
    });
    check("días en una cuenta de efectivo: 400", enEfectivo.status, 400);
    checkIncluye("dice que sólo se editan en tarjetas", enEfectivo.body?.error, "sólo se editan");

    const cuentaFantasma = await patch("/api/accounts", {
      id: "no-existe-999",
      closingDay: 25,
      dueDay: 5,
    });
    check("cuenta inexistente: 404", cuentaFantasma.status, 404);
    checkIncluye("dice que no existe", cuentaFantasma.body?.error, "no existe");

    const limiteCero = await patch("/api/accounts", { id: c2Id, creditLimit: "0" });
    check("límite 0: 400", limiteCero.status, 400);
    const limiteAbc = await patch("/api/accounts", { id: c2Id, creditLimit: "abc" });
    check("límite abc: 400", limiteAbc.status, 400);
    const limpiarLimite = await patch("/api/accounts", { id: c2Id, creditLimit: null });
    check("límite null: 200 (se limpia)", limpiarLimite.status, 200);
    check("creditLimit null", limpiarLimite.body?.creditLimit, null);

    /* ── Montos que desbordan NUMERIC(18,2) ───────────────────────────────── */

    section("Monto de 20 dígitos: 400, no 500 (F2)");
    const enorme = "99999999999999999999";
    const planEnorme = await crearPlan({
      cardId: c1Id,
      label: `${TAG}_enorme`,
      totalAmount: enorme,
      installments: 1,
      purchaseDate: "2026-10-16",
      categoryName: `${TAG}_CAT`,
    });
    check("POST plans con 20 dígitos: 400", planEnorme.status, 400);
    checkIncluye("explica que el monto es demasiado grande", planEnorme.body?.error, "demasiado grande");

    const limiteEnorme = await patch("/api/accounts", { id: c2Id, creditLimit: enorme });
    check("PATCH creditLimit con 20 dígitos: 400", limiteEnorme.status, 400);
    checkIncluye("explica que el monto es demasiado grande", limiteEnorme.body?.error, "demasiado grande");

    /* ── Regresión: el gasto de un plan no se borra ───────────────────────── */

    section("DELETE del gasto de un plan: 409 accionable por las dos rutas (F3)");
    const borrarColeccion = await del(`/api/transactions?id=${planPMovementId}`);
    check("colección: 409", borrarColeccion.status, 409);
    checkIncluye("dice que es la compra de un plan", borrarColeccion.body?.error, "plan en cuotas");
    checkIncluye("indica borrar el plan", borrarColeccion.body?.error, "DELETE /api/cards/plans");

    const borrarPorId = await api(`/api/transactions/${planPMovementId}`, {
      method: "DELETE",
    });
    check("[id]: 409 (no el 404 engañoso)", borrarPorId.status, 409);
    checkIncluye("[id]: mismo mensaje accionable", borrarPorId.body?.error, "plan en cuotas");

    check(
      "el gasto del plan sigue intacto",
      await prisma.movement.count({ where: { id: planPMovementId } }),
      1,
    );

    const gastoSuelto = await crearGasto({
      accountId: c1Id,
      amount: "100",
      date: "2026-10-17",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_suelto`,
    });
    const borrarSuelto = await api(`/api/transactions/${gastoSuelto.body.id}`, {
      method: "DELETE",
    });
    check("[id] con un movimiento normal: 200", borrarSuelto.status, 200);
    check(
      "y el movimiento ya no está",
      await prisma.movement.count({ where: { id: gastoSuelto.body.id } }),
      0,
    );
  },
});
