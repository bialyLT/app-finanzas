#!/usr/bin/env node
/**
 * ui-04 · GEOMETRÍA DE TOQUES — matriz de controles nuevos vs la banda del pie
 * (Fase 7 r2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ ASÍ
 * ─────────────────────────────────────────────────────────────────────────────
 * La ronda 1 encontró el bug más caro de esta fase: un chip de fecha que
 * quedaba DEBAJO del pie fijo del formulario — el tap caía en la franja y se
 * perdía en silencio. La lección no es "medir una vez": es que TODO control
 * interactivo, en TODO estado, tiene que poder llevarse a una posición donde el
 * tap le llegue a ÉL y no a la franja sticky.
 *
 * Esta batería mide, con `elementFromPoint` (el mismo criterio con el que un
 * dedo elige el elemento), cada control nuevo de la fase:
 *
 *   1. PANEL: botones «Importar CSV», «⌘ Buscar», botón de gasto y el chip de
 *      plantilla (sin modal, sin banda).
 *   2. FORMULARIO DE GASTO: los 11 controles (×, ☆, monto, cuenta, categoría,
 *      fecha y chips Hoy/Ayer, nota, Cancelar, Guardar). Cada uno se centra con
 *      scrollIntoView y se exige: el tap le llega, su centro queda FUERA de la
 *      banda del pie y dentro del viewport. Guardar/Cancelar viven EN la banda
 *      (exentos): se exige que el tap les llegue igual.
 *   3. PANEL DE PLANTILLA ABIERTO: nombre, Guardar y Cancelar del subpanel.
 *   4. SUGERENCIAS EN GASTO (abren hacia arriba) y EN TRANSFERENCIA (hacia
 *      abajo): cada ítem recibe el tap; se documenta cuáles caen en la banda y
 *      que el overlay (z-30) los gana; la banda no se mueve al abrirse.
 *   5. PALETA: TODOS sus ítems (no sólo el primero) se pueden centrar y
 *      recibir el tap, incluida la plantilla.
 *   6. IMPORTADOR CSV: campos y pie sticky propio (Cancelar/Previsualizar/
 *      Confirmar); después de previsualizar, el pie sigue en el viewport y
 *      Confirmar (ya habilitado) recibe el tap.
 *   7. Cierre: cero diálogos nativos, cero excepciones, cero escrituras.
 *
 * Datos propios (T_T7R2_UI4): cuentas, una plantilla y movimientos de 2027
 * para que existan sugerencias. No escribe movimientos; lo verifica contra la
 * línea base de hoy. Requiere server en :3000. Chrome propio en el puerto 9354.
 */

import {
  OUT_TMP,
  abrirModal,
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
  tapInfoPie,
} from "./lib.mjs";

const TAG = "T_T7R2_UI4";

