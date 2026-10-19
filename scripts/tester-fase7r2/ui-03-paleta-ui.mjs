#!/usr/bin/env node
/**
 * ui-03 · PALETA DE COMANDOS (`Ctrl+K`) — ataque propio (Fase 7 r2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RELACIÓN CON `scripts/probe-palette.mjs` (46 chequeos, no se toca)
 * ─────────────────────────────────────────────────────────────────────────────
 * La sonda P1–P12 ya cubre: abre/cierra básico, flechas con wrap simple,
 * filtrado con y sin acentos, estado vacío, Enter en «Nuevo gasto», guardas con
 * form/CSV abiertos, Escape, botón visible, 15 Tab adentro y navegación.
 *
 * Esta batería ataca lo que la sonda NO mira:
 *
 *   1. PARIDAD ×10: diez alternancias seguidas con la tecla real (sin deriva de
 *      estado), más un triple angosto (3 toques con 120 ms) para confirmar que
 *      el updater funcional no pierde ni duplica la alternancia.
 *   2. GUARDAS DE MODIFICADORES: Alt+K, Shift+K, Ctrl+Shift+K, Ctrl+Alt+K y la
 *      «k» pelada NO abren; Meta+K (Cmd) SÍ. (isPaletteShortcut es pura y está
 *      testeada; acá se verifica que el evento real la respete.)
 *   3. TRAMPA DE FOCO EXACTA: Shift+Tab desde el primer focusable salta al
 *      ÚLTIMO HABILITADO (los ítems deshabilitados no cuentan), Tab desde el
 *      último vuelve al primero, Tab normal desde la búsqueda va al ×, y una
 *      ráfaga mezclada no deja escapar el foco.
 *   4. PLANTILLA BLOQUEADA: se muestra con su hint, `disabled`/`aria-disabled`
 *      de verdad, y ni Enter ni el click la activan (no-op medido, sin POST).
 *   5. CIERRES: click en el fondo cierra; click adentro (pie del diálogo) NO;
 *      el × cierra; Escape cierra.
 *   6. ENTER POR ACCIÓN: las 4 acciones (gasto, ingreso, transferencia, CSV) y
 *      las 5 pantallas, una por una, verificando destino. La plantilla usable
 *      abre el formulario precargado con banner (camino paleta → favorito).
 *   7. FLECHAS: ciclo COMPLETO (N veces ↓ vuelve al primero; N veces ↑ también),
 *      con y sin filtro, y `aria-activedescendant` sincronizado.
 *   8. ATAJOS T/I: siguen vivos después de cerrar la paleta; adentro (con foco
 *      en la búsqueda) tipear «t»/«i» NO abre formularios — escribe la query.
 *   9. PUNTOS DE TOQUE de los controles de la paleta y del botón visible.
 *
 * Todo con teclas REALES por CDP (la paleta no se puede atacar con Maestro: su
 * driver no manda Ctrl+K, flechas ni Tab).
 *
 * Datos propios (prefijo T_T7R2_UI3): dos cuentas, una plantilla usable y una
 * bloqueada (cuenta archivada). La batería no crea movimientos: al final lo
 * verifica contra la línea base de hoy. Limpieza: plantillas por prefijo (el
 * `cleanupTag` de r1 no conoce `favoriteTemplate`) y cuentas por `cleanupTag`.
 *
 * Requiere: server en :3000 (build final). Chrome propio en el puerto 9353.
 */

import {
  OUT_TMP,
  BASE_URL,
  abrirPanel,
  check,
  checkTrue,
  dialogosNativos,
  get,
  imprimirTapInfo,
  instrumentar,
  localToday,
  openUi,
  pedidosA,
  post,
  runScript,
  section,
  sleep,
  tapInfo,
} from "./lib.mjs";

