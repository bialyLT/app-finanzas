#!/usr/bin/env node
/**
 * lib.mjs — helpers compartidos de las baterías del tester de la Fase 9
 * («responsive»).
 *
 * Reusa, SIN EDITAR, la red de la ronda anterior:
 *   · `scripts/tester-fase7/helpers.mjs` (sesión, contadores, limpieza por id)
 *   · `scripts/tester-fase7/cdp.mjs`       (el cliente CDP: clicks reales,
 *     teclas reales, capturas, login)
 *   · `scripts/responsive/measure.mjs`     (LA definición de desborde, target
 *     chico y tap muerto — la misma que usa la auditoría del dev)
 *
 * Y agrega lo que esta ronda necesita:
 *   · el contrato de salida `RESULT ok=N fail=M` (el de la auditoría y el que
 *     el orquestador suma entre rondas) junto al resumen de las baterías;
 *   · la emulación de device CON VERIFICACIÓN: si el viewport emulado no es el
 *     pedido, la batería falla (medir sobre otro viewport es peor que no medir,
 *     porque el reporte diría «ok»);
 *   · la emulación del puntero grueso (la regla de los 44 px está atada a
 *     `pointer: coarse`, así que sin toque emulado la app de escritorio es la
 *     que se mide);
 *   · helpers de apertura de modales y de taps REALES (con reintento acotado
 *     por la «ventana sorda» del CDP, siempre contado).
 */

import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  counters,
  failures,
  section,
  cleanupTag,
  login,
  PrismaClient,
  BASE_URL,
  checkTrue,
} from "../tester-fase7/helpers.mjs";

export * from "../tester-fase7/helpers.mjs";
export { openUi, TEST_VIEWPORT } from "../tester-fase7/cdp.mjs";
export {
  measureExpression,
  deadTapsExpression,
  scrollExpression,
} from "../responsive/measure.mjs";
import {
  measureExpression,
  deadTapsExpression,
  scrollExpression,
} from "../responsive/measure.mjs";
export { sleep };

/* ────────────────────────────────────────────────────────────────────────────
 * CONTRATO DE SALIDA
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Cierra la cuenta y deja las DOS líneas que el orquestador sabe leer:
 *   `──────── N ok · M fallas ────────` (formato de las baterías de la Fase 7)
 *   `RESULT ok=N fail=M`             (formato de la auditoría y del gate).
 * Devuelve true si no hubo fallas.
 */
export function summary() {
  const { passed, failed } = counters;
  console.log(`\n──────── ${passed} ok · ${failed} fallas ────────`);
  if (failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`RESULT ok=${passed} fail=${failed}`);
  return failed === 0;
}

/**
 * Envoltorio estándar: limpia ANTES (por id, con el prefijo del script), login →
 * main → summary → limpia DESPUÉS. Sale con 1 si hubo fallas.
 */
export async function runScript({ tag, main }) {
  const prisma = new PrismaClient();
  let ok = false;
  try {
    section(`Limpieza previa (${tag})`);
    await cleanupTag(prisma, tag);
    console.log("  lista");

    await login();
    await main(prisma);
    ok = summary();
  } finally {
    section(`Limpieza (${tag})`);
    await cleanupTag(prisma, tag);
    console.log("  lista");
    await prisma.$disconnect();
  }
  process.exit(ok ? 0 : 1);
}

/* ────────────────────────────────────────────────────────────────────────────
 * EMULACIÓN DE DEVICE (con verificación) Y PUNTERO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Aplica el viewport emulado. IMPORTANTE (y la razón de que esto esté en un
 * helper y no copiado en cada batería): la emulación de Chrome SOLO toma
 * efecto en el documento NUEVO. Si se mide sin navegar después, se mide el
 * viewport real y el reporte miente.
 */
