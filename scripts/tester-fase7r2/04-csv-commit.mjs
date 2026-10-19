#!/usr/bin/env node
/**
 * 04 · COMMIT CSV — ataque API a `POST /api/import/csv` (el que ESCRIBE).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque C: importación CSV)
 * ─────────────────────────────────────────────────────────────────────────────
 * El commit recalcula el preview, compara contra el resumen aprobado, escribe
 * TODO O NADA en una transacción y concilia al centavo contra la base.
 *
 *   1. AUTENTICACIÓN / CSRF / CUERPO: 401 sin cookie; 403 sin Origin o con
 *      Origin ajeno; 400 para JSON roto, texto ausente/no-texto/vacío/NUL,
 *      `expected` ausente/inválido (count no entero o > 500, totales no string
 *      o negativos); 413 por content-length; 422 sin filas de datos o cuando
 *      todas son vacías/duplicadas.
 *   2. CAMINO FELIZ: preview → commit (201) con 3 filas (ingreso con monto
 *      "10,00", gasto a categoría nueva, transferencia) → el resultado declara
 *      importadas/saltadas/totales/categorías, y la BASE leída de vuelta tiene
 *      exactamente esas 3 filas con montos, fechas, cuentas y categoría.
 *   3. `expected` OBSOLETO: count o total desfasados → 409 y NADA escrito.
 *   4. ESTADO CAMBIADO: un duplicado nace en la base entre preview y commit →
 *      el commit con el resumen viejo da 409 (y no escribe); con resumen fresco
 *      importa SÓLO la fila nueva y salta la duplicada.
 *   5. REIMPORTAR el mismo archivo → 422 y nada nuevo.
 *   6. CATEGORÍAS: se crea exactamente la planificada (una sola vez, aunque el
 *      archivo la mencione en dos filas idénticas); NO se crea si la
 *      importación falla (422/409); categoría existente del tipo contrario →
 *      422 con explicación, sin escribir ni tocar la categoría.
 *   7. CARRERA DE DOBLE SUBMIT (paralelo): dos commits simultáneos del mismo
 *      archivo. Invariante: exactamente uno gana (201) y el otro es 409/422;
 *      la base queda con UNA copia de cada fila, nunca dos.
 *   8. EL TEXTO CAMBIÓ entre preview y commit → 409 y nada del archivo nuevo.
 *   9. PURO DUPLICADO contra la base → 422.
 *
 * Datos propios (prefijo T_T7R2_IMP). Nada de fechas de hoy (2027-03..08).
 */

import {
  BASE_URL,
  PASSWORD,
  check,
  checkDeep,
  checkIncluye,
  checkSin500,
  checkTrue,
  login,
  post,
  postRaw,
  runScript,
  section,
} from "./lib.mjs";

const TAG = "T_T7R2_IMP";
const BANCO = `${TAG} Banco`;
const EFECTIVO = `${TAG} Efectivo`;
const H7 = "fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion";

/** Cita una celda cuando trae coma, comilla o salto (CSV bien formado). */
const celda = (v) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const fila = (...cells) => cells.map(celda).join(",");

/**
 * Clave de deduplicación de categorías, calcada de `normalizeCategoryName`
 * (lib/finance.ts): la app resuelve por `Category.normalizedName`.
 */
const clave = (name) =>
  name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const EXPECTED_CERO = { count: 0, income: "0.00", expenses: "0.00", transfers: "0.00" };

const preview = (text) => post("/api/import/csv/preview", { text });
const commit = (text, expected) => post("/api/import/csv", { text, expected });

/** Movimientos propios por prefijo de descripción, con su categoría. */
const movsDe = (prisma, prefijo) =>
  prisma.movement.findMany({
    where: { description: { startsWith: prefijo } },
    include: { category: true },
    orderBy: { date: "asc" },
  });

