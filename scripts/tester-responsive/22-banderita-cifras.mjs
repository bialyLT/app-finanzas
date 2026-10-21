#!/usr/bin/env node
/**
 * 22-banderita-cifras.mjs — LOS NÚMEROS de la banderita, de punta a punta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 *
 * La tabla del dev (que hay que comprobar, no creer):
 *
 *   |                           | banderita APAGADA | banderita TILDADA |
 *   | Ingresos de octubre       |        325.000,00 |        332.000,00 |
 *   | — de los cuales declarados |           0,00  |          7.000,00 |
 *   | Gastos                     |        331.400,00 |        331.400,00 |
 *   | Ahorro del mes             |         −6.400,00 |           +600,00 |
 *   | Patrimonio                 |           600,00 |           600,00 |
 *   | Flujo de caja              |         −6.400,00 |         −6.400,00 |
 *   | Reconciliación             |    0,00 (cuadra)  | 0,00 (cuadra con 7.000 declarados) |
 *
 * El escenario se reproduce en JULIO de 2026 (mes vacío del seed) con los
 * MISMOS montos que los de la persona: saldo inicial 7.000, ingreso 325.000,
 * gastos 325.000 y 6.400. Los números tienen que salir EXACTOS: si la fórmula
 * de la plata declarada estuviera mal, el desvío se vería en el centavo.
 *
 * Además verifica los tres caminos que el dev NO tiene test propio (§9.5 y
 * §9.6 de su informe): el DTI, el burn y `/api/reports` CON filtro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS, CALCULADOS A MANO
 *
 * Con la banderita APAGADA (julio, sólo mi cuenta):
 *   ingresos  = 325.000 (el movimiento)                     = 325.000,00
 *   gastos    = 325.000 + 6.400                             = 331.400,00
 *   ahorro    = 325.000 − 331.400                           =  −6.400,00
 *   flujo     = 325.000 (entra) − 331.400 (sale)            =  −6.400,00
 *   patrimonio: antes 7.000 → después 7.000 − 6.400          =    600,00
 *   Δpatrimonio = 600 − 7.000                               =  −6.400,00
 *   reconciliación: −6.400 − (−6.400)                       =      0,00 ✓
 *
 * Con la banderita TILDADA (la misma plata declarada como ingreso de julio):
 *   ingresos  = 325.000 + 7.000 (declarados)                = 332.000,00
 *   gastos    = 331.400,00 (no se mueven)
 *   ahorro    = 332.000 − 331.400                           =    +600,00
 *   flujo     = −6.400,00 (la plata declarada NO es un movimiento)
 *   patrimonio: 600,00 (NO cambia: la plata ya estaba)
 *   Δpatrimonio = −6.400,00
 *   reconciliación: Δ − ahorro + declarada = −6.400 − 600 + 7.000 = 0,00 ✓
 */

import {
  correrBateria,
  crearEscenario,
  banderita,
  totalesDelPanel,
  conciliacion,
  deudas,
  reporte,
  patrimonio,
  limpiarYVerificar,
  limpiarEscenario,
  check,
  checkTrue,
  section,
  api,
  post,
  MES,
  DESDE,
  HASTA,
  TAG,
} from "./lib-fase9r5.mjs";

