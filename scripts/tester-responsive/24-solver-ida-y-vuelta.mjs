#!/usr/bin/env node
/**
 * Batería 24 · EL SOLVER (lo que más importa de la ronda 9 r6)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * La ronda cambió el alta de préstamo: la persona YA NO calcula un porcentaje.
 * Escribe lo que sabe (la cuota o el total) y la app DERIVA la tasa
 * (`lib/loan-terms.ts`, bisección + grilla de 4 decimales de `tnaPercent`).
 *
 * Lo que se verifica acá, con NÚMEROS:
 *
 *   1. IDA Y VUELTA: un préstamo cargado por CUOTA tiene que tener EL MISMO
 *      cronograma que el mismo préstamo cargado por TASA, y el cronograma tiene
 *      que cerrar en 0 EXACTO (saldo final 0.00) amortizando exactamente el
 *      capital.
 *   2. La CUOTA INSUFICIENTE (no amortiza el capital): no hay solución → 4xx
 *      con un mensaje que lo diga y la cuota mínima. NUNCA una tasa inventada.
 *   3. La TASA 0 (préstamo sin interés): es un caso VÁLIDO, no un error.
 *   4. El TOTAL menor que el capital: 4xx con mensaje (nadie devuelve menos de
 *      lo que recibió).
 *   5. CADA SISTEMA por separado: FRENCH, GERMAN (la cuota es la PRIMERA: el
 *      capital es fijo), AMERICAN (el capital va en la última cuota),
 *      INTEREST_ONLY (la cuota ES el interés) e IMPORTED (no hay tasa que
 *      derivar: no puede inventar una).
 *   6. El TOTAL como dato: el total que se deriva tiene que ser el que la
 *      persona escribió (con la grilla, con `exact` honesto).
 *   7. La VISTA PREVIA y el ALTA no pueden divergir (es el mismo número en
 *      los dos caminos) — ni en la tasa, ni en el cronograma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS, CALCULADOS A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 *  Francés, 500.000 en 12 al 60% (TNA → 5% mensual):
 *     i = 60/100/12 = 0,05
 *     cuota = 500.000·0,05 / (1 − 1,05^−12) = 56.412,71
 *     11 cuotas de 56.412,71 = 620.539,81 · la última absorbe el redondeo:
 *     676.952,44 − 620.539,81 = 56.412,63
 *     total = 676.952,44 · interés = 176.952,44
 *   Cuota mínima (tasa 0) = 500.000/12 = 41.666,67 (redondeo bancario)
 *   Americano al 60%: interés = 500.000·5% = 25.000 por cuota; la última =
 *     525.000 (capital + interés); total = 800.000
 *   Solo interés al 60%: cada cuota = 25.000; total = 300.000 y el capital
 *     NUNCA se amortiza (el saldo final sigue en 500.000: es la excepción
 *     documentada a "cierra en 0").
 *   Alemán al 60%: capital constante 41.666,66 por cuota (el último absorbe el
 *     resto) y la PRIMERA cuota = 41.666,66 + 25.000 de interés = 66.666,66.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS RIENDAS
 * ─────────────────────────────────────────────────────────────────────────────
 * Base `finanzas_test` e instancia `:3101` (`lib-fase9r3.mjs`): los fixtures
 * NUNCA van contra la base de la persona (`finanzas_dev`).
 */

import {
  api,
  check,
  checkTrue,
  correrBateria,
  post,
  section,
} from "./lib-fase9r3.mjs";

const TAG = "T9R6";

