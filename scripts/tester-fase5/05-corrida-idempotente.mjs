#!/usr/bin/env node
/**
 * 05 — La corrida de resúmenes (POST /api/cards/statements): idempotencia
 * secuencial, carrera de dos corridas, tarjeta sin cierre (`skipped`) y
 * recorte por antigüedad (`truncated`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta A (cierre 25, vence 5): gasto de 1.000,00 del 10/09.
 *   → corrida 1: crea septiembre (total 1.000,00, mínimo 50,00, vence 05/10).
 *   → corrida 2: unchanged = 1, mismo id, cero filas nuevas.
 * Tarjeta B (SIN cierre ni vencimiento): gasto de 500,00 del 10/09.
 *   → no puede emitir: aparece en `skipped` con el motivo, no rompe la corrida.
 * Tarjeta C (cierre 25): gasto de 5.000,00 del 10/09 + gasto de 1.000,00 del
 *   10/01/2005. El período más viejo es 2005-01 y el último cerrado 2026-09:
 *   261 períodos > tope de 240 → `truncated: true`. Sólo se emite 2026-09
 *   (5.000,00); el gasto de 2005 queda fuera de la ventana recortada.
 * Tarjeta D (cierre 25): gasto de 2.000,00 del 15/09, sin resúmenes.
 *   → DOS corridas simultáneas: una crea, la otra ve el resumen o choca con la
 *   clave única (P2002 → 409). Nunca dos filas ni un 500.
 * Tarjeta E (cierre 25): sin actividad → no participa (ni result ni skipped).
 *
 * Mínimos a mano: 5 % → 1.000,00 → 50,00; 5.000,00 → 250,00; 2.000,00 → 100,00.
 */