await correrBateria({
  etiqueta: "22 · los números de la banderita",
  limpiar: async (prisma) => {
    await limpiarYVerificar(prisma);
  },
  main: async (prisma) => {
    let ids = null;

    try {
      /* ── 1 · El escenario ─────────────────────────────────────────────── */
      section("1 · El escenario (julio de 2026, mes vacío del seed)");
      ids = await crearEscenario();
      check("la cuenta del escenario existe", Boolean(ids.cuentaId), true);

      /* ── 2 · Banderita APAGADA: la línea de base ─────────────────────── */
      section("2 · Banderita APAGADA (la línea de base)");
      const apaga = await banderita(ids.cuentaId, null);
      check("apagar la banderita responde 200", apaga.status, 200);
      check("la cuenta queda con la banderita apagada", apaga.body?.openingIncomeMonth, null);

      const tOff = (await totalesDelPanel()).body?.totals;
      const rOff = (await conciliacion()).body?.reconciliation;
      const nOff = (await patrimonio()).body?.netWorth;

      check("ingresos del mes (apagada)", tOff?.income, "325000.00");
      check("y la parte declarada es cero", tOff?.declaredIncome, "0.00");
      check("gastos del mes (no se mueven)", tOff?.expenses, "331400.00");
      check("flujo de caja (apagada)", tOff?.cashFlow, "-6400.00");
      check("ahorro del mes (apagada)", rOff?.saving, "-6400.00");
      check("diferencia de la reconciliación (apagada)", rOff?.difference, "0.00");
      check("y la reconciliación dice que está balanced", rOff?.balanced, true);
      check("la reconciliación no declara nada (apagada)", rOff?.declaredIncome, "0.00");

      const patrimonioOff = nOff?.net;
      console.log(`  · patrimonio con la banderita apagada: ${patrimonioOff}`);

      /* ── 3 · Banderita TILDADA: los números de la tabla ──────────────── */
      section("3 · Banderita TILDADA (la plata declarada cuenta como ingreso de SU mes)");
      const enciende = await banderita(ids.cuentaId, MES);
      check("encender la banderita responde 200", enciende.status, 200);
      check("la cuenta vuelve con el mes declarado", enciende.body?.openingIncomeMonth, MES);

      const tOn = (await totalesDelPanel()).body?.totals;
      const rOn = (await conciliacion()).body?.reconciliation;
      const nOn = (await patrimonio()).body?.netWorth;

      check("ingresos del mes (tildada)", tOn?.income, "332000.00");
      check("la parte declarada se sabe", tOn?.declaredIncome, "7000.00");
      check("gastos del mes (no se mueven)", tOn?.expenses, "331400.00");
      check("flujo de caja (la declarada NO es un movimiento)", tOn?.cashFlow, "-6400.00");
      check("ahorro del mes (tildada)", rOn?.saving, "600.00");
      check("diferencia de la reconciliación (tildada)", rOn?.difference, "0.00");
      check("y la reconciliación sigue cuadrando", rOn?.balanced, true);
      check("la reconciliación declara la plata", rOn?.declaredIncome, "7000.00");
      check("el patrimonio NO cambia con la banderita", nOn?.net, patrimonioOff);

      /* ── 4 · Apagarla devuelve todo a la línea de base ────────────────── */
      section("4 · Apagarla de nuevo (vuelve todo)");
      await banderita(ids.cuentaId, null);
      const tVuelta = (await totalesDelPanel()).body?.totals;
      const rVuelta = (await conciliacion()).body?.reconciliation;
      check("ingresos vuelven a 325.000", tVuelta?.income, "325000.00");
      check("el ahorro vuelve a −6.400", rVuelta?.saving, "-6400.00");
      check("la reconciliación vuelve a cuadrar", rVuelta?.difference, "0.00");
      check("y a no declarar nada", rVuelta?.declaredIncome, "0.00");

      /* ── 5 · El DTI (el dev NO tiene test propio) ────────────────────── */
      section("5 · El DTI con la banderita encendida");
      await banderita(ids.cuentaId, null);
      const dOff = (await deudas()).body?.debtReport;
      await banderita(ids.cuentaId, MES);
      const dOn = (await deudas()).body?.debtReport;

      // El DTI se mide contra el ingreso DEL MES: con la banderita encendida el
      // denominador es 332.000 y no 325.000. Lo que hay que verificar es que la
      // plata declarada entre UNA vez (ni se cuela ni se duplica) y que el número
      // siga siendo explicable.
      check("el ingreso del mes del reporte de deudas (apagada)", dOff?.dti?.income, "325000.00");
      check("el ingreso del mes del reporte de deudas (tildada)", dOn?.dti?.income, "332000.00");
      check(
        "el ingreso del reporte de deudas es el mismo que el del panel",
        dOn?.dti?.income,
        tOn?.income,
      );
      checkTrue(
        "el DTI con la banderita encendida es MENOR (el denominador creció)",
        Number(dOn?.dti?.percent) < Number(dOff?.dti?.percent),
        `dti apagada=${dOff?.dti?.percent} dti tildada=${dOn?.dti?.percent}`,
      );
      console.log(
        `  · DTI apagada=${dOff?.dti?.percent}% · DTI tildada=${dOn?.dti?.percent}% (ingreso ${dOn?.dti?.income})`,
      );

      /* ── 6 · El burn (el dev NO tiene test propio) ───────────────────── */
      section("6 · El burn con la banderita encendida");
      const gastoId = ids.movimientos[1]; // el gasto de 325.000
      // OJO con el orden: la band's de la cuenta tiene que estar en el estado
      // que se está midiendo. (La primera versión de esta batería medía al revés
      // y el "fallo" era de la batería, no del producto: los números del
      // producto eran los correctos en los dos estados.)
      await banderita(ids.cuentaId, null);
      const bOff = (await reporte(`&burn=${gastoId}`)).body?.burn;
      await banderita(ids.cuentaId, MES);
      const bOn = (await reporte(`&burn=${gastoId}`)).body?.burn;

      check("el burn toma el ingreso del período (apagada)", bOff?.income, "325000.00");
      check("el burn toma el ingreso del período (tildada)", bOn?.income, "332000.00");
      check("el burn toma los gastos del período", bOn?.expenses, "331400.00");
      // 325.000 / 12 = 27.083,33 (half-even a 2 decimales)
      //   331.400 − 325.000 + 27.083,33 = 33.483,33
      check("los gastos mensualizados del burn", bOn?.burnExpenses, "33483.33");
      check("el resultado de caja del burn (tildada)", bOn?.cashResult, "600.00");
      check("el resultado del burn (tildada)", bOn?.burnResult, "298516.67");
      check("el resultado de caja del burn (apagada)", bOff?.cashResult, "-6400.00");
      // 325.000 − 33.483,33 = 291.516,67
      check("el resultado del burn (apagada)", bOff?.burnResult, "291516.67");
      // La plata declarada entra UNA vez en el burn (en el ingreso): ni se cuela
      // en los gastos ni se duplica.
      check(
        "la declarada entra una sola vez en el burn",
        Number(bOn?.income) - Number(bOff?.income),
        7000,
      );

      /* ── 7 · /api/reports CON filtro (el dev NO tiene test propio) ──── */
      section("7 · /api/reports con filtro (la plata declarada no se atribuye a un filtro)");
      const rSinFiltro = (await reporte()).body;
      const rCatIngreso = (await reporte(`&categoryId=${ids.categorias.ingreso}`)).body;
      const rCatAlquiler = (await reporte(`&categoryId=${ids.categorias.alquiler}`)).body;
      const rConTexto = (await reporte("&q=T9R5")).body;

      check("sin filtro: el ingreso incluye la plata declarada", rSinFiltro?.totals?.income, "332000.00");
      check("sin filtro: y se sabe cuánto es declarado", rSinFiltro?.totals?.declaredIncome, "7000.00");
      check("filtro por la categoría de INGRESO: la declarada es 0", rCatIngreso?.totals?.declaredIncome, "0.00");
      check("filtro por la categoría de INGRESO: el ingreso es el del subconjunto", rCatIngreso?.totals?.income, "325000.00");
      check("filtro por la categoría de INGRESO: los gastos son 0", rCatIngreso?.totals?.expenses, "0.00");
      check("filtro por la categoría de GASTO: la declarada es 0", rCatAlquiler?.totals?.declaredIncome, "0.00");
      check("filtro por la categoría de GASTO: el ingreso es 0", rCatAlquiler?.totals?.income, "0.00");
      check("filtro por la categoría de GASTO: los gastos son los de la categoría", rCatAlquiler?.totals?.expenses, "325000.00");
      check("filtro por texto: la declarada es 0", rConTexto?.totals?.declaredIncome, "0.00");
      check("filtro por texto: el ingreso es el del subconjunto", rConTexto?.totals?.income, "325000.00");
      check("filtro por texto: los gastos son los del subconjunto", rConTexto?.totals?.expenses, "331400.00");

      /* ── 8 · La reconciliación en los otros casos ────────────────────── */
      section("8 · La reconciliación en los otros casos");
      // (a) A mitad de mes DESPUÉS de los movimientos del escenario (el 19 y el
      //     20 de julio): la ventana los incluye y la reconciliación cuadra.
      const rMitad = (await conciliacion("2026-07-25")).body?.reconciliation;
      check("a mitad de mes la declarada sigue completa", rMitad?.declaredIncome, "7000.00");
      check("a mitad de mes la reconciliación sigue cuadrando", rMitad?.difference, "0.00");
      check("a mitad de mes el ahorro es el del período", rMitad?.saving, "600.00");

      // (a bis) A mitad de mes ANTES de los movimientos (el 15 de julio): la
      //     declaración es del MES, no del día (decisión del dev, §9.7), así que
      //     la plata declarada cuenta entera aunque todavía no haya movimientos:
      //     ingresos 7.000 (declarados) − gastos 0 = ahorro 7.000, y la
      //     reconciliación sigue cuadrando (Δpatrimonio 0 = ahorro − declarada).
      const rTemprano = (await conciliacion("2026-07-15")).body?.reconciliation;
      check("antes de los movimientos la declarada sigue completa", rTemprano?.declaredIncome, "7000.00");
      check("y el ahorro es sólo la plata declarada", rTemprano?.saving, "7000.00");
      check("y la reconciliación sigue cuadrando", rTemprano?.difference, "0.00");
      check("y el patrimonio no se movió", rTemprano?.netDelta, "0.00");

      // (b) Un mes SIN movimientos (agosto): la plata declarada no se filtra.
      const agosto = await api("/api/reconciliation?month=2026-08");
      check("un mes sin movimientos no declara nada", agosto.body?.reconciliation?.declaredIncome, "0.00");
      check("un mes sin movimientos cuadra igual", agosto.body?.reconciliation?.difference, "0.00");
      check("un mes sin movimientos no tiene ahorro", agosto.body?.reconciliation?.saving, "0.00");

      // (c) Un mes ANTERIOR a la declaración: tampoco la cuenta.
      const junio = await api("/api/reconciliation?month=2026-06");
      check("un mes anterior a la declaración no la cuenta", junio.body?.reconciliation?.declaredIncome, "0.00");
      check("y cuadra igual", junio.body?.reconciliation?.difference, "0.00");

      // (d) Con una transferencia en el mes: la transferencia no es ingreso ni
      //     gasto, y la reconciliación tiene que seguir cuadrando.
      const otra = await post("/api/accounts", {
        name: `${TAG} Banco`,
        kind: "BANK",
        openingBalance: "0",
      });
      const transfer = await post("/api/transactions", {
        kind: "TRANSFER",
        amount: "50000",
        date: "2026-07-25",
        accountId: ids.cuentaId,
        toAccountId: otra.body.id,
        description: `${TAG} Traslado`,
      });
      check("la transferencia del escenario se creó", transfer.status, 201);
      const rConTransfer = (await conciliacion()).body?.reconciliation;
      const tConTransfer = (await totalesDelPanel()).body?.totals;
      check("con transferencia, la reconciliación sigue cuadrando", rConTransfer?.difference, "0.00");
      check("con transferencia, el ahorro no cambia", rConTransfer?.saving, "600.00");
      // La plata que se muda de un bolsillo propio a otro NO es un flujo: entra
      // por el destino y sale por el origen ⇒ neto cero (la definición de
      // `movementCashFlow`). El flujo de caja NO cambia.
      check("con transferencia, el flujo NO cambia (neto cero)", tConTransfer?.cashFlow, "-6400.00");
      check("con transferencia, el ingreso NO cambia", tConTransfer?.income, "332000.00");
      check("con transferencia, los gastos no cambian", tConTransfer?.expenses, "331400.00");

      // limpieza de la cuenta auxiliar
      await prisma.movement.deleteMany({ where: { id: transfer.body.id } });
      await prisma.account.deleteMany({ where: { id: otra.body.id } });
    } finally {
      await limpiarEscenario(prisma, ids);
    }
  },
});
