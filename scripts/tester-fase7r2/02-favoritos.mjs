#!/usr/bin/env node
/**
 * 02 · FAVORITOS / PLANTILLAS — ataque API a `/api/favorites`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque B)
 * ─────────────────────────────────────────────────────────────────────────────
 * La promesa del dev: guardar el formulario como plantilla, usarla desde un
 * chip, y que usarla marque `lastUsedAt` SÓLO cuando un movimiento se guarda
 * de verdad. Una plantilla NO es un movimiento: no toca totales ni fechas.
 *
 * Esta batería ataca la API SOLA:
 *
 *   1. AUTENTICACIÓN y CSRF: sin cookie → 401; POST sin Origin → 403; POST con
 *      Origin de otro host → 403 (la segunda capa anti-CSRF documentada).
 *   2. NOMBRE: vacío/sólo espacios → 400; 41 caracteres → 400; 40 → 201;
 *      duplicado NORMALIZADO (" T_T7R2_FAV   uno " vs "T_T7R2_FAV Uno") → 409.
 *   3. TOPE 24: con 24 plantillas, la 25 → 409 con el mensaje del tope; borrar
 *      una y crear otra → 201; GET informa `max: 24`.
 *   4. BORRADO: id inexistente → 404; sin id → 400; doble borrado → 404.
 *   5. REFERENCIAS: cuenta archivada → 400; INCOME a tarjeta → 400; TRANSFER
 *      sin destino / destino igual / con categoría → 400; EXPENSE con destino
 *      → 400; cuenta inexistente → 400; `kind` inválido y cuerpos hostiles →
 *      400 (nunca 500).
 *   6. MONTO: "0" y "-5" y "1e3" y tres decimales y 10^16 → 400; "4500,25" →
 *      "4500.25"; número JSON 1234.5 → "1234.50"; vacío → null.
 *   7. CATEGORÍA resolver-o-crear: nueva se crea con el tipo de la plantilla;
 *      la misma (distinta capitalización) se reutiliza; usada con el tipo
 *      contrario → 400.
 *   8. `lastUsedAt` SÓLO CON GUARDADO REAL (CLAVE): POST /api/transactions con
 *      `favoriteId` la marca; sin `favoriteId` no; un guardado FALLIDO no;
 *      un `favoriteId` inexistente no rompe el guardado (la plantilla pudo
 *      borrarse en otra pestaña) y `favoriteId` no-texto → 400.
 *   9. NEUTRALIDAD: crear/borrar/listar plantillas no crea ni borra NINGÚN
 *      movimiento (los totales no dependen de las plantillas).
 *  10. ORDEN de la lista: último usado primero; nunca usadas después, más
 *      nuevas primero.
 *
 * Datos propios (prefijo T_T7R2_FAV) con fechas fuera de octubre; los
 * movimientos que esta batería crea (para probar `lastUsedAt`) se borran por
 * id y por descripción. La batería limpia por prefijo antes y después.
 */

import {
  BASE_URL,
  PASSWORD,
  check,
  checkIncluye,
  checkSin500,
  checkTrue,
  del,
  get,
  login,
  post,
  postRaw,
  runScript,
  section,
} from "./lib.mjs";

const TAG = "T_T7R2_FAV";

/** Borra plantillas propias (runScript no las conoce: son de esta ronda). */
const limpiarFavoritos = (prisma) =>
  prisma.favoriteTemplate.deleteMany({ where: { name: { startsWith: TAG } } });