/** POST crudo (cookie/Origin a mano) que devuelve `{status, body}` parseado. */
async function crudo(path, { cookie, origin, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Cookie a mano para atacar la capa CSRF (misma técnica que 02). */
async function sesionCruda() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((raw) => raw.split(";")[0])
    .find((pair) => pair.startsWith("finanzas_session="));
  return cookie ?? "";
}

runScript({
  tag: TAG,
  main: async (prisma) => {
    const todas = [];
    const cuentas = {};

    section("Preparación — cuentas propias");
    cuentas.banco = await prisma.account.create({ data: { name: BANCO, kind: "BANK" } });
    cuentas.efectivo = await prisma.account.create({ data: { name: EFECTIVO, kind: "CASH" } });

    /* ── 1. Autenticación, CSRF y validación del cuerpo ─────────────────── */
    section("1 · Autenticación, CSRF y validación del cuerpo");
    {
      const cuerpoMin = JSON.stringify({ text: `${H7}\n`, expected: null });

      const sinCookie = await crudo("/api/import/csv", { origin: BASE_URL, body: cuerpoMin });
      todas.push(sinCookie);
      check("POST sin cookie → 401", sinCookie.status, 401);

      const cookie = await sesionCruda();
      checkTrue("hay cookie cruda de sesión", cookie.startsWith("finanzas_session="));

      const sinOrigin = await crudo("/api/import/csv", { cookie, body: cuerpoMin });
      todas.push(sinOrigin);
      check("POST con cookie y SIN Origin → 403 (falla cerrado)", sinOrigin.status, 403);

      const origenAjeno = await crudo("/api/import/csv", {
        cookie,
        origin: "https://evil.example",
        body: cuerpoMin,
      });
      todas.push(origenAjeno);
      check("POST con Origin de otro host → 403", origenAjeno.status, 403);

      await login();

      let r = await postRaw("/api/import/csv", "no-json{");
      todas.push(r);
      check("cuerpo no-JSON → 400", r.status, 400);
      checkIncluye("dice que no es JSON", r.body?.error, "no es JSON válido");

      r = await postRaw("/api/import/csv", "[1,2]");
      todas.push(r);
      check("cuerpo array → 400", r.status, 400);
      checkIncluye("pide un objeto JSON", r.body?.error, "objeto JSON");

      r = await post("/api/import/csv", { expected: null });
      todas.push(r);
      check("sin texto → 400", r.status, 400);
      checkIncluye("nombra el texto", r.body?.error, "Falta el texto");

      r = await post("/api/import/csv", { text: 123, expected: null });
      todas.push(r);
      check("texto no-string → 400", r.status, 400);

      r = await post("/api/import/csv", { text: "   ", expected: null });
      todas.push(r);
      check("texto vacío → 400", r.status, 400);
      checkIncluye("dice vacío", r.body?.error, "vacío");

      r = await post("/api/import/csv", { text: `${H7}\n\u0000`, expected: null });
      todas.push(r);
      check("NUL → 400", r.status, 400);
      checkIncluye("dice NUL", r.body?.error, "NUL");

      r = await post("/api/import/csv", { text: "x".repeat(340 * 1024), expected: null });
      todas.push(r);
      check("cuerpo > 320 KB → 413 por content-length", r.status, 413);
      checkIncluye("dice el máximo en KB", r.body?.error, "KB");

      r = await post("/api/import/csv", { text: `${H7}\n` });
      todas.push(r);
      check("sin resumen del preview → 400", r.status, 400);
      checkIncluye("pide re-previsualizar", r.body?.error, "resumen del preview");

      const conTexto = `${H7}\n${fila("2027-09-01", "gasto", "1,00", BANCO)}`;
      r = await commit(conTexto, { ...EXPECTED_CERO, count: 501 });
      todas.push(r);
      check("count 501 → 400", r.status, 400);
      checkIncluye("dice cantidad inválida", r.body?.error, "cantidad del preview");

      r = await commit(conTexto, { ...EXPECTED_CERO, count: 2.5 });
      todas.push(r);
      check("count 2.5 → 400", r.status, 400);

      r = await commit(conTexto, { ...EXPECTED_CERO, income: 2 });
      todas.push(r);
      check("total numérico → 400", r.status, 400);
      checkIncluye("dice totales inválidos", r.body?.error, "totales del preview");

      r = await commit(conTexto, { ...EXPECTED_CERO, income: "-1.00" });
      todas.push(r);
      check("total negativo → 400", r.status, 400);

      r = await commit(conTexto, ["no", "objeto"]);
      todas.push(r);
      check("resumen array → 400", r.status, 400);

      r = await commit(`${H7}\n`, EXPECTED_CERO);
      todas.push(r);
      check("CSV sólo encabezado → 422", r.status, 422);
      checkIncluye("dice que no hay filas de datos", r.body?.error, "filas de datos");

      r = await commit(`${H7}\n,,,`, EXPECTED_CERO);
      todas.push(r);
      check("CSV de filas vacías → 422", r.status, 422);
      checkIncluye("dice duplicadas o vacías", r.body?.error, "duplicadas o vacías");

      checkSin500("ningún error de validación fue 5xx", todas);
    }

    /* ── 2. Camino feliz + lectura de vuelta ────────────────────────────── */
    section("2 · Camino feliz: 3 filas y lectura de vuelta de la base");
    {
      const texto = [
        H7,
        fila("2027-03-01", "ingreso", "10,00", EFECTIVO, "", "", `${TAG} feliz 1`),
        fila("2027-03-02", "gasto", "25,50", BANCO, "", `${TAG} CatFeliz`, `${TAG} feliz 2`),
        fila("2027-03-03", "transferencia", "5,00", BANCO, EFECTIVO, "", `${TAG} feliz 3`),
      ].join("\n");

      const p = await preview(texto);
      todas.push(p);
      check("el preview ve 3 importables", p.body?.importableRows, 3);
      checkDeep("y planifica exactamente la categoría nueva", p.body?.categoriesToCreate, [
        { name: `${TAG} CatFeliz`, kind: "EXPENSE" },
      ]);
      const expected = p.body?.totals;
      checkDeep("totales del preview: 10.00 / 25.50 / 5.00 / 3", expected, {
        income: "10.00",
        expenses: "25.50",
        transfers: "5.00",
        count: 3,
      });

      const r = await commit(texto, expected);
      todas.push(r);
      check("commit → 201", r.status, 201);
      check("imported 3", r.body?.imported, 3);
      check("skippedDuplicates 0", r.body?.skippedDuplicates, 0);
      checkDeep("los totales conciliados vuelven tal cual", r.body?.totals, expected);
      checkDeep("categorías creadas tal cual", r.body?.categoriesCreated, [
        { name: `${TAG} CatFeliz`, kind: "EXPENSE" },
      ]);

      const movs = await movsDe(prisma, `${TAG} feliz`);
      check("la base tiene exactamente 3 filas", movs.length, 3);
      const porDesc = new Map(movs.map((m) => [m.description, m]));

      const f1 = porDesc.get(`${TAG} feliz 1`);
      check("feliz 1: es ingreso", f1?.kind, "INCOME");
      check("feliz 1: 10.00", f1?.amount.toFixed(2), "10.00");
      check("feliz 1: fecha 2027-03-01", f1?.date.toISOString().slice(0, 10), "2027-03-01");
      check("feliz 1: entra a Efectivo", f1?.accountId, cuentas.efectivo.id);

      const f2 = porDesc.get(`${TAG} feliz 2`);
      check("feliz 2: es gasto", f2?.kind, "EXPENSE");
      check("feliz 2: 25.50", f2?.amount.toFixed(2), "25.50");
      check("feliz 2: fecha 2027-03-02", f2?.date.toISOString().slice(0, 10), "2027-03-02");
      check("feliz 2: sale de Banco", f2?.accountId, cuentas.banco.id);
      check("feliz 2: categoría resuelta", f2?.category?.name, `${TAG} CatFeliz`);

      const f3 = porDesc.get(`${TAG} feliz 3`);
      check("feliz 3: es transferencia", f3?.kind, "TRANSFER");
      check("feliz 3: 5.00", f3?.amount.toFixed(2), "5.00");
      check("feliz 3: Banco → Efectivo", `${f3?.accountId}|${f3?.toAccountId}`, `${cuentas.banco.id}|${cuentas.efectivo.id}`);

      const catCreadas = await prisma.category.count({
        where: { normalizedName: clave(`${TAG} CatFeliz`) },
      });
      check("la categoría quedó creda una sola vez", catCreadas, 1);
    }

    /* ── 3. `expected` obsoleto → 409 y nada escrito ─────────────────────── */
    section("3 · `expected` obsoleto → 409 y NADA escrito");
    {
      const texto = `${H7}\n${fila("2027-04-01", "gasto", "12,34", BANCO, "", "", `${TAG} stale`)}`;
      const p = await preview(texto);
      const expected = p.body?.totals;
      checkDeep("preview base: 12.34 · 1", expected, {
        income: "0.00",
        expenses: "12.34",
        transfers: "0.00",
        count: 1,
      });

      let r = await commit(texto, { ...expected, count: expected.count + 1 });
      todas.push(r);
      check("count desfasado → 409", r.status, 409);
      checkIncluye("pide re-previsualizar", r.body?.error, "vista previa no coincide");

      r = await commit(texto, { ...expected, expenses: "12.35" });
      todas.push(r);
      check("total desfasado al centavo → 409", r.status, 409);

      check("nada escrito tras los 409", (await movsDe(prisma, `${TAG} stale`)).length, 0);

      r = await commit(texto, expected);
      todas.push(r);
      check("con el resumen correcto → 201", r.status, 201);
      check("y recién ahí la fila existe", (await movsDe(prisma, `${TAG} stale`)).length, 1);
    }

    /* ── 4. Estado cambiado: duplicado nacido en la base ─────────────────── */
    section("4 · Duplicado nace en la base entre preview y commit");
    {
      const texto = [
        H7,
        fila("2027-05-01", "gasto", "1,00", BANCO, "", "", `${TAG} dup A`),
        fila("2027-05-02", "gasto", "2,00", BANCO, "", "", `${TAG} dup B`),
      ].join("\n");

      const p = await preview(texto);
      const expected = p.body?.totals;
      checkDeep("preview: 2 importables", expected, {
        income: "0.00",
        expenses: "3.00",
        transfers: "0.00",
        count: 2,
      });

      await prisma.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "1.00",
          date: new Date("2027-05-01T00:00:00.000Z"),
          description: `${TAG} dup A`,
          accountId: cuentas.banco.id,
        },
      });

      let r = await commit(texto, expected);
      todas.push(r);
      check("commit con el resumen viejo → 409", r.status, 409);
      checkIncluye("avisa que la vista previa no coincide", r.body?.error, "vista previa no coincide");
      check("la fila B todavía no existe", (await movsDe(prisma, `${TAG} dup B`)).length, 0);

      const p2 = await preview(texto);
      check("preview fresco: 1 importable", p2.body?.importableRows, 1);
      check("preview fresco: 1 duplicada", p2.body?.duplicateRows, 1);

      r = await commit(texto, p2.body?.totals);
      todas.push(r);
      check("commit con resumen fresco → 201", r.status, 201);
      check("importa sólo 1", r.body?.imported, 1);
      check("salta la duplicada", r.body?.skippedDuplicates, 1);
      check("la A manual sigue habiendo UNA", (await movsDe(prisma, `${TAG} dup A`)).length, 1);
      check("la B existe UNA", (await movsDe(prisma, `${TAG} dup B`)).length, 1);
    }

    /* ── 5. Reimportar el mismo archivo ─────────────────────────────────── */
    section("5 · Reimportar el mismo archivo → 422");
    {
      const texto = [
        H7,
        fila("2027-05-01", "gasto", "1,00", BANCO, "", "", `${TAG} dup A`),
        fila("2027-05-02", "gasto", "2,00", BANCO, "", "", `${TAG} dup B`),
      ].join("\n");
      const r = await commit(texto, EXPECTED_CERO);
      todas.push(r);
      check("reimport completo → 422", r.status, 422);
      checkIncluye("dice que no hay filas nuevas", r.body?.error, "duplicadas o vacías");
      check("A sigue única", (await movsDe(prisma, `${TAG} dup A`)).length, 1);
      check("B sigue única", (await movsDe(prisma, `${TAG} dup B`)).length, 1);
    }

    /* ── 6. Categorías: sólo las de filas válidas, una sola vez ──────────── */
    section("6 · Categorías: crear, no duplicar, no crear si falla");
    {
      const par = [
        H7,
        fila("2027-06-01", "gasto", "7,00", BANCO, "", `${TAG} CatPar`, `${TAG} par 1`),
        fila("2027-06-01", "gasto", "7,00", BANCO, "", `${TAG} CatPar`, `${TAG} par 1`),
      ].join("\n");
      const p = await preview(par);
      check("par idéntico: 1 importable", p.body?.importableRows, 1);
      check("par idéntico: 1 duplicada en archivo", p.body?.duplicateRows, 1);
      const r = await commit(par, p.body?.totals);
      todas.push(r);
      check("par idéntico → 201", r.status, 201);
      check("importa 1, salta 1", `${r.body?.imported}|${r.body?.skippedDuplicates}`, "1|1");
      check(
        "la categoría par nació UNA vez",
        await prisma.category.count({ where: { normalizedName: clave(`${TAG} CatPar`) } }),
        1,
      );
      check("y hay UN movimiento par", (await movsDe(prisma, `${TAG} par`)).length, 1);

      const invalida = [
        H7,
        fila("2027-06-02", "gasto", "1e5", BANCO, "", `${TAG} CatNo`, `${TAG} novalida`),
      ].join("\n");
      const pI = await preview(invalida);
      const rI = await commit(invalida, pI.body?.totals);
      todas.push(rI);
      check("archivo con fila inválida → 422", rI.status, 422);
      checkIncluye("dice que corrija el archivo", rI.body?.error, "Corregí el archivo");
      check(
        "la categoría de la fila inválida NO se creó",
        await prisma.category.count({ where: { normalizedName: clave(`${TAG} CatNo`) } }),
        0,
      );
      check("y no hay movimiento suyo", (await movsDe(prisma, `${TAG} novalida`)).length, 0);

      const stale = `${H7}\n${fila("2027-06-03", "gasto", "9,00", BANCO, "", `${TAG} CatC`, `${TAG} catstale`)}`;
      const pS = await preview(stale);
      const rS = await commit(stale, { ...pS.body?.totals, count: pS.body?.totals.count + 1 });
      todas.push(rS);
      check("commit con resumen desfasado → 409", rS.status, 409);
      check(
        "y la categoría planificada NO nace",
        await prisma.category.count({ where: { normalizedName: clave(`${TAG} CatC`) } }),
        0,
      );
      check("ni el movimiento", (await movsDe(prisma, `${TAG} catstale`)).length, 0);

      await prisma.category.create({
        data: {
          name: `${TAG} CatIng`,
          normalizedName: clave(`${TAG} CatIng`),
          kind: "INCOME",
        },
      });
      const conflicto = `${H7}\n${fila("2027-06-04", "gasto", "5,00", BANCO, "", `${TAG} CatIng`, `${TAG} conflicto`)}`;
      const rC = await commit(conflicto, EXPECTED_CERO);
      todas.push(rC);
      check("categoría de ingreso en fila de gasto → 422", rC.status, 422);
      checkIncluye("explica los tipos", rC.body?.error, "es de ingreso");
      check("nada escrito", (await movsDe(prisma, `${TAG} conflicto`)).length, 0);
      const catIng = await prisma.category.findFirst({
        where: { normalizedName: clave(`${TAG} CatIng`) },
      });
      check("la categoría existente no cambió de tipo", catIng?.kind, "INCOME");
    }

    /* ── 7. Carrera de doble submit (paralelo) ──────────────────────────── */
    section("7 · Carrera de doble submit: dos commits a la vez");
    {
      let dobles = 0;
      let sinGanador = 0;
      let raros = 0;

      for (let i = 0; i < 6; i += 1) {
        const d1 = String(1 + i * 2).padStart(2, "0");
        const d2 = String(2 + i * 2).padStart(2, "0");
        const texto = [
          H7,
          fila(`2027-07-${d1}`, "gasto", "1,00", BANCO, "", "", `${TAG} race ${i} a`),
          fila(`2027-07-${d2}`, "gasto", "2,00", BANCO, "", "", `${TAG} race ${i} b`),
        ].join("\n");

        const p = await preview(texto);
        const expected = p.body?.totals;
        const [a, b] = await Promise.all([commit(texto, expected), commit(texto, expected)]);
        todas.push(a, b);

        const gano201 = [a, b].filter((r) => r.status === 201).length;
        if (gano201 !== 1) sinGanador += 1;
        if ([a, b].some((r) => ![201, 409, 422].includes(r.status))) raros += 1;

        const n = await prisma.movement.count({
          where: { description: { startsWith: `${TAG} race ${i} ` } },
        });
        if (n !== 2) dobles += 1;

        console.log(
          `  · par ${i}: estados [${a.status}, ${b.status}] · movimientos en base ${n} (esperado 2)`,
        );
      }

      check("ninguna pareja duplicó la importación", dobles, 0);
      check("cada pareja tuvo exactamente un 201", sinGanador, 0);
      check("ningún estado fuera de 201/409/422", raros, 0);
      check(
        "total de filas de carrera: 12",
        await prisma.movement.count({ where: { description: { startsWith: `${TAG} race` } } }),
        12,
      );
    }

    /* ── 8. El texto cambió entre preview y commit ──────────────────────── */
    section("8 · Cambiar el texto entre preview y commit → 409");
    {
      const textoA = `${H7}\n${fila("2027-08-01", "gasto", "3,00", BANCO, "", "", `${TAG} orig`)}`;
      const textoB = `${H7}\n${fila("2027-08-02", "gasto", "4,00", BANCO, "", "", `${TAG} otro`)}`;

      const p = await preview(textoA);
      let r = await commit(textoB, p.body?.totals);
      todas.push(r);
      check("commit de otro texto → 409", r.status, 409);
      checkIncluye("avisa del cambio", r.body?.error, "vista previa no coincide");
      check("nada del A", (await movsDe(prisma, `${TAG} orig`)).length, 0);
      check("nada del B", (await movsDe(prisma, `${TAG} otro`)).length, 0);

      const pB = await preview(textoB);
      r = await commit(textoB, pB.body?.totals);
      todas.push(r);
      check("con su propio resumen → 201", r.status, 201);
      check("y ahora sí existe B", (await movsDe(prisma, `${TAG} otro`)).length, 1);
    }

    /* ── 9. Puro duplicado contra la base ───────────────────────────────── */
    section("9 · Archivo que es puro duplicado → 422");
    {
      const texto = `${H7}\n${fila("2027-05-01", "gasto", "1,00", BANCO, "", "", `${TAG} dup A`)}`;
      const p = await preview(texto);
      check("preview: 0 importables", p.body?.importableRows, 0);
      check("preview: 1 duplicada", p.body?.duplicateRows, 1);

      const r = await commit(texto, p.body?.totals);
      todas.push(r);
      check("commit → 422", r.status, 422);
      checkIncluye("dice duplicadas o vacías", r.body?.error, "duplicadas o vacías");
      check("A sigue única", (await movsDe(prisma, `${TAG} dup A`)).length, 1);
    }

    /* ── 10. Ninguna 5xx en toda la batería ─────────────────────────────── */
    section("10 · Ninguna respuesta 5xx en toda la batería");
    checkSin500("sin 5xx en el commit", todas);
  },
});
