#!/usr/bin/env node
/**
 * Helpers compartidos de las baterías del tester — Fase 7 ronda 2
 * («carga rápida, segunda capa»).
 *
 * Reusa lo de `scripts/tester-fase7/helpers.mjs` y `cdp.mjs` (NO se editan:
 * son la regresión de r1) y agrega lo que esta ronda necesita:
 *
 *   · medición de PUNTOS DE TOQUE con `elementFromPoint` — un tap muerto no da
 *     error: se mide. Contra el modal se clasifica además contra la banda del
 *     pie fijo (`#tx-submit` en un contenedor `.sticky`);
 *   · instrumentación de la página: diálogos nativos (`confirm/alert/prompt`),
 *     `fetch` (URL/método/estado/aborto) y `AbortController` (cuántos se
 *     crearon y si se abortaron) — base del ataque a debounce/abort del
 *     autocompletado y al doble submit del import;
 *   · apertura del modal de movimiento con los reintentos de hidratación que
 *     ya documentó r1 (el entorno CDP tiene ventanas en las que el click se
 *     pierde sin error; los reintentos SIEMPRE quedan contados).
 */

import { setTimeout as sleep } from "node:timers/promises";
import { BASE_URL } from "../tester-fase7/helpers.mjs";

export * from "../tester-fase7/helpers.mjs";
export { openUi, TEST_VIEWPORT } from "../tester-fase7/cdp.mjs";
export { sleep, BASE_URL };

export const OUT_TMP = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode`;

/* ────────────────────────────────────────────────────────────────────────────
 * Instrumentación in-page
 * ──────────────────────────────────────────────────────────────────────────── */

export const INSTRUMENTAR_JS = `(() => {
  if (window.__t7r2) return "ya instrumentado";
  const t7 = { dialogs: [], fetches: [], controllers: [], errores: [], listoEn: performance.now() };
  window.__t7r2 = t7;

  for (const fn of ["confirm", "alert", "prompt"]) {
    const orig = window[fn];
    window[fn] = function (...args) {
      t7.dialogs.push({ fn, args: args.map((a) => String(a)), t: performance.now() });
      return fn === "confirm" ? true : fn === "prompt" ? null : undefined;
    };
    window[fn].__orig = orig;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    const signal = (init && init.signal) || (input && input.signal) || null;
    const entry = { url, method: String(method).toUpperCase(), t: performance.now(), signal };
    t7.fetches.push(entry);
    return origFetch(input, init).then(
      (res) => { entry.done = true; entry.status = res.status; return res; },
      (err) => { entry.done = true; entry.error = String((err && err.name) || err); throw err; },
    );
  };

  const OrigAC = window.AbortController;
  class InstrumentedAC extends OrigAC {
    constructor() { super(); t7.controllers.push(this); }
  }
  window.AbortController = InstrumentedAC;

  window.addEventListener("error", (e) => t7.errores.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => t7.errores.push(String((e.reason && e.reason.message) || e.reason)));
  return "ok";
})()`;

/** Instala la instrumentación en la página actual (idempotente). */
export const instrumentar = (ui) => ui.evalJs(INSTRUMENTAR_JS);

/**
 * Resumen de los fetch registrados; `filtro` = subcadena de la URL.
 *
 * Devuelve el array ya evaluado (Promise). El bug de la primera versión fue
 * devolver el CÓDIGO como string y no evaluarlo: los chequeos comparaban
 * longitudes del propio texto y daban verde trivial. Por eso el resultado se
 * exige array (no string): `ui.evalJs` evalúa la expresión.
 */
export const pedidosA = (ui, filtro) =>
  ui.evalJs(`(() => {
    const t7 = window.__t7r2;
    if (!t7) return null;
    return t7.fetches
      .filter((f) => f.url.includes(${JSON.stringify(filtro)}))
      .map((f) => ({
        url: f.url, method: f.method, t: Math.round(f.t),
        done: !!f.done, status: f.status ?? null, error: f.error ?? null,
        abortado: f.signal ? !!f.signal.aborted : null,
      }));
  })()`);

/** Diálogos nativos abiertos desde que se instrumentó. */
export const dialogosNativos = (ui) =>
  ui.evalJs(`(window.__t7r2 ? window.__t7r2.dialogs : null)`);

/* ────────────────────────────────────────────────────────────────────────────
 * Puntos de toque
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mide el punto de toque (centro del rect) de cada selector y a quién le
 * llega ese punto AHORA MISMO (`elementFromPoint`). Si hay un modal de
 * movimiento abierto, clasifica además contra su contenedor scrolleable y la
 * banda del pie fijo. Un tap muerto no tira error: se mide y se reporta.
 */
export const tapInfo = (ui, selectors) => ui.evalJs(`(() => {
  const list = ${JSON.stringify(selectors)};
  const submit = document.getElementById("tx-submit");
  let cont = submit;
  while (cont && getComputedStyle(cont).overflowY !== "auto") cont = cont.parentElement;
  const footer = submit ? (submit.closest(".sticky") ?? submit.parentElement) : null;
  const fr = footer ? footer.getBoundingClientRect() : null;
  const cr = cont ? cont.getBoundingClientRect() : null;
  return list.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, existe: false };
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const etiqueta = (n) => n ? (n.id || (n.tagName + (n.className ? "." + String(n.className).trim().split(/\\s+/)[0] : ""))) : null;
    return {
      sel, existe: true, visible: r.width > 0 && r.height > 0,
      x, y, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      hit: etiqueta(hit),
      toqueLlega: !!hit && (el === hit || el.contains(hit)),
      enBandaPie: fr ? (y >= fr.top && y <= fr.bottom) : null,
      recortado: cr ? (y < cr.top - 1 || y > cr.bottom + 1) : null,
      enViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
    };
  });
})()`);

/** Tabla legible de `tapInfo` para el log. */
export function imprimirTapInfo(titulo, infos) {
  console.log(`\n  ${titulo}`);
  for (const t of infos) {
    if (!t.existe) { console.log(`    · ${t.sel.padEnd(38)} — no existe`); continue; }
    const marcas = [];
    if (!t.toqueLlega) marcas.push(`TAP MUERTO (llega a ${t.hit})`);
    if (t.enBandaPie) marcas.push("EN BANDA DEL PIE");
    if (t.recortado) marcas.push("RECORTADO (scroll)");
    if (!t.enViewport) marcas.push("FUERA DEL VIEWPORT");
    if (t.visible === false) marcas.push("OCULTO");
    console.log(
      `    · ${t.sel.padEnd(38)} tap(${t.x.toFixed(0)},${t.y.toFixed(0)}) hit=${String(t.hit)}` +
        ` ${t.toqueLlega && !t.enBandaPie ? "ok" : "ATENCIÓN"} ${marcas.join(" · ")}`,
    );
  }
}

/**
 * Como `tapInfo`, pero la banda del pie se localiza desde un selector propio.
 *
 * El formulario de movimiento tiene `#tx-submit`; el importador CSV no, y su
 * pie sticky es igual de relevante (`#csv-confirm`). En los dos modales el pie
 * es hijo DIRECTO del contenedor scrolleable, así que el contenedor sale del
 * padre del pie. Todo lo demás (hit-test, banda, recorte) es idéntico.
 */