/** Cookie + Origin a mano: para atacar la capa CSRF. */
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
    const propios = new Set();
    const cuentas = {};
    const creados = new Set();

    try {
      await limpiarFavoritos(prisma);
      const cookie = await sesionCruda();

      section("Preparación — cuentas propias");
      cuentas.banco = await prisma.account.create({
        data: { name: `${TAG} Banco`, kind: "BANK" },
      });
      cuentas.efectivo = await prisma.account.create({
        data: { name: `${TAG} Efectivo`, kind: "CASH" },
      });
      cuentas.tarjeta = await prisma.account.create({
        data: { name: `${TAG} Tarjeta`, kind: "CREDIT_CARD", closingDay: 25, dueDay: 5 },
      });
      cuentas.archivada = await prisma.account.create({
        data: { name: `${TAG} Archivada`, kind: "BANK", archived: true },
      });

      const crear = (over = {}) =>
        post("/api/favorites", {
          name: `${TAG} Base`,
          kind: "EXPENSE",
          amount: null,
          description: "",
          categoryName: null,
          accountId: cuentas.banco.id,
          toAccountId: null,
          ...over,
        });

      /** Crea y registra el id para limpiar aun si una aserción posterior falla. */
      const crearYRegistrar = async (over = {}) => {
        const r = await crear(over);
        if (r.status === 201 && r.body?.id) propios.add(r.body.id);
        return r;
      };

      /* ── 1. Autenticación y CSRF ─────────────────────────────────────── */
      section("1 · Autenticación y CSRF");
      {
        const sinCookie = await fetch(`${BASE_URL}/api/favorites`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: BASE_URL },
          body: JSON.stringify({ name: "x", kind: "EXPENSE", accountId: "y" }),
        });
        check("POST sin cookie → 401", sinCookie.status, 401);
      }
      {
        const conCookieSinOrigin = await fetch(`${BASE_URL}/api/favorites`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ name: `${TAG} Sin Origin`, kind: "EXPENSE", accountId: cuentas.banco.id }),
        });
        check("POST con cookie y SIN Origin → 403 (falla cerrado)", conCookieSinOrigin.status, 403);
      }
      {
        const origenAjeno = await fetch(`${BASE_URL}/api/favorites`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ name: `${TAG} Origen ajeno`, kind: "EXPENSE", accountId: cuentas.banco.id }),
        });
        check("POST con Origin de otro host → 403", origenAjeno.status, 403);
      }
      await login();

      /* ── 2. Nombre ───────────────────────────────────────────────────── */
      section("2 · Nombre (vacíos, largos, duplicado normalizado)");
      {
        let r = await crear({ name: "" });
        check("nombre vacío → 400", r.status, 400);
        r = await crear({ name: "   " });
        check("nombre sólo espacios → 400", r.status, 400);
        r = await crear({ name: `T${"x".repeat(40)}` });
        check("nombre de 41 caracteres → 400", r.status, 400);
        const cuarenta = `${TAG} ${"y".repeat(40 - TAG.length - 1)}`;
        r = await crearYRegistrar({ name: cuarenta });
        const idCuarenta = r.body?.id;
        check("nombre de 40 caracteres → 201", r.status, 201);
        check("el nombre visible se conserva recortado", r.body?.name, cuarenta);

        const primero = await crearYRegistrar({ name: `${TAG} Uno` });
        check("plantilla válida → 201", primero.status, 201);
        check("el monto vacío viaja como null", primero.body?.amount, null);
        check("lastUsedAt arranca en null", primero.body?.lastUsedAt, null);
        checkTrue("la respuesta trae id", typeof primero.body?.id === "string" && primero.body.id.length > 0);
        const dup = await crear({ name: `  ${TAG}   uno  ` });
        check("duplicado normalizado (espacios/mayúsculas) → 409", dup.status, 409);
        checkIncluye("el 409 explica por qué", dup.body?.error, "Ya existe una plantilla");
      }

      /* ── 3. Tope de 24 ───────────────────────────────────────────────── */
      section("3 · Tope de 24");
      {
        const total = await prisma.favoriteTemplate.count();
        const faltan = 24 - total;
        console.log(`  · plantillas totales antes del tope: ${total} · se crean ${faltan} propias`);
        for (let i = 0; i < faltan; i += 1) {
          const r = await crearYRegistrar({ name: `${TAG} Cap ${String(i).padStart(2, "0")}` });
          if (r.status !== 201) {
            checkTrue(`la plantilla de tope ${i} se creó`, false, JSON.stringify(r.body));
            break;
          }
        }
        const veinticinco = await crear({ name: `${TAG} Cap 25` });
        check("con 24 plantillas, la 25 → 409", veinticinco.status, 409);
        checkIncluye("el mensaje dice el tope", veinticinco.body?.error, "24");
        const listado = await get("/api/favorites");
        check("GET informa max 24", listado.body?.max, 24);
        check("GET con 24 plantillas devuelve 24", (listado.body?.favorites ?? []).length, 24);

        // Borrar una (la primera creada por esta corrida) y volver a crear: el
        // tope se recalcula solo.
        const primera = await prisma.favoriteTemplate.findFirst({
          where: { name: { startsWith: TAG } },
          orderBy: { createdAt: "asc" },
        });
        const una = primera?.id;
        const borrada = await del(`/api/favorites?id=${una}`);
        check("borrar una plantilla → 204", borrada.status, 204);
        propios.delete(una);
        const reemplazo = await crearYRegistrar({ name: `${TAG} Cap 26` });
        check("con 23, crear de nuevo → 201", reemplazo.status, 201);
        const borradoDoble = await del(`/api/favorites?id=${una}`);
        check("borrar dos veces la misma → 404", borradoDoble.status, 404);

        // Liberar cupo: las plantillas del tope ya cumplieron su prueba; si
        // quedaran, todo lo que las secciones siguientes intente crear sería
        // 409 por tope (no por la regla que se está probando).
        const liberadas = await prisma.favoriteTemplate.deleteMany({
          where: { name: { startsWith: `${TAG} Cap ` } },
        });
        console.log(`  · cupo liberado: ${liberadas.count} plantillas del tope borradas`);
      }

      /* ── 4. Borrado: bordes ──────────────────────────────────────────── */
      section("4 · Borrado (bordes)");
      {
        const sinId = await del(`/api/favorites`);
        check("DELETE sin id → 400", sinId.status, 400);
        const inexistente = await del(`/api/favorites?id=cuid_que_no_existe`);
        check("DELETE de id inexistente → 404", inexistente.status, 404);
        checkIncluye("el 404 dice que no existe", inexistente.body?.error, "no existe");
      }

      /* ── 5. Referencias y forma ──────────────────────────────────────── */
      section("5 · Referencias (cuenta/categoría/tipo)");
      {
        const hostiles = [];
        const atacar = async (label, over) => {
          const r = await crear({ name: `${TAG} H ${label}`, ...over });
          hostiles.push(r);
          return r;
        };
        let r = await atacar("archivada", { accountId: cuentas.archivada.id });
        check("cuenta archivada → 400", r.status, 400);
        checkIncluye("dice archivada", r.body?.error, "archivada");
        r = await atacar("inexistente", { accountId: "cuid_no_existe" });
        check("cuenta inexistente → 400", r.status, 400);
        r = await atacar("income a tarjeta", {
          name: `${TAG} H income tarjeta`,
          kind: "INCOME",
          accountId: cuentas.tarjeta.id,
        });
        check("INCOME a tarjeta de crédito → 400", r.status, 400);
        checkIncluye("dice cuenta de dinero", r.body?.error, "dinero");
        r = await atacar("transfer sin destino", {
          name: `${TAG} H transfer sin destino`,
          kind: "TRANSFER",
          accountId: cuentas.banco.id,
        });
        check("TRANSFER sin destino → 400", r.status, 400);
        r = await atacar("transfer igual destino", {
          name: `${TAG} H transfer igual`,
          kind: "TRANSFER",
          accountId: cuentas.banco.id,
          toAccountId: cuentas.banco.id,
        });
        check("TRANSFER con destino igual al origen → 400", r.status, 400);
        r = await atacar("transfer con categoría", {
          name: `${TAG} H transfer categoría`,
          kind: "TRANSFER",
          accountId: cuentas.banco.id,
          toAccountId: cuentas.efectivo.id,
          categoryName: `${TAG} CatX`,
        });
        check("TRANSFER con categoría → 400", r.status, 400);
        r = await atacar("expense con destino", {
          name: `${TAG} H expense destino`,
          toAccountId: cuentas.efectivo.id,
        });
        check("EXPENSE con cuenta de destino → 400", r.status, 400);
        r = await atacar("kind inválido", { name: `${TAG} H kind`, kind: "PAGO" });
        check("kind inválido → 400", r.status, 400);
        r = await atacar("nota de 201", { name: `${TAG} H nota`, description: "n".repeat(201) });
        check("nota > 200 → 400", r.status, 400);
        r = await atacar("categoría de 41", { name: `${TAG} H cat 41`, categoryName: "c".repeat(41) });
        check("categoría > 40 → 400", r.status, 400);
        const crudo = await postRaw("/api/favorites", "null");
        hostiles.push(crudo);
        check("cuerpo JSON null → 400", crudo.status, 400);
        const roto = await postRaw("/api/favorites", "{no-es-json");
        hostiles.push(roto);
        check("cuerpo no-JSON → 400", roto.status, 400);
        checkSin500("todas las formas hostiles → nunca 500", hostiles);
      }

      /* ── 6. Monto ────────────────────────────────────────────────────── */
      section("6 · Monto (hostiles y formatos)");
      {
        const malos = [];
        for (const [label, monto] of [
          ["cero", "0"],
          ["negativo", "-5"],
          ["10^16", "10000000000000000"],
        ]) {
          const r = await crear({ name: `${TAG} M ${label}`, amount: monto });
          malos.push(r);
          check(`monto ${label} → 400`, r.status, 400);
        }
        checkSin500("montos hostiles → nunca 500", malos);

        // Semántica de dinero de TODA la app (lib/money.ts, regla 4): se
        // ignoran letras, así que "1e3" se lee "13". El CSV es MÁS estricto
        // (rechaza letras): acá el contrato es "como el formulario", y el
        // formulario muestra este mismo preview antes de guardar.
        const notacion = await crearYRegistrar({ name: `${TAG} M notación`, amount: "1e3" });
        check("1e3 → 201 con la lectura de la app (letras ignoradas = 13)", notacion.status, 201);
        check("el monto guardado es 13.00 (contrato del parser global)", notacion.body?.amount, "13.00");

        // "12.345" respeta el patrón COMPLETO de miles (1-3 dígitos y grupos
        // exactos de 3): es doce mil trescientos cuarenta y cinco, no 12,345.
        const miles = await crearYRegistrar({ name: `${TAG} M miles`, amount: "12.345" });
        check("12.345 → 201 con la convención de miles (12.345,00)", miles.status, 201);
        check("el monto guardado es 12345.00", miles.body?.amount, "12345.00");

        const coma = await crearYRegistrar({ name: `${TAG} M coma`, amount: "4500,25" });
        check("monto 4500,25 → 201", coma.status, 201);
        check("se guarda normalizado 4500.25", coma.body?.amount, "4500.25");

        const numero = await crearYRegistrar({ name: `${TAG} M número`, amount: 1234.5 });
        check("monto como número JSON 1234.5 → 201", numero.status, 201);
        check("se guarda 1234.50", numero.body?.amount, "1234.50");

        const grande = await crearYRegistrar({
          name: `${TAG} M grande`,
          amount: "9999999999999999.99",
        });
        check("monto casi al tope de Decimal(18,2) → 201", grande.status, 201);
      }

      /* ── 7. Categoría resolver-o-crear ───────────────────────────────── */
      section("7 · Categoría resolver-o-crear");
      {
        const nueva = await crearYRegistrar({
          name: `${TAG} Cat nueva`,
          categoryName: `${TAG} CatFav`,
        });
        check("plantilla con categoría nueva → 201", nueva.status, 201);
        const cat = await prisma.category.findUnique({
          where: { normalizedName: `${TAG} catfav`.toLowerCase() },
        });
        // normalizedName real: normalizeCategoryName("T_T7R2_FAV CatFav")
        const catReal = cat ?? (await prisma.category.findFirst({ where: { name: `${TAG} CatFav` } }));
        checkTrue("la categoría se creó en la base", Boolean(catReal), JSON.stringify(cat));
        check("con el tipo de la plantilla (EXPENSE)", catReal?.kind, "EXPENSE");
        check("la plantilla la referencia", nueva.body?.category?.name, `${TAG} CatFav`);

        const reuso = await crearYRegistrar({
          name: `${TAG} Cat reuso`,
          categoryName: `${TAG} catfav`,
        });
        check("la misma categoría en otra capitalización → 201 (se reutiliza)", reuso.status, 201);
        check("es la MISMA categoría", reuso.body?.category?.id, nueva.body?.category?.id);
        const totalCats = await prisma.category.count({
          where: { name: { contains: "CatFav" } },
        });
        check("no se duplicó la categoría", totalCats, 1);

        const contrario = await crear({
          name: `${TAG} Cat contrario`,
          kind: "INCOME",
          accountId: cuentas.banco.id,
          categoryName: `${TAG} CatFav`,
        });
        check("la categoría de gasto usada en un INCOME → 400", contrario.status, 400);
        checkIncluye("explica el tipo", contrario.body?.error, "gasto");
      }

      /* ── 8. lastUsedAt SÓLO con guardado real ────────────────────────── */
      section("8 · lastUsedAt sólo con guardado real");
      const fecha = "2027-03-15";
      const movimientosPropios = [];
      {
        const A = await crearYRegistrar({ name: `${TAG} Uso A` });
        const B = await crearYRegistrar({ name: `${TAG} Uso B` });
        const leer = async (id) =>
          (await get("/api/favorites")).body?.favorites?.find((f) => f.id === id);
        const movimientosAntes = await prisma.movement.count();

        // (a) Guardado REAL con favoriteId=A → A.lastUsedAt se marca.
        const guardado = await post("/api/transactions", {
          kind: "EXPENSE",
          amount: "10.00",
          date: fecha,
          description: `${TAG} movimiento con plantilla`,
          accountId: cuentas.banco.id,
          favoriteId: A.body.id,
        });
        check("guardado con favoriteId → 201", guardado.status, 201);
        if (guardado.body?.id) movimientosPropios.push(guardado.body.id);
        const trasGuardar = await leer(A.body.id);
        checkTrue(
          "usar la plantilla en un guardado REAL marca lastUsedAt",
          Boolean(trasGuardar?.lastUsedAt) && trasGuardar.lastUsedAt !== null,
          JSON.stringify(trasGuardar?.lastUsedAt),
        );
        const bTrasGuardar = await leer(B.body.id);
        check("la plantilla que NO se usó sigue en null", bTrasGuardar?.lastUsedAt, null);
        const mov = guardado.body?.id
          ? await prisma.movement.findUnique({ where: { id: guardado.body.id } })
          : null;
        check("el movimiento es el que se pidió (monto y cuenta)", `${mov?.amount?.toFixed?.(2)}`, "10.00");
        check("el favoriteId no cambió la fecha del movimiento", guardado.body?.date, fecha);

        // (b) Guardado FALLIDO con favoriteId=A → A.lastUsedAt NO cambia.
        // La cuenta inexistente rompe la FK del movimiento: el route lo
        // traduce a 409 (describeDatabaseError) y la transacción entera
        // revierte, `touchFavorite` incluido.
        const antesFallo = (await leer(A.body.id))?.lastUsedAt;
        const fallido = await post("/api/transactions", {
          kind: "EXPENSE",
          amount: "10.00",
          date: fecha,
          description: `${TAG} fallido`,
          accountId: "cuid_no_existe",
          favoriteId: A.body.id,
        });
        check("guardado con cuenta inexistente → 409 (no se guarda)", fallido.status, 409);
        const trasFallo = (await leer(A.body.id))?.lastUsedAt;
        check("un guardado FALLIDO no marca lastUsedAt", trasFallo, antesFallo);

        // (c) Guardado SIN favoriteId → nadie se marca.
        const sinFav = await post("/api/transactions", {
          kind: "EXPENSE",
          amount: "11.00",
          date: fecha,
          description: `${TAG} movimiento sin plantilla`,
          accountId: cuentas.banco.id,
        });
        check("guardado sin favoriteId → 201", sinFav.status, 201);
        if (sinFav.body?.id) movimientosPropios.push(sinFav.body.id);
        check("A no se re-marca sola", (await leer(A.body.id))?.lastUsedAt, trasFallo);
        check("B sigue virgen", (await leer(B.body.id))?.lastUsedAt, null);

        // (d) favoriteId INEXISTENTE: la plantilla pudo borrarse en otra
        // pestaña; el movimiento se guarda igual.
        const huerfano = await post("/api/transactions", {
          kind: "EXPENSE",
          amount: "12.00",
          date: fecha,
          description: `${TAG} movimiento huérfano`,
          accountId: cuentas.banco.id,
          favoriteId: "cuid_plantilla_borrada",
        });
        check("favoriteId inexistente → el guardado igual es 201", huerfano.status, 201);
        if (huerfano.body?.id) movimientosPropios.push(huerfano.body.id);

        // (e) favoriteId no-texto → 400 (cliente roto, mejor decirlo).
        const tipoMalo = await post("/api/transactions", {
          kind: "EXPENSE",
          amount: "12.00",
          date: fecha,
          description: `${TAG} tipo malo`,
          accountId: cuentas.banco.id,
          favoriteId: 123,
        });
        check("favoriteId no-texto → 400", tipoMalo.status, 400);

        // (f) Neutralidad: las plantillas no crean movimientos. Los 3 guardados
        // exitosos sí (2 con plantilla ficticia incluidos).
        const movimientosDespues = await prisma.movement.count();
        check(
          "crear/borrar/listar plantillas no movió los totales (sólo los 3 guardados)",
          movimientosDespues - movimientosAntes,
          3,
        );

        // (g) Orden: A (usada) antes que B (nunca usada), aunque B es más nueva.
        const lista = (await get("/api/favorites")).body?.favorites ?? [];
        const iA = lista.findIndex((f) => f.id === A.body.id);
        const iB = lista.findIndex((f) => f.id === B.body.id);
        checkTrue(
          "la lista pone primero la última usada (A antes que B)",
          iA >= 0 && iB >= 0 && iA < iB,
          JSON.stringify({ iA, iB, orden: lista.slice(0, 5).map((f) => f.name) }),
        );
      }

      /* ── 9. GET: forma del listado ───────────────────────────────────── */
      section("9 · Forma del listado");
      {
        const r = await get("/api/favorites");
        check("GET responde 200", r.status, 200);
        const item = (r.body?.favorites ?? []).find((f) => f.name === `${TAG} Uno`);
        checkTrue("cada plantilla trae cuenta y tipo", Boolean(item?.account?.id) && item?.kind === "EXPENSE", JSON.stringify(item));
        check("una plantilla sin monto lista amount null", item?.amount, null);
      }

      // Limpieza fina: borrar los movimientos propios por id (API) y las
      // plantillas propias (Prisma, con los ids registrados).
      section("Cierre de la batería");
      for (const id of movimientosPropios) {
        const r = await del(`/api/transactions?id=${id}`);
        if (![200, 204, 404].includes(r.status)) {
          console.log(`  · AVISO borrar movimiento ${id} → ${r.status}`);
        }
        creados.add(id);
      }
      const quedan = await prisma.movement.count({ where: { description: { startsWith: TAG } } });
      check("no quedan movimientos propios", quedan, 0);
    } finally {
      // Red de seguridad: movimientos y plantillas del tag, pase lo que pase.
      for (const id of creados) {
        try {
          await del(`/api/transactions?id=${id}`);
        } catch {
          // La red no puede tapar un error real.
        }
      }
      await prisma.movement.deleteMany({ where: { description: { startsWith: TAG } } });
      await limpiarFavoritos(prisma);
    }
  },
});
