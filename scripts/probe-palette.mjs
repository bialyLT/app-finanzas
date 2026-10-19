#!/usr/bin/env node
/**
 * Sonda CDP · paleta de comandos (`Ctrl+K`) · Fase 7 ronda 2
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UNA SONDA CDP Y NO UN FLOW DE MAESTRO
 * ─────────────────────────────────────────────────────────────────────────────
 * El driver web de Maestro sólo emite ENTER y BACKSPACE desde `pressKey`; no
 * puede mandar Ctrl+K, flechas ni Tab. Y esos son justamente los contratos de
 * la paleta:
 *
 *   · Ctrl+K abre · segundo Ctrl+K cierra.
 *   · ↓/↑ mueven el activo con wrap-around · Enter ejecuta.
 *   · Escape cierra SÓLO la paleta.
 *   · Con un formulario o el importador abierto, Ctrl+K NO hace nada (no se
 *     pierde lo cargado).
 *   · El foco queda atrapado adentro del diálogo.
 *   · El botón visible `#btn-palette` abre lo mismo (entrada táctil).
 *   · La búsqueda filtra por label, alias y acentos normalizados.
 *
 * La tecla se manda REAL por CDP (keyDown + keyUp con modifier Ctrl) y se
 * verifica que Chrome la entregue a la página: en la primera corrida de esta
 * sonda el atajo abrió la paleta de verdad, no por un evento sintético.
 *
 * No crea ni borra nada: sólo abre y cierra overlays. Al final compara los ids
 * de los movimientos de hoy y el listado de plantillas contra la línea base.
 *
 * Requiere: server en :3000 y Chrome (se lanza y se mata solo en el puerto
 * 9342). Se corre desde la raíz del repo:
 *
 *   node scripts/probe-palette.mjs
 */