export const tapInfoPie = (ui, selectors, footerSelector) => ui.evalJs(`(() => {
  const list = ${JSON.stringify(selectors)};
  const footerEl = document.querySelector(${JSON.stringify(footerSelector)});
  const footer = footerEl ? (footerEl.closest(".sticky") ?? footerEl.parentElement) : null;
  const fr = footer ? footer.getBoundingClientRect() : null;
  const cont = footer ? footer.parentElement : null;
  const cr = cont ? cont.getBoundingClientRect() : null;
  return list.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, existe: false };
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const etiqueta = (n) => n ? (n.id || (n.tagName + (n.className ? "." + String(n.className).trim().split(/\\s+/)[0] : ""))) : null;
    return {
      sel, existe: true, visible: r.width > 0 && r.height > 0,
      x, y, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      hit: etiqueta(hit),
      toqueLlega: !!hit && (el === hit || el.contains(hit)),
      enBandaPie: fr ? (y >= fr.top && y <= fr.bottom) : null,
      recortado: cr ? (y < cr.top - 1 || y > cr.bottom + 1) : null,
      enViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
    };
  });
})()`);

/* ────────────────────────────────────────────────────────────────────────────
 * Flujos compartidos de UI
 * ──────────────────────────────────────────────────────────────────────────── */

/** Navega al panel, loguea si hace falta y espera el panel hidratado. */
export async function abrirPanel(ui, { timeout = 30000 } = {}) {
  await ui.navigate(`${BASE_URL}/`);
  await ui.loginIfNeeded();
  await ui.waitFor(`!!document.getElementById("btn-expense")`, {
    timeout,
    label: "el panel",
  });
  await ui.waitFor(
    `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
    { timeout, label: "la hidratación del panel" },
  );
}

/**
 * Abre el modal de movimiento tocando `openSelector` (click REAL) con los
 * reintentos de hidratación de r1. Devuelve cuántos reintentos usó.
 */
export async function abrirModal(ui, openSelector, { intentos = 4 } = {}) {
  let reintentos = 0;
  for (let intento = 0; intento < intentos; intento += 1) {
    if (intento > 0) reintentos += 1;
    await ui.evalJs(`document.getElementById(${JSON.stringify(openSelector.slice(1))})?.scrollIntoView({ block: "center" })`);
    await sleep(intento === 0 ? 200 : 300);
    await ui.clickEl(openSelector);
    try {
      await ui.waitFor(`!!document.getElementById("tx-submit")`, {
        timeout: 2500,
        label: "modal (reintento de apertura)",
      });
      return reintentos;
    } catch {
      // Reintento: el click cayó en la ventana sorda / pre-hidratación.
    }
  }
  await ui.waitFor(`!!document.getElementById("tx-submit")`, {
    timeout: 2000,
    label: "el modal tras los reintentos",
  });
  return reintentos;
}

/** Cierra el modal por cancelar (sin guardar) y espera que se vaya. */
export async function cerrarModal(ui) {
  await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
  await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 5000, label: "el cierre del modal" }).catch(() => {});
}
