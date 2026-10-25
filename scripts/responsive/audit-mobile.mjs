#!/usr/bin/env node
/**
 * audit-mobile.mjs — auditoría de responsive.
 *
 * Barre un RANGO de anchos (no tres teléfonos) y, en cada vista, mide:
 *   - desborde horizontal: el CONTENIDO (documentElement.scrollWidth) supera
 *     el ancho del DEVICE. Ojo: `innerWidth` no sirve para esto, porque
 *     cuando el contenido no puede achicarse Chrome EXPANDE el viewport de
 *     layout y `innerWidth` miente (medido: 375 -> 664 en el inicio). El
 *     ancho del device es la verdad.
 *   - los culpables: elementos más anchos que el device, con su clase y su
 *     padre (un `grid` con min-content largo, un `whitespace-nowrap`, una
 *     tabla, un `w-[Npx]`...).
 *   - targets táctiles chicos (< 44px: el mínimo recomendado en mobile).
 *   - taps muertos: un control visible cuyo punto de toque cae en otra capa
 *     (el pie pegajoso del modal, un toast) — el toque "completa" sin llegar
 *     al control.
 *   - contenido que NO entra en su caja: un número (o un texto con
 *     `nowrap`) más ancho que su tarjeta queda CORTADO dentro de ella. El
 *     documento puede estar perfecto y el número igual partido. Esto es
 *     una FALLA (con umbral explícito: `--max-overflow`, 1 px por
 *     defecto), no un aviso: el gate no puede dar verde con un número
 *     partido.
 *
 * Y abre y mide cada MODAL (movimiento, cuenta, préstamo, tarjeta, compra en
 * cuotas, CSV, paleta y el formulario de recurrencia) en las DOS
 * orientaciones: de pie (375 px) y acostado (844×390 y 667×375).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN RANGO Y NO TRES TELÉFONOS
 * Un arreglo que funciona en 375 y se rompe en 480 no es un arreglo: es un
 * arreglo para 375. El rango va de 320 (el teléfono más angosto que se
 * vende) a 1024 (una tablet en landscape, que es un teléfono en landscape
 * con más píxeles), y el criterio es el mismo en todos: el contenido no
 * puede forzar un ancho mayor al del device y ningún control táctil puede
 * medir menos de 44×44.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL VIEWPORT SE VERIFICA ANTES DE MEDIR
 * La emulación se aplica con `Emulation.setDeviceMetricsOverride` y SOLO
 * toma efecto en el documento NUEVO. Si la emulación no aplicó, la
 * medición no mide nada: es peor que no medir, porque el reporte dirá
 * "ok". Por eso, antes de cada medición se comprueba que el ancho de
 * PANTALLA del navegador es el del device (el contenido puede agrandar el
 * viewport de LAYOUT, pero nunca el de pantalla) y que el viewport de
 * layout no es menor que el device. Si no, la auditoría falla ruidosamente.
 *
 * CONTRATO DE SALIDA (el mismo de las baterías de `scripts/tester-fase7/`):
 *   - imprime `RESULT ok=N fail=M` en la última línea;
 *   - sale con código 1 si hay alguna falla, 0 si no.
 *
 * Uso:
 *   node scripts/responsive/audit-mobile.mjs
 *   node scripts/responsive/audit-mobile.mjs --only=views
 *   node scripts/responsive/audit-mobile.mjs --only=modals
 *   node scripts/responsive/audit-mobile.mjs --width 360 --height 740
 */

import { openUi } from "../tester-fase7/cdp.mjs";
import {
  measureExpression,
  deadTapsExpression,
  scrollExpression,
} from "./measure.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const args = process.argv.slice(2);

