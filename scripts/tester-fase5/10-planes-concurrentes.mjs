#!/usr/bin/env node
/**
 * 10 — Compras en cuotas concurrentes y creación repetida.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE PRUEBA (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * A. Dos POST idénticos (doble clic) crean DOS compras: la creación NO es
 *    idempotente, igual que POST /api/transactions. Se documenta como
 *    observación: la protección contra el doble clic es de la UI, no del
 *    servidor (no hay clave de idempotencia).
 * B. Cinco POST en paralelo con la categoría YA creada: todos 201, cinco
 *    planes distintos, cero 500. Cada plan con sus cuotas y su gasto.
 * C. Cinco POST en paralelo con una categoría NUEVA (no pre-creada): se
 *    observa la carrera del upsert de categoría. Ningún 500; si alguno choca,
 *    tiene que ser un 409 que nombre la categoría. La base queda coherente:
 *    un plan y un gasto por cada 201.
 *
 * Números a mano del escenario estable (A + B):
 *   A: 6.000 en 3 (dos veces) → 12.000 de deuda.
 *   B: 3.000 + 4.000 + 5.000 + 6.000 + 7.000 = 25.000 (cuotas de 1.000 c/u).
 *   Deuda de la tarjeta = 12.000 + 25.000 = 37.000,00.
 */

