#!/usr/bin/env node
/**
 * 04 — Concurrencia: doble ejecución, carrera de extra, doble cancelación y
 * curación simultánea.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief: clase de ataque "doble ejecución / concurrencia")
 * ─────────────────────────────────────────────────────────────────────────────
 * La regla de oro del pago es la SERIALIZACIÓN por préstamo (lock `FOR UPDATE`
 * sobre la fila de la cuenta). Este script la ataca de frente: peticiones EN
 * PARALELO sobre el mismo préstamo, con y sin número de cuota, con extra y con
 * cancelación, y exige "una sola verdad": exactamente UNA escribe (201), las
 * demás responden `created:false` (200) sin tocar la base, y el número de
 * transferencias es el de cuotas realmente pagadas (una por cuota, ninguna
 * duplicada).
 *
 *   A. Sin número ×5 en paralelo (la cuota 1 ya venció) → una sola escribe.
 *   B. Con número explícito ×5 (la cuota 2) → una sola escribe.
 *   C. Otra vez ×4 (la cuota 3) → una sola escribe.
 *   D. Carrera de extra: {cuota 4} vs {cuota 4 + 10.000} en paralelo → una
 *      sola escribe; el capital pagado es UNO de los dos valores posibles
 *      (cuál gane depende del orden del lock, no del cliente).
 *   E. Cancelación anticipada ×3 en paralelo → una sola pata, por el capital
 *      que queda EXACTO (se lee antes de disparar).
 *   F. Cancelar de nuevo ×2 sobre el préstamo ya cerrado → nada se escribe.
 *   G. Curación simultánea: se borran las cuotas 5 y 6 a mano y se disparan 4
 *      GET en paralelo → el cronograma queda completo, sin duplicados.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = 5% mensual, half-even a 2 decimales)
 * ─────────────────────────────────────────────────────────────────────────────
 * FRENCH 100.000/6: cuota 19.701,75.
 *   c1 5.000,00/14.701,75   c2 4.264,91/15.436,84   c3 3.493,07/16.208,68
 *   c4 2.682,64/17.019,11   c5 1.831,68/17.870,07   c6 938,18/18.763,55 (pago
 *   19.701,73: la última absorbe el resto).
 *   Σ capital c1..c3 = 46.347,27; c1..c4 = 63.366,38 (o 73.366,38 si el extra
 *   de 10.000 gana la carrera D).
 *   Cancelación E: 100.000 − capitalPaid ANTES de E (36.633,62 o 26.633,62).
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  get,
  pagarPrestamo,
  prestamoDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_04";

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const prestamo = await crearPrestamo({
      name: `${TAG}_A`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-07-10",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo responde 201", prestamo.status, 201);
    const prestamoId = prestamo.body?.id;

    const desembolso = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-07-01",
      accountId: prestamoId,
      toAccountId: bancoId,
      description: `${TAG}_A desembolso`,
    });
    check("desembolso de A responde 201", desembolso.status, 201);

    const transferenciasHacia = (id) =>
      prisma.movement.count({ where: { kind: "TRANSFER", toAccountId: id } });
    /** Los intereses de ESTE script salen del banco propio: una pata por cuota. */
    const gastosDelPago = () =>
      prisma.movement.count({
        where: { kind: "EXPENSE", accountId: bancoId },
      });

    const contarEstados = (respuestas) => {
      const creadas = respuestas.filter((r) => r.status === 201);
      const idempotentes = respuestas.filter((r) => r.status === 200);
      const raras = respuestas.filter((r) => r.status !== 200 && r.status !== 201);
      return { creadas, idempotentes, raras };
    };

    /* ────────────────────────────────────────────────────────────────────────
     * A — sin número, 5 en paralelo (la cuota 1 ya venció)
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · 5 pagos sin número en paralelo (la próxima vencida: la 1)");
    {
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () =>
          pagarPrestamo({
            accountId: prestamoId,
            cashAccountId: bancoId,
            date: "2028-07-10",
          }),
        ),
      );
      const { creadas, idempotentes, raras } = contarEstados(respuestas);
      check("ninguna respuesta rara (ni 4xx ni 5xx)", raras.length, 0);
      check("exactamente UNA escribe (201)", creadas.length, 1);
      check("las otras cuatro son idempotentes (200)", idempotentes.length, 4);
      check(
        "las cuatro idempotentes traen created:false",
        idempotentes.every((r) => r.body?.created === false),
        true,
      );
      check("UNA sola transferencia por la cuota 1", await transferenciasHacia(prestamoId), 1);
      check("UN solo gasto por el interés de la cuota 1", await gastosDelPago(), 1);

      const vista = await get("/api/loans?asOf=2028-07-10");
      const mio = prestamoDe(vista, prestamoId);
      check("cobertura: 1 de 6", mio?.plan?.paidCount, 1);
      check("capital pagado 14.701,75", mio?.capitalPaid, "14701.75");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * B — con número explícito (la 2), 5 en paralelo
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · 5 pagos de la cuota 2 en paralelo");
    {
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () =>
          pagarPrestamo({
            accountId: prestamoId,
            cashAccountId: bancoId,
            date: "2028-07-10",
            installmentNumber: 2,
          }),
        ),
      );
      const { creadas, idempotentes, raras } = contarEstados(respuestas);
      check("ninguna respuesta rara", raras.length, 0);
      check("exactamente UNA escribe", creadas.length, 1);
      check("las otras cuatro: 200", idempotentes.length, 4);
      check(
        "la que escribió pagó la cuota 2",
        creadas[0]?.body?.installment?.number,
        2,
      );
      check("dos transferencias (c1 + c2)", await transferenciasHacia(prestamoId), 2);

      const vista = await get("/api/loans?asOf=2028-07-10");
      const mio = prestamoDe(vista, prestamoId);
      check("cobertura: 2 de 6", mio?.plan?.paidCount, 2);
      check(
        "capital pagado 30.138,59",
        mio?.capitalPaid,
        "30138.59",
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * C — con número explícito (la 3), 4 en paralelo
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · 4 pagos de la cuota 3 en paralelo");
    {
      const respuestas = await Promise.all(
        Array.from({ length: 4 }, () =>
          pagarPrestamo({
            accountId: prestamoId,
            cashAccountId: bancoId,
            date: "2028-07-10",
            installmentNumber: 3,
          }),
        ),
      );
      const { creadas, idempotentes, raras } = contarEstados(respuestas);
      check("ninguna respuesta rara", raras.length, 0);
      check("exactamente UNA escribe", creadas.length, 1);
      check("las otras tres: 200", idempotentes.length, 3);
      check("tres transferencias (c1..c3)", await transferenciasHacia(prestamoId), 3);

      const vista = await get("/api/loans?asOf=2028-07-10");
      check(
        "capital pagado 46.347,27",
        prestamoDe(vista, prestamoId)?.capitalPaid,
        "46347.27",
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * D — carrera: {cuota 4} vs {cuota 4 + extra 10.000}
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · carrera extra: cuota 4 sola vs cuota 4 + 10.000");
    {
      const respuestas = await Promise.all([
        pagarPrestamo({
          accountId: prestamoId,
          cashAccountId: bancoId,
          date: "2028-07-10",
          installmentNumber: 4,
        }),
        pagarPrestamo({
          accountId: prestamoId,
          cashAccountId: bancoId,
          date: "2028-07-10",
          installmentNumber: 4,
          extraCapital: "10000",
        }),
      ]);
      const { creadas, idempotentes, raras } = contarEstados(respuestas);
      check("ninguna respuesta rara", raras.length, 0);
      check("exactamente UNA escribe", creadas.length, 1);
      check("la otra: 200", idempotentes.length, 1);
      check("cuatro transferencias (c1..c4)", await transferenciasHacia(prestamoId), 4);

      const vista = await get("/api/loans?asOf=2028-07-10");
      const mio = prestamoDe(vista, prestamoId);
      check("cobertura: 4 de 6", mio?.plan?.paidCount, 4);
      const capital = mio?.capitalPaid;
      checkTrue(
        `capital pagado: uno de los dos valores posibles (dio ${capital})`,
        capital === "63366.38" || capital === "73366.38",
        `esperado 63366.38 (sin extra) o 73366.38 (con extra)`,
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * E — cancelación anticipada ×3 en paralelo
     * ──────────────────────────────────────────────────────────────────────── */
    section("E · 3 cancelaciones anticipadas en paralelo");
    {
      const antes = await get("/api/loans?asOf=2028-07-10");
      const capitalAntes = prestamoDe(antes, prestamoId)?.capitalPaid;

      const respuestas = await Promise.all(
        Array.from({ length: 3 }, () =>
          pagarPrestamo({
            accountId: prestamoId,
            cashAccountId: bancoId,
            date: "2028-07-10",
            cancel: true,
          }),
        ),
      );
      const { creadas, idempotentes, raras } = contarEstados(respuestas);
      check("ninguna respuesta rara", raras.length, 0);
      check("exactamente UNA cancela", creadas.length, 1);
      check("las otras dos: 200 sin escribir", idempotentes.length, 2);
      check(
        "la cancelación trae cancelled:true",
        creadas[0]?.body?.cancelled,
        true,
      );

      // 100.000,00 − capitalAntes, en centavos exactos.
      const restanteCentavos = 10000000n - BigInt(String(capitalAntes).replace(".", ""));
      const esperado = `${restanteCentavos / 100n}.${String(restanteCentavos % 100n).padStart(2, "0")}`;
      check(
        `la pata canceló el capital exacto (${capitalAntes} → ${esperado})`,
        creadas[0]?.body?.principalPaid,
        esperado,
      );
      check("cinco transferencias (c1..c4 + cancelación)", await transferenciasHacia(prestamoId), 5);

      const vista = await get("/api/loans?asOf=2028-07-10");
      const mio = prestamoDe(vista, prestamoId);
      check("cobertura: 6 de 6", mio?.plan?.paidCount, 6);
      check("capital pagado 100.000,00", mio?.capitalPaid, "100000.00");
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("saldo del contrato 0,00", mio?.balance, "0.00");
      check("deuda 0,00", mio?.debt, "0.00");
      check("sin próxima cuota", mio?.nextInstallment, null);

      // El número de patas también cuenta: no puede quedar un gasto huérfano
      // de la cancelación (no lleva interés).
      check("cuatro gastos (c1..c4) — la cancelación no agrega gasto", await gastosDelPago(), 4);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * F — cancelar de nuevo sobre el préstamo cerrado
     * ──────────────────────────────────────────────────────────────────────── */
    section("F · 2 cancelaciones más sobre el préstamo ya cerrado");
    {
      const respuestas = await Promise.all(
        Array.from({ length: 2 }, () =>
          pagarPrestamo({
            accountId: prestamoId,
            cashAccountId: bancoId,
            date: "2028-07-11",
            cancel: true,
          }),
        ),
      );
      check(
        "las dos responden 200",
        respuestas.map((r) => r.status).join(","),
        "200,200",
      );
      check(
        "las dos traen created:false",
        respuestas.every((r) => r.body?.created === false),
        true,
      );
      check("siguen las cinco transferencias", await transferenciasHacia(prestamoId), 5);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * G — curación simultánea: 4 GET en paralelo con el cronograma incompleto
     * ──────────────────────────────────────────────────────────────────────── */
    section("G · 4 GET en paralelo curando un cronograma incompleto");
    {
      const prestamoG = await crearPrestamo({
        name: `${TAG}_G`,
        kind: "LOAN",
        principal: "100000",
        tnaPercent: "60",
        installmentCount: 6,
        firstInstallmentDate: "2028-07-20",
        amortizationSystem: "FRENCH",
      });
      check("alta del préstamo G responde 201", prestamoG.status, 201);
      const gId = prestamoG.body?.id;

      const borradas = await prisma.installment.deleteMany({
        where: { accountId: gId, number: { in: [5, 6] } },
      });
      check("se borraron las cuotas 5 y 6 a mano", borradas.count, 2);

      const respuestas = await Promise.all(
        Array.from({ length: 4 }, () => get("/api/loans?asOf=2028-07-20")),
      );
      check(
        "los 4 GET responden 200",
        respuestas.every((r) => r.status === 200),
        true,
      );

      const filas = await prisma.installment.findMany({
        where: { accountId: gId },
        orderBy: { number: "asc" },
      });
      check("el cronograma quedó completo: 6 filas", filas.length, 6);
      check(
        "los números son exactamente 1..6 (sin duplicados)",
        filas.map((f) => f.number).join(","),
        "1,2,3,4,5,6",
      );
      check(
        "la cuota 5 recreada tiene su pago original (19.701,75)",
        filas[4]?.payment.toFixed(2),
        "19701.75",
      );

      const vista = await get("/api/loans?asOf=2028-07-20");
      check(
        "la vista final muestra 6 cuotas",
        prestamoDe(vista, gId)?.installments?.length,
        6,
      );
    }
  },
});