/**
 * Un número de la línea de comandos.
 *
 * Acepta las dos formas (`--nombre 5` y `--nombre=5`) y —esto es lo
 * importante— NUNCA devuelve un número que no sea un número: un umbral
 * `NaN` dejaría la comparación del check de contenido siempre falsa, y el
 * check SE DESACTIVARÍA EN SILENCIO. Un gate que se apaga con un typo no es
 * un gate. Con un valor inválido se usa el de siempre y se avisa en voz alta.
 */
function optNum(name, fallback) {
  const conIgual = args.find((a) => a.startsWith(`--${name}=`));
  if (conIgual) {
    const crudo = conIgual.slice(name.length + 3);
    const n = Number(crudo);
    if (Number.isFinite(n)) return n;
    console.warn(
      `  ⚠ --${name}=«${crudo}» no es un número: se usa el valor por defecto (${fallback}).`,
    );
    return fallback;
  }
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (Number.isFinite(n)) return n;
  console.warn(
    `  ⚠ --${name} sin valor (o con un valor que no es un número): ` +
      `se usa el valor por defecto (${fallback}).`,
  );
  return fallback;
}

const optText = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const ONLY = optText("only", "all");
const MIN_TARGET = optNum("min-target", 44);
/**
 * Umbral EXPLÍCITO del check «el contenido entra en su caja».
 *
 * Un texto puede pasarse por un píxel por redondeo de la fuente: por eso
 * hay un umbral y no una comparación exacta. Pero el umbral es un NÚMERO
 * dicho de antemano (1 px), no una regla implícita: el gate tiene que poder
 * dar verde con un número PARTIDO y eso es exactamente lo que no puede pasar.
 *
 * EL CONTRATO DEL UMBRAL (para que quede escrito):
 *   · el valor por defecto es 1 px y es el que se usa salvo que se pida otro;
 *   · `--max-overflow N` lo ajusta (0 = el más estricto: un solo píxel de
 *     corte ya es falla; un valor enorme lo desactiva a propósito);
 *   · el umbral que se usó QUEDA IMPRESO en cada línea del reporte, así que
 *     una corrida con un umbral unusual es visible en el log;
 *   · un flag mal escrito (sin valor, o con un valor que no es número) NO
 *     puede desactivar el check: se usa el valor por defecto y se avisa.
 */
const MAX_OVERFLOW = optNum("max-overflow", 1);