import {
  check,
  checkDeep,
  checkTrue,
  crearPlan,
  crearTarjeta,
  guardToday,
  post,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_10";
guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const tarjeta = await crearTarjeta(`${TAG}_VISA`, { closingDay: 25, dueDay: 5 });
    const cardId = tarjeta.body.id;

    const categoria = await post("/api/categories", {
      name: `${TAG}_CAT`,
      kind: "EXPENSE",
    });
    checkTrue(
      "categoría pre-creada (201/200)",
      categoria.status === 201 || categoria.status === 200,
      JSON.stringify(categoria.body),
    );

    /* ── A: doble POST idéntico ───────────────────────────────────────────── */

    section("A: dos POST idénticos (doble clic)");
    const cuerpoDoble = {
      cardId,
      label: `${TAG}_doble`,
      totalAmount: "6000",
      installments: 3,
      purchaseDate: "2026-10-16",
      categoryName: `${TAG}_CAT`,
    };
    const doble1 = await crearPlan(cuerpoDoble);
    const doble2 = await crearPlan(cuerpoDoble);
    check("primer POST: 201", doble1.status, 201);
    check("segundo POST: 201 (no hay clave de idempotencia)", doble2.status, 201);
    checkTrue(
      "son dos planes distintos",
      doble1.body?.plan?.id !== doble2.body?.plan?.id,
    );
    checkTrue(
      "y dos gastos distintos",
      doble1.body?.plan?.movement?.id !== doble2.body?.plan?.movement?.id,
    );
    consolaObservacion();

    /* ── B: cinco POST en paralelo, categoría ya creada ──────────────────── */

    section("B: cinco compras en paralelo con la categoría ya creada");
    const paralelos = [
      { label: `${TAG}_p1`, total: "3000", cuotas: 3 },
      { label: `${TAG}_p2`, total: "4000", cuotas: 4 },
      { label: `${TAG}_p3`, total: "5000", cuotas: 5 },
      { label: `${TAG}_p4`, total: "6000", cuotas: 6 },
      { label: `${TAG}_p5`, total: "7000", cuotas: 7 },
    ];
    const respuestas = await Promise.all(
      paralelos.map((p) =>
        crearPlan({
          cardId,
          label: p.label,
          totalAmount: p.total,
          installments: p.cuotas,
          purchaseDate: "2026-10-16",
          categoryName: `${TAG}_CAT`,
        }),
      ),
    );
    console.log(
      `    distribución: ${respuestas.map((r) => r.status).join(", ")}`,
    );
    checkDeep(
      "los cinco responden 201",
      respuestas.map((r) => r.status),
      [201, 201, 201, 201, 201],
    );
    check(
      "cinco planes distintos",
      new Set(respuestas.map((r) => r.body?.plan?.id)).size,
      5,
    );
    check(
      "cada uno con sus cuotas (3, 4, 5, 6, 7)",
      respuestas.map((r) => r.body?.plan?.items?.length).join(","),
      "3,4,5,6,7",
    );
    checkTrue(
      "todas las cuotas de 1.000,00",
      respuestas.every((r) =>
        (r.body?.plan?.items ?? []).every((item) => item.amount === "1000.00"),
      ),
      JSON.stringify(
        respuestas.map((r) => r.body?.plan?.items?.map((i) => i.amount)),
      ),
    );
    check(
      "cada gasto pesa el total de su plan",
      respuestas
        .map(
          (r, index) =>
            `${r.body?.plan?.movement?.amount}` ===
            `${Number(paralelos[index].total).toFixed(2)}`,
        )
        .every(Boolean),
      true,
    );

    const enBase = await prisma.cardPlan.findMany({
      where: { accountId: cardId, label: { startsWith: TAG } },
      include: { items: true },
    });
    check("en la base hay 7 planes (2 del doble + 5 del paralelo)", enBase.length, 7);
    check(
      "y 7 gastos de compra",
      await prisma.movement.count({
        where: { accountId: cardId, kind: "EXPENSE", description: { startsWith: TAG } },
      }),
      7,
    );
    checkTrue(
      "en todos, Σ cuotas == total al centavo",
      enBase.every(
        (plan) =>
          plan.items
            .reduce((total, item) => total + Number(item.amount), 0)
            .toFixed(2) === plan.totalAmount.toFixed(2),
      ),
      JSON.stringify(
        enBase.map((plan) => [
          plan.label,
          plan.items.reduce((total, item) => total + Number(item.amount), 0).toFixed(2),
          plan.totalAmount.toFixed(2),
        ]),
      ),
    );

    const vista = await vistaTarjetas();
    const card = tarjetaDe(vista, cardId);
    check("deuda del panel = 12.000 + 25.000 = 37.000,00", card?.debt, "37000.00");
    check("el panel lista los 7 planes", card?.plans?.length, 7);

    /* ── C: cinco POST en paralelo con categoría NUEVA ───────────────────── */

    section("C: cinco en paralelo con una categoría nueva (carrera del upsert)");
    const categoriaNueva = `${TAG}_CAT2`;
    const respuestas2 = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        crearPlan({
          cardId,
          label: `${TAG}_r${n}`,
          totalAmount: "1000",
          installments: 2,
          purchaseDate: "2026-10-16",
          categoryName: categoriaNueva,
        }),
      ),
    );
    console.log(
      `    distribución: ${respuestas2
        .map((r) => `${r.status}${r.status === 409 ? ` (${r.body?.error})` : ""}`)
        .join(" | ")}`,
    );
    checkDeep(
      "nunca 500: sólo 201 o 409",
      respuestas2
        .map((r) => r.status)
        .filter((status) => status !== 201 && status !== 409),
      [],
    );
    const rechazados = respuestas2.filter((r) => r.status === 409);
    checkTrue(
      "si alguno choca con la categoría, el mensaje la nombra",
      rechazados.every((r) => String(r.body?.error).toLowerCase().includes("categor")),
      JSON.stringify(rechazados.map((r) => r.body?.error)),
    );

    const creados2 = respuestas2.filter((r) => r.status === 201).length;
    const planesNuevos = await prisma.cardPlan.count({
      where: { accountId: cardId, label: { startsWith: `${TAG}_r` } },
    });
    check("un plan por cada 201", planesNuevos, creados2);
    check(
      "las categorías con ese nombre quedaron en UNA",
      await prisma.category.count({
        where: { normalizedName: categoriaNueva.toLowerCase() },
      }),
      1,
    );

    const vista2 = await vistaTarjetas();
    const card2 = tarjetaDe(vista2, cardId);
    const deudaEsperada = (37000 + creados2 * 1000).toFixed(2);
    check(
      `la deuda refleja exactamente los planes creados (${deudaEsperada})`,
      card2?.debt,
      deudaEsperada,
    );
    const sumaGastos = await prisma.movement.aggregate({
      where: { accountId: cardId, kind: "EXPENSE" },
      _sum: { amount: true },
    });
    check(
      "y coincide con Σ gastos de la tarjeta (sin transferencias de por medio)",
      card2?.debt,
      sumaGastos._sum.amount?.toFixed(2),
    );
  },
});

/** Deja constancia de la observación de diseño (no es una falla). */
function consolaObservacion() {
  console.log(
    "    observación: POST /api/cards/plans no es idempotente (sin clave de idempotencia);",
  );
  console.log(
    "    dos envíos idénticos crean dos compras — la defensa del doble clic es de la UI.",
  );
}