const TAG = "T_T7R2_UI3";

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
    const archivable = await prisma.account.create({
      data: { name: `${TAG} Archivable`, kind: "BANK" },
    });

    const favUsable = await post("/api/favorites", {
      name: `${TAG} Favorito usable`,
      kind: "EXPENSE",
      amount: "4321,50",
      description: `${TAG} cafe con leche`,
      categoryName: `${TAG} Cat`,
      accountId: banco.id,
      toAccountId: null,
    });
    check("plantilla usable creada → 201", favUsable.status, 201);

    const favBloqueado = await post("/api/favorites", {
      name: `${TAG} Favorito bloqueado`,
      kind: "EXPENSE",
      amount: "777",
      description: `${TAG} bloqueado`,
      categoryName: null,
      accountId: archivable.id,
      toAccountId: null,
    });
    check("plantilla a bloquear creada → 201", favBloqueado.status, 201);
    await prisma.account.update({
      where: { id: archivable.id },
      data: { archived: true },
    });

    const hoy = localToday();
    const idsHoy = async () => {
      const res = await get(`/api/transactions?from=${hoy}&to=${hoy}`);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return (res.body?.movements ?? []).map((m) => m.id).sort();
    };
    const baseline = await idsHoy();

    /* ── La UI ───────────────────────────────────────────────────────────── */
    let ui;
    try {
      ui = await openUi({ port: 9353 });
      await abrirPanel(ui);
      await instrumentar(ui);

      /** Estado completo y serializable de la paleta. */
      const estado = () =>
        ui.evalJs(`(() => {
          const dialog = document.getElementById("command-palette");
          const input = document.getElementById("palette-input");
          const listbox = document.getElementById("palette-listbox");
          const activo = listbox?.querySelector('[aria-selected="true"]') ?? null;
          const items = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].map((el) => {
            const minw = el.firstElementChild;
            return {
              id: el.id,
              label: minw?.firstElementChild?.textContent?.trim() ?? el.textContent.trim(),
              hint: minw?.children?.[1]?.textContent?.trim() ?? null,
              group: el.lastElementChild?.textContent?.trim() ?? "",
              disabled: el.disabled === true,
            };
          });
          return {
            abierta: !!dialog,
            inputEnfocado: document.activeElement === input,
            activo: activo?.id ?? null,
            query: input?.value ?? null,
            items,
            vacia: (listbox?.textContent ?? "").includes("Nada coincide"),
            formAbierto: !!document.getElementById("tx-submit"),
            csvAbierto: !!document.getElementById("csv-text"),
            focoId: document.activeElement?.id || document.activeElement?.tagName || null,
            focoDentro: dialog ? dialog.contains(document.activeElement) : null,
          };
        })()`);

      /** Ctrl+K REAL (keyDown + keyUp con el modifier de Ctrl). */
      const teclaK = async (modifiers) => {
        const base = {
          key: "k",
          code: "KeyK",
          windowsVirtualKeyCode: 75,
          nativeVirtualKeyCode: 75,
          modifiers,
        };
        await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
        await sleep(25);
        await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await sleep(60);
      };
      const ctrlK = () => teclaK(2);

      /** Tab real, opcionalmente con Shift (modifier 8). */
      const teclaTab = async (shift) => {
        const base = {
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
          modifiers: shift ? 8 : 0,
        };
        await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
        await sleep(40);
        await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await sleep(80);
      };

      /** Ctrl+K con reintentos hasta que la paleta quede en `esperado`. */
      const alternarHasta = async (esperado, label) => {
        for (let i = 1; i <= 4; i += 1) {
          await ctrlK();
          for (let j = 0; j < 6; j += 1) {
            if ((await estado()).abierta === esperado) return i;
            await sleep(200);
          }
        }
        throw new Error(`Ctrl+K no dejó la paleta en abierta=${esperado} (${label})`);
      };

      const abrirPaleta = async () => {
        if (!(await estado()).abierta) await alternarHasta(true, "apertura");
      };

      /**
       * Tras una recarga, las plantillas llegan por su propio GET (medido: ~1 s
       * después del load bajo CDP). La paleta se dibuja con las 9 acciones y
       * crece cuando llegan; si se mide antes, el conteo es 9. Esperar acá es
       * esperar datos, no tapar nada: la pantalla ya está usable.
       */
      const esperarPlantillas = async (minimo = 11) => {
        await abrirPaleta();
        await ui.waitFor(
          `document.querySelectorAll('#palette-listbox [role="option"]').length >= ${minimo}`,
          { timeout: 12000, label: "las plantillas en la paleta" },
        );
      };

      /** Escribe la búsqueda con el setter nativo (dispara el onChange de React). */
      const setQuery = (texto) =>
        ui.evalJs(`(() => {
          const el = document.getElementById("palette-input");
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(el, ${JSON.stringify(texto)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return el.value;
        })()`);

      /** Acción con reintento hasta que `condicion` se cumpla (ventana sorda). */
      const hasta = async (accion, condicion, label, intentos = 4) => {
        for (let i = 1; i <= intentos; i += 1) {
          await accion();
          try {
            await ui.waitFor(condicion, { timeout: 1600, label });
            return i;
          } catch {
            // Se reintenta (ventana sorda documentada).
          }
        }
        throw new Error(`No se cumplió: ${label}`);
      };

      /** Cierra el formulario aunque aparezca el aviso de descarte. */
      const cerrarForm = async () => {
        await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
        await sleep(250);
        if (await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)) {
          await ui.evalJs(`document.getElementById("tx-discard-confirm")?.click()`);
        }
        await ui.waitFor(`!document.getElementById("tx-submit")`, {
          timeout: 5000,
          label: "el cierre del formulario",
        });
      };

      /** Cierra el formulario por Escape (si pide confirmación, acepta el descarte). */
      const cerrarFormConEscape = async () => {
        await ui.press("Escape");
        await sleep(250);
        if (await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)) {
          await ui.evalJs(`document.getElementById("tx-discard-confirm")?.click()`);
        }
        await ui.waitFor(`!document.getElementById("tx-submit")`, {
          timeout: 5000,
          label: "el cierre del formulario por Escape",
        });
      };

      /**
       * Los contadores de POST viven en la página instrumentada y una recarga
       * los borra. Antes de cada navegación se acumulan acá y se vuelve a
       * instrumentar; así "ningún POST en todo el recorrido" cubre todas las
       * cargas, no sólo la última.
       */
      let postTxAcum = 0;
      let postFavAcum = 0;
      const acumularPosts = async () => {
        const [txs, favs] = await Promise.all([
          pedidosA(ui, "/api/transactions"),
          pedidosA(ui, "/api/favorites"),
        ]);
        if (Array.isArray(txs)) postTxAcum += txs.filter((f) => f.method === "POST").length;
        if (Array.isArray(favs)) postFavAcum += favs.filter((f) => f.method === "POST").length;
      };

      /* ── 1. Paridad ×10 ──────────────────────────────────────────────── */
      section("1 · Ctrl+K: paridad de apertura/cierre ×10 con tecla real");
      check("la paleta arranca cerrada", (await estado()).abierta, false);

      let paridadesOk = 0;
      let pulsaciones = 0;
      let sordas = 0;
      let focusOk = 0;
      let queryOk = 0;
      for (let i = 1; i <= 10; i += 1) {
        const esperado = i % 2 === 1; // 1 abre, 2 cierra, 3 abre…
        const usados = await alternarHasta(esperado, `alternancia ${i}`);
        pulsaciones += usados;
        if (usados > 1) sordas += usados - 1;
        const e = await estado();
        if (e.abierta === esperado) paridadesOk += 1;
        if (esperado) {
          await sleep(120);
          const e2 = await estado();
          if (e2.inputEnfocado) focusOk += 1;
          if (e2.query === "") queryOk += 1;
        }
      }
      check("10/10 alternancias dejaron el estado esperado", paridadesOk, 10);
      check("en las 5 aperturas el foco quedó en la búsqueda", focusOk, 5);
      check("y la búsqueda arrancó vacía en las 5", queryOk, 5);
      check("queda cerrada tras la alternancia 10", (await estado()).abierta, false);
      console.log(`  · pulsaciones totales: ${pulsaciones} (sordas recuperadas: ${sordas})`);

      /* ── 1b. Triple angosto: sin deriva de estado ────────────────────── */
      section("1b · Tres Ctrl+K con 120 ms: el estado no deriva");
      let abiertaTriple = null;
      let intentosTriple = 0;
      for (let intento = 1; intento <= 3; intento += 1) {
        intentosTriple = intento;
        for (let i = 0; i < 3; i += 1) {
          await ctrlK();
          await sleep(120);
        }
        await sleep(500);
        abiertaTriple = (await estado()).abierta;
        if (abiertaTriple === true) break;
      }
      check("tras 3 Ctrl+K rápidos la paleta queda ABIERTA", abiertaTriple, true);
      console.log(`  · intentos del triple: ${intentosTriple}`);
      await alternarHasta(false, "cierre tras el triple");
      check("un Ctrl+K más la vuelve a cerrar", (await estado()).abierta, false);

      /* ── 2. Guardas de modificadores ─────────────────────────────────── */
      section("2 · Guardas: Alt, Shift y la «k» pelada no abren; Meta+K sí");
      const noAbre = async (label, accion, espera = 500) => {
        await accion();
        await sleep(espera);
        const e = await estado();
        checkTrue(`«${label}» NO abre la paleta`, e.abierta === false, JSON.stringify({ abierta: e.abierta }));
        checkTrue(`«${label}» no abre formularios ni importador`, !e.formAbierto && !e.csvAbierto);
      };
      await noAbre("Alt+K", () => teclaK(1));
      await noAbre("Shift+K", () => teclaK(8));
      await noAbre("Ctrl+Shift+K", () => teclaK(2 | 8));
      await noAbre("Ctrl+Alt+K", () => teclaK(2 | 1));
      await noAbre("k sola", () =>
        ui.pressKey("k", { code: "KeyK", keyCode: 75, text: "k" }),
      );

      await teclaK(4); // Meta+K (Cmd en mac)
      await sleep(350);
      checkTrue(
        "Meta+K (Cmd) SÍ abre la paleta",
        (await estado()).abierta === true,
        JSON.stringify(await estado()),
      );
      await alternarHasta(false, "cierre tras Meta+K");
      check("Ctrl+K la vuelve a cerrar", (await estado()).abierta, false);

      /* ── 3. Trampa de foco exacta ────────────────────────────────────── */
      section("3 · Trampa de foco exacta: los extremos y el ítem deshabilitado");
      await esperarPlantillas();
      await sleep(150);
      let e3 = await estado();
      check("al abrir, el foco está en la búsqueda", e3.focoId, "palette-input");
      const ultimoHabilitado = e3.items.reduce((acc, it, i) => (it.disabled ? acc : i), -1);
      console.log(
        `  · último habilitado: palette-item-${ultimoHabilitado}` +
          (e3.items[e3.items.length - 1]?.disabled
            ? ` (el último de la lista está deshabilitado: ${
                e3.items[e3.items.length - 1].label
              })`
            : ""),
      );

      await teclaTab(true); // Shift+Tab desde el primer focusable
      e3 = await estado();
      check(
        "Shift+Tab desde el primero salta al último HABILITADO",
        e3.focoId,
        `palette-item-${ultimoHabilitado}`,
      );
      checkTrue("y el foco queda dentro del diálogo", e3.focoDentro === true);

      await teclaTab(false); // Tab desde el último → vuelve al primero
      e3 = await estado();
      check("Tab desde el último vuelve a la búsqueda", e3.focoId, "palette-input");

      await teclaTab(false); // Tab normal desde la búsqueda → siguiente focusable
      e3 = await estado();
      check("Tab normal desde la búsqueda va al botón ×", e3.focoId, "palette-close");

      let fuera = 0;
      for (let i = 0; i < 8; i += 1) {
        await teclaTab(i % 2 === 0);
        const dentro = await ui.evalJs(
          `document.getElementById("command-palette")?.contains(document.activeElement) === true`,
        );
        if (!dentro) fuera += 1;
      }
      check("8 Tab/Shift+Tab mezclados no sacan el foco", fuera, 0);
      await ui.press("Escape");
      await sleep(250);
      check("Escape cierra la paleta tras tabular", (await estado()).abierta, false);

      /* ── 4. Plantilla bloqueada: no-op por Enter y por click ─────────── */
      section("4 · La plantilla bloqueada: se ve, se deshabilita y no se activa");
      await esperarPlantillas();
      await setQuery(`${TAG} Favorito bloqueado`);
      await sleep(250);
      let e4 = await estado();
      check("el filtro la aísla como único resultado", e4.items.length, 1);
      check("es la plantilla bloqueada (por nombre)", e4.items[0]?.label, `${TAG} Favorito bloqueado`);
      check("viene deshabilitada", e4.items[0]?.disabled, true);
      check(
        "lo dice en el hint",
        (e4.items[0]?.hint ?? "").includes("cuenta archivada"),
        true,
      );
      check(
        "y en aria-disabled",
        await ui.evalJs(
          `document.getElementById("palette-item-0")?.getAttribute("aria-disabled")`,
        ),
        "true",
      );
      check("el activo cae sobre ella igual (es el único)", e4.activo, "palette-item-0");

      const txsAntes = (await pedidosA(ui, "/api/transactions")).length;
      const rutaAntes = await ui.evalJs(`location.pathname`);
      await ui.press("Enter");
      await sleep(350);
      e4 = await estado();
      check("Enter sobre la bloqueada NO cierra la paleta", e4.abierta, true);
      checkTrue("ni abre el formulario", !e4.formAbierto);
      check("sigue en la misma pantalla", await ui.evalJs(`location.pathname`), rutaAntes);

      await ui.clickEl("#palette-item-0");
      await sleep(350);
      e4 = await estado();
      check("el click tampoco la activa (paleta sigue abierta)", e4.abierta, true);
      checkTrue("ni abre nada", !e4.formAbierto && !e4.csvAbierto);
      check("no viajó ningún pedido nuevo", (await pedidosA(ui, "/api/transactions")).length, txsAntes);
      await ui.press("Escape");
      await sleep(200);

      /* ── 5. Cierres: fondo, adentro, ×, Escape ───────────────────────── */
      section("5 · Cierres: el fondo cierra, adentro no, y el × también");
      await abrirPaleta();
      const pie = await ui.evalJs(`(() => {
        const p = document.querySelector("#command-palette p.border-t");
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      checkTrue("el pie del diálogo existe", !!pie, JSON.stringify(pie));
      await ui.clickAt(pie.x, pie.y);
      await sleep(300);
      check("un click adentro (pie del diálogo) NO cierra", (await estado()).abierta, true);

      await ui.clickAt(12, 12); // fondo (overlay), esquina superior
      await sleep(300);
      check("un click en el fondo SÍ cierra", (await estado()).abierta, false);

      await abrirPaleta();
      await ui.clickEl("#palette-close");
      await sleep(300);
      check("el botón × la cierra", (await estado()).abierta, false);

      await abrirPaleta();
      await ui.press("Escape");
      await sleep(250);
      check("Escape la cierra", (await estado()).abierta, false);

      /* ── 6. Enter ejecuta CADA acción ────────────────────────────────── */
      section("6 · Enter por acción: gasto, ingreso, transferencia, CSV, plantilla y pantallas");

      /** Abre la paleta si hace falta, escribe `query` y da Enter hasta cumplir. */
      const accionEnter = async (query, condicion, label, intentos = 3) => {
        for (let i = 1; i <= intentos; i += 1) {
          if (!(await estado()).abierta) await abrirPaleta();
          await setQuery(query);
          await sleep(220);
          await ui.press("Enter");
          try {
            await ui.waitFor(condicion, { timeout: 2500, label });
            return i;
          } catch {
            // Se reintenta: quizá la ventana sorda se comió el Enter.
          }
        }
        throw new Error(`Enter no ejecutó: ${label}`);
      };

      await accionEnter(
        "Nuevo gasto",
        `!document.getElementById("command-palette") && !!document.getElementById("tx-submit")`,
        "Enter → Nuevo gasto",
      );
      check(
        "«Nuevo gasto» abre el formulario de GASTO",
        await ui.evalJs(`document.getElementById("tx-kind-gasto")?.getAttribute("aria-pressed")`),
        "true",
      );
      check("la paleta quedó cerrada", (await estado()).abierta, false);
      await cerrarForm(ui);

      await accionEnter(
        "Nuevo ingreso",
        `!document.getElementById("command-palette") && !!document.getElementById("tx-submit")`,
        "Enter → Nuevo ingreso",
      );
      check(
        "«Nuevo ingreso» abre el formulario de INGRESO",
        await ui.evalJs(`document.getElementById("tx-kind-ingreso")?.getAttribute("aria-pressed")`),
        "true",
      );
      await cerrarForm(ui);

      await accionEnter(
        "Nueva transferencia",
        `!document.getElementById("command-palette") && !!document.getElementById("tx-submit")`,
        "Enter → Nueva transferencia",
      );
      check(
        "«Nueva transferencia» abre el formulario de TRANSFERENCIA",
        await ui.evalJs(
          `document.getElementById("tx-kind-transferencia")?.getAttribute("aria-pressed")`,
        ),
        "true",
      );
      check(
        "y con el campo de cuenta destino",
        await ui.evalJs(`!!document.getElementById("tx-to-account")`),
        true,
      );
      await cerrarForm(ui);

      await accionEnter(
        "Importar CSV",
        `!document.getElementById("command-palette") && !!document.getElementById("csv-text")`,
        "Enter → Importar CSV",
      );
      check("«Importar CSV» abre el importador", await ui.evalJs(`!!document.getElementById("csv-text")`), true);
      check("la paleta quedó cerrada", (await estado()).abierta, false);
      await ui.evalJs(`document.getElementById("csv-close")?.click()`);
      await ui.waitFor(`!document.getElementById("csv-text")`, {
        timeout: 4000,
        label: "el cierre del importador",
      });
      check("el importador se cierra por su ×", await ui.evalJs(`!!document.getElementById("csv-text")`), false);

      // Plantilla usable: camino paleta → formulario precargado con banner.
      await accionEnter(
        `${TAG} Favorito usable`,
        `!document.getElementById("command-palette") && !!document.getElementById("tx-favorite-banner")`,
        "Enter → plantilla usable",
      );
      const precargado = await ui.evalJs(`({
        banner: document.getElementById("tx-favorite-banner")?.textContent?.trim() ?? null,
        monto: document.getElementById("tx-amount")?.value ?? null,
        nota: document.getElementById("tx-description")?.value ?? null,
        categoria: document.getElementById("tx-category")?.value ?? null,
        cuenta: document.getElementById("tx-account")?.value ?? null,
        kindGasto: document.getElementById("tx-kind-gasto")?.getAttribute("aria-pressed") ?? null,
      })`);
      checkTrue(
        "el banner dice de qué plantilla viene",
        (precargado.banner ?? "").includes(`${TAG} Favorito usable`),
        JSON.stringify(precargado),
      );
      check("el monto llega precargado", precargado.monto, "4321,50");
      check("la nota llega precargada", precargado.nota, `${TAG} cafe con leche`);
      check("la categoría llega precargada", precargado.categoria, `${TAG} Cat`);
      check("la cuenta llega precargada", precargado.cuenta, banco.id);
      check("abre en modo gasto", precargado.kindGasto, "true");
      await cerrarForm(ui);

      // Las cinco pantallas, una por una.
      const pantallas = [
        ["Ir al panel", "/"],
        ["Ir a Análisis", "/analisis"],
        ["Ir a Tarjetas", "/tarjetas"],
        ["Ir a Recurrencia", "/recurrencia"],
        ["Ir a Préstamos", "/prestamos"],
      ];
      for (const [label, ruta] of pantallas) {
        await acumularPosts();
        await abrirPanel(ui);
        await instrumentar(ui);
        await abrirPaleta();
        await setQuery(label);
        await sleep(220);
        await ui.press("Enter");
        await ui
          .waitFor(`location.pathname === ${JSON.stringify(ruta)}`, {
            timeout: 6000,
            label: `Enter → ${ruta}`,
          })
          .catch(() => {});
        check(`«${label}» navega a ${ruta}`, await ui.evalJs(`location.pathname`), ruta);
        check(
          `la paleta se cerró al ir a ${ruta}`,
          (await estado()).abierta,
          false,
        );
        if (ruta !== "/") {
          await acumularPosts();
          await ui.navigate(`${BASE_URL}/`);
          await ui.waitFor(`!!document.getElementById("btn-expense")`, {
            timeout: 30000,
            label: "la vuelta al panel",
          });
          await instrumentar(ui);
        }
      }

      /* ── 7. Flechas: ciclo completo con wrap ─────────────────────────── */
      section("7 · Flechas: N×↓ y N×↑ vuelven al primero (con y sin filtro)");
      await esperarPlantillas();
      let e7 = await estado();
      const total = e7.items.length;
      checkTrue(`la lista trae ≥11 ítems (9 acciones + plantillas; hay ${total})`, total >= 11);

      let sordasFlechas = 0;
      const rondaFlechas = async (direccion, n, label) => {
        for (let i = 1; i <= n; i += 1) {
          const idx = direccion === "down" ? i % n : (n - (i % n)) % n;
          const usados = await hasta(
            () =>
              ui.pressKey(direccion === "down" ? "ArrowDown" : "ArrowUp", {
                code: direccion === "down" ? "ArrowDown" : "ArrowUp",
                keyCode: direccion === "down" ? 40 : 38,
              }),
            `document.getElementById("palette-item-${idx}")?.getAttribute("aria-selected") === "true"`,
            `${label} ${i}/${n}`,
          );
          sordasFlechas += usados - 1;
        }
      };

      await rondaFlechas("down", total, "↓");
      check("tras N × ↓ el activo volvió al primero", (await estado()).activo, "palette-item-0");
      check(
        "aria-activedescendant sigue al activo",
        await ui.evalJs(
          `document.getElementById("palette-input")?.getAttribute("aria-activedescendant")`,
        ),
        "palette-item-0",
      );

      await rondaFlechas("up", total, "↑");
      check("tras N × ↑ el activo volvió al primero", (await estado()).activo, "palette-item-0");

      await ui.pressKey("ArrowDown", { code: "ArrowDown", keyCode: 40 });
      await sleep(150);
      check(
        "una ↓ sincroniza aria-activedescendant",
        await ui.evalJs(
          `document.getElementById("palette-input")?.getAttribute("aria-activedescendant")`,
        ),
        "palette-item-1",
      );

      await setQuery("Ir a");
      await sleep(250);
      e7 = await estado();
      check("el filtro deja las 5 pantallas", e7.items.length, 5);
      await rondaFlechas("down", 5, "↓ (filtro)");
      check("con filtro, N × ↓ también vuelven al primero", (await estado()).activo, "palette-item-0");
      console.log(`  · flechas con sorda recuperada: ${sordasFlechas}`);
      await ui.press("Escape");
      await sleep(200);

      /* ── 8. Atajos T/I: vivos, y adentro no disparan ─────────────────── */
      section("8 · Los atajos T/I: siguen vivos, y adentro de la paleta escriben");
      await ui.pressKey("t", { code: "KeyT", keyCode: 84, text: "t" });
      await ui.waitFor(`!!document.getElementById("tx-submit")`, {
        timeout: 4000,
        label: "el form de gasto con T",
      });
      check(
        "«t» abre gasto después de usar la paleta",
        await ui.evalJs(`document.getElementById("tx-kind-gasto")?.getAttribute("aria-pressed")`),
        "true",
      );
      await cerrarFormConEscape(ui);
      check("el form se cerró por Escape", await ui.evalJs(`!!document.getElementById("tx-submit")`), false);

      await ui.pressKey("i", { code: "KeyI", keyCode: 73, text: "i" });
      await ui.waitFor(`!!document.getElementById("tx-submit")`, {
        timeout: 4000,
        label: "el form de ingreso con I",
      });
      check(
        "«i» abre ingreso",
        await ui.evalJs(`document.getElementById("tx-kind-ingreso")?.getAttribute("aria-pressed")`),
        "true",
      );
      await cerrarFormConEscape(ui);

      await abrirPaleta();
      await sleep(150);
      await ui.pressKey("t", { code: "KeyT", keyCode: 84, text: "t" });
      await sleep(200);
      await ui.pressKey("i", { code: "KeyI", keyCode: 73, text: "i" });
      await sleep(250);
      let e8 = await estado();
      check("tipear «t» adentro va a la búsqueda de la paleta", e8.query, "ti");
      checkTrue("y NO abre el formulario (guarda por campo de texto)", !e8.formAbierto);
      check("la paleta sigue abierta mientras se escribe", e8.abierta, true);

      await ui.press("Escape");
      await sleep(200);
      await abrirPaleta();
      await sleep(200);
      e8 = await estado();
      check("al reabrir, la búsqueda arranca vacía", e8.query, "");
      check("y el activo vuelve al primero", e8.activo, "palette-item-0");

      await alternarHasta(false, "cierre final de la sección 8");
      check("Ctrl+K cierra la paleta reabierta", (await estado()).abierta, false);
      await ui.pressKey("t", { code: "KeyT", keyCode: 84, text: "t" });
      await ui.waitFor(`!!document.getElementById("tx-submit")`, {
        timeout: 4000,
        label: "el form con T tras el Ctrl+K",
      });
      check(
        "«t» sigue abriendo gasto tras el Ctrl+K",
        await ui.evalJs(`document.getElementById("tx-kind-gasto")?.getAttribute("aria-pressed")`),
        "true",
      );
      await cerrarFormConEscape(ui);

      /* ── 9. Puntos de toque ──────────────────────────────────────────── */
      section("9 · Puntos de toque de la paleta y del botón visible");
      await abrirPaleta();
      await sleep(150);
      const infos = await tapInfo(ui, [
        "#palette-input",
        "#palette-close",
        "#palette-item-0",
        "#palette-item-1",
      ]);
      imprimirTapInfo("Puntos (paleta abierta)", infos);
      for (const sel of ["#palette-input", "#palette-close", "#palette-item-0", "#palette-item-1"]) {
        const t = infos.find((x) => x.sel === sel);
        checkTrue(`el tap de ${sel} llega al control`, t?.toqueLlega === true, JSON.stringify(t));
      }
      await ui.press("Escape");
      await sleep(250);

      await ui.evalJs(`document.getElementById("btn-palette")?.scrollIntoView({ block: "center" })`);
      await sleep(250);
      const infoBtn = await tapInfo(ui, ["#btn-palette"]);
      imprimirTapInfo("Puntos (botón visible)", infoBtn);
      checkTrue("el tap del botón Buscar llega", infoBtn[0]?.toqueLlega === true, JSON.stringify(infoBtn[0]));
      await ui.clickEl("#btn-palette");
      await ui
        .waitFor(`!!document.getElementById("command-palette")`, {
          timeout: 3000,
          label: "la paleta por el botón",
        })
        .catch(() => {});
      check("el botón abre la paleta (tap real)", (await estado()).abierta, true);
      await alternarHasta(false, "cierre tras el botón");

      /* ── 10. Cierre ──────────────────────────────────────────────────── */
      section("10 · Cierre");
      const dialogos = await dialogosNativos(ui);
      check("ningún diálogo nativo en todo el recorrido", (dialogos ?? []).length, 0);
      const errores = await ui.evalJs(`(window.__t7r2 ? window.__t7r2.errores : null)`);
      check("ninguna excepción de página", (errores ?? []).length, 0);
      await acumularPosts();
      check(
        "ningún POST /api/transactions en todo el recorrido",
        postTxAcum,
        0,
      );
      check(
        "ningún POST /api/favorites en todo el recorrido",
        postFavAcum,
        0,
      );
      await ui.screenshot(`${OUT_TMP}/t7r2-ui03-paleta.png`);
      const idsFinal = await idsHoy();
      check("los movimientos de hoy no cambiaron", idsFinal.join(","), baseline.join(","));
    } finally {
      await ui?.close();
      await limpiarFavoritos();
    }
  },
});