/** Filtros para iterar rápido: `--routes=analisis,inicio` `--widths=320,640`. */
const filtroRutas = optText("routes", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const filtroAnchos = optText("widths", "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * El rango de anchos que se barren. La altura es la de un device real con
 * ese ancho: en 320 la pantalla es más baja, y en 1024 (landscape) también.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS ORIENTACIONES (el hueco que dejó la ronda anterior)
 * La auditoría medía sólo de PORTRAIT: el landscape no existía para ella, y
 * ahí estaba el BUG-1 que el tester encontró a mano (la paleta de comandos
 * medía 439 px en una ventana de 390). Un teléfono acostado es un caso de
 * uso real —es como se mira el celular en la calle— y una pantalla BAJA
 * rompe cosas que una pantalla alta no rompe (el pie fijo del modal se
 * come los campos).
 *
 * Por eso el rango incluye los dos landscape: 844×390 (un iPhone 14
 * acostado) y 667×375 (un SE acostado, el teléfono más chico).
 *
 * OJO con la orientación: la metadata `screenOrientation` no cambia lo que
 * se mide (el viewport de LAYOUT: el ancho y el alto emulados), pero se
 * deja en `portraitPrimary` para que el `screen.width` que verifica
 * `verifyViewport` sea el emulado y no el que Chrome deduzca de la
 * metadata.
 */
const VIEWPORTS = [
  { name: "320 angosto", width: optNum("width", 320), height: optNum("height", 568), orientacion: "portrait" },
  { name: "360 android", width: 360, height: 740, orientacion: "portrait" },
  { name: "390 iphone14", width: 390, height: 844, orientacion: "portrait" },
  { name: "414 iphone11", width: 414, height: 896, orientacion: "portrait" },
  { name: "480 grande", width: 480, height: 854, orientacion: "portrait" },
  { name: "640 tablet", width: 640, height: 960, orientacion: "portrait" },
  { name: "768 ipadmini", width: 768, height: 1024, orientacion: "portrait" },
  { name: "1024 tablet", width: 1024, height: 768, orientacion: "landscape" },
  { name: "844 landscape", width: 844, height: 390, orientacion: "landscape" },
  { name: "667 landscape", width: 667, height: 375, orientacion: "landscape" },
];

/**
 * Los modales se miden en las DOS orientaciones: de pie (el teléfono más
 * chico que se usa) y acostado (844×390 y 667×375). Un modal que entra de
 * pie y se pasa acostado es un modal roto: en landscape la ventana es BAJA
 * y los pies fijos tapan los campos (el BUG-1 de la paleta).
 */
const MODAL_VIEWPORTS = [
  { name: "375 iphone-se", width: 375, height: 667, orientacion: "portrait" },
  { name: "844 landscape", width: 844, height: 390, orientacion: "landscape" },
  { name: "667 landscape", width: 667, height: 375, orientacion: "landscape" },
];

const ROUTES = [
  { path: "/", name: "inicio" },
  { path: "/analisis", name: "analisis" },
  { path: "/prestamos", name: "prestamos" },
  { path: "/tarjetas", name: "tarjetas" },
  { path: "/recurrencia", name: "recurrencia" },
  { path: "/login", name: "login" },
];

/**
 * Los modales (y el formulario de recurrencia, que no es un modal pero se
 * abre y se mide igual) que hay que abrir y medir.
 *
 * `scope` es lo que se mide: el panel del modal o la sección del formulario.
 * `trigger` es el botón que lo abre.
 */
const PANEL = '[role="dialog"]';
const MODALS = [
  { name: "gasto", path: "/", trigger: "#btn-expense", scope: PANEL },
  { name: "ingreso", path: "/", trigger: "#btn-income", scope: PANEL },
  { name: "transferencia", path: "/", trigger: "#btn-transfer", scope: PANEL },
  { name: "cuenta", path: "/", trigger: "#btn-add-account", scope: PANEL },
  { name: "csv", path: "/", trigger: "#btn-import-csv", scope: PANEL, prepare: "csv-preview" },
  { name: "paleta", path: "/", trigger: "#btn-palette", scope: PANEL },
  { name: "prestamo", path: "/prestamos", trigger: "#loans-new", scope: PANEL },
  { name: "tarjeta-config", path: "/tarjetas", trigger: '[id^="card-config-"]', scope: PANEL },
  {
    name: "tarjeta-cuotas",
    path: "/tarjetas",
    trigger: '[id^="card-new-plan-"]',
    scope: PANEL,
    // La compra en cuotas sólo se puede cargar si la tarjeta tiene día de
    // cierre. El seed no lo tiene, así que la auditoría arma una tarjeta
    // descartable para poder medir el modal y la borra al final.
    needsCardWithClosing: true,
  },
  {
    name: "regla-recurrencia",
    path: "/recurrencia",
    trigger: "#rec-add-rule",
    scope: "#rec-form",
  },
  {
    // El nav abierto: el estado que la app ofrece en el teléfono. Antes de
    // tocarlo, el panel existe pero está oculto (`hidden`): que aparezca de
    // verdad es lo que se verifica.
    //
    // El menú del teléfono es un `Sheet` (Radix Dialog, side=left): al tocar
    // `#nav-toggle` se ve el panel `#nav-sheet` (`role=dialog`) con los mismos
    // destinos que la fila de escritorio. Se mide el panel abierto.
    //
    // OJO: el botón del menú (`#nav-toggle`) es `md:hidden` — desde 768 px
    // la navegación es una fila y el botón no existe. El caso NO aplica en
    // pantalla ancha (y en landscape de teléfono, con 844 px, tampoco): por
    // eso el caso se salta a partir de 768 px, con la razón anotada.
    name: "nav-abierto",
    path: "/",
    trigger: "#nav-toggle",
    scope: "#nav-sheet",
    aplicaHasta: 768,
    verify:
      "!!document.querySelector('#nav-sheet') " +
      "&& document.querySelector('#nav-sheet').getBoundingClientRect().width > 0",
  },
];

/** Lee APP_PASSWORD del .env del proyecto (el smoke hace lo mismo). */
function readPassword() {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    const m = raw.match(/^APP_PASSWORD=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "finanzas-dev";
  } catch {
    return "finanzas-dev";
  }
}

/* ── Estado de la app (para el modal que necesita preparación) ───────────── */

let sessionCookie = "";

/** Login por la API: hace falta una sesión para armar el estado del modal. */
async function apiLogin(password) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ password }),
  });
  const raw = response.headers.getSetCookie?.().find((c) => c.startsWith("finanzas_session="));
  if (!raw) throw new Error("la API no devolvió la cookie de sesión");
  sessionCookie = raw.split(";")[0];
}