import {
  check,
  checkDeep,
  checkIncluye,
  checkTrue,
  correrResumenes,
  crearGasto,
  crearTarjeta,
  guardToday,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_05";
guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const a = await crearTarjeta(`${TAG}_A`, { closingDay: 25, dueDay: 5 });
    const idA = a.body.id;
    await crearGasto({
      accountId: idA,
      amount: "1000",
      date: "2026-09-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_A gasto`,
    });

    const b = await crearTarjeta(`${TAG}_B`, {});
    const idB = b.body.id;
    await crearGasto({
      accountId: idB,
      amount: "500",
      date: "2026-09-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_B gasto`,
    });

    const c = await crearTarjeta(`${TAG}_C`, { closingDay: 25, dueDay: 5 });
    const idC = c.body.id;
    await crearGasto({
      accountId: idC,
      amount: "5000",
      date: "2026-09-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_C reciente`,
    });
    await crearGasto({
      accountId: idC,
      amount: "1000",
      date: "2005-01-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_C viejo`,
    });

    const d = await crearTarjeta(`${TAG}_D`, { closingDay: 25, dueDay: 5 });
    const idD = d.body.id;
    await crearGasto({
      accountId: idD,
      amount: "2000",
      date: "2026-09-15",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_D gasto`,
    });

    const e = await crearTarjeta(`${TAG}_E`, { closingDay: 25, dueDay: 5 });
    const idE = e.body.id;

    /* ── Idempotencia secuencial ──────────────────────────────────────────── */

    section("Corrida 1 de A: emite septiembre");
    const run1 = await correrResumenes(idA);
    check("corrida 1: 200", run1.status, 200);
    check("runDate = hoy", run1.body?.runDate, "2026-10-17");
    const r1 = (run1.body?.results ?? []).find((r) => r.card.id === idA);
    checkTrue("A aparece en results", Boolean(r1));
    check("created = 1", r1?.created, 1);
    check("updated = 0", r1?.updated, 0);
    check("unchanged = 0", r1?.unchanged, 0);
    check("frozen = 0", r1?.frozen, 0);
    const sep1 = (r1?.statements ?? [])[0];
    check("un solo resumen visible", r1?.statements?.length, 1);
    check("período septiembre 2026", `${sep1?.year}-${sep1?.month}`, "2026-9");
    check("cierre 2026-09-25", sep1?.closingDate, "2026-09-25");
    check("vence 2026-10-05", sep1?.dueDate, "2026-10-05");
    check("total 1.000,00", sep1?.totalDue, "1000.00");
    check("mínimo 50,00 (5 % exacto)", sep1?.minimumDue, "50.00");
    check("impago", sep1?.paid, false);

    section("Corrida 2 de A: no cambia nada");
    const run2 = await correrResumenes(idA);
    check("corrida 2: 200", run2.status, 200);
    const r2 = (run2.body?.results ?? []).find((r) => r.card.id === idA);
    check("created = 0", r2?.created, 0);
    check("updated = 0", r2?.updated, 0);
    check("unchanged = 1", r2?.unchanged, 1);
    check("frozen = 0", r2?.frozen, 0);
    check("el resumen es EL MISMO documento (id estable)", r2?.statements?.[0]?.id, sep1?.id);
    check(
      "en la base hay UNA sola fila de resumen para A",
      await prisma.statement.count({ where: { accountId: idA } }),
      1,
    );

    const run3 = await correrResumenes(idA);
    const r3 = (run3.body?.results ?? []).find((r) => r.card.id === idA);
    check("tercera corrida: unchanged = 1 (idempotencia no se gasta)", r3?.unchanged, 1);
    check(
      "sigue habiendo UNA fila",
      await prisma.statement.count({ where: { accountId: idA } }),
      1,
    );

    /* ── Tarjeta sin cierre ───────────────────────────────────────────────── */

    section("B: tarjeta con compras pero sin cierre");
    const runB = await correrResumenes(idB);
    check("la corrida no rompe: 200", runB.status, 200);
    checkDeep("B no aparece en results", runB.body?.results, []);
    check("B aparece en skipped", runB.body?.skipped?.length, 1);
    check("skipped[0] es B", runB.body?.skipped?.[0]?.cardId, idB);
    checkIncluye(
      "el motivo nombra el día de cierre",
      runB.body?.skipped?.[0]?.reason,
      "día de cierre",
    );
    check(
      "no se inventó ningún resumen para B",
      await prisma.statement.count({ where: { accountId: idB } }),
      0,
    );

    /* ── Recorte por antigüedad ───────────────────────────────────────────── */

    section("C: 261 períodos → truncated");
    const runC = await correrResumenes(idC);
    check("corrida de C: 200", runC.status, 200);
    checkTrue("truncated = true (261 > 240)", runC.body?.truncated);
    const rC = (runC.body?.results ?? []).find((r) => r.card.id === idC);
    check("created = 1 (sólo el período reciente)", rC?.created, 1);
    check("un resumen en la respuesta", rC?.statements?.length, 1);
    const sepC = (rC?.statements ?? [])[0];
    check("el resumen es 2026-09", `${sepC?.year}-${sepC?.month}`, "2026-9");
    check("total 5.000,00 (el gasto de 2005 no entra en la ventana)", sepC?.totalDue, "5000.00");
    check("mínimo 250,00", sepC?.minimumDue, "250.00");
    check(
      "en la base hay UNA fila (no 261)",
      await prisma.statement.count({ where: { accountId: idC } }),
      1,
    );
    check(
      "no existe un resumen de 2005-01 recortado fuera",
      await prisma.statement.count({
        where: { accountId: idC, periodYear: 2005, periodMonth: 1 },
      }),
      0,
    );

    /* ── Carrera: dos corridas simultáneas ────────────────────────────────── */

    section("D: dos corridas simultáneas sobre la misma tarjeta");
    const [carrera1, carrera2] = await Promise.all([
      correrResumenes(idD),
      correrResumenes(idD),
    ]);
    console.log(
      `    distribución: ${[carrera1, carrera2]
        .map((r) => `${r.status}/created:${r.body?.results?.[0]?.created ?? "-"}`)
        .join(", ")}`,
    );
    checkDeep(
      "ningún status inesperado (sólo 200 o 409, nunca 500)",
      [carrera1, carrera2]
        .map((r) => r.status)
        .filter((s) => s !== 200 && s !== 409),
      [],
    );
    checkTrue(
      "al menos una corrida responde 200",
      [carrera1, carrera2].some((r) => r.status === 200),
    );
    const exitosas = [carrera1, carrera2].filter((r) => r.status === 200);
    const creador = exitosas.find((r) => r.body?.results?.[0]?.created === 1);
    checkTrue("exactamente una corrida creó el resumen", Boolean(creador));
    const perdedora = [carrera1, carrera2].find((r) => r !== creador);
    checkTrue(
      "la otra o vio el resumen (unchanged) o chocó con la clave única (409)",
      perdedora.status === 409 ||
        perdedora.body?.results?.[0]?.unchanged === 1,
      JSON.stringify(perdedora.body),
    );
    check(
      "en la base hay UNA sola fila de resumen para D",
      await prisma.statement.count({ where: { accountId: idD } }),
      1,
    );
    const dbD = await prisma.statement.findFirst({ where: { accountId: idD } });
    check("total 2.000,00", dbD?.totalDue?.toFixed(2), "2000.00");
    check("mínimo 100,00", dbD?.minimumDue?.toFixed(2), "100.00");

    /* ── 61 resúmenes: la vista recorta y lo dice ─────────────────────────── */

    section("F: 61 resúmenes → GET /api/cards trunca y lo avisa");
    const f = await crearTarjeta(`${TAG}_F`, { closingDay: 25, dueDay: 5 });
    const idF = f.body.id;
    let gastosF = 0;
    for (let index = 0; index < 61; index += 1) {
      // Septiembre 2021 … septiembre 2026: 61 meses, un gasto de 10,00 el 10
      // de cada uno (día 10 ≤ cierre 25 → cae en el resumen de ese mes).
      const absolute = 2021 * 12 + 8 + index;
      const year = Math.floor(absolute / 12);
      const month = (absolute % 12) + 1;
      const date = `${year}-${String(month).padStart(2, "0")}-10`;
      const creado = await crearGasto({
        accountId: idF,
        amount: "10",
        date,
        categoryName: `${TAG}_CAT`,
        description: `${TAG}_F ${index}`,
      });
      if (creado.status === 201) gastosF += 1;
    }
    check("61 gastos creados (sep 2021 … sep 2026)", gastosF, 61);

    const runF = await correrResumenes(idF);
    const rF = (runF.body?.results ?? []).find((r) => r.card.id === idF);
    check("la corrida crea 61 resúmenes", rF?.created, 61);
    check("la respuesta trae 60 (tope de filas)", rF?.statements?.length, 60);

    const vistaF = await vistaTarjetas();
    check("GET /api/cards: truncated = true", vistaF.body?.truncated, true);
    const cardF = tarjetaDe(vistaF, idF);
    check("la tarjeta muestra 60 resúmenes", cardF?.statements?.length, 60);
    check(
      "el más nuevo es septiembre 2026",
      `${cardF?.statements?.[0]?.year}-${cardF?.statements?.[0]?.month}`,
      "2026-9",
    );
    check(
      "el más viejo visible es octubre 2021 (se recortó septiembre 2021)",
      `${cardF?.statements?.[59]?.year}-${cardF?.statements?.[59]?.month}`,
      "2021-10",
    );

    /* ── Tarjeta sin actividad ────────────────────────────────────────────── */

    section("E: tarjeta sin actividad");
    const runE = await correrResumenes(idE);
    check("corrida de E: 200", runE.status, 200);
    checkDeep("no aparece en results", runE.body?.results, []);
    checkDeep("no aparece en skipped", runE.body?.skipped, []);
    check("truncated = false", runE.body?.truncated, false);
    check(
      "no se creó nada",
      await prisma.statement.count({ where: { accountId: idE } }),
      0,
    );
  },
});