runScript({
  tag: TAG,
  main: async (prisma) => {
    await prisma.favoriteTemplate.deleteMany({ where: { name: { startsWith: TAG } } });

    /* ── Fixtures ────────────────────────────────────────────────────────── */
    section("Preparación — cuentas, plantilla y movimientos con sugerencias");
    const banco = await prisma.account.create({
      data: { name: `${TAG} Banco`, kind: "BANK" },
    });
    const efectivo = await prisma.account.create({
      data: { name: `${TAG} Efectivo`, kind: "CASH" },
    });
    const fav = await post("/api/favorites", {
      name: `${TAG} Plantilla`,
      kind: "EXPENSE",
      amount: "987,65",
      description: `${TAG} nota`,
      categoryName: `${TAG} Comida`,
      accountId: banco.id,
      toAccountId: null,
    });
    check("plantilla creada → 201", fav.status, 201);

    for (const [i, monto] of ["4500", "4500", "4800"].entries()) {
      const r = await post("/api/transactions", {
        kind: "EXPENSE",
        amount: monto,
        date: `2027-06-0${i + 1}`,
        description: "Feria del barrio",
        accountId: banco.id,
        categoryName: `${TAG} Comida`,
      });
      check(`movimiento de sugerencia ${i + 1} → 201`, r.status, 201);
    }
    // Segundo grupo con la misma inicial: el desplegable de "fe" tiene 2 ítems.
    for (const [i, monto] of ["2100", "2300"].entries()) {
      const r = await post("/api/transactions", {
        kind: "EXPENSE",
        amount: monto,
        date: `2027-07-0${i + 1}`,
        description: "Feria de libros",
        accountId: banco.id,
        categoryName: `${TAG} Comida`,
      });
      check(`movimiento de sugerencia extra ${i + 1} → 201`, r.status, 201);
    }
    for (const [i, monto] of ["50000", "52000"].entries()) {
      const r = await post("/api/transactions", {
        kind: "TRANSFER",
        amount: monto,
        date: `2027-06-0${i + 3}`,
        description: "Traspaso geom",
        accountId: banco.id,
        toAccountId: efectivo.id,
      });
      check(`transferencia de sugerencia ${i + 1} → 201`, r.status, 201);
    }

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
      ui = await openUi({ port: 9354 });
      await abrirPanel(ui);
      await instrumentar(ui);

      /** Banda del pie sticky que contiene `footerSelector`. */
      const banda = (footerSelector) =>
        ui.evalJs(`(() => {
          const f = document.querySelector(${JSON.stringify(footerSelector)});
          const sticky = f ? (f.closest(".sticky") ?? f.parentElement) : null;
          if (!sticky) return null;
          const r = sticky.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        })()`);

      /** Centra cada selector (opcional) y lo mide con la banda indicada. */
      const medir = async (selectors, footerSelector, { scroll = true, titulo } = {}) => {
        const out = [];
        for (const sel of selectors) {
          if (scroll) {
            // La primera carga puede mover el layout DESPUÉS del primer scroll:
            // se repite hasta que el centro del control esté de verdad en el
            // viewport (máx. 4 intentos), en vez de confiar en un sleep fijo.
            for (let intento = 0; intento < 4; intento += 1) {
              await ui.evalJs(
                `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" })`,
              );
              await sleep(220);
              const centrado = await ui.evalJs(`(() => {
                const el = document.querySelector(${JSON.stringify(sel)});
                if (!el) return true;
                const r = el.getBoundingClientRect();
                const y = r.top + r.height / 2;
                return y >= 0 && y <= innerHeight;
              })()`);
              if (centrado) break;
            }
          }
          const infos =
            footerSelector === null
              ? await tapInfo(ui, [sel])
              : await tapInfoPie(ui, [sel], footerSelector);
          out.push(infos[0]);
        }
        imprimirTapInfo(titulo ?? "Puntos", out);
        return out;
      };

      /** Exige que cada control reciba el tap y no viva detrás de la banda. */
      const afirma = (resultados, exentos = []) => {
        for (const t of resultados) {
          if (!t.existe) {
            checkTrue(`${t.sel} existe`, false);
            continue;
          }
          checkTrue(`${t.sel}: el tap le llega`, t.toqueLlega === true, JSON.stringify(t));
          if (exentos.includes(t.sel)) {
            checkTrue(
              `${t.sel}: vive en el pie y aun así recibe el tap`,
              t.enBandaPie === true && t.toqueLlega === true,
              JSON.stringify(t),
            );
          } else {
            checkTrue(`${t.sel}: su centro queda FUERA de la banda`, t.enBandaPie === false, JSON.stringify(t));
            checkTrue(`${t.sel}: está en el viewport`, t.enViewport === true, JSON.stringify(t));
          }
        }
      };

      /** Toca con scroll previo y reintentos (ventana sorda documentada). */
      const tocarHasta = async (selector, condicion, label, intentos = 4) => {
        for (let i = 1; i <= intentos; i += 1) {
          await ui.evalJs(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
          );
          await sleep(i === 1 ? 220 : 280);
          await ui.clickEl(selector);
          try {
            await ui.waitFor(condicion, { timeout: 2500, label });
            return i;
          } catch {
            // Ventana sorda: se reintenta.
          }
        }
        throw new Error(`${selector} no produjo: ${label}`);
      };

      /** Cierra el formulario aunque tenga datos (aviso de descarte incluido). */
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

      /** Setter nativo + input (React) para textarea/input. */
      const setTexto = (selector, texto) =>
        ui.evalJs(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, ${JSON.stringify(texto)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return el.value.length;
        })()`);

      /* ── 1. Panel ────────────────────────────────────────────────────── */
      section("1 · Panel: botones nuevos y chip de plantilla (sin banda)");
      const chip = `#favorite-${fav.body.id}`;
      const infos1 = await medir(
        ["#btn-import-csv", "#btn-palette", "#btn-expense", chip],
        null,
        { titulo: "Panel (sin modal: no hay banda de pie)" },
      );
      for (const t of infos1) {
        checkTrue(`${t.sel}: existe y recibe el tap`, t.existe && t.toqueLlega === true, JSON.stringify(t));
        checkTrue(`${t.sel}: en el viewport`, t.existe && t.enViewport === true, JSON.stringify(t));
        checkTrue(`${t.sel}: sin banda (no hay modal abierto)`, t.enBandaPie === null, JSON.stringify(t));
      }
      check(
        "el chip muestra la plantilla",
        await ui.evalJs(
          `[...document.querySelectorAll('#favorites-list button[id^="favorite-"]')].some((el) => el.textContent.includes(${JSON.stringify(`${TAG} Plantilla`)}))`,
        ),
        true,
      );

      /* ── 2. Formulario de gasto ──────────────────────────────────────── */
      section("2 · Formulario de gasto: matriz completa contra la banda del pie");
      const reintentosGasto = await abrirModal(ui, "#btn-expense");
      console.log(`  · reintentos de apertura: ${reintentosGasto}`);
      const bandaGasto = await banda("#tx-submit");
      console.log(
        `  · banda del pie del form: y=${Math.round(bandaGasto.top)}..${Math.round(
          bandaGasto.bottom,
        )} (alto ${Math.round(bandaGasto.height)})`,
      );
      checkTrue(
        "la banda del pie está entera en el viewport",
        !!bandaGasto && bandaGasto.top > 0 && bandaGasto.bottom <= 557,
        JSON.stringify(bandaGasto),
      );

      const selsGasto = [
        "#tx-close",
        "#tx-save-favorite",
        "#tx-amount",
        "#tx-account",
        "#tx-category",
        "#tx-date",
        "#tx-date-hoy",
        "#tx-date-ayer",
        "#tx-description",
        "#tx-cancel",
        "#tx-submit",
      ];
      const infos2 = await medir(selsGasto, "#tx-submit", {
        exentos: ["#tx-cancel", "#tx-submit"],
        titulo: "Formulario de gasto (banda #tx-submit)",
      });
      afirma(infos2, ["#tx-cancel", "#tx-submit"]);

      // El pie queda pegado aun con el contenido scrolleado al tope.
      await ui.evalJs(`document.getElementById("tx-amount")?.scrollIntoView({ block: "start" })`);
      await sleep(250);
      const [submitArriba] = await tapInfoPie(ui, ["#tx-submit"], "#tx-submit");
      checkTrue(
        "con el scroll arriba, Guardar sigue recibiendo el tap",
        submitArriba?.toqueLlega === true,
        JSON.stringify(submitArriba),
      );

      /* ── 3. Panel de plantilla abierto ───────────────────────────────── */
      section("3 · Panel de plantilla abierto: nombre y los dos botones");
      const intentosPanel = await tocarHasta(
        "#tx-save-favorite",
        `!!document.getElementById("tx-favorite-panel")`,
        "el panel de plantilla",
      );
      console.log(`  · intentos para abrir el panel: ${intentosPanel}`);
      const bandaConPanel = await banda("#tx-submit");
      check(
        "abrir el panel no mueve la banda del pie",
        Math.round(bandaConPanel.top * 10) / 10,
        Math.round(bandaGasto.top * 10) / 10,
      );
      const infos3 = await medir(
        ["#tx-favorite-name", "#tx-favorite-save", "#tx-favorite-cancel"],
        "#tx-submit",
        { titulo: "Panel de plantilla (banda #tx-submit)" },
      );
      afirma(infos3);

      await ui.evalJs(`document.getElementById("tx-favorite-cancel")?.click()`);
      await ui.waitFor(`!document.getElementById("tx-favorite-panel")`, {
        timeout: 4000,
        label: "el cierre del panel de plantilla",
      });
      check(
        "el panel de plantilla se cierra por Cancelar",
        await ui.evalJs(`!!document.getElementById("tx-favorite-panel")`),
        false,
      );

      /* ── 4. Sugerencias en gasto (abren hacia arriba) ────────────────── */
      section("4 · Sugerencias en GASTO: ítems alcanzables y banda inmóvil");
      await ui.evalJs(`document.getElementById("tx-description")?.scrollIntoView({ block: "center" })`);
      await sleep(200);
      await ui.evalJs(`document.getElementById("tx-description")?.focus()`);
      await ui.insertText("fe");
      await ui.waitFor(`!!document.getElementById("tx-description-suggestions")`, {
        timeout: 6000,
        label: "el desplegable de gasto",
      });
      await sleep(250);
      const selsDrop = ["#tx-description-suggestion-0", "#tx-description-suggestion-1"];
      const infos4 = await medir(selsDrop, "#tx-submit", {
        scroll: false,
        titulo: "Sugerencias en gasto (sin scrollear: posición real)",
      });
      for (const t of infos4) {
        checkTrue(`${t.sel}: el ítem recibe el tap`, t.toqueLlega === true, JSON.stringify(t));
        checkTrue(`${t.sel}: visible en el viewport`, t.existe && t.enViewport === true, JSON.stringify(t));
        checkTrue(`${t.sel}: no recortado por el contenedor`, t.recortado === false, JSON.stringify(t));
      }
      const bandaConDrop = await banda("#tx-submit");
      check(
        "abrir el desplegable no mueve la banda del pie",
        Math.round(bandaConDrop.top * 10) / 10,
        Math.round(bandaGasto.top * 10) / 10,
      );
      const enBanda = infos4.filter((t) => t.enBandaPie);
      console.log(
        `  · ítems cuyo centro cae en la banda: ${enBanda.length}` +
          (enBanda.length ? ` → ${enBanda.map((t) => t.sel).join(", ")} (el overlay z-30 los gana)` : ""),
      );
      const yPrimero = infos4[0]?.y;
      console.log(`  · centro del primer ítem: y=${Math.round(yPrimero)}`);

      await ui.press("Escape");
      await sleep(300);
      const trasEscapeDrop = await ui.evalJs(`({
        drop: !!document.getElementById("tx-description-suggestions"),
        form: !!document.getElementById("tx-submit"),
        warn: !!document.getElementById("tx-discard-warning"),
      })`);
      check("Escape cierra sólo el desplegable", trasEscapeDrop.drop, false);
      check("el formulario sigue abierto", trasEscapeDrop.form, true);
      check("y no aparece el aviso de descarte", trasEscapeDrop.warn, false);

      /* ── 5. Sugerencias en transferencia (abren hacia abajo) ─────────── */
      section("5 · Sugerencias en TRANSFERENCIA: abren hacia abajo y se tocan");
      await cerrarForm(ui);
      await abrirModal(ui, "#btn-transfer");
      await ui.evalJs(`document.getElementById("tx-description")?.scrollIntoView({ block: "center" })`);
      await sleep(200);
      await ui.evalJs(`document.getElementById("tx-description")?.focus()`);
      await ui.insertText("tra");
      await ui.waitFor(`!!document.getElementById("tx-description-suggestions")`, {
        timeout: 6000,
        label: "el desplegable de transferencia",
      });
      await sleep(250);
      const [infoTrans] = await medir(["#tx-description-suggestion-0"], "#tx-submit", {
        scroll: false,
        titulo: "Sugerencias en transferencia (sin scrollear)",
      });
      checkTrue("el ítem de transferencia recibe el tap", infoTrans?.toqueLlega === true, JSON.stringify(infoTrans));
      checkTrue("no queda recortado por el contenedor", infoTrans?.recortado === false, JSON.stringify(infoTrans));
      const posicionTransfer = await ui.evalJs(`(() => {
        const dd = document.getElementById("tx-description-suggestions")?.getBoundingClientRect();
        const campo = document.getElementById("tx-description")?.getBoundingClientRect();
        return dd && campo ? { ddTop: dd.top, campoBottom: campo.bottom } : null;
      })()`);
      checkTrue(
        "el desplegable abre hacia ABAJO del campo",
        !!posicionTransfer && posicionTransfer.ddTop >= posicionTransfer.campoBottom - 2,
        JSON.stringify(posicionTransfer),
      );
      await cerrarForm(ui);

      /* ── 6. Paleta: TODOS los ítems ─────────────────────────────────── */
      section("6 · Paleta: todos los ítems se centran y reciben el tap");
      const ctrlK = async () => {
        const base = {
          key: "k",
          code: "KeyK",
          windowsVirtualKeyCode: 75,
          nativeVirtualKeyCode: 75,
          modifiers: 2,
        };
        await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
        await sleep(25);
        await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await sleep(60);
      };
      let abiertaPaleta = false;
      for (let i = 0; i < 4 && !abiertaPaleta; i += 1) {
        await ctrlK();
        try {
          await ui.waitFor(`!!document.getElementById("command-palette")`, {
            timeout: 2500,
            label: "la paleta",
          });
          abiertaPaleta = true;
        } catch {
          // Ventana sorda: se reintenta.
        }
      }
      check("la paleta se abrió con Ctrl+K", abiertaPaleta, true);
      await ui.waitFor(
        `document.querySelectorAll('#palette-listbox [role="option"]').length >= 10`,
        { timeout: 12000, label: "las plantillas en la paleta" },
      );
      const totalPaleta = await ui.evalJs(
        `document.querySelectorAll('#palette-listbox [role="option"]').length`,
      );
      const selsPaleta = Array.from({ length: totalPaleta }, (_, i) => `#palette-item-${i}`);
      console.log(`  · ítems de la paleta: ${totalPaleta}`);
      checkTrue("la paleta trae las 9 acciones + la plantilla", totalPaleta >= 10, String(totalPaleta));
      const infos6 = await medir(selsPaleta, null, {
        titulo: "Paleta (ítem por ítem, centrado en la lista)",
      });
      for (const t of infos6) {
        checkTrue(`${t.sel}: el tap le llega`, t.existe && t.toqueLlega === true, JSON.stringify(t));
        checkTrue(`${t.sel}: en el viewport`, t.existe && t.enViewport === true, JSON.stringify(t));
      }
      await ui.press("Escape");
      await sleep(250);
      check("la paleta se cerró por Escape", await ui.evalJs(`!!document.getElementById("command-palette")`), false);

      /* ── 7. Importador CSV: campos y pie sticky propio ───────────────── */
      section("7 · Importador CSV: campos, pie sticky y estado de preview");
      const intentosCsv = await tocarHasta(
        "#btn-import-csv",
        `!!document.getElementById("csv-text")`,
        "el importador CSV",
      );
      console.log(`  · intentos para abrir el importador: ${intentosCsv}`);
      const bandaCsv = await banda("#csv-confirm");
      console.log(
        `  · banda del pie del CSV: y=${Math.round(bandaCsv.top)}..${Math.round(
          bandaCsv.bottom,
        )} (alto ${Math.round(bandaCsv.height)})`,
      );
      checkTrue(
        "el pie del importador está entero en el viewport",
        !!bandaCsv && bandaCsv.top > 0 && bandaCsv.bottom <= 557,
        JSON.stringify(bandaCsv),
      );

      const exentosCsv = ["#csv-cancel", "#csv-preview-button", "#csv-confirm"];
      const selsCsv = ["#csv-close", "#csv-text", "#csv-file", ...exentosCsv];
      const infos7 = await medir(selsCsv, "#csv-confirm", {
        exentos: exentosCsv,
        titulo: "Importador CSV (banda #csv-confirm)",
      });
      afirma(infos7, exentosCsv);
      check(
        "Confirmar arranca deshabilitado (sin preview)",
        await ui.evalJs(`document.getElementById("csv-confirm").disabled`),
        true,
      );

      // Preview con datos válidos: el modal crece y el pie debe seguir ahí.
      const csv = [
        "fecha,tipo,monto,cuenta,categoria,descripcion",
        `2027-06-01,EXPENSE,1500,${TAG} Banco,${TAG} Comida,Feria uno`,
        `2027-06-02,INCOME,2500,${TAG} Banco,,Ingreso uno`,
      ].join("\n");
      await setTexto("#csv-text", csv);
      await sleep(200);
      await ui.evalJs(`document.getElementById("csv-preview-button")?.click()`);
      let previewOk = true;
      try {
        await ui.waitFor(`!!document.getElementById("csv-summary")`, {
          timeout: 10000,
          label: "la previsualización",
        });
      } catch {
        previewOk = false;
      }
      if (!previewOk) {
        await ui.evalJs(`document.getElementById("csv-preview-button")?.click()`);
        await ui.waitFor(`!!document.getElementById("csv-summary")`, {
          timeout: 10000,
          label: "la previsualización (reintento)",
        });
      }
      check("la previsualización apareció", await ui.evalJs(`!!document.getElementById("csv-summary")`), true);
      check(
        "Confirmar se habilitó con el preview válido",
        await ui.evalJs(`document.getElementById("csv-confirm").disabled`),
        false,
      );
      const bandaCsvPreview = await banda("#csv-confirm");
      console.log(
        `  · banda antes del preview: y=${Math.round(bandaCsv.top)}..${Math.round(
          bandaCsv.bottom,
        )} · después: y=${Math.round(bandaCsvPreview.top)}..${Math.round(bandaCsvPreview.bottom)}`,
      );
      checkTrue(
        "tras previsualizar, el pie sigue entero en el viewport",
        !!bandaCsvPreview && bandaCsvPreview.top > 0 && bandaCsvPreview.bottom <= 557,
        JSON.stringify(bandaCsvPreview),
      );
      const infos7b = await medir(
        ["#csv-close", "#csv-text", ...exentosCsv],
        "#csv-confirm",
        { exentos: exentosCsv, titulo: "Importador CSV con preview (banda #csv-confirm)" },
      );
      afirma(infos7b, exentosCsv);
      check(
        "no se importó nada (preview no escribe)",
        await ui.evalJs(`!!document.getElementById("csv-result")`),
        false,
      );

      await ui.evalJs(`document.getElementById("csv-close")?.click()`);
      await ui.waitFor(`!document.getElementById("csv-text")`, {
        timeout: 4000,
        label: "el cierre del importador",
      });
      check("el importador se cierra sin importar", await ui.evalJs(`!!document.getElementById("csv-text")`), false);

      /* ── 8. Cierre ───────────────────────────────────────────────────── */
      section("8 · Cierre");
      const dialogos = await dialogosNativos(ui);
      check("ningún diálogo nativo en todo el recorrido", (dialogos ?? []).length, 0);
      const errores = await ui.evalJs(`(window.__t7r2 ? window.__t7r2.errores : null)`);
      check("ninguna excepción de página", (errores ?? []).length, 0);
      const imports = await pedidosA(ui, "/api/import/csv");
      check(
        "ningún POST de importación (sólo preview)",
        imports.filter((f) => f.method === "POST" && !f.url.includes("/preview")).length,
        0,
      );
      const txs = await pedidosA(ui, "/api/transactions");
      check(
        "ningún POST /api/transactions",
        txs.filter((f) => f.method === "POST").length,
        0,
      );
      await ui.screenshot(`${OUT_TMP}/t7r2-ui04-geometria.png`);
      const idsFinal = await idsHoy();
      check("los movimientos de hoy no cambiaron", idsFinal.join(","), baseline.join(","));
    } finally {
      await ui?.close();
      await prisma.favoriteTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
    }
  },
});
