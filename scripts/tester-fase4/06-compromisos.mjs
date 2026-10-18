#!/usr/bin/env node
/**
 * 06 — Compromisos: 12 buckets desde el mes de `asOf`, vencidos aparte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief punto 6 + criterio 6 de la fase)
 * ─────────────────────────────────────────────────────────────────────────────
 * `GET /api/loans` devuelve, por préstamo, los compromisos de los próximos 12
 * meses EN BUCKETS MENSUALES, anclados al mes de `asOf` (no al mes del reloj):
 *
 *   · Un bucket por mes desde `startOfMonth(asOf)` (12 en total).
 *   · `overdue` va APARTE: nunca suma al total de la ventana (contar dos veces
 *     inflaría el compromiso).
 *   · Las cuotas cubiertas se EXCLUYEN (ya se pagaron).
 *   · Un vencimiento POSTERIOR a la ventana se ignora en silencio.
 *   · INTEREST_ONLY (y AMERICAN) no cuentan `overdue`: su interés va como gasto
 *     y "vencido" no tiene fuente de verdad derivable del saldo.
 *   · `GET /api/cards` no se toca (lo nuevo es `GET /api/loans`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (TNA 0% → cuota = principal ÷ n EXACTO)
 * ─────────────────────────────────────────────────────────────────────────────
 * P1 FRENCH 120.000/12 al 0% (primera 10/09/2028): 12 cuotas de 10.000,00.
 *    Con asOf 15/10/2028: vencida = c1 (10/09) → overdue 10.000,00 (1 cuota);
 *    ventana 10/2028..09/2029 → c2..c12 = 11 × 10.000 = 110.000,00;
 *    next6 = 60.000,00. Pagando c1 y c2: overdue 0, y 10/2028 queda en 0,00
 *    (su cuota se pagó) con total 100.000,00.
 *    Con asOf 20/01/2029 (después de c1 y c2): ventana 01/2029..12/2029 →
 *    c5..c12 = 80.000,00; overdue = c3 + c4 = 20.000,00 (2 cuotas); next6 =
 *    c5..c10 = 60.000,00.
 * P2 FRENCH 120.000/3 al 0% (primera 10/10/2029): cuotas 40.000,00 TODAS
 *    posteriores a la ventana de asOf 15/10/2028 → se ignoran: total 0,00.
 * P3 INTEREST_ONLY 100.000 al 36% (i = 3%): 12 cuotas de 3.000,00; sin
 *    vencidos por diseño; ventana → c2..c12 = 33.000,00; next6 = 18.000,00.
 *    DTI de 2028-10: Σ cuota de los planes con pendientes = 10.000 + 40.000 +
 *    3.000 = 53.000,00 (un plan sin pagar ningún interés YA compromete su
 *    cuota); sin ingresos en el mes → percent null ("no se puede calcular").
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  deudaDelMes,
  get,
  pagarPrestamo,
  prestamoDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_06";

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const soloMeses = (mio) =>
      (mio?.commitments?.months ?? []).map(
        (m) => `${m.year}-${String(m.month).padStart(2, "0")}:${m.amount}`,
      );
    const mesDe = (mio, index) => {
      const m = mio?.commitments?.months?.[index];
      return `${m?.year}-${String(m?.month).padStart(2, "0")}`;
    };

    // La foto de tarjetas ANTES: no puede cambiar por crear préstamos.
    const cardsAntes = await get("/api/cards");
    check("GET /api/cards responde 200", cardsAntes.status, 200);

    const deudasAntes = await deudaDelMes("2028-10", "2028-10-31");
    check("la base de deudas responde 200", deudasAntes.status, 200);

    /* ────────────────────────────────────────────────────────────────────────
     * P1 — FRENCH 120.000/12 al 0% (asOf 15/10/2028)
     * ──────────────────────────────────────────────────────────────────────── */
    section("P1 · FRENCH 120.000/12 al 0% (primera 10/09/2028)");
    const p1 = await crearPrestamo({
      name: `${TAG}_P1`,
      kind: "LOAN",
      principal: "120000",
      tnaPercent: "0",
      installmentCount: 12,
      firstInstallmentDate: "2028-09-10",
      amortizationSystem: "FRENCH",
    });
    check("alta de P1 responde 201", p1.status, 201);
    const p1Id = p1.body?.id;
    {
      const vista = await get("/api/loans?asOf=2028-10-15");
      const mio = prestamoDe(vista, p1Id);
      checkTrue("la vista trae P1", mio !== null);
      check("12 buckets", mio?.commitments?.months?.length, 12);
      check("el primer bucket es el mes de asOf (2028-10)", mesDe(mio, 0), "2028-10");
      check("el último bucket es 2029-09", mesDe(mio, 11), "2029-09");
      check(
        "la etiqueta del primer bucket es octubre de 2028",
        `${mio?.commitments?.months?.[0]?.periodLabel}`.toLowerCase().includes("octubre"),
        true,
      );
      check(
        "vencida: c1 (10/09) = 10.000,00",
        `${mio?.commitments?.overdue}/${mio?.commitments?.overdueCount}`,
        "10000.00/1",
      );
      check("next6 = 60.000,00 (c2..c7)", mio?.commitments?.next6Months, "60000.00");
      check("next12 = 110.000,00 (c2..c12, SIN la vencida)", mio?.commitments?.next12Months, "110000.00");
      check("el bucket 10/2028 trae la c2", mio?.commitments?.months?.[0]?.amount, "10000.00");
      check("el bucket 09/2029 está vacío (la c12 es de 08/2029)", mio?.commitments?.months?.[11]?.amount, "0.00");

      // La cobertura se excluye: se paga la c1 (vencida, sin número)…
      const pago1 = await pagarPrestamo({
        accountId: p1Id,
        cashAccountId: bancoId,
        date: "2028-10-15",
      });
      check("pagar la vencida sin número: 201", pago1.status, 201);
      check("pagó la c1", pago1.body?.installment?.number, 1);

      const despues1 = await get("/api/loans?asOf=2028-10-15");
      const mio1 = prestamoDe(despues1, p1Id);
      check("overdue ya no cuenta la c1", `${mio1?.commitments?.overdue}/${mio1?.commitments?.overdueCount}`, "0.00/0");
      check("la ventana sigue en 110.000,00", mio1?.commitments?.next12Months, "110000.00");

      // …y la c2 (10/10, también vencida a la fecha de pago).
      const pago2 = await pagarPrestamo({
        accountId: p1Id,
        cashAccountId: bancoId,
        date: "2028-10-15",
        installmentNumber: 2,
      });
      check("pagar la c2: 201", pago2.status, 201);

      const despues2 = await get("/api/loans?asOf=2028-10-15");
      const mio2 = prestamoDe(despues2, p1Id);
      check("el bucket 10/2028 queda en 0,00 (su cuota se pagó)", mio2?.commitments?.months?.[0]?.amount, "0.00");
      check("el bucket 11/2028 trae la c3", mio2?.commitments?.months?.[1]?.amount, "10000.00");
      check("total de la ventana: 100.000,00 (c3..c12)", mio2?.commitments?.next12Months, "100000.00");
      check("cobertura: 2 de 12", mio2?.plan?.paidCount, 2);

      // Otro asOf: la ventana se corre DOS meses y los vencidos son c3 y c4.
      const enero = await get("/api/loans?asOf=2029-01-20");
      const mioEnero = prestamoDe(enero, p1Id);
      check("ventana desde 2029-01", mesDe(mioEnero, 0), "2029-01");
      check(
        "vencidas: c3 + c4 = 20.000,00 (2 cuotas)",
        `${mioEnero?.commitments?.overdue}/${mioEnero?.commitments?.overdueCount}`,
        "20000.00/2",
      );
      check("ventana 01/2029: c5..c12 = 80.000,00", mioEnero?.commitments?.next12Months, "80000.00");
      check("next6: c5..c10 = 60.000,00", mioEnero?.commitments?.next6Months, "60000.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * P2 — todo el cronograma POSTERIOR a la ventana: se ignora
     * ──────────────────────────────────────────────────────────────────────── */
    section("P2 · FRENCH 120.000/3 (primera 10/10/2029): fuera de la ventana");
    const p2 = await crearPrestamo({
      name: `${TAG}_P2`,
      kind: "LOAN",
      principal: "120000",
      tnaPercent: "0",
      installmentCount: 3,
      firstInstallmentDate: "2029-10-10",
      amortizationSystem: "FRENCH",
    });
    check("alta de P2 responde 201", p2.status, 201);
    const p2Id = p2.body?.id;
    {
      const vista = await get("/api/loans?asOf=2028-10-15");
      const mio = prestamoDe(vista, p2Id);
      check("las cuotas futuras no inflan la ventana", mio?.commitments?.next12Months, "0.00");
      check("next6 también en 0,00", mio?.commitments?.next6Months, "0.00");
      check("no son 'vencidas': no suman a overdue", `${mio?.commitments?.overdue}/${mio?.commitments?.overdueCount}`, "0.00/0");
      check("los 12 buckets están en cero", soloMeses(mio).every((m) => m.endsWith(":0.00")), true);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * P3 — INTEREST_ONLY: sin vencidos, el resto igual
     * ──────────────────────────────────────────────────────────────────────── */
    section("P3 · INTEREST_ONLY 100.000 al 36% (primera 10/09/2028)");
    const p3 = await crearPrestamo({
      name: `${TAG}_P3`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "36",
      installmentCount: 12,
      firstInstallmentDate: "2028-09-10",
      amortizationSystem: "INTEREST_ONLY",
    });
    check("alta de P3 responde 201", p3.status, 201);
    const p3Id = p3.body?.id;
    {
      const vista = await get("/api/loans?asOf=2028-10-15");
      const mio = prestamoDe(vista, p3Id);
      check("cuota mensual = interés = 3.000,00", mio?.plan?.payment, "3000.00");
      check("cobertura 0 (el interés va como gasto)", mio?.plan?.paidCount, 0);
      check("interés pagado: null (no derivable)", mio?.interestPaid, null);
      check("vencidos: 0,00 por diseño (countOverdue:false)", `${mio?.commitments?.overdue}/${mio?.commitments?.overdueCount}`, "0.00/0");
      check("ventana: c2..c12 = 33.000,00", mio?.commitments?.next12Months, "33000.00");
      check("next6 = 18.000,00", mio?.commitments?.next6Months, "18000.00");
      check("la última cuota (08/2029) cae en su bucket", soloMeses(mio)[10], "2029-08:3000.00");
      check("el último bucket (09/2029) queda vacío", soloMeses(mio)[11], "2029-09:0.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * El DTI del mes: una cuota por plan con pendientes, sin importar ventana
     * ──────────────────────────────────────────────────────────────────────── */
    section("DTI · Σ de las cuotas de los planes con pendientes (0% de tasa)");
    {
      const deudas = await deudaDelMes("2028-10", "2028-10-31");
      const antes = deudasAntes.body?.debtReport;
      const ahora = deudas.body?.debtReport;
      const delta = (BigInt(String(ahora?.dti?.monthlyCommitment).replace(".", "")) -
        BigInt(String(antes?.dti?.monthlyCommitment).replace(".", ""))).toString();
      const deltaStr = `${delta.slice(0, -2)}.${delta.slice(-2)}`;
      check("el compromiso mensual sube 53.000,00 (10.000 + 40.000 + 3.000)", deltaStr, "53000.00");
      check("planCount sube 3 (los tres planes comprometen)", ahora?.dti?.planCount - antes?.dti?.planCount, 3);
      check("sin ingresos en 2028-10: percent null ('no se calcula')", ahora?.dti?.percent, null);
      check("el ingreso del mes es 0,00", ahora?.dti?.income, "0.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * GET /api/cards intacto
     * ──────────────────────────────────────────────────────────────────────── */
    section("Regresión · GET /api/cards no cambió");
    {
      const cardsDespues = await get("/api/cards");
      check("responde 200 igual", cardsDespues.status, 200);
      check(
        "respuesta idéntica a la de antes de crear los préstamos",
        JSON.stringify(cardsDespues.body) === JSON.stringify(cardsAntes.body),
        true,
      );
    }
  },
});
