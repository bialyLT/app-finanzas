#!/usr/bin/env node
/**
 * 01 — Los cinco sistemas: matemática exacta, a mano.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * Cada sistema de amortización cierra EXACTO (o declara su excepción):
 *   · FRENCH       → cuota constante, última absorbe el redondeo. El caso del
 *                    §3.2 (500.000 al 60% TNA en 12 cuotas).
 *   · GERMAN       → capital constante con piso, última absorbe el resto.
 *   · AMERICAN     → interés periódico + bullet final; exige tasa > 0 salvo n=1.
 *   · INTEREST_ONLY→ rotativo: nunca amortiza (la excepción documentada).
 *   · IMPORTED     → sin vista previa (su cronograma se carga, no se calcula).
 * Además: cada sistema materializa EXACTAMENTE lo que la vista previa promete
 * (DB real == /api/loans/preview, fila por fila), y los bordes de plata chica
 * ($0,01) y grande ($9.999.999,99).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL REDONDEO DEL MOTOR ES HALF-EVEN (bancario), NO HALF-UP
 * ─────────────────────────────────────────────────────────────────────────────
 * `round()` de lib/money.ts usa ROUND_HALF_EVEN. Los números de este script
 * están calculados A MANO con ese redondeo. Dos lugares donde se nota:
 *   · FRENCH cuota 11: interés = round(104.894,30 × 0,05) = round(5.244,715)
 *     → empate exacto → al par → 5.244,72.
 *   · FRENCH $0,01 a 1 cuota: interés = round(0,0005) → 0,00 (half-up daría
 *     0,01).
 */

