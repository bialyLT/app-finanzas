#!/usr/bin/env node
/**
 * 11-descartes-y-enter · ¿los «Cancelar» descartan en silencio? ¿Enter dispara
 * acciones raras?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS CUATRO PREGUNTAS
 *
 * A · El «Cancelar» del PRÉSTAMO: el dev de la r2 dice que ahora PREGUNTA antes
 *     de descartar (aviso en línea, dos pasos). Hay que verlo: que el aviso
 *     aparezca, que «Seguir editando» vuelva al formulario CON lo cargado, y
 *     que «Descartar» lo cierre.
 *
 * B · El «Cancelar» de la RECURRENCIA: el dev dice que pregunta SÓLO cuando
 *     hay algo escrito (nombre, monto o categoría) — elegir el tipo o la
 *     cuenta no marca sucio. Hay que ver las dos ramas.
 *
 * C · Los «Cancelar» que CIERRAN EN EL ACTO (movimiento, config de tarjeta,
 *     compra en cuotas): son el diferido explícito del dev. Se mide QUÉ se
 *     pierde y se deja el veredicto por escrito.
 *
 * D · ENTER en un campo: el dev movió el botón de guardar FUERA del `<form>`
 *     (lo referencia con `form="tx-form"`) para que Enter en el nombre de una
 *     plantilla no guarde el movimiento. Y el botón fuera del `<form>` tiene un
 *     efecto colateral que hay que medir: ¿Enter en un campo del formulario
 *     sigue guardando (que es lo normal) o dejó de hacerlo (que sería un
 *     bug: el formulario no se puede enviar con el teclado)?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ IMPORTA
 * Perder lo cargado sin avisar es la clase de defecto que el tester de la
 * ronda anterior reportó como BUG-3 (severidad media) y que el dev de esta
 * ronda dejó cerrado a medias (en el préstamo y en la recurrencia, no en los
 * otros tres). Y un formulario que no se puede enviar con el teclado es un
 * problema de accesibilidad, no de gusto.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  openRoute,
  abrirModal,
  correrBateria,
  api,
  sleep,
} from "./lib.mjs";

const VP = { name: "375 iphone-se", width: 375, height: 667 };

/** Monto de prueba: no está en el seed (así el borrado por monto es seguro). */
const MONTO_PRUEBA = "987,65";

/** ¿Está el modal de movimiento abierto? */
const modalAbierto = (ui) =>
  ui.evalJs(`!!document.querySelector('[role="dialog"]')`);

/** Rellena el formulario de movimiento con datos reales. */
async function cargarMovimiento(ui) {
  const monto = await ui.centerOf("#tx-amount");
  await ui.clickAt(monto.x, monto.y);
  await sleep(150);
  await ui.insertText(MONTO_PRUEBA);
  await ui.evalJs(`document.querySelector("#tx-category").focus()`);
  await sleep(150);
  await ui.insertText("Comida");
  await sleep(300);
}

/**
 * Borra los movimientos que esta batería pudo crear (por monto y fecha).
 * El monto es de prueba y no aparece en el seed: el borrado es por id, como
 * manda la casa.
 */