/** Crea una tarjeta descartable con día de cierre (para medir compras en cuotas). */
async function createTempCard() {
  const response = await fetch(`${BASE_URL}/api/accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      name: "__AUDIT_TARJETA__",
      kind: "CREDIT_CARD",
      closingDay: 25,
      dueDay: 5,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.id) {
    throw new Error(`no se pudo crear la tarjeta temporal: ${response.status}`);
  }
  return body.id;
}

async function deleteTempCard(id) {
  if (!id) return;
  await fetch(`${BASE_URL}/api/accounts?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Origin: BASE_URL, Cookie: sessionCookie },
  }).catch(() => {});
}

/** Cuenta cuántas tarjetas de la auditoría quedaron en la base. */
async function countTempCards() {
  const response = await fetch(`${BASE_URL}/api/accounts`, {
    headers: { Cookie: sessionCookie },
  });
  const body = await response.json().catch(() => ({}));
  const cuentas = Array.isArray(body?.accounts) ? body.accounts : [];
  return cuentas.filter((c) => String(c?.name ?? "").startsWith("__AUDIT_")).length;
}

/* ── Reporte ─────────────────────────────────────────────────────────────── */

const report = [];
const failures = [];
let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

/* ── Recorridos ──────────────────────────────────────────────────────────── */

