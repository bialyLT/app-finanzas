#!/usr/bin/env node
/**
 * ui-03 - La vista previa del alta == el préstamo que queda registrado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, criterio 3: "preview del servidor exacta")
 * ─────────────────────────────────────────────────────────────────────────────
 * El formulario de alta (`components/LoanForm.tsx`) manda a
 * `GET /api/loans/preview` EXACTAMENTE lo que la persona escribió —sin
 * normalizar— y después manda lo mismo a `POST /api/accounts`. Si la ruta de
 * preview no normaliza igual que la de alta, la cuota que muestra el formulario
 * NO es la que queda registrada. Ese es el contrato de la ronda: "la preview no
 * puede mentir".
 *
 * Casos (los tres con el MISMO string crudo en preview y en alta):
 *   A. `9.999.999,99` al `60,00005` en 12 (TNA con 5 decimales: la ruta de alta
 *      la guarda `toFixed(4)` -> 60.0001).
 *   B. `1234,005` al 0% en 2 (monto con 3 decimales: la ruta de alta lo guarda
 *      `toFixed(2)` -> 1.234,01).
 *   C. Control canónico `500.000` al 60 en 12 (el caso del §3.2): cuota
 *      56.412,71, total 676.952,44, interés 176.952,44.
 *
 * La aserción fuerte es fila por fila: payment/interest/principal/dueDate de
 * `preview.schedule[i]` contra `installments[i]` de `GET /api/loans`, más el
 * pago de la cuota 1 y el total contra lo que la vista devuelve YA registrado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * A: TNA 60.0001 -> i mensual = 60.0001/12/100 = 0,0500000833...
 *    500.000 al 60 -> cuota 56.412,71 (clásico); con más monto/TNA chica el
 *    error por TNA sin redondear es de CENTAVOS (27 en la cuota de este caso).
 * B: 1.234,005 -> normalizado 1.234,01 al 0% en 2 cuotas: 617,00 + 617,01
 *    (la última absorbe el centavo del redondeo). El total Σ capital es
 *    1.234,01 == el principal guardado.
 * C: 12 × 56.412,71 = 676.952,52; la última absorbe -0,08 -> 56.412,63;
 *    total 676.952,44 e interés 176.952,44 (35,39% del principal).
 */

