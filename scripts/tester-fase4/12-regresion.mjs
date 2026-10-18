#!/usr/bin/env node
/**
 * 12 — Regresión: las rutas de las fases anteriores siguen en pie y el seed del
 *      smoke queda EXACTAMENTE como estaba.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (el mandato del tester: nada de lo viejo se rompió)
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. Lecturas de siempre (accounts, transactions, categories, reports,
 *      reconciliation, cards, debts, recurrence) → 200.
 *   B. El préstamo del seed (`Préstamo personal`): 12 cuotas, la 1 cubierta, la
 *      2 no, deuda 468.587,29 y sus derivados — los MISMOS números que el
 *      smoke. La vista lista todas las cuentas LOAN/RECEIVABLE de la base.
 *   C. El contrato de borrado sigue: una cuenta CON movimientos → 409 "archivala";
 *      una vacía → 204 y desaparece; un movimiento → 204.
 *   D. La invariante del reporte: `totalDebt` es EXACTAMENTE la suma de las
 *      filas (comparación string a string: nada de floats).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * Seed del smoke: 500.000 al 60% TNA en 12 cuotas (cuota 56.412,71); la cuota 1
 * se pagó a mano (capital 31.412,71 + interés 25.000,00) → deuda viva
 * 500.000,00 − 31.412,71 = 468.587,29.
 */

import {
  check,
  checkDeep,
  checkIncluye,
  checkTrue,
  cuentaDe,
  crearCuenta,
  crearMovimiento,
  deudaDelMes,
  del,
  get,
  reconciliacion,
  runScript,
  section,
  sumItems,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_12";
const MES = "2026-10";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ────────────────────────────────────────────────────────────────────────
     * A — Las lecturas de las fases anteriores
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · Las rutas de las fases 1–5 siguen respondiendo");

    const rutas = [
      await get("/api/accounts"),
      await get("/api/transactions"),
      await get("/api/categories"),
      await get(`/api/reports?from=${MES}-01&to=${MES}-31`),
      await reconciliacion(MES, "2026-10-31"),
      await get("/api/cards"),
      await deudaDelMes(MES, "2026-10-31"),
      await get("/api/recurrence"),
    ];
    checkDeep(
      "accounts/transactions/categories/reports/reconciliation/cards/debts/recurrence: 200",
      rutas.map((r) => r.status),
      [200, 200, 200, 200, 200, 200, 200, 200],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * B — El seed del smoke: el préstamo y su plan, número por número
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · El préstamo del seed, intacto (los números del smoke)");

    const vista = await vistaPrestamos("?asOf=2026-10-31");
    check("GET /api/loans?asOf=… responde 200", vista.status, 200);
    const seed = (vista.body?.loans ?? []).find(
      (loan) => loan.name === "Préstamo personal",
    );
    checkTrue("el préstamo del seed está en la vista", Boolean(seed));
    check("12 cuotas materializadas", seed?.installments?.length, 12);
    check("la cuota 1 vence el 15/10", seed?.installments?.[0]?.dueDate, "2026-10-15");
    check("la cuota 1 está cubierta", seed?.installments?.[0]?.covered, true);
    check("la cuota 2 todavía no", seed?.installments?.[1]?.covered, false);
    check("1 de 12 cuotas pagadas", seed?.plan?.paidCount, 1);
    check("la próxima impaga es la 2", seed?.nextInstallment?.number, 2);
    check("capital pagado 31.412,71", seed?.capitalPaid, "31412.71");
    check("interés pagado 25.000,00", seed?.interestPaid, "25000.00");
    check("deuda viva 468.587,29", seed?.debt, "468587.29");
    check("dirección I_OWE", seed?.direction, "I_OWE");
    check("sistema FRENCH", seed?.system, "FRENCH");

    const cuentasPrestamo = await prisma.account.count({
      where: { kind: { in: ["LOAN", "RECEIVABLE"] } },
    });
    check(
      "la vista lista todas las cuentas de préstamo de la base",
      (vista.body?.loans ?? []).length,
      cuentasPrestamo,
    );

    const sinAsOf = await vistaPrestamos();
    check("GET /api/loans sin asOf también responde 200", sinAsOf.status, 200);

    /* ────────────────────────────────────────────────────────────────────────
     * C — El contrato de borrado de cuentas y movimientos
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · DELETE: con movimientos 409, vacía 204");

    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    const caja = await crearCuenta(`${TAG}_Caja`, "CASH", "0");
    check("alta del banco 201", banco.status, 201);
    check("alta de la caja 201", caja.status, 201);

    const transferencia = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100",
      date: "2026-10-05",
      description: `${TAG}_transferencia`,
      accountId: banco.body?.id,
      toAccountId: caja.body?.id,
    });
    check("la transferencia responde 201", transferencia.status, 201);

    const conMovimientos = await del(`/api/accounts?id=${banco.body?.id}`);
    check("DELETE de una cuenta con movimientos: 409", conMovimientos.status, 409);
    checkIncluye(
      "…y sugiere archivar en vez de borrar",
      conMovimientos.body?.error,
      "Archivala",
    );

    const vacia = await crearCuenta(`${TAG}_Vacia`, "CASH", "0");
    const borrada = await del(`/api/accounts?id=${vacia.body?.id}`);
    check("DELETE de una cuenta vacía: 204", borrada.status, 204);
    check("la cuenta borrada ya no está", await cuentaDe(vacia.body?.id), null);

    const borrarMovimiento = await del(`/api/transactions/${transferencia.body?.id}`);
    check("DELETE de un movimiento: 200", borrarMovimiento.status, 200);
    check("…y confirma con ok:true", borrarMovimiento.body?.ok, true);

    /* ────────────────────────────────────────────────────────────────────────
     * D — totalDebt == Σ filas, exacto
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · El total del reporte es la suma de sus filas");

    const deuda = await deudaDelMes(MES, "2026-10-31");
    check("el reporte de deudas responde 200", deuda.status, 200);
    const report = deuda.body?.debtReport;
    checkTrue("hay filas", (report?.rows ?? []).length > 0);
    check(
      "totalDebt == Σ filas (string exacto)",
      report?.totalDebt,
      sumItems(report?.rows ?? [], (fila) => fila.debt),
    );
  },
});
