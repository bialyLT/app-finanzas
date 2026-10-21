#!/usr/bin/env node
/**
 * 17-invariante-categoria · EL INVARIANTE QUE FALTABA, EN LAS TRES CAPAS DE
 * ESCRITURA (base / API de movimientos / API de categorías)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * QUÉ VERIFICA
 *
 * La regla: **el tipo de un movimiento tiene que ser el mismo que el de su
 * categoría**. Una categoría tiene UN tipo (`INCOME` o `EXPENSE`); un ingreso
 * clasificado como «Alquiler» (un gasto) es un dato que se contradice a sí
 * mismo.
 *
 * Se verifica en las tres capas que ESCRIBEN, y cada una con su propia
 * evidencia:
 *
 *   A · LA BASE (SQL directo, sin pasar por la API). Es la última palabra: si
 *       algo escribe sin pasar por la API, el dato no entra. Y el mensaje
 *       tiene que decir QUÉ se pidió y POR QUÉ se rechaza.
 *   B · LA API DE MOVIMIENTOS, con cuerpos hostiles: nunca un 500.
 *   C · LA API DE CATEGORÍAS: el tipo de una categoría EN USO es inmutable; el
 *       de una LIBRE se puede cambiar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SQL DIRECTO Y NO LA API
 *
 * Porque la API puede tener un hueco: si el 400 de la API no estuviera, el
 * mismo movimientoSEGUIRÍA entrando por la API. La prueba de que el candado
 * está en la base es escribir en la base saltándose la API: si eso entra, el
 * invariante no existe.
 *
 * Y al revés: si la base lo frena pero la API no lo avisa, la persona recibe un
 * 500 sin explicación. Por eso las dos capas se prueban por separado.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÓNDE CORRE
 *
 * Contra `finanzas_test` y la instancia de pruebas (`:3101`). NUNCA contra
 * `finanzas_dev` ni contra el `:3000` (la instancia de la persona): las dos
 * riendas las verifica `lib-fase9r3.mjs` ANTES de escribir una sola fila.
 *
 * Todo lo que crea se borra POR ID al final.
 */

import { randomUUID } from "node:crypto";
import {
  BASE,
  check,
  checkIncluye,
  checkTrue,
  correrBateria,
  get,
  post,
  postRaw,
  section,
  sql,
  sqlWrite,
} from "./lib-fase9r3.mjs";

const TAG = "T F9R3 ";

/** Las cuentas y categorías que esta batería creó (para borrarlas por id). */
const creados = { cuentas: [], categorias: [], reglas: [], movimientos: [] };

async function crearCuenta(nombre, kind = "CASH", extra = {}) {
  const res = await post("/api/accounts", {
    name: nombre,
    kind,
    openingBalance: "0",
    ...extra,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear la cuenta «${nombre}»: ${res.status} ${res.rawText}`);
  }
  creados.cuentas.push(res.body.id);
  return res.body;
}

async function crearCategoria(nombre, kind) {
  const res = await post("/api/categories", { name: nombre, kind });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear la categoría «${nombre}»: ${res.status} ${res.rawText}`);
  }
  const cat = res.body;
  if (cat?.id) creados.categorias.push(cat.id);
  return cat;
}

/** El id de una categoría por nombre normalizado (la API devuelve el DTO). */
async function idDeCategoria(nombre) {
  const res = await get("/api/categories");
  const encontrada = (res.body?.categories ?? []).find(
    (c) => c.name.toLowerCase() === nombre.toLowerCase(),
  );
  return encontrada?.id ?? null;
}

