#!/usr/bin/env node
/**
 * 03 · EL MONTO — interpretación, sanitización y los bordes que mienten
 * (brief, ataque I — lado servidor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * `parseMoneyInput` (lib/money.ts) es el MISMO parser del POST, del chequeo de
 * duplicados y de la vista previa del formulario. Sus reglas son explícitas
 * (comentario de la función): con los dos separadores manda el ÚLTIMO; con sólo
 * comas la última es decimal; un punto solo es de miles si el patrón completo
 * "1.234.567" se respeta; se ignoran espacios, símbolos de moneda y letras.
 *
 * Esta suite ataca el contrato contra la API real:
 *
 *   1. Formatos válidos: argentino ("1.500,50"), inverso ("1,500.50"), pelado
 *      ("1500"), centavos ("0,01"), grande ("12.345.678,90"), símbolo ($),
 *      espacios, y un `number` de cliente hecho a mano.
 *   2. Las consecuencias DOCUMENTADAS de "se ignoran letras": "12abc34" → 1234
 *      y "1e3" → 13 (la 'e' no es un separador: se saca). No es un bug —la
 *      vista previa de la interfaz muestra lo mismo mientras se tipea—, pero
 *      queda PINNEADO para que un cambio de regla no pase de callado.
 *   3. Montos que NO van: letras solas, vacío, espacios, signos solos, cero,
 *      negativos, NaN/Infinity (string y number), arrays y objetos.
 *   4. La traducción de los bordes de la BASE: "0,001" redondea a 0,00 y el
 *      CHECK `movement_amount_positive` tiene que salir 400 EXPLICADO; un monto
 *      de 20 dígitos desborda `NUMERIC(18,2)` y tiene que salir 400 "demasiado
 *      grande" — nunca el 500 genérico.
 *   5. Redondeo del tercer decimal: "1234.567" → 1234,57 (toFixed(2) del
 *      Decimal, half-up), y queda guardado como se ve.
 *
 * Escenario en 2028-04 (lejos del seed). Limpieza antes y después.
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  PrismaClient,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_MONTO";
const DIA = "2028-04-10";

runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Preparación");
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "1000000");
    check("el banco responde 201", banco.status, 201);

    const base = (extra) => ({
      kind: "EXPENSE",
      date: DIA,
      accountId: banco.body?.id,
      description: `${TAG}_${extra}`,
      ...(extra ? {} : {}),
    });

    /* ─────────────────────────────────────────────────────────────────────────
     * 1. Formatos válidos: el número guardado es el que se quiso escribir
     * ───────────────────────────────────────────────────────────────────────── */
    section("Formatos válidos (el monto guardado, exacto)");
    const validos = [
      ["1.500,50", "1500.50", "argentino completo"],
      ["1,500.50", "1500.50", "inverso (punto decimal)"],
      ["1500", "1500.00", "pelado"],
      ["0,01", "0.01", "un centavo"],
      ["12.345.678,90", "12345678.90", "monto grande"],
      ["1.234", "1234.00", "punto de miles solo"],
      ["$ 1.500,50", "1500.50", "símbolo de moneda"],
      ["  1.500,50  ", "1500.50", "espacios alrededor"],
      ["100 50", "10050.00", "espacio interno (documentado: se ignora)"],
      ["+100", "100.00", "signo más (positivo)"],
      [1500.5, "1500.50", "number de un cliente hecho a mano"],
      [0.05, "0.05", "number con centavos"],
    ];

    for (const [entrada, esperado, nombre] of validos) {
      const res = await crearMovimiento({
        ...base("Valido"),
        amount: entrada,
      });
      check(`"${entrada}" (${nombre}): 201`, res.status, 201);
      check(`"${entrada}" → se guarda como ${esperado}`, res.body?.amount, esperado);
    }

    /* ─────────────────────────────────────────────────────────────────────────
     * 2. Las consecuencias documentadas de "se ignoran letras"
     * ───────────────────────────────────────────────────────────────────────── */
    section("Letras ignoradas (documentado, queda pinneado)");
    const letras = [
      ["12abc34", "1234.00", '"12abc34" → 1234 (las letras no separan)'],
      ["1e3", "13.00", '"1e3" → 13 (la e se saca, quedan 1 y 3)'],
      ["USD 250,75", "250.75", '"USD 250,75" → 250,75 (símbolos de moneda)'],
    ];
    for (const [entrada, esperado, nombre] of letras) {
      const res = await crearMovimiento({ ...base("Letras"), amount: entrada });
      check(`${nombre}: 201`, res.status, 201);
      check(`${nombre}: guardado ${esperado}`, res.body?.amount, esperado);
    }
    // La contracara en la vista previa del formulario: `formatAmountInput`
    // replica la MISMA limpieza, así que lo que se ve al tipear coincide con lo
    // que se guarda (la verificación de punta a punta vive en ui-07).

    /* ─────────────────────────────────────────────────────────────────────────
     * 3. Montos que NO van: 400 explicado, nunca 500
     * ───────────────────────────────────────────────────────────────────────── */
    section("Montos inválidos (todos 400 con mensaje, nunca 500)");
    const invalidos = [
      ["abc", "letras solas"],
      ["", "vacío"],
      [" ", "un espacio"],
      ["-", "signo menos solo"],
      ["+", "signo más solo"],
      [".", "punto solo"],
      [",", "coma sola"],
      ["-100", "negativo"],
      ["-0,01", "negativo con centavos"],
      ["0", "cero"],
      ["0,00", "cero con centavos"],
      ["Infinity", "Infinity string"],
      ["NaN", "NaN string"],
      [NaN, "NaN number"],
      [Infinity, "Infinity number"],
      [-5, "negativo number"],
      [[], "array"],
      [{}, "objeto"],
      [true, "booleano"],
      [null, "null"],
      ["1.000,00.000", "separadores mal puestos"],
    ];

    const resultados = [];
    for (const [entrada, nombre] of invalidos) {
      const res = await crearMovimiento({ ...base("Invalido"), amount: entrada });
      resultados.push({ nombre, status: res.status, error: res.body?.error });
    }
    checkTrue(
      "los 21 inválidos son 400 (ninguna 5xx)",
      resultados.every((r) => r.status === 400),
      JSON.stringify(resultados.filter((r) => r.status !== 400).map((r) => `${r.nombre}:${r.status}`)),
    );
    checkTrue(
      "y todos traen un mensaje que se entiende",
      resultados.every((r) => typeof r.error === "string" && r.error.length > 0),
      JSON.stringify(resultados.filter((r) => !r.error).map((r) => r.nombre)),
    );
    // El caso "1.000,00.000" (medido: 400): el último separador es el punto
    // (decimal) y la coma se toma de miles y se quita, pero el punto de "1.000"
    // queda en el medio → "1.00000.000" tiene DOS puntos y el postcheck
    // estricto de `parseMoneyInput` (lib/money.ts, `^[+-]?\d*\.?\d*$`) lo
    // rechaza en vez de adivinar. Se pinnea para que el día que cambie, se vea.
    console.log(
      `  ·  "1.000,00.000" → ${resultados.at(-1).status} ` +
        `(${resultados.at(-1).status === 201 ? "el último punto manda: 100000,00" : resultados.at(-1).error})`,
    );

    /* ─────────────────────────────────────────────────────────────────────────
     * 4. Los bordes de la BASE: el CHECK del positivo y el overflow de NUMERIC
     * ───────────────────────────────────────────────────────────────────────── */
    section("Los bordes de la base, traducidos");
    const subCentavo = await crearMovimiento({ ...base("SubCentavo"), amount: "0,001" });
    check("0,001 redondea a 0,00 y el CHECK lo frena: 400", subCentavo.status, 400);
    checkTrue(
      "con el mensaje del monto (no un 500 de integridad)",
      /monto/i.test(String(subCentavo.body?.error ?? "")),
      JSON.stringify(subCentavo.body?.error),
    );

    const desborde = await crearMovimiento({
      ...base("Desborde"),
      amount: "9".repeat(20),
    });
    check("20 dígitos desbordan NUMERIC(18,2): 400", desborde.status, 400);
    checkTrue(
      "con el mensaje de 'demasiado grande' (regla del 22003, no un 500)",
      /demasiado grande/i.test(String(desborde.body?.error ?? "")),
      JSON.stringify(desborde.body?.error),
    );

    /* ─────────────────────────────────────────────────────────────────────────
     * 5. El redondeo del tercer decimal que SÍ entra
     * ───────────────────────────────────────────────────────────────────────── */
    section("Tercer decimal que entra");
    const tercero = await crearMovimiento({ ...base("Tercero"), amount: "1234.567" });
    check("1234.567 (sin patrón de miles): 201", tercero.status, 201);
    check("y se guarda redondeado a 1234,57", tercero.body?.amount, "1234.57");

    /* ─────────────────────────────────────────────────────────────────────────
     * 6. Lo guardado es lo que cuenta: releer de la base
     * ───────────────────────────────────────────────────────────────────────── */
    section("Relectura de la base");
    const guardados = await prisma.movement.findMany({
      where: { description: { startsWith: `${TAG}_Valido` } },
      select: { amount: true },
      orderBy: { createdAt: "asc" },
    });
    check("quedaron exactamente los 12 válidos", guardados.length, 12);
    checkTrue(
      "y ningún Decimal perdió precisión al releer (los valores son los esperados)",
      guardados.map((m) => m.amount.toFixed(2)).join(",") ===
        ["1500.50", "1500.50", "1500.00", "0.01", "12345678.90", "1234.00", "1500.50", "1500.50", "10050.00", "100.00", "1500.50", "0.05"].join(","),
      JSON.stringify(guardados.map((m) => m.amount.toFixed(2))),
    );
  },
});