export async function applyViewport(ui, vp, { touch = true } = {}) {
  await ui.send("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    screenWidth: vp.width,
    screenHeight: vp.height,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  if (touch) {
    await ui.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  } else {
    await ui.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}

/**
 * Verifica que la emulación aplicó. Si no, la batería FALLA: medir sobre otro
 * viewport es peor que no medir.
 *
 * Las señales:
 *   · `screen.width` — lo pone la emulación; el contenido puede agrandar el
 *     viewport de LAYOUT (`innerWidth`), nunca el de pantalla;
 *   · `innerWidth >= device` — el viewport de layout no puede ser menor;
 *   · `pointer: coarse` — la regla de los 44 px está atada al puntero: sin
 *     emulación de toque se mediría la app de escritorio.
 */
export async function verifyViewport(ui, vp, { touch = true } = {}) {
  const probe = await ui.evalJs(`({
    inner: window.innerWidth,
    screen: window.screen.width,
    avail: window.screen.availWidth,
    dpr: window.devicePixelRatio,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    anyCoarse: window.matchMedia("(any-pointer: coarse)").matches
  })`);
  const ok =
    probe.screen === vp.width &&
    probe.inner >= vp.width &&
    (touch ? probe.coarse === true : probe.coarse === false);
  if (!ok) {
    throw new Error(
      `LA EMULACIÓN NO APLICÓ para ${vp.width}px ` +
        `(screen.width=${probe.screen}, innerWidth=${probe.inner}, ` +
        `availWidth=${probe.avail}, dpr=${probe.dpr}, pointer-coarse=${probe.coarse}). ` +
        `La medición de ${vp.width}px no valdría nada.`,
    );
  }
  return probe;
}

/** Navega y deja la página lista (hidratada) para medir. */
export async function openRoute(ui, path, { wait = 900 } = {}) {
  await ui.navigate(`${BASE_URL}${path}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(wait);
  if (path !== "/login") await ui.loginIfNeeded();
  await sleep(500);
}

/* ────────────────────────────────────────────────────────────────────────────
 * MEDICIÓN (la MISMA definición que usa la auditoría del dev)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mide una unidad (vista o modal) con la expresión de `scripts/responsive/`.
 * Devuelve los datos crudos: desborde, targets chicos, taps muertos, avisos,
 * scrollers internos y contenido que no entra en su caja.
 */
export async function medir(ui, vp, { scope = null, minTarget = 44 } = {}) {
  await ui.evalJs(scrollExpression(scope ?? "body", 0));
  await sleep(200);
  const data = await ui.evalJs(
    measureExpression({ deviceWidth: vp.width, scopeSelector: scope, minTarget }),
  );
  if (data.error) throw new Error(`no se pudo medir: ${data.error}`);
  const taps = await ui.evalJs(deadTapsExpression({ scopeSelector: scope }));
  if (taps.error) throw new Error(`no se pudieron medir los taps: ${taps.error}`);
  return { data, taps };
}

/** ¿El documento (o el panel) se sale del ancho del device? */
export function desborde(data, vp, { scope = null } = {}) {
  if (scope) {
    return data.scopeScrollWidth > data.scopeClientWidth + 1;
  }
  return data.scrollWidth > vp.width + 1 || data.innerWidth > vp.width + 1;
}

/* ────────────────────────────────────────────────────────────────────────────
 * TAPS REALES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un TAP REAL (evento de mouse de verdad) con reintento acotado.
 *
 * La «ventana sorda» del CDP (el primer clic tras cargar puede llegar al DOM
 * sin reacción de React) es un artefacto de MEDICIÓN: se reintenta y el
 * reintento SIEMPRE queda contado, nunca se esconde.
 */
export async function tapHasta(ui, selector, condicion, { intentos = 4, label = selector } = {}) {
  let usados = 0;
  for (let intento = 0; intento < intentos; intento += 1) {
    if (intento > 0) usados += 1;
    await ui.evalJs(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
    );
    await sleep(intento === 0 ? 200 : 350);
    const rect = await ui.centerOf(selector);
    if (!rect) throw new Error(`No existe ${selector} para tocar.`);
    await ui.clickAt(rect.x, rect.y);
    try {
      await ui.waitFor(condicion, { timeout: 2500, label });
      return usados;
    } catch {
      // Reintento acotado (ventana sorda).
    }
  }
  await ui.waitFor(condicion, { timeout: 2500, label: `${label} tras los reintentos` });
  return usados;
}

/**
 * Abre un modal por su disparador (click real) y espera a que exista.
 * Devuelve el número de reintentos que hubo que hacer.
 */
export async function abrirModal(ui, disparador, selectorEspera, { intentos = 4 } = {}) {
  return tapHasta(ui, disparador, `!!document.querySelector(${JSON.stringify(selectorEspera)})`, {
    intentos,
    label: selectorEspera,
  });
}

/**
 * La geometría de un control Y a quién le llega el punto de toque AHORA.
 * `banda` = el rect del pie pegajoso (si se pasa), para decir si el control
 * queda DEBAJO de la banda.
 */
export const geometria = (ui, selector, bandaSelector = null) =>
  ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { existe: false };
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const banda = ${bandaSelector ? `document.querySelector(${JSON.stringify(bandaSelector)})` : "null"};
    const br = banda ? banda.getBoundingClientRect() : null;
    return {
      existe: true,
      x, y, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      w: r.width, h: r.height,
      hit: hit ? (hit.id || hit.tagName.toLowerCase()) : null,
      llega: !!hit && (hit === el || el.contains(hit)),
      bandaTop: br ? br.top : null,
      bandaBottom: br ? br.bottom : null,
      bajoLaBanda: br ? (y >= br.top) : false
    };
  })()`);

/* ────────────────────────────────────────────────────────────────────────────
 * SERVIDOR DE FIXTURES (para probar la auditoría sin tocar la app)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Levanta un servidor HTTP mínimo que sirve la misma página para cualquier
 * ruta. Sirve para probar la auditoría REAL contra un layout roto a propósito
 * (sin rebuild y sin tocar la app): la auditoría es un script que habla HTTP,
 * y lo que importa es que detects el desborde, no de dónde viene la página.
 */
export function servirFixture(html, puerto = 3199) {
  return new Promise((resolve) => {
    const server = spawn(
      process.execPath,
      [
        "-e",
        `const http=require("http");const html=${JSON.stringify(html)};` +
          `http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8"});` +
          `res.end(html);}).listen(${puerto},"127.0.0.1",()=>{console.log("listo");});`,
      ],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    const listo = () => resolve({ server, puerto, cerrar: () => childKill(server) });
    server.stdout.once("data", listo);
    server.once("error", (e) => resolve({ server, puerto, error: e, cerrar: () => {} }));
  });
}

function childKill(child) {
  try {
    process.kill(child.pid);
  } catch {
    // Ya estaba muerto.
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * EJECUCIÓN DEL RUNNER DE LA AUDITORÍA (para probarlo de verdad)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Corre `scripts/responsive/audit-mobile.mjs` como proceso hijo y devuelve
 * `{code, out}`. Se usa para verificar el CONTRATO del runner: `RESULT
 * ok=N fail=M` en la última línea y código de salida 1 si hay fallas.
 */
export function correrAuditoria(args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/responsive/audit-mobile.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Última línea `RESULT ok=N fail=M` de la salida de un runner. */
export function resultadoDe(out) {
  const m = [...out.matchAll(/RESULT ok=(\d+) fail=(\d+)/g)].pop();
  return m ? { ok: Number(m[1]), fail: Number(m[2]) } : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ENVOLTORIO DE BATERÍA
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Envoltorio común de las baterías de esta carpeta: corre `main`, y si
 * revienta con una excepción la cuenta como FALLA (una batería que se cae no
 * puede terminar con «0 fallas»), imprime el resumen con las dos líneas que
 * el orquestador suma y sale con 1 si hubo fallas.
 */
export async function correrBateria({ main, etiqueta = "la batería", conSesion = false }) {
  let ok = false;
  try {
    if (conSesion) await login();
    await main();
    ok = true;
  } catch (error) {
    console.error(`\n${etiqueta} falló: ${error.message ?? error}`);
    checkTrue(`${etiqueta} termina sin excepción`, false, String(error.message ?? error));
  } finally {
    const bueno = summary();
    process.exit(bueno && ok ? 0 : 1);
  }
}
