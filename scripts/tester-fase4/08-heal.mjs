#!/usr/bin/env node
/**
 * 08 — Curación (heal-on-GET): completa lo que falta, nunca reescribe lo que
 * ya está, y un legado corrupto no tumba la vista.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief punto 8)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · Si a un préstamo con parámetros completos le faltan filas del cronograma,
 *     `GET /api/loans` las materializa (`createMany` + `skipDuplicates`).
 *   · Las filas EXISTENTES no se reescriben: el cronograma es un DOCUMENTO. Una
 *     fila torcida a mano (dentro de los CHECK) sigue torcida después del heal.
 *   · El heal de una cuenta legada (sin `amortizationSystem`) usa el fallback
 *     documentado: FRENCH. Se verifica contra la MISMA cuenta del preview.
 *   · Un legado que no describe un contrato posible (AMERICAN con tasa 0) NO
 *     tumba la vista: la fila va sin plan y el resto sigue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = 5% mensual, half-even)
 * ─────────────────────────────────────────────────────────────────────────────
 * FRENCH 100.000/6: cuota 19.701,75.
 *   c1 5.000,00/14.701,75   c2 4.264,91/15.436,84   c3 3.493,07/16.208,68
 *   c4 2.682,64/17.019,11   c5 1.831,68/17.870,07   c6 938,18/18.763,55
 * Legado H2: 60.000/3 — las cuotas del francés son CONSTANTES (la c1 y la c2
 * iguales, salvo el centavo de la última); el alemán sería decreciente. Se
 * compara contra el preview FRENCH del mismo contrato.
 */

