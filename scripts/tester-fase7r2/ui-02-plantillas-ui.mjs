#!/usr/bin/env node
/**
 * ui-02 · PLANTILLAS / FAVORITOS — contrato de UI (Fase 7 r2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque B)
 * ─────────────────────────────────────────────────────────────────────────────
 * La batería 02 atacó `/api/favorites` por API. Ésta recorre el camino REAL en
 * el panel y el formulario:
 *
 *   1. Los chips se dibujan con nombre, tipo y monto; una plantilla cuya cuenta
 *      quedó ARCHIVADA se muestra deshabilitada y tocarla NO abre nada.
 *   2. Tocar un chip abre el formulario PRECARGADO (monto, categoría, nota,
 *      cuenta) con el banner "plantilla: <nombre>".
 *   3. "☆ Plantilla" guarda el formulario como plantilla: nombre vacío y monto
 *      ilegible se cortan ANTES de viajar (sin POST); la guardada aparece en el
 *      panel sin recargar y NO crea ningún movimiento.
 *   4. Usar una plantilla de verdad (guardar un movimiento desde ella) marca
 *      `lastUsedAt`, la sube al primer lugar de la lista y muestra el aviso de
 *      "Deshacer" (que se descarta con su ×).
 *   5. Cambiar de tipo limpia el banner: la plantilla era de OTRO tipo.
 *   6. El borrado es en DOS pasos inline (nunca `window.confirm`): "¿Borrar…?"
 *      → "Sí" la borra de la base y del panel; "No" la deja.
 *   7. Cero diálogos nativos y cero excepciones de página.
 *
 * Los movimientos que esta batería crea (para `lastUsedAt`) van fechados en
 * 2028 — fuera de la ventana de los flows — y se borran por id al final.
 * Requiere: server en :3000 (build final). Chrome propio en el puerto 9352.
 */

import {
  OUT_TMP,
  abrirPanel,
  cerrarModal,
  check,
  checkIncluye,
  checkTrue,
  del,
  dialogosNativos,
  get,
  imprimirTapInfo,
  instrumentar,
  openUi,
  pedidosA,
  post,
  runScript,
  section,
  sleep,
  tapInfo,
} from "./lib.mjs";

const TAG = "T_T7R2_UI2";
const FECHA_MOV = "2028-02-15";