import {
  check,
  checkTrue,
  crearCuenta,
  get,
  post,
  prestamoDe,
  runScript,
  section,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4R2_03";
const ASOF = "2028-12-31";
const FIRST = "2028-06-20";

/** Pide el preview con el string CRUDO, exactamente como lo manda el form. */
function pedirPreview({ principal, tna, count, system = "FRENCH", first = FIRST }) {
  const params = new URLSearchParams({
    principal,
    tnaPercent: tna,
    installmentCount: String(count),
    system,
    firstInstallmentDate: first,
  });
  return get(`/api/loans/preview?${params}`);
}

/** Alta con el mismo string crudo que usó el preview. */
function altaCruda({ name, kind = "LOAN", principal, tna, count, system = "FRENCH", first = FIRST }) {
  return post("/api/accounts", {
    name,
    kind,
    principal,
    tnaPercent: tna,
    installmentCount: count,
    firstInstallmentDate: first,
    amortizationSystem: system,
  });
}

/** Compara la fila i del preview con la cuota i+1 registrada. */
function filasIguales(preview, loan) {
  const rows = preview.schedule ?? [];
  const real = loan?.installments ?? [];
  // Sin cronograma en el preview (p. ej. un 400) la comparación no es vacua:
  // no hay nada que pueda coincidir fila por fila.
  if (rows.length === 0 || rows.length !== real.length) return false;
  return rows.every((row, index) => {
    const item = real[index];
    return (
      item &&
      row.payment === item.payment &&
      row.interest === item.interest &&
      row.principal === item.principal &&
      row.dueDate === item.dueDate
    );
  });
}

function primeraDiferencia(preview, loan) {
  return (preview.schedule ?? [])
    .map((row, index) => {
      const real = loan?.installments?.[index];
      if (
        real &&
        row.payment === real.payment &&
        row.interest === real.interest &&
        row.principal === real.principal &&
        row.dueDate === real.dueDate
      ) {
        return null;
      }
      return `cuota ${index + 1}: preview ${JSON.stringify(row)} vs registrado ${JSON.stringify(real)}`;
    })
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ");
}

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);

    /* ───────────────────────────────────────────────────────────────────────
     * A - TNA con 5 decimales (el string crudo que puede tipear una persona)
     * ─────────────────────────────────────────────────────────────────────── */
    section("A - 9.999.999,99 al 60,00005 en 12 cuotas");
    const previewA = await pedirPreview({ principal: "9.999.999,99", tna: "60,00005", count: 12 });
    check("A: el preview responde 200", previewA.status, 200);

    const altaA = await altaCruda({
      name: `${TAG}_A`,
      principal: "9.999.999,99",
      tna: "60,00005",
      count: 12,
    });
    check("A: el alta responde 201", altaA.status, 201);

    const vistaA = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanA = prestamoDe(vistaA, altaA.body?.id);
    check("A: el principal guardado es el normalizado a centavos", loanA?.principal, "9999999.99");
    check("A: la TNA guardada es la normalizada a 4 decimales", loanA?.tnaPercent, "60.0001");

    // El corazón del repro: la cuota del preview tiene que ser LA MISMA fila.
    check("A: la cuota 1 del preview == la cuota 1 registrada", previewA.body?.payment, loanA?.installments?.[0]?.payment);
    check("A: el interés de la cuota 1 == el registrado", previewA.body?.schedule?.[0]?.interest, loanA?.installments?.[0]?.interest);
    checkTrue("A: TODAS las filas coinciden", filasIguales(previewA.body, loanA), primeraDiferencia(previewA.body, loanA));
    // El total prometido == la suma EXACTA de las cuotas registradas (en centavos).
    const sumaCuotasA = (loanA?.installments ?? []).reduce(
      (acc, row) => acc + Math.round(Number(row.payment) * 100),
      0,
    );
    check(
      "A: el total del preview == Σ de las cuotas registradas",
      Math.round(Number(previewA.body?.totalPaid ?? "0") * 100),
      sumaCuotasA,
    );

    /* ───────────────────────────────────────────────────────────────────────
     * B - Monto con 3 decimales (1.234,005 -> 1.234,01 al guardar)
     * ─────────────────────────────────────────────────────────────────────── */
    section("B - 1.234,005 al 0% en 2 cuotas");
    const previewB = await pedirPreview({ principal: "1234,005", tna: "0", count: 2 });
    check("B: el preview responde 200 (no una invariante interna)", previewB.status, 200);

    const altaB = await altaCruda({ name: `${TAG}_B`, principal: "1234,005", tna: "0", count: 2 });
    check("B: el alta responde 201", altaB.status, 201);

    const vistaB = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanB = prestamoDe(vistaB, altaB.body?.id);
    check("B: el principal guardado es 1.234,01", loanB?.principal, "1234.01");
    check("B: cuota 1 registrada 617,00", loanB?.installments?.[0]?.payment, "617.00");
    check("B: cuota 2 registrada 617,01 (absorbe el redondeo)", loanB?.installments?.[1]?.payment, "617.01");
    check("B: la cuota 1 del preview == la registrada", previewB.body?.payment, loanB?.installments?.[0]?.payment);
    checkTrue("B: TODAS las filas coinciden", filasIguales(previewB.body, loanB), primeraDiferencia(previewB.body, loanB));

    /* ───────────────────────────────────────────────────────────────────────
     * C - Control canónico: 500.000 al 60 en 12 (el §3.2)
     * ─────────────────────────────────────────────────────────────────────── */
    section("C - control canónico 500.000 al 60 en 12");
    const previewC = await pedirPreview({ principal: "500.000", tna: "60", count: 12 });
    check("C: el preview responde 200", previewC.status, 200);
    check("C: la cuota del preview es 56.412,71", previewC.body?.payment, "56412.71");
    check("C: el total del preview es 676.952,44", previewC.body?.totalPaid, "676952.44");
    check("C: el interés del preview es 176.952,44", previewC.body?.totalInterest, "176952.44");

    const altaC = await altaCruda({ name: `${TAG}_C`, principal: "500.000", tna: "60", count: 12 });
    check("C: el alta responde 201", altaC.status, 201);

    const vistaC = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanC = prestamoDe(vistaC, altaC.body?.id);
    check("C: la cuota 1 registrada == la del preview", previewC.body?.payment, loanC?.installments?.[0]?.payment);
    check("C: el interés de cuota 1 == 25.000,00", previewC.body?.schedule?.[0]?.interest, "25000.00");
    checkTrue("C: TODAS las filas coinciden", filasIguales(previewC.body, loanC), primeraDiferencia(previewC.body, loanC));

    /* ───────────────────────────────────────────────────────────────────────
     * D - Fecha de la primera cuota: borde 31 -> febrero -> bisiesto
     * ─────────────────────────────────────────────────────────────────────── */
    section("D - primera cuota 31/01/2028: 31 -> 29 (bisiesto) -> 31");
    const previewD = await pedirPreview({
      principal: "300.000",
      tna: "0",
      count: 3,
      first: "2028-01-31",
    });
    check("D: el preview responde 200", previewD.status, 200);
    check("D: fecha 1", previewD.body?.schedule?.[0]?.dueDate, "2028-01-31");
    check("D: fecha 2 (clamp de fin de mes contra el ancla)", previewD.body?.schedule?.[1]?.dueDate, "2028-02-29");
    check("D: fecha 3", previewD.body?.schedule?.[2]?.dueDate, "2028-03-31");

    const altaD = await altaCruda({
      name: `${TAG}_D`,
      principal: "300.000",
      tna: "0",
      count: 3,
      first: "2028-01-31",
    });
    check("D: el alta responde 201", altaD.status, 201);
    const vistaD = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanD = prestamoDe(vistaD, altaD.body?.id);
    check("D: la fecha 2 registrada también es 2028-02-29", loanD?.installments?.[1]?.dueDate, "2028-02-29");
    checkTrue("D: TODAS las filas coinciden (fechas incluidas)", filasIguales(previewD.body, loanD), primeraDiferencia(previewD.body, loanD));

    /* ───────────────────────────────────────────────────────────────────────
     * E - Los cinco sistemas por el mismo camino: preview == registrado
     * ─────────────────────────────────────────────────────────────────────── */
    section("E - AMERICAN e INTEREST_ONLY crudos también coinciden");
    const previewE1 = await pedirPreview({ principal: "500.000", tna: "60", count: 12, system: "AMERICAN" });
    check("E1: preview americano 200", previewE1.status, 200);
    check("E1: la cuota 1 del americano es sólo interés: 25.000,00", previewE1.body?.payment, "25000.00");
    const altaE1 = await altaCruda({ name: `${TAG}_E1`, principal: "500.000", tna: "60", count: 12, system: "AMERICAN" });
    check("E1: alta americana 201", altaE1.status, 201);
    const vistaE1 = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanE1 = prestamoDe(vistaE1, altaE1.body?.id);
    check("E1: el cierre registrado es 525.000,00", loanE1?.installments?.[11]?.payment, "525000.00");
    checkTrue("E1: TODAS las filas coinciden", filasIguales(previewE1.body, loanE1), primeraDiferencia(previewE1.body, loanE1));

    const previewE2 = await pedirPreview({ principal: "100.000", tna: "36", count: 6, system: "INTEREST_ONLY" });
    check("E2: preview rotativo 200", previewE2.status, 200);
    check("E2: la cuota del rotativo es 3.000,00 (sólo interés)", previewE2.body?.payment, "3000.00");
    const altaE2 = await altaCruda({ name: `${TAG}_E2`, principal: "100.000", tna: "36", count: 6, system: "INTEREST_ONLY" });
    check("E2: alta rotativa 201", altaE2.status, 201);
    const vistaE2 = await vistaPrestamos(`?asOf=${ASOF}`);
    const loanE2 = prestamoDe(vistaE2, altaE2.body?.id);
    checkTrue("E2: TODAS las filas coinciden", filasIguales(previewE2.body, loanE2), primeraDiferencia(previewE2.body, loanE2));
  },
});