import { openUi } from "./tester-fase7/cdp.mjs";
import {
  BASE_URL,
  check,
  checkTrue,
  get,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./tester-fase7/helpers.mjs";

const TAG = "T_TESTER_F7_PALETA";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runScript({
  tag: TAG,
  main: async () => {
    const hoy = localToday();
    const ui = await openUi({ port: 9342 });

    /** Estado completo y serializable de la paleta. */
    const estado = () =>
      ui.evalJs(`(() => {
        const dialog = document.getElementById("command-palette");
        const input = document.getElementById("palette-input");
        const listbox = document.getElementById("palette-listbox");
        const activo = listbox?.querySelector('[aria-selected="true"]') ?? null;
        const items = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].map((el) => ({
          id: el.id,
          label: el.querySelector("span span")?.textContent?.trim() ?? el.textContent.trim(),
          group: el.lastElementChild?.textContent?.trim() ?? "",
          disabled: el.getAttribute("aria-disabled") === "true",
        }));
        return {
          abierta: !!dialog,
          role: dialog?.getAttribute("role") ?? null,
          modal: dialog?.getAttribute("aria-modal") ?? null,
          inputEnfocado: document.activeElement === input,
          activo: activo?.id ?? null,
          activoLabel: activo?.querySelector("span span")?.textContent?.trim() ?? null,
          query: input?.value ?? null,
          items,
          vacia: (listbox?.textContent ?? "").includes("Nada coincide"),
          formAbierto: !!document.getElementById("tx-submit"),
          csvAbierto: !!document.getElementById("csv-text"),
        };
      })()`);

    /** Ctrl+K REAL (keyDown + keyUp con el modifier de Ctrl). */
    const ctrlKReal = async () => {
      const base = {
        key: "k",
        code: "KeyK",
        windowsVirtualKeyCode: 75,
        nativeVirtualKeyCode: 75,
        modifiers: 2,
      };
      await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await sleep(30);
      await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };

    /** Abre la paleta con Ctrl+K; si ya está abierta no vuelve a pulsar. */
    const abrirPaleta = async () => {
      for (let intento = 1; intento <= 4; intento += 1) {
        if ((await estado()).abierta) return intento - 1;
        await ctrlKReal();
        try {
          await ui.waitFor(`!!document.getElementById("command-palette")`, {
            timeout: 3500,
            label: "la paleta tras Ctrl+K",
          });
          return intento;
        } catch {
          // Ventana sorda documentada: se reintenta la tecla.
        }
      }
      throw new Error("Ctrl+K no abrió la paleta tras 4 intentos.");
    };

    /** Cierra la paleta con Escape (reintenta si la ventana está sorda). */
    const cerrarConEscape = async () => {
      for (let intento = 1; intento <= 3; intento += 1) {
        await ui.press("Escape");
        try {
          await ui.waitFor(`!document.getElementById("command-palette")`, {
            timeout: 2500,
            label: "el cierre de la paleta",
          });
          return intento;
        } catch {
          // Se reintenta.
        }
      }
      throw new Error("Escape no cerró la paleta.");
    };

    /** Tecla real con reintento hasta que `condicion` se cumpla. */
    const teclaHasta = async (tecla, condicion, label, intentos = 4) => {
      for (let i = 1; i <= intentos; i += 1) {
        await tecla();
        try {
          await ui.waitFor(condicion, { timeout: 2000, label });
          return i;
        } catch {
          // Se reintenta.
        }
      }
      throw new Error(`No se cumplió: ${label}`);
    };

    const limpiarQuery = () =>
      ui.evalJs(`(() => {
        const el = document.getElementById("palette-input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
      })()`);

    const escribirQuery = async (texto) => {
      await limpiarQuery();
      await ui.clickEl("#palette-input");
      await ui.insertText(texto);
      await sleep(150);
      return (await estado()).query;
    };

    /** Toca un botón del panel con scroll previo y reintentos. */
    const tocarBoton = async (selector, esperar) => {
      for (let i = 1; i <= 4; i += 1) {
        await ui.evalJs(
          `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        );
        await sleep(i === 1 ? 250 : 300);
        await ui.clickEl(selector);
        try {
          await ui.waitFor(esperar, { timeout: 2500, label: `la apertura con ${selector}` });
          return i;
        } catch {
          // Ventana sorda: se reintenta.
        }
      }
      throw new Error(`${selector} no abrió lo esperado.`);
    };

    const idsDeHoy = async () => {
      const res = await movimientosDe(hoy, hoy);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return (res.body?.movements ?? []).map((m) => m.id).sort();
    };

    try {
      section("Preparación · panel, hidratación y línea base");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "el panel",
      });
      await ui.waitFor(
        `Object.keys(document.getElementById("btn-palette") ?? {}).some((k) => k.startsWith("__reactProps"))`,
        { timeout: 30000, label: "la hidratación del panel" },
      );
      const baselineIds = await idsDeHoy();
      const baselineFavoritos = (await get("/api/favorites")).body?.favorites ?? [];
      check("la paleta arranca cerrada", (await estado()).abierta, false);
      console.log(`  · movimientos de hoy en la línea base: ${baselineIds.length}`);
      console.log(`  · plantillas en la línea base: ${baselineFavoritos.length}`);

      /* ── P1 · Ctrl+K abre ────────────────────────────────────────────── */
      section("P1 · Ctrl+K abre el diálogo y enfoca la búsqueda");
      const intentosApertura = await abrirPaleta();
      const abierta = await estado();
      checkTrue("Ctrl+K abre la paleta (tecla real)", abierta.abierta);
      check("el diálogo declara role=dialog", abierta.role, "dialog");
      check("el diálogo declara aria-modal=true", abierta.modal, "true");
      checkTrue("el foco cae en el campo de búsqueda", abierta.inputEnfocado);
      check("el listbox existe", await ui.evalJs(`!!document.getElementById("palette-listbox")`), true);
      checkTrue(
        `trae las 9 acciones base (trajo ${abierta.items.length})`,
        abierta.items.length >= 9,
      );
      check("el activo inicial es el primero", abierta.activo, "palette-item-0");
      check("el primer item es Nuevo gasto", abierta.activoLabel, "Nuevo gasto");
      console.log(`  · intentos de apertura: ${intentosApertura} (1 = sin ventana sorda)`);

      /* ── P2 · segundo Ctrl+K cierra ──────────────────────────────────── */
      section("P2 · Segundo Ctrl+K cierra (toggle)");
      await ctrlKReal();
      await ui.waitFor(`!document.getElementById("command-palette")`, {
        timeout: 3500,
        label: "el cierre con el segundo Ctrl+K",
      });
      check("segundo Ctrl+K cierra la paleta", (await estado()).abierta, false);

      /* ── P3 · flechas con wrap-around ────────────────────────────────── */
      section("P3 · ↓/↑ mueven el activo y dan la vuelta");
      await abrirPaleta();
      const total = (await estado()).items.length;
      await teclaHasta(
        () => ui.pressKey("ArrowDown", { code: "ArrowDown", keyCode: 40 }),
        `document.getElementById("palette-item-1")?.getAttribute("aria-selected") === "true"`,
        "↓ al segundo item",
      );
      check("↓ mueve al segundo item", (await estado()).activo, "palette-item-1");
      check("el segundo item es Nuevo ingreso", (await estado()).activoLabel, "Nuevo ingreso");

      await teclaHasta(
        () => ui.pressKey("ArrowUp", { code: "ArrowUp", keyCode: 38 }),
        `document.getElementById("palette-item-0")?.getAttribute("aria-selected") === "true"`,
        "↑ de vuelta al primero",
      );
      check("↑ vuelve al primero", (await estado()).activo, "palette-item-0");

      await teclaHasta(
        () => ui.pressKey("ArrowUp", { code: "ArrowUp", keyCode: 38 }),
        `document.getElementById("palette-item-${total - 1}")?.getAttribute("aria-selected") === "true"`,
        "↑ con wrap al último",
      );
      check("↑ desde el primero da la vuelta al último", (await estado()).activo, `palette-item-${total - 1}`);

      await teclaHasta(
        () => ui.pressKey("ArrowDown", { code: "ArrowDown", keyCode: 40 }),
        `document.getElementById("palette-item-0")?.getAttribute("aria-selected") === "true"`,
        "↓ con wrap al primero",
      );
      check("↓ desde el último da la vuelta al primero", (await estado()).activo, "palette-item-0");

      /* ── P4 · filtrado ───────────────────────────────────────────────── */
      section("P4 · La búsqueda filtra por label, alias y sin acentos");
      const qGasto = await escribirQuery("gasto");
      const filtroGasto = await estado();
      check("la búsqueda queda escrita", qGasto, "gasto");
      check("«gasto» deja primero Nuevo gasto", filtroGasto.items[0]?.label, "Nuevo gasto");
      check("y en el grupo Acciones", filtroGasto.items[0]?.group, "Acciones");

      const qAnalisis = await escribirQuery("analisis");
      const filtroAnalisis = await estado();
      check("«analisis» (sin tilde) encuentra Análisis", filtroAnalisis.items[0]?.label, "Ir a Análisis");
      check("la tilde no cambia la búsqueda", qAnalisis, "analisis");

      await escribirQuery("zzzz-no-existe");
      const filtroVacio = await estado();
      check("sin coincidencias no hay items", filtroVacio.items.length, 0);
      check("y se muestra el aviso de vacío", filtroVacio.vacia, true);
      await ui.press("Enter");
      await sleep(300);
      check("Enter sin items no cierra la paleta", (await estado()).abierta, true);
      check("ni abre un formulario", (await estado()).formAbierto, false);

      /* ── P5 · Enter ejecuta la acción ────────────────────────────────── */
      section("P5 · Enter ejecuta la acción activa");
      await escribirQuery("gasto");
      await teclaHasta(
        () => ui.press("Enter"),
        `!document.getElementById("command-palette") && !!document.getElementById("tx-submit")`,
        "Enter → Nuevo gasto",
      );
      const trasEnter = await estado();
      check("Enter cierra la paleta", trasEnter.abierta, false);
      checkTrue("y abre el formulario", trasEnter.formAbierto);
      check(
        "el formulario es de gasto",
        await ui.evalJs(`document.getElementById("tx-kind-gasto")?.getAttribute("aria-pressed")`),
        "true",
      );
      checkTrue(
        "el título dice Nuevo gasto",
        await ui.evalJs(
          `[...document.querySelectorAll("h2")].some((h) => h.textContent.includes("Nuevo gasto"))`,
        ),
      );

      /* ── P6 · guarda con el formulario abierto ──────────────────────── */
      section("P6 · Con el formulario abierto, Ctrl+K no hace nada (no pierde datos)");
      await ui.clickEl("#tx-amount");
      await ui.insertText("123");
      const montoAntes = await ui.evalJs(`document.getElementById("tx-amount").value`);
      check("el monto tipeado quedó en el campo", montoAntes, "123");

      await ctrlKReal();
      await sleep(700);
      check("Ctrl+K NO abre la paleta encima del form", (await estado()).abierta, false);
      check("el formulario sigue abierto", (await estado()).formAbierto, true);
      check(
        "y el monto sigue intacto",
        await ui.evalJs(`document.getElementById("tx-amount").value`),
        "123",
      );

      await ui.press("Escape");
      await ui.waitFor(`!!document.getElementById("tx-discard-warning")`, {
        timeout: 3000,
        label: "el aviso de descarte",
      });
      check(
        "Escape con datos pide confirmación (no descarta de una)",
        await ui.evalJs(`!!document.getElementById("tx-discard-warning")`),
        true,
      );
      await ui.press("Escape");
      await ui.waitFor(`!document.getElementById("tx-submit")`, {
        timeout: 3000,
        label: "el cierre del formulario con el segundo Escape",
      });

      /* ── P7 · guarda con el importador abierto ──────────────────────── */
      section("P7 · Con el importador CSV abierto, Ctrl+K no hace nada");
      await tocarBoton("#btn-import-csv", `!!document.getElementById("csv-text")`);
      await ctrlKReal();
      await sleep(700);
      check("Ctrl+K NO abre la paleta encima del CSV", (await estado()).abierta, false);
      check("el importador sigue abierto", (await estado()).csvAbierto, true);
      await ui.evalJs(`document.getElementById("csv-close").click()`);
      await ui.waitFor(`!document.getElementById("csv-text")`, {
        timeout: 3000,
        label: "el cierre del importador",
      });

      /* ── P8 · Escape cierra sólo la paleta ──────────────────────────── */
      section("P8 · Escape cierra la paleta, no el panel");
      await abrirPaleta();
      const intentosEscape = await cerrarConEscape();
      check("Escape cierra la paleta", (await estado()).abierta, false);
      checkTrue(
        "el panel sigue montado",
        await ui.evalJs(`!!document.getElementById("btn-expense")`),
      );
      console.log(`  · intentos de Escape: ${intentosEscape}`);

      /* ── P9 · botón visible (entrada táctil) ────────────────────────── */
      section("P9 · El botón visible abre la misma paleta");
      const intentosBoton = await tocarBoton("#btn-palette", `!!document.getElementById("command-palette")`);
      check("el botón Buscar abre la paleta", (await estado()).abierta, true);
      await ctrlKReal();
      await ui.waitFor(`!document.getElementById("command-palette")`, {
        timeout: 3500,
        label: "el cierre con Ctrl+K desde el botón",
      });
      check("y Ctrl+K la vuelve a cerrar", (await estado()).abierta, false);
      console.log(`  · intentos del botón: ${intentosBoton}`);

      /* ── P10 · trampa de foco ───────────────────────────────────────── */
      section("P10 · El foco queda atrapado dentro del diálogo");
      await abrirPaleta();
      let fuera = 0;
      for (let i = 0; i < 15; i += 1) {
        await ui.pressKey("Tab", { code: "Tab", keyCode: 9 });
        await sleep(40);
        const dentro = await ui.evalJs(
          `document.getElementById("command-palette")?.contains(document.activeElement) === true`,
        );
        if (!dentro) fuera += 1;
      }
      check("15 Tab seguidos no sacan el foco del diálogo", fuera, 0);
      check("la paleta sigue abierta después de tabular", (await estado()).abierta, true);

      /* ── P11 · acción de navegación ─────────────────────────────────── */
      section("P11 · La paleta navega a otra pantalla");
      await escribirQuery("analisis");
      await teclaHasta(
        () => ui.press("Enter"),
        `!document.getElementById("command-palette") && location.pathname === "/analisis"`,
        "Enter → /analisis",
      );
      check("Enter navega a /analisis", await ui.evalJs(`location.pathname`), "/analisis");
      await ui.navigate(`${BASE_URL}/`);
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "la vuelta al panel",
      });

      /* ── P12 · nada mutó ────────────────────────────────────────────── */
      section("P12 · La sonda no modificó datos");
      const idsFinales = await idsDeHoy();
      const favoritosFinales = (await get("/api/favorites")).body?.favorites ?? [];
      check("los movimientos de hoy son los mismos", idsFinales.join(","), baselineIds.join(","));
      check(
        "las plantillas son las mismas",
        favoritosFinales.map((f) => f.id).sort().join(","),
        baselineFavoritos.map((f) => f.id).sort().join(","),
      );
    } finally {
      await ui.close();
    }
  },
});