runScript({
  tag: TAG,
  main: async (prisma) => {
    const limpiarFavoritos = () =>
      prisma.favoriteTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
    await limpiarFavoritos();

    /* ── Fixtures ────────────────────────────────────────────────────────── */
    section("Preparación — cuentas y plantillas propias");
    const banco = await prisma.account.create({
      data: { name: `${TAG} Banco`, kind: "BANK" },
    });
    const efectivo = await prisma.account.create({
      data: { name: `${TAG} Efectivo`, kind: "CASH" },
    });
    const futura = await prisma.account.create({
      data: { name: `${TAG} Futura`, kind: "BANK" },
    });

    const favA = await post("/api/favorites", {
      name: `${TAG} Café`,
      kind: "EXPENSE",
      amount: "1234,56",
      description: `${TAG} nota favorita`,
      categoryName: `${TAG} Cat`,
      accountId: banco.id,
      toAccountId: null,
    });
    check("plantilla de gasto creada → 201", favA.status, 201);
    check("el monto se normalizó", favA.body?.amount, "1234.56");

    const favB = await post("/api/favorites", {
      name: `${TAG} Traspaso`,
      kind: "TRANSFER",
      amount: "5000",
      description: `${TAG} traspaso favorito`,
      categoryName: null,
      accountId: banco.id,
      toAccountId: efectivo.id,
    });
    check("plantilla de transferencia creada → 201", favB.status, 201);

    const favC = await post("/api/favorites", {
      name: `${TAG} Bloqueada`,
      kind: "EXPENSE",
      amount: "100",
      description: `${TAG} bloqueada`,
      categoryName: null,
      accountId: futura.id,
      toAccountId: null,
    });
    check("plantilla sobre cuenta viva creada → 201", favC.status, 201);
    await prisma.account.update({ where: { id: futura.id }, data: { archived: true } });
    check("la cuenta de esa plantilla quedó archivada", true, true);

    /* ── La UI ───────────────────────────────────────────────────────────── */
    const ui = await openUi({ port: 9352 });
    const movimientosCreados = [];
    try {
      await abrirPanel(ui);
      await instrumentar(ui);

      const dialogs = () => dialogosNativos(ui);
      const favPosts = async () => {
        const lista = await pedidosA(ui, "/api/favorites");
        if (!Array.isArray(lista)) throw new Error(`pedidosA no devolvió un array: ${typeof lista}`);
        return lista.filter((f) => f.method === "POST");
      };
      const chips = () =>
        ui.evalJs(`[...document.querySelectorAll('#favorites-list [id^="favorite-"]')]
          .filter((el) => el.id.startsWith("favorite-"))
          .map((el) => ({ id: el.id, texto: el.textContent.trim(), disabled: el.disabled === true }))`);

      /** Toca con scroll + reintentos de hidratación. */
      const tocarHasta = async (selector, condicion, label, intentos = 4) => {
        for (let i = 1; i <= intentos; i += 1) {
          await ui.evalJs(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
          );
          await sleep(i === 1 ? 250 : 300);
          await ui.clickEl(selector);
          try {
            await ui.waitFor(condicion, { timeout: 2500, label });
            return i;
          } catch {
            // Ventana sorda / pre-hidratación: se reintenta.
          }
        }
        throw new Error(`${selector} no cumplió: ${label}`);
      };

      const setValor = (selector, valor) =>
        ui.evalJs(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
          setter.call(el, ${JSON.stringify(valor)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return el.value;
        })()`);

      /* ── 1. Chips en el panel ─────────────────────────────────────────── */
      section("1 · Los chips: nombre, tipo, monto y la bloqueada deshabilitada");
      await ui.waitFor(`!!document.getElementById("favorite-${favA.body.id}")`, {
        timeout: 10000,
        label: "el chip de Café",
      });
      let lista = await chips();
      const chipA = lista.find((c) => c.id === `favorite-${favA.body.id}`);
      const chipB = lista.find((c) => c.id === `favorite-${favB.body.id}`);
      const chipC = lista.find((c) => c.id === `favorite-${favC.body.id}`);
      checkTrue("el chip de gasto muestra nombre, tipo y monto", Boolean(chipA) && chipA.texto.includes(`${TAG} Café`) && chipA.texto.includes("Gasto") && chipA.texto.includes("1.234,56"), JSON.stringify(chipA));
      checkTrue("el chip de transferencia dice Transferencia", Boolean(chipB) && chipB.texto.includes("Transferencia"), JSON.stringify(chipB));
      checkTrue("el chip de la cuenta archivada queda deshabilitado", Boolean(chipC) && chipC.disabled === true, JSON.stringify(chipC));
      checkTrue("y lo dice: 'cuenta archivada'", Boolean(chipC) && chipC.texto.includes("cuenta archivada"), JSON.stringify(chipC));

      await ui.evalJs(`document.getElementById("favorite-${favA.body.id}").scrollIntoView({ block: "center" })`);
      await sleep(250);
      const tapChip = await tapInfo(ui, [`#favorite-${favA.body.id}`]);
      imprimirTapInfo("Punto de toque del chip", tapChip);
      checkTrue("el punto de toque del chip llega al chip", tapChip[0]?.toqueLlega === true, JSON.stringify(tapChip[0]));

      /* ── 2. Tocar el chip abre el form precargado ─────────────────────── */
      section("2 · El chip abre el formulario precargado con banner");
      await tocarHasta(`#favorite-${favA.body.id}`, `!!document.getElementById("tx-submit")`, "el modal desde el chip");
      await ui.waitFor(`!!document.getElementById("tx-favorite-banner")`, {
        timeout: 4000,
        label: "el banner de plantilla",
      });
      const precarga = await ui.evalJs(`({
        banner: document.getElementById("tx-favorite-banner").textContent.trim(),
        monto: document.getElementById("tx-amount").value,
        categoria: document.getElementById("tx-category").value,
        nota: document.getElementById("tx-description").value,
        cuenta: document.getElementById("tx-account").value,
      })`);
      checkIncluye("el banner dice de qué plantilla viene", precarga.banner, `${TAG} Café`);
      check("el monto llega precargado", precarga.monto, "1234,56");
      check("la categoría llega precargada", precarga.categoria, `${TAG} Cat`);
      check("la nota llega precargada", precarga.nota, `${TAG} nota favorita`);
      check("la cuenta llega precargada", precarga.cuenta, banco.id);

      /* ── 3. Guardar el formulario como plantilla ──────────────────────── */
      section("3 · '☆ Plantilla': errores primero, guardado después");
      const postsAntes = (await favPosts()).length;
      await ui.clickEl("#tx-save-favorite");
      await ui.waitFor(`!!document.getElementById("tx-favorite-panel")`, { timeout: 4000, label: "el panel de plantilla" });

      await ui.clickEl("#tx-favorite-save");
      await ui.waitFor(`!!document.getElementById("tx-favorite-error")`, { timeout: 4000, label: "el error de nombre" });
      checkIncluye("sin nombre, el aviso pide un nombre", await ui.evalJs(`document.getElementById("tx-favorite-error").textContent`), "nombre");
      check("sin nombre no sale ningún POST", (await favPosts()).length, postsAntes);

      await ui.clickEl("#tx-favorite-name");
      await ui.insertText(`${TAG} Nueva`);
      await setValor("#tx-amount", "abc");
      await ui.clickEl("#tx-favorite-save");
      await ui.waitFor(
        `(document.getElementById("tx-favorite-error")?.textContent ?? "").includes("monto")`,
        { timeout: 4000, label: "el error de monto" },
      );
      checkIncluye("con monto ilegible, el aviso habla del monto", await ui.evalJs(`document.getElementById("tx-favorite-error").textContent`), "monto");
      check("tampoco viajó ningún POST", (await favPosts()).length, postsAntes);

      // Restaurar el monto y guardar de verdad. La plantilla NO crea movimiento.
      await setValor("#tx-amount", "1234.56");
      const movsAntesDeGuardar = await prisma.movement.count();
      await ui.clickEl("#tx-favorite-save");
      await ui.waitFor(`!!document.getElementById("tx-favorite-notice")`, { timeout: 6000, label: "el aviso de guardada" });
      checkIncluye("el aviso confirma la plantilla", await ui.evalJs(`document.getElementById("tx-favorite-notice").textContent`), "guardada");
      check("el panel de plantilla se cierra solo", await ui.evalJs(`!!document.getElementById("tx-favorite-panel")`), false);
      check("salió UN POST /api/favorites", (await favPosts()).length, postsAntes + 1);
      check("guardar la plantilla no creó ningún movimiento", await prisma.movement.count(), movsAntesDeGuardar);
      await ui.waitFor(
        `[...document.querySelectorAll('#favorites-list [id^="favorite-"]')].some((el) => el.textContent.includes(${JSON.stringify(`${TAG} Nueva`)}))`,
        { timeout: 6000, label: "el chip nuevo en el panel (sin recargar)" },
      );
      checkTrue("el chip aparece en el panel sin recargar la página", true);

      /* ── 4. Usar la plantilla: lastUsedAt, orden y aviso ──────────────── */
      section("4 · Usar la plantilla de verdad: lastUsedAt, orden y 'Deshacer'");
      await setValor("#tx-date", FECHA_MOV);
      await ui.clickEl("#tx-submit");
      await ui.waitFor(`!!document.getElementById("undo-toast")`, { timeout: 8000, label: "el aviso de guardado" });
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 5000, label: "el cierre del modal" });

      const trasGuardar = (await get("/api/favorites")).body?.favorites ?? [];
      const aTras = trasGuardar.find((f) => f.id === favA.body.id);
      checkTrue("usar la plantilla marcó lastUsedAt", Boolean(aTras?.lastUsedAt), JSON.stringify(aTras?.lastUsedAt));
      const bTras = trasGuardar.find((f) => f.id === favB.body.id);
      check("la que no se usó sigue en null", bTras?.lastUsedAt, null);

      const movsDelDia = await get(`/api/transactions?from=${FECHA_MOV}&to=${FECHA_MOV}`);
      const movCreado = (movsDelDia.body?.movements ?? []).find(
        (m) => m.description === `${TAG} nota favorita`,
      );
      checkTrue("el movimiento se guardó con la nota de la plantilla", Boolean(movCreado), JSON.stringify((movsDelDia.body?.movements ?? []).map((m) => m.description)));
      check("y con el monto de la plantilla", movCreado?.amount, "1234.56");
      if (movCreado) movimientosCreados.push(movCreado.id);

      await ui.waitFor(
        `document.getElementById("favorites-list")?.firstElementChild?.textContent.includes(${JSON.stringify(`${TAG} Café`)})`,
        { timeout: 6000, label: "la plantilla usada primero" },
      );
      checkTrue("la usada pasa al primer lugar de la lista", true);
      await ui.evalJs(`document.getElementById("undo-dismiss")?.click()`);
      await sleep(200);
      check("el aviso de 'Deshacer' se descarta con su ×", await ui.evalJs(`!!document.getElementById("undo-toast")`), false);

      /* ── 5. Cambiar de tipo limpia el banner ─────────────────────────── */
      section("5 · Cambiar de tipo limpia el banner (la plantilla era de otro tipo)");
      await tocarHasta(`#favorite-${favB.body.id}`, `!!document.getElementById("tx-submit")`, "el modal desde el chip de transferencia");
      check("el banner de la transferencia está", await ui.evalJs(`!!document.getElementById("tx-favorite-banner")`), true);
      check("el monto llega", await ui.evalJs(`document.getElementById("tx-amount").value`), "5000,00");
      await ui.clickEl("#tx-kind-gasto");
      await ui.waitFor(`!!document.getElementById("tx-category")`, { timeout: 4000, label: "el cambio a gasto" });
      check("tras cambiar a gasto, el banner se limpia", await ui.evalJs(`!!document.getElementById("tx-favorite-banner")`), false);
      check("y el monto sobrevive al cambio", await ui.evalJs(`document.getElementById("tx-amount").value`), "5000,00");
      await cerrarModal(ui);

      /* ── 6. La chip bloqueada no abre nada ───────────────────────────── */
      section("6 · La chip con cuenta archivada no abre el formulario");
      await ui.evalJs(`document.getElementById("favorite-${favC.body.id}").scrollIntoView({ block: "center" })`);
      await sleep(250);
      await ui.clickEl(`#favorite-${favC.body.id}`);
      await sleep(500);
      check("tocar la chip deshabilitada no abre nada", await ui.evalJs(`!!document.getElementById("tx-submit")`), false);

      /* ── 7. Borrado en dos pasos ──────────────────────────────────────── */
      section("7 · Borrado en dos pasos inline");
      await tocarHasta(`#favorite-delete-${favA.body.id}`, `!!document.getElementById("favorite-delete-panel-${favA.body.id}")`, "el panel de borrado");
      checkIncluye("el panel pregunta antes de borrar", await ui.evalJs(`document.getElementById("favorite-delete-panel-${favA.body.id}").textContent`), `${TAG} Café`);
      await ui.clickEl(`#favorite-delete-cancel-${favA.body.id}`);
      await ui.waitFor(`!document.getElementById("favorite-delete-panel-${favA.body.id}")`, { timeout: 4000, label: "el cancelar" });
      check("'No' deja la plantilla donde estaba", await ui.evalJs(`!!document.getElementById("favorite-${favA.body.id}")`), true);

      await ui.clickEl(`#favorite-delete-${favA.body.id}`);
      await ui.waitFor(`!!document.getElementById("favorite-delete-panel-${favA.body.id}")`, { timeout: 4000, label: "el panel de borrado otra vez" });
      await ui.clickEl(`#favorite-delete-confirm-${favA.body.id}`);
      await ui.waitFor(`!document.getElementById("favorite-${favA.body.id}")`, { timeout: 6000, label: "la chip borrada" });
      const quedan = (await get("/api/favorites")).body?.favorites ?? [];
      check("la plantilla ya no está en la API", quedan.some((f) => f.id === favA.body.id), false);

      /* ── 8. Cierre ────────────────────────────────────────────────────── */
      section("8 · Cierre");
      check("ningún diálogo nativo en todo el recorrido", ((await dialogs()) ?? []).length, 0);
      const errores = await ui.evalJs(`(window.__t7r2 ? window.__t7r2.errores : null)`);
      check("ninguna excepción de página", (errores ?? []).length, 0);
      await ui.screenshot(`${OUT_TMP}/t7r2-ui02-plantillas.png`);

      for (const id of movimientosCreados) {
        const r = await del(`/api/transactions?id=${id}`);
        if (![200, 204, 404].includes(r.status)) {
          console.log(`  · AVISO borrar movimiento ${id} → ${r.status}`);
        }
      }
      check("no quedan movimientos propios de la batería", await prisma.movement.count({ where: { description: { startsWith: TAG } } }), 0);
    } finally {
      // Red de seguridad.
      for (const id of movimientosCreados) {
        try {
          await del(`/api/transactions?id=${id}`);
        } catch {
          // No tapa un error real: sólo evita dejar basura.
        }
      }
      await ui.close();
      await prisma.movement.deleteMany({ where: { description: { startsWith: TAG } } });
      await limpiarFavoritos();
    }
  },
});