async function applyViewport(ui, vp) {
  // La emulación SOLO toma efecto en el documento NUEVO: se aplica y
  // después se navega (si se mide antes, el reporte mide el viewport real).
  await ui.send("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    screenWidth: vp.width,
    screenHeight: vp.height,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
}

/**
 * Verifica que la emulación se aplicó. Se hace ANTES de medir: si la
 * emulación no aplicó, la medición no mide nada y el reporte mentiría.
 *
 * La señal es el ancho de PANTALLA (`screen.width`): el contenido puede
 * agrandar el viewport de LAYOUT (innerWidth) cuando no puede achicarse,
 * pero el de pantalla lo pone la emulación y nada más.
 */
async function verifyViewport(ui, vp) {
  const probe = await ui.evalJs(`({
    inner: window.innerWidth,
    screen: window.screen.width,
    avail: window.screen.availWidth,
    dpr: window.devicePixelRatio,
    coarse: window.matchMedia("(pointer: coarse)").matches
  })`);
  const ok =
    probe.screen === vp.width && probe.inner >= vp.width && probe.coarse === true;
  if (!ok) {
    throw new Error(
      `LA EMULACIÓN NO APLICÓ para ${vp.width}px ` +
        `(screen.width=${probe.screen}, innerWidth=${probe.inner}, ` +
        `availWidth=${probe.avail}, dpr=${probe.dpr}, ` +
        `pointer-coarse=${probe.coarse}). ` +
        `La medición de ${vp.width}px no valdría nada: se aborta.`,
    );
  }
  return probe;
}

async function openRoute(ui, path) {
  await ui.navigate(`${BASE_URL}${path}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(600);
  if (path !== "/login") await ui.loginIfNeeded();
  await sleep(400);
}

/**
 * Mide una unidad (una vista o un modal abierto).
 *
 * La métrica de desborde y la de targets chicos no dependen del scroll (son
 * properties del layout), así que se miden una vez. Los taps muertos tienen
 * su propia prueba (`deadTapsExpression`): un control tapado en la posición
 * actual se trae al centro y se vuelve a medir, para no confundu un pie
 * pegajoso —que se aparta al scrollear— con una capa que no se mueve.
 */
async function measureUnit(ui, vp, unit) {
  const scope = unit.scope ?? null;

  await ui.evalJs(scrollExpression(scope ?? "body", 0));
  await sleep(200);

  const data = await ui.evalJs(
    measureExpression({
      deviceWidth: vp.width,
      scopeSelector: scope,
      minTarget: MIN_TARGET,
      maxOverflow: MAX_OVERFLOW,
    }),
  );
  if (data.error) {
    check(`${vp.name} · ${unit.name} · se mide`, false, data.error);
    return null;
  }

  const taps = await ui.evalJs(deadTapsExpression({ scopeSelector: scope }));
  if (taps.error) {
    check(`${vp.name} · ${unit.name} · se miden los taps`, false, taps.error);
    return null;
  }

  return {
    data,
    deadTaps: taps.deadTaps,
    avisos: taps.avisos ?? [],
    smallTargets: data.smallTargets,
    smallTargetCount: data.smallTargetCount,
    scopeScrollWidth: data.scopeScrollWidth,
    scopeClientWidth: data.scopeClientWidth,
    overflowers: data.overflowers ?? [],
  };
}

async function measureView(ui, vp, route) {
  const result = await measureUnit(ui, vp, { name: `vista ${route.name}`, scope: null });
  if (!result) return null;
  const data = result.data;

  const overflow = data.scrollWidth > vp.width + 1 || data.innerWidth > vp.width + 1;

  const line =
    `[${vp.name.padEnd(15)}] vista ${route.name.padEnd(12)} device=${vp.width} contenido=${data.scrollWidth} ` +
    `${overflow ? "DESBORDE" : "ok"} | innerWidth=${data.innerWidth} | tapTargets<${MIN_TARGET}px: ${result.smallTargetCount} | taps muertos: ${result.deadTaps.length} | avisos: ${result.avisos.length} | cortados: ${result.overflowers.length} | ${vp.orientacion ?? "portrait"}`;

  report.push({ type: "vista", line, data, result });

  check(
    `${vp.name} · vista ${route.name} · sin desborde horizontal`,
    !overflow,
    `contenido=${data.scrollWidth} device=${vp.width} innerWidth=${data.innerWidth}`,
  );
  check(
    `${vp.name} · vista ${route.name} · sin targets táctiles < ${MIN_TARGET}px`,
    result.smallTargetCount === 0,
    result.smallTargets.map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "),
  );
  check(
    `${vp.name} · vista ${route.name} · sin taps muertos`,
    result.deadTaps.length === 0,
    result.deadTaps.map((t) => `${t.el} <- ${t.blockedBy}`).join(" | "),
  );
  check(
    `${vp.name} · vista ${route.name} · el contenido entra en su caja (sobra ≤ ${MAX_OVERFLOW}px)`,
    result.overflowers.length === 0,
    result.overflowers
      .map((o) => `${o.el} ${o.scrollW} en ${o.parentW} (sobra ${o.sobra}px) texto="${o.text}"`)
      .join(" | "),
  );

  return result;
}

async function measureModal(ui, vp, modal) {
  await openRoute(ui, modal.path);

  // El disparador puede aparecer DESPUÉS del `load`: varias páginas son
  // componentes de cliente que piden sus datos recién al montar (la de
  // tarjetas, por ejemplo, resuelve /api/cards después). La espera fija de
  // `openRoute` alcanzaba casi siempre, pero con el caché de JS frío la
  // primera vista podía tardar más y el gate reportaba «no existe el
  // disparador» — un FALSO NEGATIVO (medido en la F0b: pasó en la primera
  // corrida y no en la segunda). Se espera el SELECTOR, con tope: si de verdad
  // no existe, la falla sigue siendo una falla.
  await ui
    .waitFor(`!!document.querySelector(${JSON.stringify(modal.trigger)})`, {
      timeout: 8000,
      label: `el disparador ${modal.trigger}`,
    })
    .catch(() => null);

  // El disparador puede estar debajo del pliegue: se trae a la vista antes
  // de tocar (un tap fuera de la vista no toca nada).
  const brought = await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(modal.trigger)});
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  })()`);
  if (!brought) {
    check(
      `${vp.name} · modal ${modal.name} · se puede abrir`,
      false,
      `no existe el disparador ${modal.trigger}`,
    );
    return null;
  }
  await sleep(250);

  const rect = await ui.centerOf(modal.trigger);
  if (!rect) {
    check(`${vp.name} · modal ${modal.name} · se puede abrir`, false, "sin rectángulo");
    return null;
  }
  await ui.clickAt(rect.x, rect.y);
  await sleep(600);

  const opened = await ui.evalJs(`!!document.querySelector(${JSON.stringify(modal.scope)})`);
  if (!opened) {
    check(
      `${vp.name} · modal ${modal.name} · se abre con el disparador ${modal.trigger}`,
      false,
      `no apareció ${modal.scope}`,
    );
    return null;
  }
  check(
    `${vp.name} · modal ${modal.name} · se abre con el disparador ${modal.trigger}`,
    true,
  );

  // Un panel puede EXISTIR y estar oculto: para el nav del teléfono, el
  // panel está en el DOM desde el arranque (`hidden`) y lo que se verifica es
  // que aparezca de verdad al tocar el botón.
  if (modal.verify) {
    const visible = await ui.evalJs(`Boolean(${modal.verify})`);
    check(
      `${vp.name} · modal ${modal.name} · el panel queda visible`,
      visible,
      `no se cumplió: ${modal.verify}`,
    );
    if (!visible) return null;
  }

  // Algunos modales tienen más de un estado que importa: el importador CSV,
  // por ejemplo, con la previsualización ya cargada (que es donde estaba la
  // tabla que no entraba en un teléfono).
  if (modal.prepare === "csv-preview") {
    await ui.evalJs(`(() => {
      const ta = document.querySelector("#csv-text");
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, [
        "fecha,tipo,monto,cuenta,categoria,descripcion",
        "2026-08-03,EXPENSE,1500,Banco Galicia,Comida,Café",
        "2026-08-04,INCOME,250000,Banco Galicia,Sueldo,Agosto",
        "2026-08-05,TRANSFER,50000,Efectivo,,Traslado entre mis cuentas",
        "no-es-fecha,EXPENSE,100,Banco Galicia,,Fila rota a proposito",
      ].join("\\n"));
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(200);
    await ui.clickEl("#csv-preview-button");
    const preview = await ui
      .waitFor(`!!document.querySelector("#csv-preview")`, {
        timeout: 15000,
        label: "la previsualización del CSV",
      })
      .then(() => true)
      .catch(() => false);
    check(
      `${vp.name} · modal ${modal.name} · la previsualización se puede ver`,
      preview,
      "no apareció #csv-preview",
    );
    await sleep(300);
  }

  const result = await measureUnit(ui, vp, modal);
  if (!result) return null;
  const data = result.data;

  const innerOverflow = result.scopeScrollWidth > result.scopeClientWidth + 1;
  const pageOverflow = data.scrollWidth > vp.width + 1 || data.innerWidth > vp.width + 1;

  const line =
    `[${vp.name.padEnd(15)}] ${modal.name.padEnd(18)} device=${vp.width} ` +
    `panel=${result.scopeClientWidth} contenido=${result.scopeScrollWidth} ` +
    `${innerOverflow ? "DESBORDE DENTRO" : "ok"} | doc=${data.scrollWidth} | tapTargets<${MIN_TARGET}px: ${result.smallTargetCount} | taps muertos: ${result.deadTaps.length} | avisos: ${result.avisos.length} | cortados: ${result.overflowers.length} | ${vp.orientacion ?? "portrait"}`;

  report.push({ type: "modal", line, data, result });

  check(
    `${vp.name} · ${modal.name} · el contenido entra en el panel`,
    !innerOverflow,
    `panel=${result.scopeClientWidth} contenido=${result.scopeScrollWidth}`,
  );
  check(
    `${vp.name} · ${modal.name} · sin desborde horizontal de la página`,
    !pageOverflow,
    `doc=${data.scrollWidth} device=${vp.width} innerWidth=${data.innerWidth}`,
  );
  check(
    `${vp.name} · ${modal.name} · sin targets táctiles < ${MIN_TARGET}px`,
    result.smallTargetCount === 0,
    result.smallTargets.map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "),
  );
  check(
    `${vp.name} · ${modal.name} · sin taps muertos`,
    result.deadTaps.length === 0,
    result.deadTaps.map((t) => `${t.el} <- ${t.blockedBy}`).join(" | "),
  );
  check(
    `${vp.name} · ${modal.name} · el contenido entra en su caja (sobra ≤ ${MAX_OVERFLOW}px)`,
    result.overflowers.length === 0,
    result.overflowers
      .map((o) => `${o.el} ${o.scrollW} en ${o.parentW} (sobra ${o.sobra}px) texto="${o.text}"`)
      .join(" | "),
  );

  return result;
}

/* ── Corredora ───────────────────────────────────────────────────────────── */

async function main() {
  process.env.APP_PASSWORD = readPassword();
  // `fileURLToPath` y no `.pathname`: el pathname deja el espacio del path
  // como "%20" y las capturas se guardan en un directorio que no existe.
  // `AUDIT_OUT_DIR` permite que otra corrida (la del tester) no pise las
  // capturas de la corrida anterior: es sólo dónde se guardan los PNG.
  const outDir =
    process.env.AUDIT_OUT_DIR ??
    fileURLToPath(new URL("../../reports/responsive/", import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const ui = await openUi({
    port: 9347,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile`,
  });

  // SIN ESTO LA AUDITORÍA MIENTE. Con sólo `setDeviceMetricsOverride`, Chrome
  // sigue reportando `pointer: fine` (verificado), así que la regla de los
  // 44 px —que está atada al puntero grueso, no al ancho— NO se aplicaría
  // y la auditoría mediría una app de escritorio en un supposedly-teléfono.
  // Con la emulación de toque activada, `pointer: coarse` es cierto: lo que
  // se mide es lo que pasa en un teléfono de verdad, a cualquier ancho
  // (incluido un landscape de 1024 px).
  //
  // `AUDIT_SKIP_TOUCH=1` apaga la emulación de toque a propósito: es el
  // gancho de prueba del camino de ABORTE (si la emulación no aplicó, la
  // auditoría tiene que fallar ruidosamente, no decir «ok»). Lo usa
  // `scripts/tester-responsive/01-auditoria-integridad.mjs`. Por defecto la
  // emulación está activada: el comportamiento normal no cambia.
  if (process.env.AUDIT_SKIP_TOUCH !== "1") {
    await ui.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  }

  let tempCardId = null;

  try {
    if (ONLY === "all" || ONLY === "views") {
      for (const vp of VIEWPORTS) {
        if (filtroAnchos.length && !filtroAnchos.includes(vp.width)) continue;
        for (const route of ROUTES) {
          if (filtroRutas.length && !filtroRutas.includes(route.name)) continue;
          await applyViewport(ui, vp);
          await openRoute(ui, route.path);
          await verifyViewport(ui, vp);
          const result = await measureView(ui, vp, route);
          if (result) {
            await ui.screenshot(`${outDir}${route.name}-${vp.width}.png`);
          }
        }
      }
    }

    if (ONLY === "all" || ONLY === "modals") {
      await apiLogin(process.env.APP_PASSWORD);
      for (const vp of MODAL_VIEWPORTS) {
        for (const modal of MODALS) {
          // Un caso que NO aplica en este viewport (el botón del menú del
          // teléfono no existe desde 768 px) se salta con su razón: no se
          // mide, y no es una falla.
          if (modal.aplicaHasta && vp.width >= modal.aplicaHasta) {
            console.log(
              `\n[${vp.name}] ${modal.name}: caso que no aplica a ${vp.width} px ` +
                `(el disparador no existe desde ${modal.aplicaHasta} px) — se salta`,
            );
            continue;
          }
          if (modal.needsCardWithClosing && !tempCardId) {
            tempCardId = await createTempCard();
          }
          await applyViewport(ui, vp);
          await openRoute(ui, modal.path);
          await verifyViewport(ui, vp);
          const result = await measureModal(ui, vp, modal);
          if (result) {
            await ui.screenshot(`${outDir}modal-${modal.name}-${vp.width}x${vp.height}.png`);
          }
        }
      }
    }
  } finally {
    if (tempCardId) await deleteTempCard(tempCardId);
    if (!sessionCookie) await apiLogin(process.env.APP_PASSWORD).catch(() => {});
    const left = await countTempCards().catch(() => -1);
    if (left > 0) {
      check("la base queda sin tarjetas de la auditoría", false, `quedaron ${left}`);
    } else {
      check("la base queda sin tarjetas de la auditoría", true);
    }
    await ui.close();
  }

  console.log("\n=== AUDITORIA RESPONSIVE ===\n");
  for (const r of report) {
    console.log(r.line);
    for (const c of (r.data.culprits ?? []).slice(0, 5)) {
      console.log(`      culpable: ${c.el}`);
      console.log(
        `               w=${c.w} scrollW=${c.scrollW} minW=${c.minW} display=${c.display} cols=${c.gridCols}`,
      );
    }
    for (const t of (r.result?.smallTargets ?? []).slice(0, 25)) {
      console.log(`      target chico: ${t.el} ${t.w}x${t.h} (${t.why})`);
    }
    for (const t of (r.result?.deadTaps ?? []).slice(0, 25)) {
      console.log(`      tap muerto: ${t.el} -> lo tapa ${t.blockedBy}`);
    }
    for (const t of (r.result?.avisos ?? []).slice(0, 25)) {
      console.log(`      aviso: en reposo lo tapa ${t.blockedBy} (${t.el}) — scrolleando se alcanza`);
    }
    for (const s of (r.data.innerScroll ?? []).slice(0, 10)) {
      console.log(`      scroll horizontal interno: ${s.el} (${s.scrollW} en ${s.clientW})`);
    }
    for (const o of (r.data.overflowers ?? []).slice(0, 10)) {
      console.log(
        `      no entra en su caja: ${o.el} (${o.scrollW} en ${o.parentW}, ` +
          `sobra ${o.sobra}px > ${MAX_OVERFLOW}px) padre=${o.parent} texto="${o.text}"`,
      );
    }
  }

  console.log(`\nCapturas: ${outDir}`);

  if (failed > 0) {
    console.log(`\nFallaron ${failed} checks:`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`\nRESULT ok=${passed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nFalló la auditoría:", error.message ?? error);
  console.log("\nRESULT ok=0 fail=1");
  process.exit(1);
});