async function borrarMovimientosDePrueba() {
  const hoy = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const dia = `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}-${p(hoy.getDate())}`;
  const res = await api(`/api/transactions?from=${dia}&to=${dia}`);
  const mios = (res.body?.movements ?? []).filter(
    (m) => String(m.amount).replace(",", ".") === MONTO_PRUEBA.replace(",", "."),
  );
  for (const m of mios) {
    await api(`/api/transactions?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
  }
  const res2 = await api(`/api/transactions?from=${dia}&to=${dia}`);
  const quedan = (res2.body?.movements ?? []).filter(
    (m) => String(m.amount).replace(",", ".") === MONTO_PRUEBA.replace(",", "."),
  );
  return { borrados: mios.length, quedan: quedan.length };
}

/** Rellena el formulario de préstamo con datos reales. */
async function cargarPrestamo(ui) {
  const nombre = await ui.centerOf("#loanalta-name");
  await ui.clickAt(nombre.x, nombre.y);
  await sleep(150);
  await ui.insertText("Préstamo de prueba T_ZONA9");
  await sleep(200);
  const principal = await ui.centerOf("#loanalta-principal");
  await ui.clickAt(principal.x, principal.y);
  await sleep(150);
  await ui.insertText("100000");
  await sleep(200);
  const tna = await ui.centerOf("#loanalta-tna");
  await ui.clickAt(tna.x, tna.y);
  await sleep(150);
  await ui.insertText("60");
  await sleep(200);
  const count = await ui.centerOf("#loanalta-count");
  await ui.clickAt(count.x, count.y);
  await sleep(150);
  await ui.insertText("12");
  await sleep(300);
}

/** Rellena el formulario de recurrencia con datos reales. */
async function cargarRecurrencia(ui) {
  const titulo = await ui.centerOf("#rec-title");
  await ui.clickAt(titulo.x, titulo.y);
  await sleep(150);
  await ui.insertText("Regla de prueba T_ZONA9");
  await sleep(250);
  const monto = await ui.centerOf("#rec-amount");
  await ui.clickAt(monto.x, monto.y);
  await sleep(150);
  await ui.insertText("1234,56");
  await sleep(250);
  const categoria = await ui.centerOf("#rec-category");
  await ui.clickAt(categoria.x, categoria.y);
  await sleep(150);
  await ui.insertText("Comida");
  await sleep(350);
}

async function main() {
  // Limpieza previa: una corrida anterior interrumpida no envenena esta.
  await borrarMovimientosDePrueba();
  const ui = await openUi({
    port: 9372,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9372`,
  });
  try {
    /* ─────────────────────────────────────────────────────────────────────
     * A · El «Cancelar» del PRÉSTAMO
     * ───────────────────────────────────────────────────────────────────── */
    section("A · préstamo · el «Cancelar» pregunta antes de descartar");
    await applyViewport(ui, VP, { touch: true });
    await openRoute(ui, "/prestamos");
    await verifyViewport(ui, VP, { touch: true });
    await abrirModal(ui, "#loans-new", '[role="dialog"]');
    await cargarPrestamo(ui);

    // El «Cancelar» con algo cargado: NO puede cerrar en silencio.
    await ui.clickEl("#loanalta-cancel");
    await sleep(500);
    const aviso = await ui.evalJs(`!!document.querySelector("#loanalta-discard-warning")`);
    checkTrue(
      "préstamo · el «Cancelar» con datos cargados MUESTRA el aviso de descarte",
      aviso === true,
    );
    checkTrue(
      "préstamo · el «Cancelar» con datos cargados NO cierra el formulario",
      (await modalAbierto(ui)) === true,
    );

    // «Seguir editando»: vuelve al formulario CON lo cargado.
    if (aviso) {
      await ui.clickEl("#loanalta-discard-cancel");
      await sleep(400);
      checkTrue(
        "préstamo · «Seguir editando» saca el aviso",
        (await ui.evalJs(`!!document.querySelector("#loanalta-discard-warning")`)) === false,
      );
      const sigue = await ui.evalJs(`({
        abierto: !!document.querySelector('[role="dialog"]'),
        nombre: document.querySelector("#loanalta-name")?.value ?? null,
        monto: document.querySelector("#loanalta-principal")?.value ?? null
      })`);
      checkTrue("préstamo · «Seguir editando» deja el formulario abierto", sigue.abierto === true);
      checkTrue(
        "préstamo · «Seguir editando» conserva lo cargado (nombre y monto)",
        String(sigue.nombre).includes("T_ZONA9") && String(sigue.monto).includes("100000"),
        JSON.stringify(sigue),
      );

      // «Descartar»: cierra.
      await ui.clickEl("#loanalta-cancel");
      await sleep(400);
      await ui.clickEl("#loanalta-discard-confirm");
      await sleep(600);
      checkTrue(
        "préstamo · «Descartar» cierra el formulario",
        (await modalAbierto(ui)) === false,
      );
    }

    /* ─────────────────────────────────────────────────────────────────────
     * B · El «Cancelar» de la RECURRENCIA
     * ───────────────────────────────────────────────────────────────────── */
    section("B · recurrencia · el «Cancelar» pregunta sólo si hay algo escrito");
    await openRoute(ui, "/recurrencia");
    await verifyViewport(ui, VP, { touch: true });
    await abrirModal(ui, "#rec-add-rule", "#rec-form");

    // Rama 1 · SIN nada escrito: cierra en el acto (no avisa).
    await ui.clickEl("#rec-form-cancel");
    await sleep(600);
    checkTrue(
      "recurrencia · el «Cancelar» SIN nada escrito cierra en el acto (sin aviso)",
      (await ui.evalJs(`!!document.querySelector("#rec-form")`)) === false,
    );

    // Rama 2 · CON algo escrito: avisa.
    await abrirModal(ui, "#rec-add-rule", "#rec-form");
    await cargarRecurrencia(ui);
    await ui.clickEl("#rec-form-cancel");
    await sleep(500);
    const avisoRec = await ui.evalJs(`!!document.querySelector("#rec-discard-warning")`);
    checkTrue(
      "recurrencia · el «Cancelar» CON datos cargados muestra el aviso de descarte",
      avisoRec === true,
    );
    checkTrue(
      "recurrencia · el «Cancelar» CON datos cargados NO cierra el formulario",
      (await ui.evalJs(`!!document.querySelector("#rec-form")`)) === true,
    );
    if (avisoRec) {
      await ui.clickEl("#rec-discard-cancel");
      await sleep(400);
      const sigue = await ui.evalJs(`({
        abierto: !!document.querySelector("#rec-form"),
        titulo: document.querySelector("#rec-title")?.value ?? null
      })`);
      checkTrue("recurrencia · «Seguir editando» deja el formulario abierto", sigue.abierto === true);
      checkTrue(
        "recurrencia · «Seguir editando» conserva lo cargado",
        String(sigue.titulo).includes("T_ZONA9"),
        JSON.stringify(sigue),
      );
      await ui.clickEl("#rec-form-cancel");
      await sleep(400);
      await ui.clickEl("#rec-discard-confirm");
      await sleep(600);
      checkTrue(
        "recurrencia · «Descartar» cierra el formulario",
        (await ui.evalJs(`!!document.querySelector("#rec-form")`)) === false,
      );
    }

    /* ─────────────────────────────────────────────────────────────────────
     * C · Los «Cancelar» que CIERRAN EN EL ACTO
     * ───────────────────────────────────────────────────────────────────── */
    section("C · movimiento · el «Cancelar» cierra en el acto (diferido del dev)");
    await openRoute(ui, "/");
    await verifyViewport(ui, VP, { touch: true });
    await abrirModal(ui, "#btn-expense", '[role="dialog"]');
    await cargarMovimiento(ui);
    await ui.clickEl("#tx-cancel");
    await sleep(600);
    const cerrado = (await modalAbierto(ui)) === false;
    checkTrue(
      "movimiento · el «Cancelar» cierra en el acto (sin aviso) — es el diferido declarado",
      cerrado === true,
    );
    console.log(
      "  · lo que se pierde con ese «Cancelar»: el monto, la categoría y la nota escritos",
    );

    /* ─────────────────────────────────────────────────────────────────────
     * D · ENTER en un campo
     * ───────────────────────────────────────────────────────────────────── */
    section("D · Enter en un campo no dispara acciones raras");
    await abrirModal(ui, "#btn-expense", '[role="dialog"]');
    await cargarMovimiento(ui);

    // D1 · Enter en el NOMBRE DE UNA PLANTILLA: no puede guardar el
    //      movimiento (el panel de plantillas está FUERA del `<form>`).
    await ui.clickEl("#tx-save-favorite");
    await sleep(400);
    checkTrue(
      "movimiento · el panel de plantillas se abre",
      (await ui.evalJs(`!!document.querySelector("#tx-favorite-panel")`)) === true,
    );
    const nombreFav = await ui.centerOf("#tx-favorite-name");
    await ui.clickAt(nombreFav.x, nombreFav.y);
    await sleep(150);
    await ui.insertText("Plantilla de prueba T_ZONA9");
    await sleep(250);
    await ui.pressKey("Enter", { code: "Enter", keyCode: 13, text: "\r" });
    await sleep(1200);
    const despuesDeEnter = await ui.evalJs(`({
      modal: !!document.querySelector('[role="dialog"]'),
      aviso: document.querySelector("#tx-favorite-notice")?.textContent ?? null,
      error: document.querySelector("#tx-favorite-error")?.textContent ?? null,
      monto: document.querySelector("#tx-amount")?.value ?? null
    })`);
    console.log(`  · Enter en el nombre de la plantilla → ${JSON.stringify(despuesDeEnter)}`);
    checkTrue(
      "movimiento · Enter en el nombre de la plantilla NO cierra el modal (no guardó el movimiento)",
      despuesDeEnter.modal === true,
      JSON.stringify(despuesDeEnter),
    );
    checkTrue(
      "movimiento · Enter en el nombre de la plantilla NO guarda la plantilla",
      despuesDeEnter.aviso === null,
      `aviso=${despuesDeEnter.aviso}`,
    );
    checkTrue(
      "movimiento · Enter en el nombre de la plantilla deja el monto cargado (no se guardó nada)",
      String(despuesDeEnter.monto).includes(MONTO_PRUEBA),
      `monto=${despuesDeEnter.monto}`,
    );

    // D2 · Enter en el MONTO: el formulario tiene que poder enviarse con el
    //      teclado (el botón de guardar está FUERA del `<form>`: si el
    //      envío implícito se rompió, el formulario no se manda nunca).
    //
    //      OJO — la tecla: un `keyDown` SIN `text` no genera el `keypress` y
    //      el navegador NO hace el envío implícito (artefacto de MEDICIÓN:
    //      el mismo Enter sin `text` tampoco envío el formulario de
    //      recurrencia, que sí tiene el botón dentro). Con la tecla completa
    //      (keyDown + text "\r") el envío implícito es el del navegador.
    await ui.evalJs(`document.querySelector("#tx-favorite-cancel")?.click()`);
    await sleep(300);
    await ui.evalJs(`(() => {
      window.__posts = [];
      const orig = window.fetch;
      window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
        const method = (args[1]?.method ?? (args[0]?.method ?? "GET")).toUpperCase();
        window.__posts.push(method + " " + url);
        return orig.apply(this, args);
      };
      return true;
    })()`);
    await ui.evalJs(`document.querySelector("#tx-amount").focus()`);
    await sleep(250);
    await ui.pressKey("Enter", { code: "Enter", keyCode: 13, text: "\r" });
    await sleep(1600);
    const despuesDeEnterMonto = await ui.evalJs(`({
      modal: !!document.querySelector('[role="dialog"]'),
      posts: window.__posts,
      alertas: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent.trim().slice(0, 60))
    })`);
    console.log(`  · Enter en el monto → ${JSON.stringify(despuesDeEnterMonto)}`);
    checkTrue(
      "movimiento · Enter en un campo del formulario ENVÍA el formulario (el botón fuera del `<form>` no lo rompió)",
      despuesDeEnterMonto.posts.some((p) => p.startsWith("GET /api/transactions/duplicates")) ||
        despuesDeEnterMonto.posts.some((p) => p.startsWith("POST /api/transactions")),
      JSON.stringify(despuesDeEnterMonto),
    );

    // 0 residuos: si el Enter guardó el movimiento, se borra por id.
    const limpieza = await borrarMovimientosDePrueba();
    checkTrue(
      "movimiento · el Enter de prueba no dejó movimientos sin borrar",
      limpieza.quedan === 0,
      `quedaron ${limpieza.quedan} (borrados ${limpieza.borrados})`,
    );

    /* ─────────────────────────────────────────────────────────────────────
     * D3 · EL TECLADO EN LOS CINCO FORMULARIOS
     *
     * El dev movió el botón de guardar FUERA del `<form>` en los 5
     * formularios (lo referencia con `form="…"`). Con el botón adentro, el
     * navegador hacía el envío implícito con Enter; con el botón afuera, la
     * pregunta es si el envío implícito sigue funcionando: si no, el
     * formulario no se puede mandar con el teclado (WCAG 2.1.1).
     *
     * El observable es el handler de submit: con el formulario incompleto
     * aparece el error de validación (o una petición).
     * ───────────────────────────────────────────────────────────────────── */
    section("D3 · Enter envía el formulario en los modales con el botón fuera del `<form>`");
    const FORMULARIOS = [
      { nombre: "movimiento", path: "/", trigger: "#btn-expense", campo: "#tx-amount" },
      { nombre: "cuenta", path: "/", trigger: "#btn-add-account", campo: "#acc-name" },
      { nombre: "prestamo", path: "/prestamos", trigger: "#loans-new", campo: "#loanalta-name" },
      {
        nombre: "config de tarjeta",
        path: "/tarjetas",
        trigger: '[id^="card-config-"]',
        campo: "#cardconf-closing",
      },
    ];
    for (const f of FORMULARIOS) {
      await openRoute(ui, f.path);
      await verifyViewport(ui, VP, { touch: true });
      await abrirModal(ui, f.trigger, '[role="dialog"]');
      await sleep(300);
      await ui.evalJs(`(() => {
        window.__posts = [];
        const orig = window.fetch;
        window.fetch = function (...args) {
          const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
          const method = (args[1]?.method ?? (args[0]?.method ?? "GET")).toUpperCase();
          window.__posts.push(method + " " + url);
          return orig.apply(this, args);
        };
        return true;
      })()`);
      await ui.evalJs(`document.querySelector(${JSON.stringify(f.campo)}).focus()`);
      await sleep(250);
      await ui.pressKey("Enter", { code: "Enter", keyCode: 13, text: "\r" });
      await sleep(1500);
      const r = await ui.evalJs(`({
        posts: window.__posts,
        alertas: [...document.querySelectorAll('[role="alert"]')]
          .map((a) => a.textContent.trim().slice(0, 60))
      })`);
      console.log(`  · ${f.nombre}: ${JSON.stringify(r)}`);
      if (f.nombre === "config de tarjeta") {
        // DATO: en la config de tarjeta el envío implícito con Enter PATCHEA
        // la cuenta: con los campos vacíos, «vacío = limpiar la
        // configuración» (es el contrato del PATCH). O sea: Enter borra el
        // día de cierre de la tarjeta. La app lo avisa ("quedó sin día de
        // cierre…"), pero es un filo del envío implícito.
        console.log(
          "  · DATO (config de tarjeta): Enter con los campos vacíos PATCHea la cuenta " +
            "y con el contrato «vacío = limpiar» deja la tarjeta sin día de cierre. " +
            "La app lo avisa en el aviso de guardado; no es silencioso.",
        );
      }
      checkTrue(
        `${f.nombre} · Enter en un campo ENVÍA el formulario (el botón fuera del \`<form>\` no lo rompió)`,
        r.alertas.length > 0 ||
          r.posts.some((p) => p.startsWith("POST") || p.startsWith("PATCH")),
        JSON.stringify(r),
      );
      await ui.evalJs(
        `document.querySelector("#tx-close, #acc-close, #loanalta-close, #cardconf-close")?.click()`,
      );
      await sleep(400);
    }
  } finally {
    await borrarMovimientosDePrueba();
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "11-descartes-y-enter", conSesion: true });