import {
  check,
  checkDeep,
  checkTrue,
  cents,
  centsToMoney,
  crearPrestamo,
  get,
  prestamoDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_01";

/* ────────────────────────────────────────────────────────────────────────────
 * Los cronogramas esperados, calculados a mano (half-even)
 * ──────────────────────────────────────────────────────────────────────────── */

/** FRENCH 500.000 · TNA 60 (i = 0,05) · 12 cuotas — el §3.2. */
const FRENCH_500K = [
  ["56412.71", "25000.00", "31412.71", "468587.29"],
  ["56412.71", "23429.36", "32983.35", "435603.94"],
  ["56412.71", "21780.20", "34632.51", "400971.43"],
  ["56412.71", "20048.57", "36364.14", "364607.29"],
  ["56412.71", "18230.36", "38182.35", "326424.94"],
  ["56412.71", "16321.25", "40091.46", "286333.48"],
  ["56412.71", "14316.67", "42096.04", "244237.44"],
  ["56412.71", "12211.87", "44200.84", "200036.60"],
  ["56412.71", "10001.83", "46410.88", "153625.72"],
  ["56412.71", "7681.29", "48731.42", "104894.30"],
  ["56412.71", "5244.72", "51167.99", "53726.31"],
  ["56412.63", "2686.32", "53726.31", "0.00"],
];

/** GERMAN 500.000 · TNA 60 · 12 cuotas: capital fijo 41.666,66 y última 41.666,74. */
const GERMAN_500K = [
  ["66666.66", "25000.00", "41666.66", "458333.34"],
  ["64583.33", "22916.67", "41666.66", "416666.68"],
  ["62499.99", "20833.33", "41666.66", "375000.02"],
  ["60416.66", "18750.00", "41666.66", "333333.36"],
  ["58333.33", "16666.67", "41666.66", "291666.70"],
  ["56250.00", "14583.34", "41666.66", "250000.04"],
  ["54166.66", "12500.00", "41666.66", "208333.38"],
  ["52083.33", "10416.67", "41666.66", "166666.72"],
  ["50000.00", "8333.34", "41666.66", "125000.06"],
  ["47916.66", "6250.00", "41666.66", "83333.40"],
  ["45833.33", "4166.67", "41666.66", "41666.74"],
  ["43750.08", "2083.34", "41666.74", "0.00"],
];

/** FRENCH 100 · TNA 60 · 7 cuotas: la última absorbe el centavo del reparto. */
const FRENCH_100_7 = [
  ["17.28", "5.00", "12.28", "87.72"],
  ["17.28", "4.39", "12.89", "74.83"],
  ["17.28", "3.74", "13.54", "61.29"],
  ["17.28", "3.06", "14.22", "47.07"],
  ["17.28", "2.35", "14.93", "32.14"],
  ["17.28", "1.61", "15.67", "16.47"],
  ["17.29", "0.82", "16.47", "0.00"],
];

/** GERMAN 100 · TNA 0 · 7 cuotas: 14,28 × 6 + 14,32. */
const GERMAN_100_7 = [
  ["14.28", "0.00", "14.28", "85.72"],
  ["14.28", "0.00", "14.28", "71.44"],
  ["14.28", "0.00", "14.28", "57.16"],
  ["14.28", "0.00", "14.28", "42.88"],
  ["14.28", "0.00", "14.28", "28.60"],
  ["14.28", "0.00", "14.28", "14.32"],
  ["14.32", "0.00", "14.32", "0.00"],
];

/** Convierte una tabla [payment, interest, principal, remaining] en DTOs. */
function tablaEsperada(tabla) {
  return tabla.map(([payment, interest, principal, remainingBalance], index) => ({
    number: index + 1,
    payment,
    interest,
    principal,
    remainingBalance,
  }));
}

/** Verifica los invariantes comunes de un cronograma calculado. */
function invariantes(label, schedule, expectedTotalPrincipal, expectedFinalBalance) {
  const sumaCapital = centsToMoney(
    schedule.reduce((acc, row) => acc + cents(row.principal), 0n),
  );
  check(`${label} · Σ capital`, sumaCapital, expectedTotalPrincipal);
  check(
    `${label} · saldo final`,
    schedule[schedule.length - 1].remainingBalance,
    expectedFinalBalance,
  );
  const ultima = schedule[schedule.length - 1];
  check(
    `${label} · la última cuota descompone exacto (payment = interest + principal)`,
    centsToMoney(cents(ultima.interest) + cents(ultima.principal)),
    ultima.payment,
  );
}

runScript({
  tag: TAG,
  main: async () => {
    /* ──────────────────────────────────────────────────────────────────────
     * FRENCH — el caso del §3.2, entero y a mano
     * ────────────────────────────────────────────────────────────────────── */
    section("FRENCH 500.000 · TNA 60 · 12 cuotas (el §3.2)");
    {
      const res = await get(
        "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12",
      );
      check("preview responde 200", res.status, 200);
      const esperado = tablaEsperada(FRENCH_500K);
      checkDeep(
        "el cronograma entero coincide con el cálculo a mano",
        res.body?.schedule?.map(({ number, payment, interest, principal, remainingBalance }) => ({
          number,
          payment,
          interest,
          principal,
          remainingBalance,
        })),
        esperado,
      );
      check("la cuota (primera) es 56.412,71", res.body?.payment, "56412.71");
      check("el total pagado es 676.952,44", res.body?.totalPaid, "676952.44");
      check("el costo real (interés) es 176.952,44", res.body?.totalInterest, "176952.44");
      check("de cada 100 pagados, 26,14 son del banco", res.body?.interestSharePercent, "26.14");
      invariantes("FRENCH 500k", res.body.schedule, "500000.00", "0.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * GERMAN — capital constante, pago decreciente
     * ────────────────────────────────────────────────────────────────────── */
    section("GERMAN 500.000 · TNA 60 · 12 cuotas");
    {
      const res = await get(
        "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12&system=GERMAN",
      );
      check("preview responde 200", res.status, 200);
      checkDeep(
        "el cronograma entero coincide con el cálculo a mano",
        res.body?.schedule?.map(({ number, payment, interest, principal, remainingBalance }) => ({
          number,
          payment,
          interest,
          principal,
          remainingBalance,
        })),
        tablaEsperada(GERMAN_500K),
      );
      check("el interés total es 162.500,03", res.body?.totalInterest, "162500.03");
      check("el total pagado es 662.500,03", res.body?.totalPaid, "662500.03");
      invariantes("GERMAN 500k", res.body.schedule, "500000.00", "0.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * AMERICAN — interés periódico + bullet
     * ────────────────────────────────────────────────────────────────────── */
    section("AMERICAN 100.000 · TNA 24 · 4 cuotas");
    {
      const res = await get(
        "/api/loans/preview?principal=100000&tnaPercent=24&installmentCount=4&system=AMERICAN",
      );
      check("preview responde 200", res.status, 200);
      checkDeep(
        "el cronograma entero coincide con el cálculo a mano",
        res.body?.schedule?.map(({ number, payment, interest, principal, remainingBalance }) => ({
          number,
          payment,
          interest,
          principal,
          remainingBalance,
        })),
        tablaEsperada([
          ["2000.00", "2000.00", "0.00", "100000.00"],
          ["2000.00", "2000.00", "0.00", "100000.00"],
          ["2000.00", "2000.00", "0.00", "100000.00"],
          ["102000.00", "2000.00", "100000.00", "0.00"],
        ]),
      );
      check("el interés total es 8.000,00", res.body?.totalInterest, "8000.00");
      invariantes("AMERICAN 100k", res.body.schedule, "100000.00", "0.00");
    }

    section("AMERICAN — tasa 0");
    {
      // n > 1 con tasa 0 dejaría cuotas de $0,00 (la base las prohíbe): 400.
      const malo = await get(
        "/api/loans/preview?principal=100000&tnaPercent=0&installmentCount=4&system=AMERICAN",
      );
      check("con más de una cuota y tasa 0 responde 400", malo.status, 400);
      checkTrue(
        "el mensaje explica por qué",
        String(malo.body?.error ?? "").includes("tasa 0"),
        String(malo.body?.error),
      );

      // n = 1: la única cuota es capital puro, el caso no aplica.
      const uno = await get(
        "/api/loans/preview?principal=100000&tnaPercent=0&installmentCount=1&system=AMERICAN",
      );
      check("con 1 cuota y tasa 0 responde 200", uno.status, 200);
      check("paga 100.000,00", uno.body?.schedule?.[0]?.payment, "100000.00");
      check("interés 0,00", uno.body?.schedule?.[0]?.interest, "0.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * INTEREST_ONLY — el rotativo (la excepción documentada)
     * ────────────────────────────────────────────────────────────────────── */
    section("INTEREST_ONLY 200.000 · TNA 36 · 6 cuotas");
    {
      const res = await get(
        "/api/loans/preview?principal=200000&tnaPercent=36&installmentCount=6&system=INTEREST_ONLY",
      );
      check("preview responde 200", res.status, 200);
      checkDeep(
        "las 6 cuotas son SOLO interés de 6.000,00",
        res.body?.schedule?.map((row) => [row.payment, row.interest, row.principal, row.remainingBalance]),
        Array.from({ length: 6 }, () => ["6000.00", "6000.00", "0.00", "200000.00"]),
      );
      // La excepción a "cierra a 0": el capital nunca se amortiza por contrato.
      invariantes("INTEREST_ONLY 200k", res.body.schedule, "0.00", "200000.00");
      check("Σ capital es 0,00 (no amortiza)", res.body?.totalPrincipal, "0.00");
      check("el interés total es 36.000,00", res.body?.totalInterest, "36000.00");
    }

    section("INTEREST_ONLY — tasa 0 es un préstamo gratis: 400");
    {
      const res = await get(
        "/api/loans/preview?principal=200000&tnaPercent=0&installmentCount=6&system=INTEREST_ONLY",
      );
      check("responde 400", res.status, 400);
      checkTrue(
        "el mensaje explica por qué",
        String(res.body?.error ?? "").includes("solo interés con tasa 0"),
        String(res.body?.error),
      );
    }

    /* ──────────────────────────────────────────────────────────────────────
     * Redondeo de la última cuota (los dos casos chicos)
     * ────────────────────────────────────────────────────────────────────── */
    section("FRENCH 100 · TNA 60 · 7 cuotas (absorción del centavo)");
    {
      const res = await get(
        "/api/loans/preview?principal=100&tnaPercent=60&installmentCount=7",
      );
      checkDeep(
        "cronograma a mano (cuota 7 = 17,29 absorbe el redondeo)",
        res.body?.schedule?.map(({ payment, interest, principal, remainingBalance }) => ({
          payment,
          interest,
          principal,
          remainingBalance,
        })),
        tablaEsperada(FRENCH_100_7).map(({ payment, interest, principal, remainingBalance }) => ({
          payment,
          interest,
          principal,
          remainingBalance,
        })),
      );
      invariantes("FRENCH 100/7", res.body.schedule, "100.00", "0.00");
    }

    section("GERMAN 100 · TNA 0 · 7 cuotas (capital piso + última al resto)");
    {
      const res = await get(
        "/api/loans/preview?principal=100&tnaPercent=0&installmentCount=7&system=GERMAN",
      );
      checkDeep(
        "cronograma a mano (14,28 × 6 + 14,32)",
        res.body?.schedule?.map(({ payment, interest, principal, remainingBalance }) => ({
          payment,
          interest,
          principal,
          remainingBalance,
        })),
        tablaEsperada(GERMAN_100_7).map(({ payment, interest, principal, remainingBalance }) => ({
          payment,
          interest,
          principal,
          remainingBalance,
        })),
      );
      invariantes("GERMAN 100/7", res.body.schedule, "100.00", "0.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * Bordes de plata: $0,01 (half-even baja) y millones
     * ────────────────────────────────────────────────────────────────────── */
    section("Plata extrema");
    {
      // interés = round(0,01 × 0,05) = round(0,0005) → 0,00 con half-even.
      const chico = await get(
        "/api/loans/preview?principal=0.01&tnaPercent=60&installmentCount=1",
      );
      check("un préstamo de $0,01 responde 200", chico.status, 200);
      check("su cuota es 0,01", chico.body?.schedule?.[0]?.payment, "0.01");
      check("su interés es 0,00 (half-even)", chico.body?.schedule?.[0]?.interest, "0.00");
      check("su capital es 0,01", chico.body?.schedule?.[0]?.principal, "0.01");

      const grande = await get(
        "/api/loans/preview?principal=9999999.99&tnaPercent=60&installmentCount=12",
      );
      check("un préstamo de $9.999.999,99 responde 200", grande.status, 200);
      invariantes("FRENCH 9.999.999,99", grande.body.schedule, "9999999.99", "0.00");

      // Mil cuotas（600 es el tope）: por encima del tope, 400.
      const setecientas = await get(
        "/api/loans/preview?principal=100000&tnaPercent=60&installmentCount=601",
      );
      check("601 cuotas responde 400 (tope 600)", setecientas.status, 400);
    }

    /* ──────────────────────────────────────────────────────────────────────
     * El alta MATERIALIZA exactamente lo que la preview promete
     * ────────────────────────────────────────────────────────────────────── */
    section("Alta: DB == preview, fila por fila (los 4 sistemas calculados)");
    const casos = [
      { system: "FRENCH", principal: "500000", tna: "60", n: 12, first: "2028-04-10" },
      { system: "GERMAN", principal: "500000", tna: "60", n: 12, first: "2028-04-10" },
      { system: "AMERICAN", principal: "100000", tna: "24", n: 4, first: "2028-05-15" },
      { system: "INTEREST_ONLY", principal: "200000", tna: "36", n: 6, first: "2028-06-01" },
    ];

    for (const caso of casos) {
      const name = `${TAG}_${caso.system}`;
      const creado = await crearPrestamo({
        name,
        principal: caso.principal,
        tnaPercent: caso.tna,
        installmentCount: caso.n,
        firstInstallmentDate: caso.first,
        amortizationSystem: caso.system,
      });
      check(`alta ${caso.system} responde 201`, creado.status, 201);

      const preview = await get(
        `/api/loans/preview?principal=${caso.principal}&tnaPercent=${caso.tna}&installmentCount=${caso.n}&system=${caso.system}&firstInstallmentDate=${caso.first}`,
      );
      check(`preview ${caso.system} responde 200`, preview.status, 200);

      const vista = await get(`/api/loans?asOf=${caso.first}`);
      const prestamo = prestamoDe(vista, creado.body?.id);
      checkTrue(`la vista ${caso.system} trae el préstamo`, prestamo !== null);

      checkDeep(
        `${caso.system} · cada fila materializada == la preview (con fecha)`,
        (prestamo?.installments ?? []).map(
          ({ number, dueDate, payment, interest, principal, remainingBalance }) => ({
            number,
            dueDate,
            payment,
            interest,
            principal,
            remainingBalance,
          }),
        ),
        (preview.body?.schedule ?? []).map(
          ({ number, dueDate, payment, interest, principal, remainingBalance }) => ({
            number,
            dueDate,
            payment,
            interest,
            principal,
            remainingBalance,
          }),
        ),
      );

      // Los parámetros del contrato viven en la cuenta, con el sistema elegido.
      check(`${caso.system} · system en la vista`, prestamo?.system, caso.system);
      check(`${caso.system} · principal`, prestamo?.principal, `${caso.principal}.00`);
      check(
        `${caso.system} · tnaPercent`,
        prestamo?.tnaPercent,
        Number(caso.tna) === 0 ? "0.0000" : `${Number(caso.tna).toFixed(4)}`,
      );
      check(`${caso.system} · installmentCount`, prestamo?.installmentCount, caso.n);
      check(`${caso.system} · firstInstallmentDate`, prestamo?.firstInstallmentDate, caso.first);
    }

    /* ──────────────────────────────────────────────────────────────────────
     * IMPORTED no tiene preview
     * ────────────────────────────────────────────────────────────────────── */
    section("IMPORTED — sin vista previa calculada");
    {
      const res = await get(
        "/api/loans/preview?principal=300000&tnaPercent=60&installmentCount=3&system=IMPORTED",
      );
      check("responde 400", res.status, 400);
      checkTrue(
        "el mensaje explica que se carga tal como lo dio el banco",
        String(res.body?.error ?? "").includes("no tiene vista previa"),
        String(res.body?.error),
      );

      const basura = await get(
        "/api/loans/preview?principal=300000&tnaPercent=60&installmentCount=3&system=INVENTADO",
      );
      check("un sistema inventado responde 400", basura.status, 400);
    }
  },
});