/** Limpieza: por id, nunca por `deleteMany` sin filtro. */
async function limpiar(prisma) {
  section("Limpieza (17-invariante-categoria)");
  if (creados.reglas.length) {
    await prisma.recurrenceRule.deleteMany({
      where: { id: { in: creados.reglas } },
    });
  }
  if (creados.movimientos.length) {
    await prisma.movement.deleteMany({
      where: { id: { in: creados.movimientos } },
    });
  }
  await prisma.favoriteTemplate.deleteMany({
    where: { accountId: { in: creados.cuentas } },
  });
  if (creados.cuentas.length) {
    await prisma.movement.deleteMany({
      where: {
        OR: [
          { accountId: { in: creados.cuentas } },
          { toAccountId: { in: creados.cuentas } },
        ],
      },
    });
    await prisma.account.deleteMany({ where: { id: { in: creados.cuentas } } });
  }
  if (creados.categorias.length) {
    await prisma.category.deleteMany({
      where: { id: { in: creados.categorias } },
    });
  }
  console.log("  lista");
}

await correrBateria({
  etiqueta: "17-invariante-categoria",
  limpiar,
  main: async (prisma) => {
    /* ────────────────────────────────────────────────────────────────────────
     * A · LA BASE
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · La base (SQL directo, sin pasar por la API)");

    const cuenta = await crearCuenta(`${TAG}Cuenta`);
    const gasto = await crearCategoria(`${TAG}Gasto`, "EXPENSE");
    const ingreso = await crearCategoria(`${TAG}Ingreso`, "INCOME");

    const hoy = new Date().toISOString().slice(0, 10);
    const idMov = () => randomUUID();

    const insertMovimiento = async (kind, categoryId) => {
      const id = idMov();
      const res = await sqlWrite(
        prisma,
        `INSERT INTO "Movement" ("id","kind","amount","date","description","categoryId","accountId","updatedAt")
         VALUES ($1,$2::"MovementKind",$3::numeric,$4::date,$5,$6,$7,now())`,
        [id, kind, "100.00", hoy, "T F9R3 crudo", categoryId, cuenta.id],
      );
      if (res.ok) creados.movimientos.push(id);
      return res;
    };

    // A1 · INCOME con categoría de GASTO → la base lo frena.
    const a1 = await insertMovimiento("INCOME", gasto.id);
    checkTrue("A1 · un INCOME con categoría de Gasto NO entra en la base", !a1.ok, a1.error ?? "");
    checkIncluye(
      "A1 · el mensaje trae el marcador estable del invariante",
      a1.error ?? "",
      "[finanzas:categoria_no_corresponde]",
    );
    checkIncluye(
      "A1 · el mensaje dice el tipo de la categoría (Gasto)",
      a1.error ?? "",
      "Gasto",
    );
    checkIncluye(
      "A1 · el mensaje dice el tipo pedido (Ingreso)",
      a1.error ?? "",
      "Ingreso",
    );
    checkIncluye(
      "A1 · el mensaje nombra la categoría",
      a1.error ?? "",
      gasto.name,
    );

    // A2 · EXPENSE con categoría de INGRESO → también lo frena.
    const a2 = await insertMovimiento("EXPENSE", ingreso.id);
    checkTrue("A2 · un EXPENSE con categoría de Ingreso NO entra en la base", !a2.ok, a2.error ?? "");
    checkIncluye(
      "A2 · el mensaje trae el marcador estable del invariante",
      a2.error ?? "",
      "[finanzas:categoria_no_corresponde]",
    );

    // A3 · lo coherente entra: el trigger no bloquea lo válido.
    const a3 = await insertMovimiento("INCOME", ingreso.id);
    checkTrue("A3 · un INCOME con categoría de Ingreso SÍ entra", a3.ok, a3.error ?? "");

    // A4 · UPDATE inocuo de una fila coherente: tiene que PASAR (si no, la app
    //      no puede ni editar un movimiento).
    const updateInocuo = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "description" = $2 WHERE "id" = $1`,
      [creados.movimientos.at(-1), "T F9R3 descripción nueva"],
    );
    checkTrue(
      "A4 · un UPDATE que no cambia el tipo ni la categoría PASA",
      updateInocuo.ok,
      updateInocuo.error ?? "",
    );

    // A5 · UPDATE que cambia el tipo a contradictorio → frenado.
    const a5 = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "kind" = 'EXPENSE' WHERE "id" = $1`,
      [creados.movimientos.at(-1)],
    );
    checkTrue("A5 · un UPDATE que cambia el tipo a contradictorio se frena", !a5.ok, a5.error ?? "");
    checkIncluye(
      "A5 · el mensaje trae el marcador del invariante",
      a5.error ?? "",
      "[finanzas:categoria_no_corresponde]",
    );

    // A6 · UPDATE que cambia la categoría a la del otro tipo → frenado.
    const a6 = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "categoryId" = $2 WHERE "id" = $1`,
      [creados.movimientos.at(-1), gasto.id],
    );
    checkTrue("A6 · un UPDATE que cambia a la categoría del otro tipo se frena", !a6.ok, a6.error ?? "");

    // A7 · la REGLA de recurrencia también se custodia.
    const idRegla = randomUUID();
    const a7 = await sqlWrite(
      prisma,
      `INSERT INTO "RecurrenceRule" ("id","title","kind","amount","freq","startDate","accountId","categoryId","updatedAt")
       VALUES ($1,$2,'INCOME',$3::numeric,'MONTHLY',$4::date,$5,$6,now())`,
      [idRegla, "T F9R3 regla imposible", "50.00", hoy, cuenta.id, gasto.id],
    );
    checkTrue("A7 · una regla INCOME con categoría de Gasto NO entra", !a7.ok, a7.error ?? "");
    checkIncluye(
      "A7 · el mensaje trae el marcador de la regla",
      a7.error ?? "",
      "[finanzas:regla_categoria_no_corresponde]",
    );

    // A8 · el tipo de una categoría EN USO es inmutable.
    //      (primero: un movimiento que la use, si no la categoría está LIBRE
    //      y el trigger la deja cambiar — que es lo correcto)
    const a8uso = await insertMovimiento("EXPENSE", gasto.id);
    checkTrue(
      "A8 · (andamiaje) hay un gasto con esa categoría",
      a8uso.ok,
      a8uso.error ?? "",
    );
    const a8 = await sqlWrite(
      prisma,
      `UPDATE "Category" SET "kind" = 'INCOME' WHERE "id" = $1`,
      [gasto.id],
    );
    checkTrue("A8 · el tipo de una categoría en uso NO se puede cambiar", !a8.ok, a8.error ?? "");
    checkIncluye(
      "A8 · el mensaje trae el marcador de la categoría en uso",
      a8.error ?? "",
      "[finanzas:categoria_en_uso_no_cambia_tipo]",
    );

    // A9 · el tipo de una categoría LIBRE sí se puede cambiar.
    const libre = await crearCategoria(`${TAG}Libre`, "EXPENSE");
    const a9 = await sqlWrite(
      prisma,
      `UPDATE "Category" SET "kind" = 'INCOME' WHERE "id" = $1`,
      [libre.id],
    );
    checkTrue("A9 · el tipo de una categoría LIBRE se puede cambiar", a9.ok, a9.error ?? "");
    const ahora = await prisma.category.findUnique({ where: { id: libre.id } });
    check("A9 · y el tipo quedó cambiado de verdad", ahora?.kind, "INCOME");

    // A10 · LA FILA QUE YA VIENÍA MAL (lo que promete el dev).
    //      Se apaga el trigger un momento, se inserta la fila inconsistente
    //      (como si fuera anterior al trigger), se lo vuelve a encender y se
    //      comprueba que la fila se puede actualizar y que el trigger sigue
    //      frenando lo que tiene que frenar.
    await sqlWrite(prisma, `ALTER TABLE "Movement" DISABLE TRIGGER "movement_category_kind_check"`);
    const idVieja = randomUUID();
    const a10a = await sqlWrite(
      prisma,
      `INSERT INTO "Movement" ("id","kind","amount","date","description","categoryId","accountId","updatedAt")
       VALUES ($1,'INCOME',$2::numeric,$3::date,'T F9R3 heredada',$4,$5,now())`,
      [idVieja, "77.00", hoy, gasto.id, cuenta.id],
    );
    await sqlWrite(prisma, `ALTER TABLE "Movement" ENABLE TRIGGER "movement_category_kind_check"`);
    checkTrue(
      "A10 · (andamiaje) la fila inconsistente entra con el trigger apagado",
      a10a.ok,
      a10a.error ?? "",
    );
    if (a10a.ok) creados.movimientos.push(idVieja);

    const a10b = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "description" = 'T F9R3 editada' WHERE "id" = $1`,
      [idVieja],
    );
    checkTrue(
      "A10 · la fila que ya venía mal se puede editar (no queda trancada)",
      a10b.ok,
      a10b.error ?? "",
    );

    const a10c = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "kind" = 'EXPENSE', "categoryId" = $2 WHERE "id" = $1`,
      [idVieja, ingreso.id],
    );
    checkTrue(
      "A10 · pero dejarla contradiciéndose otra vez se frena",
      !a10c.ok,
      a10c.error ?? "",
    );
    checkIncluye(
      "A10 · con el marcador del invariante",
      a10c.error ?? "",
      "[finanzas:categoria_no_corresponde]",
    );

    // A10-bis · cambiar el tipo de la fila heredada al de SU categoría la
    //           ARREGLA (no la deja contradiciéndose): eso tiene que pasar.
    const a10bis = await sqlWrite(
      prisma,
      `UPDATE "Movement" SET "kind" = 'EXPENSE' WHERE "id" = $1`,
      [idVieja],
    );
    checkTrue(
      "A10 · (bis) corregir el tipo de la fila heredada SÍ se puede",
      a10bis.ok,
      a10bis.error ?? "",
    );

    const a10d = await sqlWrite(
      prisma,
      `INSERT INTO "Movement" ("id","kind","amount","date","description","categoryId","accountId","updatedAt")
       VALUES ($1,'INCOME',$2::numeric,$3::date,'T F9R3 otra',$4,$5,now())`,
      [randomUUID(), "10.00", hoy, gasto.id, cuenta.id],
    );
    checkTrue(
      "A10 · y el trigger sigue frenando lo imposible después de la excepción",
      !a10d.ok,
      a10d.error ?? "",
    );

    /* ────────────────────────────────────────────────────────────────────────
     * B · LA API DE MOVIMIENTOS
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · La API de movimientos (cuerpos hostiles)");

    const base = {
      amount: "1000.00",
      date: hoy,
      accountId: cuenta.id,
    };

    // B1 · el cruce de tipos: 400 con el mensaje que dice qué hacer.
    const b1 = await post("/api/transactions", {
      ...base,
      kind: "INCOME",
      categoryName: gasto.name,
    });
    check("B1 · un ingreso con categoría de gasto NO se guarda", b1.status, 400);
    checkIncluye("B1 · el mensaje nombra la categoría", b1.rawText, gasto.name);
    checkIncluye("B1 · el mensaje dice el tipo de la categoría", b1.rawText, "Gasto");
    checkIncluye("B1 · el mensaje dice el tipo pedido", b1.rawText, "ingreso");

    // B2 · y al revés: gasto con categoría de ingreso.
    const b2 = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      categoryName: ingreso.name,
    });
    check("B2 · un gasto con categoría de ingreso NO se guarda", b2.status, 400);

    // B3 · categoryName null → es "sin categoría" (permitido), nunca un 500.
    const b3 = await post("/api/transactions", { ...base, kind: "EXPENSE", categoryName: null });
    checkTrue("B3 · categoryName null no es un 500", b3.status < 500, `status ${b3.status}`);
    check("B3 · categoryName null se guarda como movimiento SIN categoría", b3.status, 201);
    if (b3.body?.id) creados.movimientos.push(b3.body.id);

    // B4 · categoryName "" → también "sin categoría".
    const b4 = await post("/api/transactions", { ...base, kind: "EXPENSE", categoryName: "" });
    checkTrue("B4 · categoryName vacío no es un 500", b4.status < 500, `status ${b4.status}`);
    check("B4 · categoryName vacío se guarda", b4.status, 201);
    if (b4.body?.id) creados.movimientos.push(b4.body.id);

    // B5 · categoryName 42 → 400.
    const b5 = await post("/api/transactions", { ...base, kind: "EXPENSE", categoryName: 42 });
    check("B5 · categoryName número es un 400", b5.status, 400);

    // B6 · categoryName array → 400.
    const b6 = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      categoryName: ["a", "b"],
    });
    check("B6 · categoryName array es un 400", b6.status, 400);

    // B7 · categoryName con un NUL adentro: es un texto que Postgres no
    //      puede guardar. Tiene que ser un 4xx con mensaje, NUNCA un 500.
    const b7 = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      categoryName: `T F9R3 con \u0000 adentro`,
    });
    checkTrue(
      "B7 · un nombre con \\u0000 NO es un 500 (es un 4xx con mensaje)",
      b7.status < 500,
      `status ${b7.status} · ${String(b7.rawText).slice(0, 160)}`,
    );
    checkTrue(
      "B7 · y si no es un 500, tiene que ser un 4xx con mensaje",
      b7.status === 400 || (b7.status >= 400 && b7.status < 500 && !!b7.body?.error),
      `status ${b7.status} · cuerpo ${String(b7.rawText).slice(0, 160)}`,
    );

    // B8 · un nombre de 40 caracteres (el tope) → se guarda.
    const nombre40 = `T F9R3 ${"a".repeat(40 - "T F9R3 ".length)}`;
    const b8 = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      categoryName: nombre40,
    });
    check("B8 · un nombre de 40 caracteres se guarda", b8.status, 201);
    if (b8.body?.id) creados.movimientos.push(b8.body.id);

    // B9 · la normalización: "t f9r3 ..." en minúscula es la MISMA categoría.
    const b9 = await post("/api/transactions", {
      ...base,
      kind: "INCOME",
      categoryName: gasto.name.toLowerCase(),
    });
    check(
      "B9 · la categoría se busca por nombre normalizado (minúsculas)",
      b9.status,
      400,
    );

    // B10 · una categoría que NO existe se crea con el tipo del movimiento.
    const b10 = await post("/api/transactions", {
      ...base,
      kind: "INCOME",
      categoryName: `${TAG}Ingreso Nuevo`,
    });
    check("B10 · una categoría inexistente se crea con el tipo del movimiento", b10.status, 201);
    if (b10.body?.id) creados.movimientos.push(b10.body.id);
    const idNueva = await idDeCategoria(`${TAG}Ingreso Nuevo`);
    checkTrue("B10 · y la categoría nueva existe", !!idNueva);
    if (idNueva) creados.categorias.push(idNueva);

    // B11 · descripción con NUL: el mismo camino (la descripción también es
    //       texto que Postgres no puede guardar con un byte 0).
    const b11 = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      description: "T F9R3 con \u0000 en la nota",
    });
    checkTrue(
      "B11 · una descripción con \\u0000 NO es un 500",
      b11.status < 500,
      `status ${b11.status} · ${String(b11.rawText).slice(0, 160)}`,
    );

    // B12 · ninguno de los cuerpos hostiles devolvió un 5xx.
    const todos = [b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11];
    const con500 = todos.filter((r) => r.status >= 500);
    check(
      "B12 · ningún cuerpo hostil devolvió un 5xx",
      con500.length,
      0,
    );
    if (con500.length) {
      console.log(
        "        ",
        con500.map((r) => `${r.status} ${String(r.rawText).slice(0, 140)}`).join(" | "),
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * C · LA API DE CATEGORÍAS
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · La API de categorías");

    // C1 · una categoría con MOVIMIENTOS: el tipo no se puede cambiar.
    const conMov = await crearCategoria(`${TAG}ConMov`, "EXPENSE");
    const mov = await post("/api/transactions", {
      ...base,
      kind: "EXPENSE",
      categoryName: conMov.name,
    });
    check("C1 · (andamiaje) el gasto con esa categoría se guardó", mov.status, 201);
    if (mov.body?.id) creados.movimientos.push(mov.body.id);
    const c1 = await post("/api/categories", { name: conMov.name, kind: "INCOME" });
    check("C1 · cambiar el tipo de una categoría con movimientos es un 409", c1.status, 409);
    checkIncluye("C1 · el mensaje dice que está en uso", c1.rawText, "en uso");
    checkIncluye("C1 · el mensaje dice cuántos movimientos la usan", c1.rawText, "movimiento");

    // C2 · una categoría usada por una REGLA.
    const conRegla = await crearCategoria(`${TAG}ConRegla`, "EXPENSE");
    const regla = await post("/api/recurrence/rules", {
      title: `${TAG}Regla`,
      kind: "EXPENSE",
      amount: "100.00",
      freq: "MONTHLY",
      startDate: hoy,
      accountId: cuenta.id,
      categoryName: conRegla.name,
      postingMode: "NOTIFY",
    });
    check("C2 · (andamiaje) la regla con esa categoría se creó", regla.status, 201);
    if (regla.body?.id) creados.reglas.push(regla.body.id);
    const c2 = await post("/api/categories", { name: conRegla.name, kind: "INCOME" });
    check("C2 · cambiar el tipo de una categoría con una regla es un 409", c2.status, 409);
    checkIncluye("C2 · el mensaje dice que la usa una regla", c2.rawText, "regla");

    // C3 · una categoría usada por una PLANTILLA.
    const conPlantilla = await crearCategoria(`${TAG}ConPlantilla`, "EXPENSE");
    const plantilla = await post("/api/favorites", {
      name: `${TAG}Plantilla`,
      kind: "EXPENSE",
      amount: "500.00",
      accountId: cuenta.id,
      categoryName: conPlantilla.name,
    });
    check("C3 · (andamiaje) la plantilla con esa categoría se creó", plantilla.status, 201);
    const c3 = await post("/api/categories", { name: conPlantilla.name, kind: "INCOME" });
    check("C3 · cambiar el tipo de una categoría con una plantilla es un 409", c3.status, 409);
    checkIncluye("C3 · el mensaje dice que la usa una plantilla", c3.rawText, "plantilla");

    // C4 · una categoría LIBRE: el tipo se cambia, y de verdad.
    const libre2 = await crearCategoria(`${TAG}Libre2`, "EXPENSE");
    const c4 = await post("/api/categories", { name: libre2.name, kind: "INCOME" });
    check("C4 · una categoría libre cambia de tipo", c4.status, 200);
    const catLibre2 = await prisma.category.findUnique({ where: { id: libre2.id } });
    check("C4 · y el tipo quedó cambiado de verdad", catLibre2?.kind, "INCOME");

    // C5 · LA CARRERA: entre el chequeo de la API y el UPDATE, la categoría se
    //      vuelve a estar en uso. El trigger tiene que frenarla.
    //      Se simula escribiendo en la base (que es lo que haría la otra
    //      petición) y después pidiendo el cambio por la API.
    const carrera = await crearCategoria(`${TAG}Carrera`, "EXPENSE");
    const movCarrera = await sqlWrite(
      prisma,
      `INSERT INTO "Movement" ("id","kind","amount","date","description","categoryId","accountId","updatedAt")
       VALUES ($1,'EXPENSE',$2::numeric,$3::date,'T F9R3 carrera',$4,$5,now())`,
      [randomUUID(), "10.00", hoy, carrera.id, cuenta.id],
    );
    checkTrue("C5 · (andamiaje) la categoría quedó en uso", movCarrera.ok, movCarrera.error ?? "");
    if (movCarrera.ok) {
      const c5 = await sqlWrite(
        prisma,
        `UPDATE "Category" SET "kind" = 'INCOME' WHERE "id" = $1`,
        [carrera.id],
      );
      checkTrue(
        "C5 · el trigger frena el cambio de tipo de una categoría que recién quedó en uso",
        !c5.ok,
        c5.error ?? "",
      );
      checkIncluye(
        "C5 · el mensaje trae el marcador de la categoría en uso",
        c5.error ?? "",
        "[finanzas:categoria_en_uso_no_cambia_tipo]",
      );
    }
    const c5b = await post("/api/categories", { name: carrera.name, kind: "INCOME" });
    check("C5 · y la API también lo rechaza con un 409", c5b.status, 409);

    // C6 · el tope de 40 caracteres del nombre.
    const c6largo = await post("/api/categories", {
      name: `T F9R3 ${"b".repeat(40)}`,
      kind: "EXPENSE",
    });
    check("C6 · un nombre de más de 40 caracteres es un 400", c6largo.status, 400);
    const c6ok = await post("/api/categories", {
      name: `T F9R3 ${"c".repeat(40 - "T F9R3 ".length)}`,
      kind: "EXPENSE",
    });
    check("C6 · uno de 40 caracteres exactos se guarda", c6ok.status, 201);
    if (c6ok.body?.id) creados.categorias.push(c6ok.body.id);

    // C7 · una categoría nueva con el mismo nombre normalizado no se duplica.
    const c7 = await post("/api/categories", {
      name: `${TAG}ConMov`.toUpperCase(),
      kind: "EXPENSE",
    });
    check("C7 · el mismo nombre en mayúsculas es la misma categoría", c7.status, 200);

    /* ────────────────────────────────────────────────────────────────────────
     * D · LOS OTROS CAMINOS QUE CREAN MOVIMIENTOS
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · Los otros caminos que crean movimientos (CSV y plantillas)");

    // D1 · el CSV: una fila de INGRESO con una categoría de Gasto.
    const csv = [
      "fecha,tipo,monto,cuenta,categoria",
      `2026-08-08,INGRESO,100,${cuenta.name},${gasto.name}`,
    ].join("\r\n");
    const d1a = await post("/api/import/csv/preview", { text: csv });
    check("D1 · el preview del CSV responde 200", d1a.status, 200);
    const d1b = await post("/api/import/csv", {
      text: csv,
      expected: {
        count: d1a.body?.totals?.count ?? 0,
        income: d1a.body?.totals?.income ?? "0.00",
        expenses: d1a.body?.totals?.expenses ?? "0.00",
        transfers: d1a.body?.totals?.transfers ?? "0.00",
      },
    });
    checkTrue(
      "D1 · el commit del CSV con la categoría del otro tipo NO se guarda",
      d1b.status !== 201,
      `status ${d1b.status} · ${String(d1b.rawText).slice(0, 160)}`,
    );
    checkTrue(
      "D1 · y no es un 500",
      d1b.status < 500,
      `status ${d1b.status}`,
    );
    checkIncluye(
      "D1 · el mensaje nombra la categoría",
      d1b.rawText,
      gasto.name,
    );
    const movCsv = await prisma.movement.findFirst({
      where: { description: { startsWith: TAG }, accountId: cuenta.id, date: new Date("2026-08-08") },
    });
    checkTrue("D1 · no quedó ningún movimiento del CSV", !movCsv);

    // D2 · la plantilla: una categoría del otro tipo.
    const d2 = await post("/api/favorites", {
      name: `${TAG}Plantilla mala`,
      kind: "EXPENSE",
      amount: "100.00",
      accountId: cuenta.id,
      categoryName: ingreso.name,
    });
    check("D2 · una plantilla con la categoría del otro tipo es un 4xx", d2.status, 400);
    checkIncluye("D2 · el mensaje nombra la categoría", d2.rawText, ingreso.name);
    checkIncluye("D2 · y dice el tipo de la categoría", d2.rawText, "Ingreso");
  },
});