import {
  check,
  checkTrue,
  crearPrestamo,
  get,
  prestamoDe,
  runScript,
  section,
  vistasPreview,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_08";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ────────────────────────────────────────────────────────────────────────
     * H1 — el heal completa sin reescribir
     * ──────────────────────────────────────────────────────────────────────── */
    section("H1 · FRENCH 100.000/6: fila torcida + filas faltantes");
    const h1 = await crearPrestamo({
      name: `${TAG}_H1`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-12-10",
      amortizationSystem: "FRENCH",
    });
    check("alta de H1 responde 201", h1.status, 201);
    const h1Id = h1.body?.id;
    {
      // La c1 se "tuerce" a mano (misma identidad payment = interés + capital).
      await prisma.installment.update({
        where: { accountId_number: { accountId: h1Id, number: 1 } },
        data: {
          payment: "18701.75",
          interest: "4000.00",
          principal: "14701.75",
          remainingBalance: "85298.25",
        },
      });
      // Y se borran las últimas cuatro.
      const borradas = await prisma.installment.deleteMany({
        where: { accountId: h1Id, number: { in: [3, 4, 5, 6] } },
      });
      check("se borraron 4 filas", borradas.count, 4);

      const antes = await prisma.installment.count({ where: { accountId: h1Id } });
      check("quedan 2 filas antes del GET", antes, 2);

      const vista = await get("/api/loans?asOf=2028-12-10");
      check("el GET responde 200", vista.status, 200);

      const filas = await prisma.installment.findMany({
        where: { accountId: h1Id },
        orderBy: { number: "asc" },
      });
      check("el heal completó: 6 filas", filas.length, 6);
      check(
        "los números son 1..6 sin duplicados",
        filas.map((f) => f.number).join(","),
        "1,2,3,4,5,6",
      );
      check(
        "la fila torcida NO se reescribió (sigue en 18.701,75)",
        filas[0]?.payment.toFixed(2),
        "18701.75",
      );
      check(
        "la c2 intacta sigue igual (19.701,75 / 4.264,91 / 15.436,84)",
        `${filas[1]?.payment.toFixed(2)}/${filas[1]?.interest.toFixed(2)}/${filas[1]?.principal.toFixed(2)}`,
        "19701.75/4264.91/15436.84",
      );
      check(
        "la c3 recreada es la del contrato (3.493,07 de interés)",
        filas[2]?.interest.toFixed(2),
        "3493.07",
      );
      check(
        "la c6 recreada es la última del contrato (pago 19.701,73)",
        filas[5]?.payment.toFixed(2),
        "19701.73",
      );

      const mio = prestamoDe(vista, h1Id);
      check("la vista muestra las 6 cuotas", mio?.installments?.length, 6);

      // Segundo GET: el heal es idempotente (nada nuevo, nada duplicado).
      await get("/api/loans?asOf=2028-12-10");
      const segunda = await prisma.installment.count({ where: { accountId: h1Id } });
      check("un segundo GET no duplica nada", segunda, 6);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * H2 — cuenta legada: sin sistema (FRENCH por defecto) y sin filas
     * ──────────────────────────────────────────────────────────────────────── */
    section("H2 · legado sin amortizationSystem: se cura como FRENCH");
    const legado = await prisma.account.create({
      data: {
        name: `${TAG}_Legado`,
        kind: "LOAN",
        principal: "60000.00",
        tnaPercent: "60.0000",
        installmentCount: 3,
        firstInstallmentDate: new Date("2029-01-10T00:00:00.000Z"),
        // amortizationSystem queda NULL a propósito: cuenta anterior a la fase.
      },
    });
    {
      const preview = await vistasPreview(
        "principal=60000&tnaPercent=60&installmentCount=3&system=FRENCH",
      );
      check("el preview FRENCH responde 200", preview.status, 200);
      const cuotaFrancia = preview.body?.payment;
      checkTrue("el preview trae la cuota del francés", Boolean(cuotaFrancia));

      const vista = await get("/api/loans?asOf=2029-01-10");
      const mio = prestamoDe(vista, legado.id);
      checkTrue("la vista trae el legado", mio !== null);
      check("el sistema legado se lee como FRENCH", mio?.system, "FRENCH");

      const filas = await prisma.installment.findMany({
        where: { accountId: legado.id },
        orderBy: { number: "asc" },
      });
      check("el heal materializó las 3 cuotas", filas.length, 3);
      check(
        "la c1 del heal es LA MISMA del preview francés",
        filas[0]?.payment.toFixed(2),
        cuotaFrancia,
      );
      check(
        "el francés es constante: c2 = c1 (el alemán sería decreciente)",
        filas[1]?.payment.toFixed(2),
        filas[0]?.payment.toFixed(2),
      );
      const sumaCapital = filas.reduce(
        (total, fila) => total + BigInt(fila.principal.toFixed(2).replace(".", "")),
        0n,
      );
      check(
        "Σ capital = 60.000,00 EXACTO (cierra a 0)",
        `${sumaCapital / 100n}.${String(sumaCapital % 100n).padStart(2, "0")}`,
        "60000.00",
      );
      check("la vista ya muestra el plan", mio?.plan?.installmentCount, 3);
      check("primera fecha derivada del documento", mio?.firstInstallmentDate, "2029-01-10");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * H3 — legado corrupto: no describe un contrato → sin plan, sin caída
     * ──────────────────────────────────────────────────────────────────────── */
    section("H3 · legado corrupto (AMERICAN con tasa 0): la vista no se cae");
    const corrupto = await prisma.account.create({
      data: {
        name: `${TAG}_Corrupto`,
        kind: "LOAN",
        principal: "50000.00",
        tnaPercent: "0.0000",
        installmentCount: 3,
        firstInstallmentDate: new Date("2029-02-10T00:00:00.000Z"),
        amortizationSystem: "AMERICAN",
      },
    });
    {
      const vista = await get("/api/loans?asOf=2029-02-10");
      check("el GET responde 200 igual", vista.status, 200);
      const mio = prestamoDe(vista, corrupto.id);
      checkTrue("la fila corrupta se muestra", mio !== null);
      check("sin plan (los números no describen un contrato)", mio?.plan, null);
      check("sin cuotas materializadas", mio?.installments?.length, 0);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check("sistema declarado: AMERICAN", mio?.system, "AMERICAN");

      const filasCorruptas = await prisma.installment.count({
        where: { accountId: corrupto.id },
      });
      check("no se materializó nada del contrato imposible", filasCorruptas, 0);

      // El resto de las vistas no se contaminó.
      const h1Vista = prestamoDe(vista, h1Id);
      checkTrue("H1 sigue con su plan", h1Vista?.plan !== null);
      check("H1 sigue con sus 6 cuotas", h1Vista?.installments?.length, 6);
    }
  },
});
