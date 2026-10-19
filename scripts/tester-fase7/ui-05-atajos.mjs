#!/usr/bin/env node
/**
 * ui-05 · ATAQUE G — los atajos T / I y sus tres guardas
 *
 * El contrato que ataca (app/page.tsx + lib/quick-entry.ts):
 *   · T abre "Nuevo gasto"; I abre "Nuevo ingreso". Mayúscula no importa
 *     (Shift+T también dispara: el contexto sigue siendo "no estoy
 *     escribiendo en un campo").
 *   · Guarda 1: con un MODAL abierto no se dispara nada.
 *   · Guarda 2: con el foco en un campo de texto (input/textarea/select) o
 *     contenido editable, la tecla es DATO — escribir "tomate" no puede abrir
 *     el modal de gasto a mitad de palabra.
 *   · Guarda 3: con Ctrl/Alt/Meta apretadas no se toca (son atajos del
 *     navegador o del sistema).
 *
 * Método — y por qué hay dos clases de evento:
 *   · Los casos POSITIVOS (T, I, Shift+T abren) y las guardas de TIPEO van
 *     con teclas REALES por CDP, con reintento: el entorno CDP tiene la
 *     ventana sorda documentada y una tecla real puede caer ahí. En la guarda
 *     de tipeo, además, se EXIGE que la letra haya entrado al campo (si no
 *     entró, la prueba no vale: no es un verde).
 *   · Las guardas de modificador (Ctrl/Alt/Meta) van con `KeyboardEvent`
 *     sintético A PROPÓSITO: un Ctrl+T REAL le pediría a Chrome una pestaña
 *     nueva, y robarse los atajos del navegador no es lo que la app promete.
 *     Lo que se prueba es la guarda de la app sobre el evento que recibe.
 *
 * No crea ni borra movimientos: sólo abre y cierra modales. Verifica al final
 * que el día de hoy quedó igual (ids).
 *
 * Requiere: server en :3000 y Chrome CDP 9341 (se lanza y se mata solo).
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  check,
  checkDeep,
  checkTrue,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_ATAJOS";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runScript({
  tag: TAG,
  main: async (prisma) => {
    const ui = await openUi({ port: 9341 });
    const hoy = localToday();

    const idsDeHoy = async () => {
      const res = await movimientosDe(hoy, hoy);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return new Set((res.body?.movements ?? []).map((m) => m.id));
    };

    const estadoModal = () =>
      ui.evalJs(`(() => {
        const titulo = document.querySelector("div.fixed.inset-0 h2")?.textContent?.trim() ?? null;
        const abierto = !!document.getElementById("tx-submit");
        const activo = ["tx-kind-gasto", "tx-kind-ingreso", "tx-kind-transferencia"].find(
          (id) => document.getElementById(id)?.getAttribute("aria-pressed") === "true",
        ) ?? null;
        return { abierto, titulo, activo };
      })()`);

    /** Cierra con Escape (sólo modales sin datos) con reintentos. */
    const cerrar = async () => {
      for (let i = 0; i < 3; i += 1) {
        await ui.press("Escape");
        try {
          await ui.waitFor(`!document.getElementById("tx-submit")`, {
            timeout: 2500,
            label: "el cierre (Escape)",
          });
          return;
        } catch {
          console.log(`  AVISO Escape no cerró (intento ${i + 1}/3); se reintenta.`);
        }
      }
      await ui.waitFor(`!document.getElementById("tx-submit")`, {
        timeout: 2000,
        label: "el cierre tras los reintentos",
      });
    };

    /** Abre un modal con click real en un botón del panel (con reintentos). */
    const abrirConBoton = async (selector) => {
      for (let i = 0; i < 4; i += 1) {
        await ui.evalJs(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
        await sleep(i === 0 ? 250 : 300);
        await ui.clickEl(selector);
        try {
          await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2500, label: "el modal" });
          return;
        } catch {
          // Ventana sorda: se reintenta el click.
        }
      }
      await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2000, label: "el modal tras los reintentos" });
    };

    /** Presiona (real, con reintento) hasta que el modal aparezca. */
    const atajoReal = async (presionar, etiqueta) => {
      for (let i = 0; i < 4; i += 1) {
        await presionar();
        try {
          await ui.waitFor(`!!document.getElementById("tx-submit")`, {
            timeout: 2000,
            label: `el modal tras ${etiqueta}`,
          });
          return { abierto: true, estado: await estadoModal(), intentos: i + 1 };
        } catch {
          // Ventana sorda: se reintenta la tecla.
        }
      }
      return { abierto: false, estado: await estadoModal(), intentos: 4 };
    };

    /** `KeyboardEvent` sintético (para las guardas de modificador). */
    const sintetico = (key, opts = {}, targetSelector = null) =>
      ui.evalJs(`(() => {
        const destino = ${targetSelector ? `document.querySelector(${JSON.stringify(targetSelector)})` : "document"} ?? document;
        destino.dispatchEvent(new KeyboardEvent("keydown", Object.assign(
          { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true },
          ${JSON.stringify(opts)},
        )));
        return true;
      })()`);

    /** Limpia un input controlado por React (setter nativo + evento input). */
    const limpiarInput = (selector) =>
      ui.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
      })()`);

    try {
      section("Preparación — panel y línea base");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, { timeout: 30000, label: "el panel" });
      await ui.waitFor(
        `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
        { timeout: 30000, label: "la hidratación del panel" },
      );
      const baselineIds = await idsDeHoy();
      console.log(`  · movimientos de hoy en la línea base: ${baselineIds.size}`);

      /* ── P1/P2 · T e I abren ─────────────────────────────────────────── */
      section("P1/P2 — T abre gasto y I abre ingreso (teclas reales)");
      const p1 = await atajoReal(() => ui.press("t"), "T");
      checkTrue("T abre el modal", p1.abierto, JSON.stringify(p1.estado));
      check("T abre GASTO", p1.estado.activo, "tx-kind-gasto");
      check("con el título '－ Nuevo gasto'", p1.estado.titulo, "－ Nuevo gasto");
      if (p1.abierto) await cerrar();

      const p2 = await atajoReal(() => ui.press("i"), "I");
      checkTrue("I abre el modal", p2.abierto, JSON.stringify(p2.estado));
      check("I abre INGRESO", p2.estado.activo, "tx-kind-ingreso");
      check("con el título '＋ Nuevo ingreso'", p2.estado.titulo, "＋ Nuevo ingreso");
      if (p2.abierto) await cerrar();

      /* ── P3 · Shift+T (mayúscula) ────────────────────────────────────── */
      section("P3 — Shift+T también abre (mayúscula no importa)");
      const shiftT = async () => {
        await ui.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "T",
          code: "KeyT",
          windowsVirtualKeyCode: 84,
          nativeVirtualKeyCode: 84,
          modifiers: 8, // Shift
          text: "T",
          unmodifiedText: "T",
        });
        await sleep(20);
        await ui.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "T",
          code: "KeyT",
          windowsVirtualKeyCode: 84,
          nativeVirtualKeyCode: 84,
          modifiers: 8,
        });
      };
      const p3 = await atajoReal(shiftT, "Shift+T");
      checkTrue("Shift+T abre el modal", p3.abierto, JSON.stringify(p3.estado));
      check("y abre GASTO", p3.estado.activo, "tx-kind-gasto");
      if (p3.abierto) await cerrar();

      /* ── N1 · con modal abierto, T no hace nada ──────────────────────── */
      section("N1 — con un modal abierto, T no hace nada (guarda del diálogo)");
      await abrirConBoton("#btn-expense");
      // El autofocus vive en el monto: se lo saca para que la tecla caiga en
      // el body y lo único que pueda frenarla sea la guarda del modal.
      await ui.evalJs(`document.activeElement?.blur?.(); true`);
      for (let i = 0; i < 3; i += 1) {
        await ui.press("t");
        await sleep(150);
      }
      const n1 = await estadoModal();
      checkTrue("el modal sigue abierto tras 3 T (sin foco)", n1.abierto, JSON.stringify(n1));
      check("sigue siendo el mismo formulario (GASTO)", n1.activo, "tx-kind-gasto");
      await sintetico("t"); // target = document → body
      await sleep(150);
      const n1b = await estadoModal();
      checkTrue(
        "ni con el evento sintético (target=body) se re-dispara",
        n1b.abierto && n1b.activo === "tx-kind-gasto",
        JSON.stringify(n1b),
      );
      await cerrar();

      /* ── N2 · escribiendo en el monto, T es DATO ─────────────────────── */
      section("N2 — escribiendo en un campo, T es DATO (no atajo)");
      await abrirConBoton("#btn-expense");
      await ui.evalJs(`document.getElementById("tx-amount").focus()`);
      await sleep(80);
      await ui.press("t");
      await ui.press("t");
      await sleep(150);
      const n2 = await estadoModal();
      const valorN2 = await ui.evalJs(`document.getElementById("tx-amount")?.value ?? null`);
      checkTrue("el modal sigue abierto", n2.abierto, JSON.stringify(n2));
      check("el tipo no cambió (sigue GASTO)", n2.activo, "tx-kind-gasto");
      checkTrue(
        "la 't' fue DATO: entró al campo del monto (si no entró, la prueba no vale)",
        String(valorN2 ?? "").includes("t"),
        `valor: ${JSON.stringify(valorN2)}`,
      );
      await limpiarInput("#tx-amount");
      await cerrar();

      /* ── N3 · escribiendo en la búsqueda del panel ───────────────────── */
      section("N3 — escribiendo en la búsqueda del panel, T es DATO");
      await ui.evalJs(`document.getElementById("mov-search").focus()`);
      await sleep(80);
      await ui.press("t");
      await sleep(150);
      const n3 = await estadoModal();
      const busqueda = await ui.evalJs(`document.getElementById("mov-search")?.value ?? null`);
      checkTrue("no se abrió ningún modal", !n3.abierto, JSON.stringify(n3));
      checkTrue(
        "la 't' entró a la búsqueda (evento real entregado)",
        String(busqueda ?? "").includes("t"),
        `valor: ${JSON.stringify(busqueda)}`,
      );
      await sintetico("t", {}, "#mov-search"); // target = INPUT
      await sleep(150);
      const n3b = await estadoModal();
      checkTrue("ni con el sintético dirigido al input (target=INPUT) se abre", !n3b.abierto, JSON.stringify(n3b));
      await limpiarInput("#mov-search");

      /* ── N4 · modificadores (sintético a propósito) ──────────────────── */
      section("N4 — Ctrl/Alt/Meta: la tecla es del navegador, no de la app");
      for (const [nombre, opts] of [
        ["Ctrl+T", { ctrlKey: true }],
        ["Alt+T", { altKey: true }],
        ["Meta+T", { metaKey: true }],
      ]) {
        await sintetico("t", opts);
        await sleep(120);
        const est = await estadoModal();
        checkTrue(`${nombre} no abre nada (la guarda lo ignora)`, !est.abierto, JSON.stringify(est));
      }

      /* ── Escape sin modal ────────────────────────────────────────────── */
      section("P4 — Escape sin modal no rompe nada");
      await ui.press("Escape");
      await sleep(150);
      const p4 = await estadoModal();
      checkTrue("no se abrió ni cerró nada raro", !p4.abierto, JSON.stringify(p4));

      /* ── Cierre ──────────────────────────────────────────────────────── */
      section("Cierre — el día quedó como estaba");
      const idsFinal = await idsDeHoy();
      checkDeep("ids de hoy idénticos a la línea base (los atajos no guardaron nada)", [...idsFinal].sort(), [...baselineIds].sort());
    } finally {
      await ui.close();
    }
  },
});