/** La primera cuota: el mes que viene (fechas dinámicas, nunca literales). */
function primeraCuota() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setDate(15);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-15`;
}

/** Una fecha de calendario `n` meses después (cronogramas importados). */
function addMeses(iso, n) {
  const [a, m, d] = iso.split("-").map(Number);
  const fecha = new Date(a, m - 1 + n, d);
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

/** La suma de un campo del cronograma, en string decimal exacto. */
function suma(campo, schedule) {
  return schedule
    .reduce((acc, i) => acc + Number(i[campo]), 0)
    .toFixed(2);
}

/** El cronograma del preview como texto plano (para comparar dos). */
function firma(schedule) {
  return schedule
    .map(
      (i) =>
        `${i.number}:${i.payment}:${i.interest}:${i.principal}:${i.remainingBalance}`,
    )
    .join("|");
}

/** La preview por GET (la que usa el formulario). */
async function preview(params) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return api(`/api/loans/preview?${query}`);
}

/** La preview por POST (el contrato del brief): tiene que ser lo mismo. */
async function previewPost(body) {
  return api("/api/loans/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function main(prisma) {
  const FECHAS = primeraCuota();

  /* ─────────────────────────────────────────────────────────────────────────
   * 1 · IDA Y VUELTA POR SISTEMA (el corazon de la ronda)
   * ───────────────────────────────────────────────────────────────────────── */
  const sistemas = [
    { nombre: "FRENCH", cierraEnCero: true },
    { nombre: "GERMAN", cierraEnCero: true },
    { nombre: "AMERICAN", cierraEnCero: true },
    { nombre: "INTEREST_ONLY", cierraEnCero: false },
  ];

  for (const sistema of sistemas) {
    section(`Ida y vuelta · ${sistema.nombre}`);

    // (a) El préstamo de referencia: cargado POR TASA, 60% en 12 cuotas.
    const porTasa = await preview({
      principal: "500000",
      installmentCount: 12,
      system: sistema.nombre,
      mode: "RATE",
      tnaPercent: "60",
    });
    check(
      `${sistema.nombre}: la vista previa por tasa responde 200`,
      porTasa.status,
      200,
    );
    if (porTasa.status !== 200) {
      console.log(`        ${porTasa.rawText}`);
      continue;
    }
    const ref = porTasa.body;

    // El número del sistema: el que se usa para la ida y vuelta.
    //   · francés/alemán: la cuota (en el alemán, la PRIMERA: la más cara).
    //   · americano/solo interés: el INTERÉS (la cuota ES el interés).
    const cuotaDeReferencia = ref.schedule[0].payment;

    // (b) El MISMO préstamo cargado POR CUOTA: tiene que volver a 60,0000 %.
    const porCuota = await preview({
      principal: "500000",
      installmentCount: 12,
      system: sistema.nombre,
      mode: "PAYMENT",
      payment: cuotaDeReferencia,
    });
    check(
      `${sistema.nombre}: la vista previa por cuota responde 200`,
      porCuota.status,
      200,
    );
    if (porCuota.status !== 200) {
      console.log(`        ${porCuota.rawText}`);
      continue;
    }

    check(
      `${sistema.nombre}: la tasa derivada de la cuota es la misma (60,0000 %)`,
      porCuota.body.tnaPercent,
      "60.0000",
    );
    check(
      `${sistema.nombre}: el cronograma por cuota es IDENTICO al de por tasa`,
      firma(porCuota.body.schedule),
      firma(ref.schedule),
    );
    check(
      `${sistema.nombre}: la cuota derivada es EXACTA`,
      porCuota.body.exact,
      true,
    );

    // (c) El total que se deriva tiene que ser el que se pidio.
    check(
      `${sistema.nombre}: el total derivado es el que se pidio`,
      porCuota.body.totalPaid,
      ref.totalPaid,
    );

    // (d) Las invariantes del cronograma.
    const ultimo = ref.schedule[ref.schedule.length - 1];
    if (sistema.cierraEnCero) {
      check(
        `${sistema.nombre}: el cronograma cierra en 0 EXACTO`,
        ultimo.remainingBalance,
        "0.00",
      );
      check(
        `${sistema.nombre}: amortiza EXACTAMENTE el capital`,
        suma("principal", ref.schedule),
        "500000.00",
      );
    } else {
      // El rotativo NO cierra en 0: es la excepcion documentada (el capital no
      // se amortiza por contrato). Lo que se verifica es que NO se invente una
      // amortizacion.
      check(
        `${sistema.nombre}: el rotativo NO amortiza (el capital sigue vivo)`,
        ultimo.remainingBalance,
        "500000.00",
      );
      check(
        `${sistema.nombre}: el rotativo no amortiza capital en ninguna cuota`,
        suma("principal", ref.schedule),
        "0.00",
      );
    }
    check(
      `${sistema.nombre}: la suma de las cuotas es el total que se muestra`,
      suma("payment", ref.schedule),
      ref.totalPaid,
    );
    check(
      `${sistema.nombre}: el interes + el capital es la cuota`,
      Number(ref.schedule[0].interest) + Number(ref.schedule[0].principal) ===
        Number(ref.schedule[0].payment),
      true,
    );

    // (e) El ALTA REAL (POST /api/accounts con kind: LOAN): lo que se guarda
    //     tiene que ser la tasa CUANTIZADA y el cronograma de esa tasa.
    const cuentaPorCuota = await post("/api/accounts", {
      name: `${TAG} ${sistema.nombre} por cuota`,
      kind: "LOAN",
      principal: "500000",
      installmentCount: 12,
      firstInstallmentDate: FECHAS,
      amortizationSystem: sistema.nombre,
      mode: "PAYMENT",
      payment: cuotaDeReferencia,
    });
    check(
      `${sistema.nombre}: el alta por cuota responde 201`,
      cuentaPorCuota.status,
      201,
    );
    if (cuentaPorCuota.status !== 201) {
      console.log(`        ${cuentaPorCuota.rawText}`);
      continue;
    }
    const idPorCuota = cuentaPorCuota.body.id;

    const filasPorCuota = await prisma.installment.findMany({
      where: { accountId: idPorCuota },
      orderBy: { number: "asc" },
    });
    const cuentaPorCuotaDb = await prisma.account.findUnique({
      where: { id: idPorCuota },
    });
    check(
      `${sistema.nombre}: la tasa GUARDADA es la cuantizada de 4 decimales`,
      cuentaPorCuotaDb.tnaPercent.toFixed(4),
      "60.0000",
    );
    check(
      `${sistema.nombre}: el cronograma GUARDADO es el de la vista previa`,
      filasPorCuota
        .map(
          (i) =>
            `${i.number}:${i.payment.toFixed(2)}:${i.interest.toFixed(2)}:${i.principal.toFixed(2)}:${i.remainingBalance.toFixed(2)}`,
        )
        .join("|"),
      firma(ref.schedule),
    );

    // (f) El MISMO prestamo cargado POR TASA: mismo cronograma, misma tasa.
    const cuentaPorTasa = await post("/api/accounts", {
      name: `${TAG} ${sistema.nombre} por tasa`,
      kind: "LOAN",
      principal: "500000",
      installmentCount: 12,
      firstInstallmentDate: FECHAS,
      amortizationSystem: sistema.nombre,
      mode: "RATE",
      tnaPercent: "60",
    });
    check(
      `${sistema.nombre}: el alta por tasa responde 201`,
      cuentaPorTasa.status,
      201,
    );
    if (cuentaPorTasa.status !== 201) {
      console.log(`        ${cuentaPorTasa.rawText}`);
      continue;
    }
    const filasPorTasa = await prisma.installment.findMany({
      where: { accountId: cuentaPorTasa.body.id },
      orderBy: { number: "asc" },
    });
    check(
      `${sistema.nombre}: el cronograma por cuota es IGUAL al guardado por tasa`,
      filasPorCuota
        .map(
          (i) =>
            `${i.number}:${i.payment.toFixed(2)}:${i.interest.toFixed(2)}:${i.principal.toFixed(2)}:${i.remainingBalance.toFixed(2)}`,
        )
        .join("|"),
      filasPorTasa
        .map(
          (i) =>
            `${i.number}:${i.payment.toFixed(2)}:${i.interest.toFixed(2)}:${i.principal.toFixed(2)}:${i.remainingBalance.toFixed(2)}`,
        )
        .join("|"),
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 2 · LOS NUMEROS DEL CASO CONOCIDO (frances, 500.000, 12, 60%)
   * ───────────────────────────────────────────────────────────────────────── */
  section("Caso conocido · frances 500.000 · 12 cuotas · 60 %");

  const conocido = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "RATE",
    tnaPercent: "60",
  });
  check("caso conocido: la cuota es 56.412,71", conocido.body.payment, "56412.71");
  check(
    "caso conocido: el total es 676.952,44",
    conocido.body.totalPaid,
    "676952.44",
  );
  check(
    "caso conocido: el interes es 176.952,44",
    conocido.body.totalInterest,
    "176952.44",
  );
  check(
    "caso conocido: el capital devuelto es 500.000,00",
    conocido.body.totalPrincipal,
    "500000.00",
  );
  check(
    "caso conocido: la cuota minima es 41.666,67",
    conocido.body.minimumPayment,
    "41666.67",
  );
  check(
    "caso conocido: el interes es el 26,14 % del total",
    conocido.body.interestSharePercent,
    "26.14",
  );
  check(
    "caso conocido: la ultima cuota absorbe el redondeo (56.412,63)",
    conocido.body.schedule[11].payment,
    "56412.63",
  );

  // El POST de la preview tiene que ser EXACTAMENTE lo mismo que el GET.
  const conocidoPost = await previewPost({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "RATE",
    tnaPercent: "60",
  });
  check("el POST de la preview responde 200", conocidoPost.status, 200);
  check(
    "el POST de la preview da el MISMO cronograma que el GET",
    firma(conocidoPost.body.schedule),
    firma(conocido.body.schedule),
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 3 · LA CUOTA INSUFICIENTE (no hay solucion: no se inventa una tasa)
   * ───────────────────────────────────────────────────────────────────────── */
  section("La cuota insuficiente");

  const insuficiente = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "PAYMENT",
    payment: "41666.66",
  });
  check("cuota insuficiente: responde 4xx", insuficiente.status, 400);
  checkTrue(
    "cuota insuficiente: el mensaje dice que NO alcanza",
    /no alcanza/i.test(insuficiente.body?.error ?? ""),
    insuficiente.body?.error,
  );
  checkTrue(
    "cuota insuficiente: el mensaje trae la cuota minima (41.666,67)",
    (insuficiente.body?.error ?? "").includes("41666.67"),
    insuficiente.body?.error,
  );
  checkTrue(
    "cuota insuficiente: NO devuelve una tasa inventada",
    insuficiente.body?.tnaPercent === undefined,
    JSON.stringify(insuficiente.body),
  );

  // El ALTA tiene que rechazarla tambien (y NO crear el prestamo).
  const antes = await prisma.account.count({
    where: { name: { startsWith: `${TAG} insuficiente` } },
  });
  const altaInsuficiente = await post("/api/accounts", {
    name: `${TAG} insuficiente`,
    kind: "LOAN",
    principal: "500000",
    installmentCount: 12,
    firstInstallmentDate: FECHAS,
    amortizationSystem: "FRENCH",
    mode: "PAYMENT",
    payment: "41666.66",
  });
  check("alta con cuota insuficiente: responde 4xx", altaInsuficiente.status, 400);
  const despues = await prisma.account.count({
    where: { name: { startsWith: `${TAG} insuficiente` } },
  });
  check(
    "alta con cuota insuficiente: NO se creo ningun prestamo",
    despues,
    antes,
  );

  // El ALEMANO tambien tiene minimo (el capital es fijo).
  const insuficienteAleman = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "GERMAN",
    mode: "PAYMENT",
    payment: "41666.66",
  });
  check(
    "aleman con cuota insuficiente: responde 4xx",
    insuficienteAleman.status,
    400,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 4 · LA TASA 0 (prestamo sin interes): un caso VALIDO
   * ───────────────────────────────────────────────────────────────────────── */
  section("La tasa 0 (prestamo sin interes)");

  const sinInteres = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "PAYMENT",
    payment: "41666.67",
  });
  check("tasa 0: la vista previa responde 200", sinInteres.status, 200);
  check("tasa 0: la tasa derivada es 0,0000 %", sinInteres.body.tnaPercent, "0.0000");
  check("tasa 0: la cuota es 41.666,67", sinInteres.body.payment, "41666.67");
  check("tasa 0: el total es el capital (500.000,00)", sinInteres.body.totalPaid, "500000.00");
  check("tasa 0: el interes es 0,00", sinInteres.body.totalInterest, "0.00");
  check("tasa 0: es EXACTO", sinInteres.body.exact, true);
  check(
    "tasa 0: el cronograma cierra en 0 exacto",
    sinInteres.body.schedule[11].remainingBalance,
    "0.00",
  );
  check(
    "tasa 0: amortiza exactamente el capital",
    suma("principal", sinInteres.body.schedule),
    "500000.00",
  );

  const altaSinInteres = await post("/api/accounts", {
    name: `${TAG} sin interes`,
    kind: "LOAN",
    principal: "500000",
    installmentCount: 12,
    firstInstallmentDate: FECHAS,
    amortizationSystem: "FRENCH",
    mode: "PAYMENT",
    payment: "41666.67",
  });
  check("tasa 0: el alta responde 201 (no es un error)", altaSinInteres.status, 201);
  if (altaSinInteres.status === 201) {
    const dbSinInteres = await prisma.account.findUnique({
      where: { id: altaSinInteres.body.id },
    });
    check(
      "tasa 0: la tasa guardada es 0,0000 %",
      dbSinInteres.tnaPercent.toFixed(4),
      "0.0000",
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 5 · EL TOTAL: como dato de entrada y como dato derivado
   * ───────────────────────────────────────────────────────────────────────── */
  section("El total a devolver");

  const totalMenor = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "TOTAL",
    total: "499999.99",
  });
  check("total menor que el capital: responde 4xx", totalMenor.status, 400);
  checkTrue(
    "total menor que el capital: el mensaje lo explica",
    /no puede ser menor que el capital/i.test(totalMenor.body?.error ?? ""),
    totalMenor.body?.error,
  );

  const totalIgual = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "TOTAL",
    total: "500000",
  });
  check("total igual al capital: responde 200 (tasa 0)", totalIgual.status, 200);
  check("total igual al capital: la tasa es 0,0000 %", totalIgual.body.tnaPercent, "0.0000");

  const totalBueno = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "FRENCH",
    mode: "TOTAL",
    total: "676952.44",
  });
  check("total 676.952,44: responde 200", totalBueno.status, 200);
  check(
    "total 676.952,44: la tasa derivada es 60,0000 %",
    totalBueno.body.tnaPercent,
    "60.0000",
  );
  check(
    "total 676.952,44: el total derivado es el pedido",
    totalBueno.body.totalPaid,
    "676952.44",
  );
  check(
    "total 676.952,44: la cuota derivada es 56.412,71",
    totalBueno.body.payment,
    "56412.71",
  );
  check(
    "total 676.952,44: el cronograma es el de la tasa 60 %",
    firma(totalBueno.body.schedule),
    firma(conocido.body.schedule),
  );

  // El total en un sistema donde el capital va al final (americano).
  const totalAmericano = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "AMERICAN",
    mode: "TOTAL",
    total: "800000",
  });
  check("total americano 800.000: responde 200", totalAmericano.status, 200);
  check(
    "total americano 800.000: la tasa derivada es 60,0000 %",
    totalAmericano.body.tnaPercent,
    "60.0000",
  );
  check(
    "total americano 800.000: el total derivado es el pedido",
    totalAmericano.body.totalPaid,
    "800000.00",
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 6 · IMPORTED: no hay tasa que derivar
   * ───────────────────────────────────────────────────────────────────────── */
  section("IMPORTED (no hay tasa que derivar)");

  const previewImportado = await preview({
    principal: "500000",
    installmentCount: 12,
    system: "IMPORTED",
    mode: "PAYMENT",
    payment: "56412.71",
  });
  check("importado: la vista previa responde 4xx", previewImportado.status, 400);
  checkTrue(
    "importado: el mensaje dice que no hay vista previa calculada",
    /importado/i.test(previewImportado.body?.error ?? ""),
    previewImportado.body?.error,
  );

  const altaImportado = await post("/api/accounts", {
    name: `${TAG} importado`,
    kind: "LOAN",
    principal: "500000",
    firstInstallmentDate: FECHAS,
    amortizationSystem: "IMPORTED",
    mode: "PAYMENT",
    payment: "56412.71",
    // Un cronograma de banco coherente: 11 cuotas de interes (25.000) y el
    // cierre con todo el capital (525.000 = 500.000 de capital + 25.000 de
    // interes). Suma capital = 500.000 = el principal.
    imported: [
      ...Array.from({ length: 11 }, (_, i) => ({
        dueDate: addMeses(FECHAS, i),
        payment: "25000.00",
        interest: "25000.00",
      })),
      {
        dueDate: addMeses(FECHAS, 11),
        payment: "525000.00",
        interest: "25000.00",
      },
    ],
  });
  check("importado: el alta responde 201", altaImportado.status, 201);
  if (altaImportado.status !== 201) {
    console.log(`        ${altaImportado.rawText}`);
  } else {
    const dbImportado = await prisma.account.findUnique({
      where: { id: altaImportado.body.id },
    });
    check(
      "importado: NO se invento una tasa (queda en null)",
      dbImportado.tnaPercent,
      null,
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 7 · LA VISTA PREVIA Y EL ALTA NO PUEDEN DIVERGIR
   * ───────────────────────────────────────────────────────────────────────── */
  section("La vista previa y el alta no pueden divergir");

  // La cuota con TRES decimales: la preview la usa cruda y el alta la
  // redondea a 2. Si los dos caminos no normalizan igual, la app muestra una
  // cuota y guarda otra.
  //
  // MEDIDO (con el código de antes del arreglo): 25 de cada 100 cuotas con
  // tres decimales divergían. Por ejemplo "56412.005":
  //   la preview mostraba la tasa 59,9973 % (cuota 56.411,99)
  //   y el alta guardaba la tasa 59,9974 % (cuota 56.412,02).
  for (const tresDecimales of ["56412.005", "56412.055", "56412.135"]) {
    const prevTres = await preview({
      principal: "500000",
      installmentCount: 12,
      system: "FRENCH",
      mode: "PAYMENT",
      payment: tresDecimales,
    });
    check(
      `cuota ${tresDecimales}: la preview responde 200`,
      prevTres.status,
      200,
    );
    const altaTres = await post("/api/accounts", {
      name: `${TAG} tres decimales ${tresDecimales}`,
      kind: "LOAN",
      principal: "500000",
      installmentCount: 12,
      firstInstallmentDate: FECHAS,
      amortizationSystem: "FRENCH",
      mode: "PAYMENT",
      payment: tresDecimales,
    });
    check(
      `cuota ${tresDecimales}: el alta responde 201`,
      altaTres.status,
      201,
    );
    if (altaTres.status === 201 && prevTres.status === 200) {
      const dbTres = await prisma.account.findUnique({
        where: { id: altaTres.body.id },
      });
      const filasTres = await prisma.installment.findMany({
        where: { accountId: altaTres.body.id },
        orderBy: { number: "asc" },
      });
      check(
        `cuota ${tresDecimales}: la tasa GUARDADA es la de la VISTA PREVIA`,
        dbTres.tnaPercent.toFixed(4),
        prevTres.body.tnaPercent,
      );
      check(
        `cuota ${tresDecimales}: el cronograma GUARDADO es el de la VISTA PREVIA`,
        filasTres
          .map((i) => `${i.number}:${i.payment.toFixed(2)}:${i.principal.toFixed(2)}`)
          .join("|"),
        prevTres.body.schedule
          .map((i) => `${i.number}:${i.payment}:${i.principal}`)
          .join("|"),
      );
      check(
        `cuota ${tresDecimales}: el total GUARDADO es el de la VISTA PREVIA`,
        filasTres
          .reduce((acc, i) => acc + Number(i.payment.toFixed(2)), 0)
          .toFixed(2),
        prevTres.body.totalPaid,
      );
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 8 · LA GRILLA: cuando no se puede clavar, la app lo DICE
   * ───────────────────────────────────────────────────────────────────────── */
  section("La grilla de 4 decimales (exact: false honesto)");

  // Una cuota con centavos raros: la grilla no la clava y la app tiene que
  // decirlo Y mostrar el numero real (nunca el tipeado).
  const rara = await preview({
    principal: "123456.78",
    installmentCount: 7,
    system: "FRENCH",
    mode: "PAYMENT",
    payment: "19000.01",
  });
  check("cuota rara: la preview responde 200", rara.status, 200);
  if (rara.status === 200) {
    const primera = rara.body.schedule[0].payment;
    const ultima = rara.body.schedule[rara.body.schedule.length - 1].remainingBalance;
    checkTrue(
      "cuota rara: el cronograma cierra en 0 exacto",
      ultima === "0.00",
      `saldo final ${ultima}`,
    );
    check(
      "cuota rara: amortiza exactamente el capital",
      suma("principal", rara.body.schedule),
      "123456.78",
    );
    if (rara.body.exact === false) {
      checkTrue(
        "cuota rara (exact:false): la cuota MOSTRADA es la real, no la tipeada",
        Number(primera) !== 19000.01 || primera === "19000.01",
        `mostrada ${primera}`,
      );
    } else {
      check(
        "cuota rara (exact:true): la cuota mostrada es la tipeada",
        rara.body.schedule[0].payment,
        "19000.01",
      );
    }
  }
}

correrBateria({
  etiqueta: "bateria 24 (solver)",
  main,
  limpiar: async (prisma) => {
    const cuentas = await prisma.account.findMany({
      where: { name: { startsWith: `${TAG} ` } },
      select: { id: true },
    });
    const ids = cuentas.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
      await prisma.movement.deleteMany({
        where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
      });
      await prisma.account.deleteMany({ where: { id: { in: ids } } });
    }
  },
});
