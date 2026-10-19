#!/usr/bin/env node
/**
 * ui-06 · ATAQUE H — el modal de carga rápida por dentro
 *
 * El contrato que ataca (components/TransactionForm.tsx):
 *   · El backdrop NO cierra por clic afuera (no tiene onClick): la salida
 *     implícita del modal es Escape, y con datos escritos es en DOS PASOS:
 *     primer Escape → aviso INLINE `tx-discard-warning` ("Seguir editando" /
 *     "Descartar"), segundo Escape (o "Descartar") → cierra. Nunca diálogos
 *     nativos (el driver de los tests no puede contestarlos).
 *   · "Seguir editando" (#tx-discard-cancel) vuelve sin perder nada.
 *   · Cambiar de tipo ida y vuelta (gasto↔ingreso, transferencia↔gasto) NO
 *     pierde monto, nota ni categoría; la cuenta se conserva si sigue siendo
 *     válida; el destino de la transferencia se conserva y nunca se re-elige
 *     solo.
 *   · Las salidas EXPLÍCITAS (#tx-cancel, #tx-close ×) cierran directo, sin
 *     aviso: son intención declarada, no un accidente.
 *
 * Método:
 *   · Clics con CDP sobre la ventana real; el clic afuera va a (50,50) y el
 *     caso sólo vale si ese punto cae FUERA del formulario (se verifica).
 *   · La "ventana sorda" del CDP (clics que la página recibe sin reacción de
 *     React) haría pasar un "no cerró" por diseño. Para que un "no cerró" sea
 *     evidencia, un capturador en document cuenta clicks y keydowns: cada
 *     caso afirma que su gesto LLEGÓ antes de interpretar la reacción.
 *   · Escape es tecla real (Input.dispatchKeyEvent) con reintento acotado;
 *     tipear es insertText sobre el campo enfocado (select-all previo).
 *   · Esta batería NO guarda nada: la invariante final es que el día quede
 *     idéntico a la línea base (más red de seguridad por monto en el finally).
 *
 * Requiere: server en :3000 y Chrome CDP 9341 (se lanza y se mata solo).
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  check,
  checkDeep,
  checkTrue,
  cuentas,
  del,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_MODAL";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runScript({
  tag: TAG,
  main: async (_prisma) => {
    const ui = await openUi({ port: 9341 });
    const hoy = localToday();
    const creados = new Set();
    const montosUsados = new Set();
    let baselineIds = new Set();

    const idsDeHoy = async () => {
      const res = await movimientosDe(hoy, hoy);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return new Set((res.body?.movements ?? []).map((m) => m.id));
    };

    const borrar = async (id) => {
      await del(`/api/transactions?id=${id}`);
      creados.delete(id);
    };

    /** Abre el modal de `btnSelector` con reintentos (ventana sorda del CDP). */
    const abrirCon = async (btnSelector) => {
      for (let intento = 0; intento < 4; intento += 1) {
        await ui.evalJs(`document.querySelector(${JSON.stringify(btnSelector)}).scrollIntoView({ block: "center" })`);
        await sleep(intento === 0 ? 250 : 300);
        await ui.clickEl(btnSelector);
        try {
          await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2500, label: "el modal" });
          return;
        } catch {
          // Reintento: el click cayó en la ventana sorda.
        }
      }
      await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2000, label: "el modal tras los reintentos" });
    };

    /**
     * Clic real con reintento acotado hasta que la condición se cumpla.
     * Devuelve cuántos intentos hicieron falta (0 = el primero anduvo).
     */
    const clickHasta = async (selector, condicion, label) => {
      for (let intento = 0; intento < 3; intento += 1) {
        await ui.clickEl(selector);
        try {
          await ui.waitFor(condicion, { timeout: 2500, label });
          return intento;
        } catch {
          console.log(`  AVISO ${label}: el clic no reaccionó (intento ${intento + 1}/3); se reintenta.`);
        }
      }
      await ui.waitFor(condicion, { timeout: 2000, label: `${label} tras reintentos` });
      return 3;
    };

    /**
     * Tipea en un campo por id (focus programático + insertText). Antes de
     * insertar selecciona todo: si un intento previo dejó texto a medias o
     * repetido, el nuevo insert lo REEMPLAZA en vez de apilarse.
     */
    const tipearEn = async (selector, texto) => {
      for (let intento = 0; intento < 2; intento += 1) {
        await ui.evalJs(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          el.focus();
          if (el.select) el.select();
          return true;
        })()`);
        await sleep(80);
        await ui.insertText(texto);
        const valor = await ui.evalJs(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
        if (valor === texto) return;
      }
      check(`el texto "${texto}" quedó tipeado en ${selector}`, await ui.evalJs(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`), texto);
    };

    /** Estado del modal: tipo activo + todos los campos que importan. */
    const estado = () =>
      ui.evalJs(`(() => {
        const activo = ["tx-kind-gasto", "tx-kind-ingreso", "tx-kind-transferencia"].find(
          (id) => document.getElementById(id)?.getAttribute("aria-pressed") === "true",
        ) ?? null;
        return {
          activo,
          monto: document.getElementById("tx-amount")?.value ?? null,
          nota: document.getElementById("tx-description")?.value ?? null,
          categoria: document.getElementById("tx-category")?.value ?? null,
          cuenta: document.getElementById("tx-account")?.value ?? null,
          destino: document.getElementById("tx-to-account")?.value ?? null,
          hayDestino: !!document.getElementById("tx-to-account"),
        };
      })()`);

    /** Escape real hasta que aparezca el aviso de descarte (o se acabe el aire). */
    const escapeHastaAviso = async () => {
      for (let intento = 0; intento < 3; intento += 1) {
        await ui.press("Escape");
        await sleep(300);
        if (await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)) return true;
      }
      return false;
    };

    /** Escape real hasta que el modal cierre; devuelve los intentos usados. */
    const escapeHastaCierre = async (label) => {
      for (let intento = 0; intento < 4; intento += 1) {
        if (!(await ui.evalJs(`!!document.getElementById("tx-submit")`))) return intento;
        await ui.press("Escape");
        await sleep(300);
        if (intento > 0) console.log(`  AVISO ${label}: reintento ${intento}/4.`);
      }
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 2000, label });
      return 4;
    };

    /** Cambia el tipo de movimiento con reintento (condición: aria-pressed). */
    const cambiarTipo = (idTab) =>
      clickHasta(`#${idTab}`, `document.getElementById(${JSON.stringify(idTab)})?.getAttribute("aria-pressed") === "true"`, `el cambio de tipo ${idTab}`);

    const lectura = () => ui.evalJs(`window.__f7h_ev`);

    try {
      /* ── Preparación ─────────────────────────────────────────────────── */
      section("Preparación — panel, línea base y capturador de gestos");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, { timeout: 30000, label: "el panel" });
      await ui.waitFor(
        `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
        { timeout: 30000, label: "la hidratación del panel" },
      );
      baselineIds = await idsDeHoy();
      console.log(`  · movimientos de hoy en la línea base: ${baselineIds.size}`);

      // El capturador: prueba de entrega de los gestos. Sin esto, un clic que
      // "no cerró" podría ser (a) el diseño correcto o (b) un clic perdido en
      // la ventana sorda — evidencia inútil sin poder distinguirlas.
      await ui.evalJs(`(() => {
        window.__f7h_ev = { clicks: 0, ultimosTargets: [], claves: [] };
        document.addEventListener("click", (e) => {
          window.__f7h_ev.clicks += 1;
          window.__f7h_ev.ultimosTargets.push((e.target.id || e.target.tagName) + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY));
          if (window.__f7h_ev.ultimosTargets.length > 30) window.__f7h_ev.ultimosTargets.shift();
        }, true);
        document.addEventListener("keydown", (e) => {
          window.__f7h_ev.claves.push(e.key);
          if (window.__f7h_ev.claves.length > 60) window.__f7h_ev.claves.shift();
        }, true);
        return true;
      })()`);

      const cuentasRes = await cuentas("?includeArchived=false");
      const liab = (cuentasRes.body?.accounts ?? []).find((a) => a.isLiability);
      checkTrue("hay una cuenta liability para el caso de ingreso (contexto)", Boolean(liab), "sin liability");
      const liabId = liab?.id ?? null;

      /* ── H1 · clic afuera ────────────────────────────────────────────── */
      section("H1 — clic afuera (50,50): no cierra ni pierde lo cargado");
      await abrirCon("#btn-expense");
      await tipearEn("#tx-amount", "4500");
      await tipearEn("#tx-description", "notaH1");
      const antesH1 = await estado();
      check("el modal tiene los datos cargados", `${antesH1.monto}|${antesH1.nota}`, "4500|notaH1");

      // El caso sólo vale si (50,50) cae FUERA del formulario: si el panel
      // llegara hasta ahí, el clic golpearía el panel y no probaría nada.
      const fuera = await ui.evalJs(`(() => {
        const el = document.elementFromPoint(50, 50);
        return { tag: el?.tagName ?? null, id: el?.id ?? "", dentroDelForm: el ? !!el.closest("form") : null };
      })()`);
      console.log(`  · (50,50) apunta a: ${JSON.stringify(fuera)}`);
      checkTrue("(50,50) está fuera del formulario (el caso vale)", fuera.dentroDelForm === false, JSON.stringify(fuera));

      const clicksAntes = (await lectura()).clicks;
      await ui.clickAt(50, 50);
      await sleep(400);
      const trasClic = await lectura();
      checkTrue(
        "el clic afuera SE ENTREGÓ a la página (lo vio el capturador)",
        trasClic.clicks > clicksAntes,
        JSON.stringify(trasClic.ultimosTargets.slice(-3)),
      );
      checkTrue("el modal sigue abierto tras el clic afuera", await ui.evalJs(`!!document.getElementById("tx-submit")`), "se cerró");
      const despuesH1 = await estado();
      check("el monto no se perdió por el clic afuera", despuesH1.monto, "4500");
      check("la nota no se perdió por el clic afuera", despuesH1.nota, "notaH1");
      checkTrue("el clic afuera no disparó el aviso de descarte", !(await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)), "apareció");

      /* ── H1b · Escape con datos = dos pasos, inline ──────────────────── */
      section("H1b — Escape con datos pide confirmación INLINE (dos pasos)");
      checkTrue("con datos escritos, el primer Escape muestra el aviso", await escapeHastaAviso(), "no apareció");
      const aviso = await ui.evalJs(`(() => {
        const w = document.getElementById("tx-discard-warning");
        return w ? {
          texto: w.textContent.trim(),
          role: w.getAttribute("role"),
          cancelar: document.getElementById("tx-discard-cancel")?.textContent.trim() ?? null,
          descartar: document.getElementById("tx-discard-confirm")?.textContent.trim() ?? null,
        } : null;
      })()`);
      checkTrue(
        "el aviso es inline (role=alert) y explica qué se pierde",
        aviso && aviso.role === "alert" && aviso.texto.includes("se pierde lo que cargaste"),
        JSON.stringify(aviso),
      );
      check("el botón seguro dice 'Seguir editando'", aviso?.cancelar, "Seguir editando");
      check("el botón que descarta dice 'Descartar'", aviso?.descartar, "Descartar");
      checkTrue("con el aviso visible el modal SIGUE abierto (primer Escape no cierra)", await ui.evalJs(`!!document.getElementById("tx-submit")`), "se cerró");
      // Si esto responde, el hilo de JS no está bloqueado por un window.confirm.
      check("la página responde con el aviso en pantalla (no hay diálogo nativo)", await ui.evalJs(`2 + 2`), 4);
      const trasAviso = await estado();
      check("el monto sigue intacto con el aviso visible", trasAviso.monto, "4500");
      check("la nota sigue intacta con el aviso visible", trasAviso.nota, "notaH1");

      /* ── H2 · Seguir editando + segundo Escape ───────────────────────── */
      section("H2 — 'Seguir editando' vuelve; el segundo Escape cierra");
      await clickHasta("#tx-discard-cancel", `!document.getElementById("tx-discard-warning")`, "cerrar el aviso (Seguir editando)");
      const trasCancelar = await estado();
      check("tras 'Seguir editando' el monto sigue", trasCancelar.monto, "4500");
      check("y la nota sigue", trasCancelar.nota, "notaH1");
      checkTrue("el modal sigue abierto", await ui.evalJs(`!!document.getElementById("tx-submit")`), "se cerró");
      checkTrue("Escape vuelve a pedir confirmación", await escapeHastaAviso(), "no apareció");
      await ui.press("Escape");
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 4000, label: "el cierre con el aviso visible" });
      checkTrue("con el aviso visible, el segundo Escape CIERRA el modal", !(await ui.evalJs(`!!document.getElementById("tx-submit")`)), "sigue abierto");
      checkTrue("no quedó ningún aviso colgado", !(await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)), "quedó");
      checkTrue("cerrar por Escape no guardó nada (sin toast)", !(await ui.evalJs(`!!document.getElementById("undo-toast")`)), "apareció toast");

      /* ── H3 · Descartar ──────────────────────────────────────────────── */
      section("H3 — 'Descartar' cierra y descarta de verdad");
      await abrirCon("#btn-expense");
      await tipearEn("#tx-amount", "4600");
      await tipearEn("#tx-description", "notaH3");
      checkTrue("Escape pide confirmación", await escapeHastaAviso(), "no apareció");
      await clickHasta("#tx-discard-confirm", `!document.getElementById("tx-submit")`, "descartar y cerrar");
      checkTrue("el modal se cerró", !(await ui.evalJs(`!!document.getElementById("tx-submit")`)), "abierto");
      checkTrue("descartar no guardó nada (sin toast)", !(await ui.evalJs(`!!document.getElementById("undo-toast")`)), "apareció toast");

      /* ── H4 · Escape limpio ──────────────────────────────────────────── */
      section("H4 — Escape sin datos cierra directo (sin pasar por el aviso)");
      await abrirCon("#btn-income");
      const limpio = await estado();
      check("el formulario arranca limpio (monto vacío)", limpio.monto, "");
      await ui.press("Escape");
      let vioAviso = false;
      for (let i = 0; i < 8; i += 1) {
        if (await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)) vioAviso = true;
        await sleep(75);
      }
      if (await ui.evalJs(`!!document.getElementById("tx-submit")`)) await ui.press("Escape");
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 4000, label: "el cierre limpio" });
      checkTrue("cerró sin que el aviso apareciera NUNCA", !vioAviso, `vioAviso=${vioAviso}`);

      /* ── H5 · ida y vuelta gasto↔ingreso ─────────────────────────────── */
      section("H5 — ida y vuelta gasto↔ingreso: no se pierde nada");
      await abrirCon("#btn-expense");
      await tipearEn("#tx-amount", "4700");
      await tipearEn("#tx-description", "notaH5");
      await tipearEn("#tx-category", "cafe");
      const a5 = await estado();
      check("datos cargados en gasto (monto|nota|categoría)", `${a5.monto}|${a5.nota}|${a5.categoria}`, "4700|notaH5|cafe");
      await cambiarTipo("tx-kind-ingreso");
      const b5 = await estado();
      check("en ingreso, el monto sobrevivió", b5.monto, "4700");
      check("la nota sobrevivió", b5.nota, "notaH5");
      check("la categoría tipeada sobrevivió", b5.categoria, "cafe");
      checkTrue("la cuenta quedó en una válida para ingreso (no liability)", b5.cuenta && b5.cuenta !== liabId, `${b5.cuenta}`);
      await cambiarTipo("tx-kind-gasto");
      const c5 = await estado();
      check("de vuelta en gasto, el monto", c5.monto, "4700");
      check("la nota", c5.nota, "notaH5");
      check("la categoría", c5.categoria, "cafe");
      check("la cuenta volvió a ser la misma", c5.cuenta, a5.cuenta);
      // Salida EXPLÍCITA: Cancelar cierra sin aviso (intención declarada, no
      // un gesto accidental como Escape o el backdrop).
      await clickHasta("#tx-cancel", `!document.getElementById("tx-submit")`, "cancelar y cerrar");
      checkTrue("Cancelar cierra directo, sin aviso intermedio", !(await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)), "apareció aviso");

      /* ── H6 · transferencia a medias ─────────────────────────────────── */
      section("H6 — transferencia a medias: ida y vuelta a gasto conserva todo");
      await abrirCon("#btn-transfer");
      const t0 = await estado();
      checkTrue("la transferencia tiene campo 'hacia' (destino)", t0.hayDestino, "sin destino");
      checkTrue("origen y destino son distintos", Boolean(t0.cuenta && t0.destino && t0.cuenta !== t0.destino), `${t0.cuenta}→${t0.destino}`);
      await tipearEn("#tx-amount", "4800");
      await tipearEn("#tx-description", "notaH6");
      await cambiarTipo("tx-kind-gasto");
      const t1 = await estado();
      checkTrue("en gasto, el campo 'hacia' ya no existe", !t1.hayDestino, "sigue el destino");
      check("el monto sobrevivió al viaje", t1.monto, "4800");
      check("la nota sobrevivió al viaje", t1.nota, "notaH6");
      await cambiarTipo("tx-kind-transferencia");
      const t2 = await estado();
      checkTrue("volvió el campo 'hacia'", t2.hayDestino, "no volvió");
      check("el origen es el mismo que antes del viaje", t2.cuenta, t0.cuenta);
      check("el destino es el mismo (no se re-eligió solo)", t2.destino, t0.destino);
      check("el monto sigue ahí al final del viaje", t2.monto, "4800");
      check("la nota sigue ahí al final del viaje", t2.nota, "notaH6");
      // Salida EXPLÍCITA por la ×: mismo trato que Cancelar.
      await clickHasta("#tx-close", `!document.getElementById("tx-submit")`, "cerrar con la ×");
      checkTrue("la × cerró el modal", !(await ui.evalJs(`!!document.getElementById("tx-submit")`)), "abierto");

      /* ── Cierre ──────────────────────────────────────────────────────── */
      section("Cierre — ningún guardado fantasma y evidencia de entrega de gestos");
      const idsFinal = await idsDeHoy();
      checkDeep("ids de hoy idénticos a la línea base (el modal no guardó nada)", [...idsFinal].sort(), [...baselineIds].sort());
      const evFinal = await lectura();
      const escapes = evFinal.claves.filter((k) => k === "Escape").length;
      console.log(`  · capturador: ${evFinal.clicks} clicks · ${escapes} Escape · últimos targets: ${JSON.stringify(evFinal.ultimosTargets.slice(-5))}`);
      checkTrue("los Escape de la corrida se entregaron (≥3)", escapes >= 3, JSON.stringify(evFinal.claves.slice(-12)));
      checkTrue("no quedó ningún aviso de descarte en pantalla", !(await ui.evalJs(`!!document.getElementById("tx-discard-warning")`)), "quedó");
      checkTrue("no quedó ningún toast de deshacer", !(await ui.evalJs(`!!document.getElementById("undo-toast")`)), "quedó");
    } finally {
      // Red de seguridad: esta batería no guarda, pero si un caso futuro
      // guardara algo, se limpia por id y por monto (los movimientos de UI no
      // llevan nota: cleanupTag no puede encontrarlos por prefijo).
      try {
        const res = await movimientosDe(hoy, hoy);
        for (const m of res.body?.movements ?? []) {
          const huerfano = !baselineIds.has(m.id) && (creados.has(m.id) || montosUsados.has(m.amount));
          if (huerfano) await del(`/api/transactions?id=${m.id}`);
        }
      } catch {
        // La limpieza no puede tapar un error real de la corrida.
      }
      for (const id of [...creados]) {
        try {
          await del(`/api/transactions?id=${id}`);
        } catch {
          // Ya no está.
        }
      }
      await ui.close();
    }
  },
});
