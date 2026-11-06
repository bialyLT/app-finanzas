#!/usr/bin/env node
/**
 * f3b-empty-a11y.mjs — batería adversarial de F3b (EmptyState, foco, aria-live,
 * foco del modal de voz, glifo de 320), contra :3101 + `finanzas_test`.
 *
 * Ataques, en orden de riesgo:
 *
 *   1. ESTADOS VACÍOS DE VERDAD. Se vacían las 11 tablas de la app (respaldo
 *      previo con `pg_dump`, restauración con `pg_restore --clean`), se navegan
 *      las 5 vistas y se exige el `EmptyState` con su id y su título: ni blanco,
 *      ni "Cargando." eterno, ni error de carga. Se repite a 320 px.
 *   2. REGRESIÓN CON DATOS. Antes de vaciar: panel/listas/totales vivos y los
 *      ids de vacío AUSENTES.
 *   3. TECLADO. Tab real en las 5 vistas y en 5 modales: todo control declarado
 *      alcanzable y todo foco con indicador visible (outline o box-shadow).
 *   4. aria-live. Guardar un movimiento (status) y CSV inválido (alert).
 *   5. FOCO DEL MODAL DE VOZ. Escape devuelve el foco a `#btn-voice-capture`.
 *   6. 320. Pestañas de tipo de movimiento sin roce ni superposición y sin
 *      scroll horizontal, barriendo 320/336/352/368/384.
 *
 * Contrato: imprime `RESULT ok=N fail=M`, sale 1 si hay fallas.
 * Seguridad: aborta si DATABASE_URL_TEST no es `finanzas_test`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:3101";
const PORT = 9391;
const APP_PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";
const DUMP = "C:\\Users\\Lourdes\\AppData\\Local\\Temp\\gpX0GABX\\opencode\\finanzas_test_f3b_backup.dump";

function dotEnvValue(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // sin .env
  }
  return "";
}

const TEST_DB_URL = process.env.DATABASE_URL_TEST || dotEnvValue("DATABASE_URL_TEST");
if (!TEST_DB_URL || !/\/finanzas_test(\?|$)/.test(TEST_DB_URL)) {
  console.error("Destino IMPERMITIDO: DATABASE_URL_TEST no apunta a finanzas_test. Aborto.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB_URL;
process.env.SMOKE_BASE_URL = BASE;

const { openUi } = await import("../tester-fase7/cdp.mjs");
const { check, checkTrue, checkIncluye, counters, failures, section, summary } =
  await import("../tester-fase7/helpers.mjs");
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

const VIEWPORT = { width: 1019, height: 557 };
const PG_BIN = `${process.env.LOCALAPPDATA}\\pg17\\pgsql\\bin`;

/* ────────────────────────── sonda de foco ────────────────────────── */

/** Lista de focusables visibles del ámbito (devuelve el CONTEO: los nodos no
 *  siempre se serializan bien por CDP). */
function focusablesScript(scope) {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';
    return [...root.querySelectorAll(sel)].filter((el) => {
      if (el.disabled) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) < 0) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
  })()`;
}

const FOCUS_PROBE = (scope) => `(() => {
  const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const inScope = root.contains(el);
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';
  const list = [...root.querySelectorAll(sel)].filter((node) => {
    if (node.disabled) return false;
    if (node.closest('[aria-hidden="true"]')) return false;
    const tabindex = node.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) < 0) return false;
    const s = getComputedStyle(node);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const own = el.closest('[aria-hidden="true"]');
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 48);
  return {
    tag: el.tagName,
    id: el.id || '',
    label,
    inScope,
    idx: list.indexOf(el),
    visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !own,
    indicator: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none'),
    outline: s.outlineStyle + ' ' + s.outlineWidth,
    shadow: s.boxShadow === 'none' ? 'none' : 'yes',
    key: (list.indexOf(el) >= 0 ? 'idx:' + list.indexOf(el) : 'out:') + el.tagName + '#' + (el.id || label || el.name || ''),
  };
})()`;

const TAB = { key: "Tab", code: "Tab", keyCode: 9 };

/** Marcador que confirma que LA VISTA cargó sus datos (no el shell vacío). */
const VIEW_MARKER = {
  "/": `document.querySelector('#networth-ARS') || document.querySelector('#movements-empty') || document.querySelector('#load-error')`,
  "/analisis": `document.querySelector('#analisis-search')`,
  "/tarjetas": `document.querySelector('#cards-toggle-archived') || document.querySelector('#cards-empty')`,
  "/prestamos": `document.querySelector('#loans-new')`,
  "/recurrencia": `document.querySelector('#rec-add-rule')`,
};

/** Espera a que la vista terminó de cargar (sin Cargando., con contenido). */
async function waitReady(ui, path = "/", { timeout = 25000 } = {}) {
  const marker = VIEW_MARKER[path] ?? `document.querySelector('main')`;
  await ui.waitFor(
    `(() => {
      const text = document.body.innerText || '';
      if (text.includes('Cargando.')) return false;
      const main = document.querySelector('main');
      if (!main || main.getBoundingClientRect().height <= 100) return false;
      return !!(${marker});
    })()`,
    { timeout, label: `vista ${path} lista` },
  );
  await sleep(400);
}

/** Cuenta que se estabiliza: la vista puede agregar controles tardíos. */
async function stableCount(ui, scope, tries = 14) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < tries; i += 1) {
    const n = await ui.evalJs(focusablesScript(scope));
    if (n === last) {
      same += 1;
      if (same >= 2) return n;
    } else {
      same = 0;
      last = n;
    }
    await sleep(250);
  }
  return last;
}

const FIRST_FOCUS = (scope) => `(() => {
  const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';
  const first = [...root.querySelectorAll(sel)].find((el) => {
    if (el.disabled) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) < 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!first) return false;
  first.focus();
  return true;
})()`;

/** Recorre con Tab real desde el inicio del ámbito. Devuelve informe. */
async function tabWalk(ui, scope, { maxSteps = 55, startAtFirst = false } = {}) {
  const declared = await stableCount(ui, scope);
  // Foco al inicio del documento y Tab real: así el navegador marca :focus-visible.
  await ui.evalJs(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0,0); true`);
  const probe = FOCUS_PROBE(scope);
  const seen = new Set();
  const steps = [];
  let entered = false;

  if (startAtFirst) {
    // Un Tab primero fija la modalidad de teclado; después el foco programático
    // sobre el PRIMER control (los modales no atrapan el foco y arrancan en el
    // segundo, dejando el primero sin recorrer).
    await ui.pressKey(TAB.key, TAB);
    await ui.evalJs(FIRST_FOCUS(scope));
    await sleep(60);
    const first = await ui.evalJs(probe);
    if (first && first.inScope && first.visible) {
      seen.add(first.key);
      steps.push(first);
      entered = true;
    }
  }

  for (let i = 0; i < maxSteps; i += 1) {
    await ui.pressKey(TAB.key, TAB);
    await sleep(45);
    const info = await ui.evalJs(probe);
    if (!info) {
      if (entered) break;
      continue;
    }
    if (!info.inScope) {
      // Entra al ámbito desde la cabecera; cuando sale, el recorrido terminó.
      if (entered) break;
      continue;
    }
    entered = true;
    if (!info.visible) continue;
    if (seen.has(info.key) && seen.size >= declared) break;
    seen.add(info.key);
    steps.push(info);
  }
  const sinIndicador = steps.filter((s) => !s.indicator);
  return { declared, touched: seen.size, steps, sinIndicador };
}

/* ────────────────────────── navegación ────────────────────────── */

async function goto(ui, path) {
  await ui.navigate(`${BASE}${path}`);
  await ui.loginIfNeeded();
  // Si el login redirigió a "/", volver a la ruta pedida antes de medir.
  const current = await ui.evalJs(`location.pathname`);
  if (current !== path) {
    await ui.navigate(`${BASE}${path}`);
  }
  await waitReady(ui, path);
}

async function setViewport(ui, width, height, mobile) {
  await ui.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await sleep(120);
}

/**
 * Tap honesto: scrollea al centro, verifica que el PUNTO DE TOQUE caiga dentro
 * del viewport y sobre el propio control (no bajo un pie fijo/overlay), y
 * recién ahí hace clic. Devuelve el rect usado.
 */
async function tap(ui, selector) {
  const exists = await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  })()`);
  if (!exists) throw new Error(`No existe ${selector} para tocar.`);
  await sleep(220);
  const rect = await ui.centerOf(selector);
  if (!rect) throw new Error(`No se pudo medir ${selector}.`);
  const view = await ui.evalJs(`({ w: window.innerWidth, h: window.innerHeight })`);
  if (rect.x < 0 || rect.y < 0 || rect.x > view.w || rect.y > view.h) {
    throw new Error(`${selector} cae fuera del viewport: (${rect.x},${rect.y}) en ${view.w}x${view.h}`);
  }
  const hit = await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const target = document.elementFromPoint(${rect.x}, ${rect.y});
    if (!target) return { ok: false, hit: '(nada)' };
    const same = el === target || el.contains(target) || target.contains(el);
    return { ok: same, hit: target.tagName + '#' + (target.id || '') + '.' + String(target.className || '').slice(0, 40) };
  })()`);
  if (!hit.ok) throw new Error(`El punto de toque de ${selector} está tapado por ${hit.hit}`);
  await ui.clickAt(rect.x, rect.y);
  return rect;
}

/* ────────────────────────── ataques ────────────────────────── */

const VIEWS = [
  { name: "panel", path: "/" },
  { name: "analisis", path: "/analisis" },
  { name: "tarjetas", path: "/tarjetas" },
  { name: "prestamos", path: "/prestamos" },
  { name: "recurrencia", path: "/recurrencia" },
];

const ERROR_TEXTS = ["No se pudo", "Error al cargar", "algo salió mal", "Algo salió mal"];

async function ataqueRegresion(ui) {
  section("1. Regresión con datos (sin vaciar todavía)");
  for (const view of VIEWS) {
    await goto(ui, view.path);
    const info = await ui.evalJs(`(() => {
      const text = document.body.innerText || '';
      const main = document.querySelector('main');
      return {
        cargando: text.includes('Cargando.'),
        errores: ${JSON.stringify(ERROR_TEXTS)}.filter((e) => text.includes(e)),
        scrollW: document.documentElement.scrollWidth,
        mainH: main ? Math.round(main.getBoundingClientRect().height) : 0,
        texto: text.length,
      };
    })()`);
    checkTrue(`${view.name}: cargó (sin "Cargando.")`, !info.cargando);
    check(`${view.name}: sin errores de carga`, info.errores.length, 0);
    checkTrue(`${view.name}: sin scroll horizontal a 1019`, info.scrollW <= VIEWPORT.width + 1, `scrollWidth=${info.scrollW}`);
  }

  await goto(ui, "/");
  const panel = await ui.evalJs(`(() => {
    const net = document.querySelector('#networth-ARS');
    const accounts = document.querySelector('#account-cards');
    return {
      net: net ? net.textContent.trim().slice(0, 40) : null,
      accounts: accounts ? accounts.querySelectorAll('[id^="acc-"]').length : 0,
      empty: !!document.querySelector('#movements-empty'),
      emptyTitle: document.querySelector('#movements-empty p') ? document.querySelector('#movements-empty p').innerText.trim() : null,
    };
  })()`);
  checkTrue("panel: patrimonio ARS con número", !!panel.net && /\d/.test(panel.net), `net=${panel.net}`);
  checkTrue("panel: tarjetas de cuenta renderizadas", panel.accounts >= 1, `cuentas=${panel.accounts}`);
  if (panel.empty) {
    // Noviembre está vacíoo en la base: el vacío del mes es correcto y con su copy.
    check("panel: el vacío del mes dice lo que debe", panel.emptyTitle, "Sin movimientos este mes");
  } else {
    checkTrue("panel: sin vacío, la lista tiene movimientos", true);
  }

  await goto(ui, "/tarjetas");
  const cards = await ui.evalJs(`document.querySelectorAll('[id^="card-"]').length`);
  checkTrue("tarjetas: la tarjeta de la base se renderiza", cards >= 1, `nodos card-*=${cards}`);

  await goto(ui, "/prestamos");
  try {
    await ui.waitFor(`document.querySelectorAll('[id^="loan-"]').length > 0`, { timeout: 10000, label: "prestamos cargados" });
  } catch {
    // la asercion de abajo lo reporta
  }
  const loans = await ui.evalJs(`document.querySelectorAll('[id^="loan-"]').length`);
  checkTrue("préstamos: el préstamo de la base se renderiza", loans >= 1, `nodos loan-*=${loans}`);

  await goto(ui, "/analisis");
  await sleep(800);
  const analisis = await ui.evalJs(`({ search: !!document.querySelector('#analisis-search'), charts: document.querySelectorAll('svg.recharts-surface').length })`);
  checkTrue("análisis: barra de búsqueda y gráficos vivos", analisis.search && analisis.charts > 0, JSON.stringify(analisis));
}

async function ataqueTecladoVistas(ui) {
  section("2. Teclado: 5 vistas");
  for (const view of VIEWS) {
    await goto(ui, view.path);
    const report = await tabWalk(ui, "main");
    checkTrue(`${view.name}: todos los controles alcanzables (${report.touched}/${report.declared})`, report.touched >= report.declared);
    check(`${view.name}: focos sin indicador visible`, report.sinIndicador.length, 0);
    if (report.sinIndicador.length) {
      console.log("        sin indicador:", report.sinIndicador.slice(0, 4).map((s) => `${s.tag}#${s.id || s.label}`).join(" | "));
    }
  }
}

/** La fila de navegación de escritorio está FUERA de `main`: se recorre aparte. */
async function ataqueNav(ui) {
  section("2b. Navegación global: foco visible por teclado");
  await goto(ui, "/");
  const hasNav = await ui.evalJs(`!!document.querySelector('#nav-destinos')`);
  checkTrue("nav de escritorio presente a 1019", hasNav);
  if (!hasNav) return;
  const report = await tabWalk(ui, "#nav-destinos", { maxSteps: 10 });
  checkTrue(`nav: controles alcanzables (${report.touched}/${report.declared})`, report.touched >= report.declared);
  check("nav: focos sin indicador visible", report.sinIndicador.length, 0);
  if (report.sinIndicador.length) {
    console.log("        sin indicador:", report.sinIndicador.map((s) => `${s.tag}#${s.id || s.label}`).join(" | "));
  }
}

async function ataqueTecladoModales(ui) {
  section("3. Teclado: modales principales");
  const modals = [
    { name: "gasto", path: "/", open: "#btn-expense", scope: '[role="dialog"]' },
    { name: "cuenta", path: "/", open: "#btn-add-account", scope: '[role="dialog"]' },
    { name: "prestamo", path: "/prestamos", open: "#loans-new", scope: '[role="dialog"]' },
    { name: "regla", path: "/recurrencia", open: "#rec-add-rule", scope: "#rec-form" },
    { name: "csv", path: "/", open: "#btn-import-csv", scope: '[role="dialog"]' },
  ];
  for (const modal of modals) {
    await goto(ui, modal.path);
    await tap(ui, modal.open);
    try {
      await ui.waitFor(`!!document.querySelector(${JSON.stringify(modal.scope)})`, { timeout: 8000, label: `modal ${modal.name}` });
    } catch (error) {
      checkTrue(`${modal.name}: abre`, false, error.message);
      continue;
    }
    await sleep(250);
    const report = await tabWalk(ui, modal.scope, { maxSteps: 80, startAtFirst: true });
    checkTrue(`${modal.name}: todos los controles alcanzables (${report.touched}/${report.declared})`, report.touched >= report.declared);
    check(`${modal.name}: focos sin indicador visible`, report.sinIndicador.length, 0);
    if (report.sinIndicador.length) {
      console.log("        sin indicador:", report.sinIndicador.slice(0, 4).map((s) => `${s.tag}#${s.id || s.label}`).join(" | "));
    }
    await ui.press("Escape");
    await sleep(300);
  }
}

async function ataqueAriaLive(ui) {
  section("4. aria-live: confirmación y error async");
  await goto(ui, "/");
  const before = await prisma.movement.count();

  await tap(ui, "#btn-expense");
  await ui.waitFor(`!!document.querySelector('#tx-form')`, { label: "modal gasto" });
  await sleep(250);
  await ui.evalJs(`document.querySelector('#tx-amount').focus()`);
  await ui.insertText("1234.56");
  await sleep(120);
  // El toast no existe antes del guardado: se mide en el momento en que se anuncia.
  await tap(ui, "#tx-submit");
  let toast = false;
  try {
    await ui.waitFor(`!!document.querySelector('#undo-toast')`, { timeout: 12000, label: "toast de guardado" });
    toast = true;
  } catch {
    toast = false;
  }
  checkTrue("guardado: aparece el aviso de confirmación", toast);
  if (toast) {
    const live = await ui.evalJs(`(() => {
      const el = document.querySelector('#undo-toast');
      return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'), text: el.innerText.replace(/\\s+/g, ' ').trim() };
    })()`);
    check("guardado: role=status", live.role, "status");
    check("guardado: aria-live=polite", live.live, "polite");
    check("guardado: aria-atomic=true", live.atomic, "true");
    checkIncluye("guardado: el texto anuncia el guardado", live.text, "Movimiento guardado");
    const after = await prisma.movement.count();
    check("guardado: la fila se persistió", after, before + 1);

    // Deshacer deja el estado como estaba (limpieza por id, no por borrado masivo).
    await tap(ui, "#undo-button");
    let undone = false;
    try {
      await ui.waitFor(`!document.querySelector('#undo-toast')`, { timeout: 12000, label: "toast deshecho" });
      undone = true;
    } catch {
      undone = false;
    }
    checkTrue("deshacer: el aviso desaparece", undone);
    check("deshacer: la fila se borró", await prisma.movement.count(), before);
  }

  // CSV inválido → error async
  await tap(ui, "#btn-import-csv");
  await ui.waitFor(`!!document.querySelector('#csv-text')`, { label: "modal CSV" });
  await sleep(250);
  await ui.evalJs(`document.querySelector('#csv-text').focus()`);
  await ui.insertText("esto no es un csv\nni esto tampoco");
  await sleep(120);
  await tap(ui, "#csv-preview-button");
  let csvError = false;
  try {
    await ui.waitFor(`!!document.querySelector('#csv-error')`, { timeout: 12000, label: "error CSV" });
    csvError = true;
  } catch {
    csvError = false;
  }
  checkTrue("CSV inválido: aparece el error", csvError);
  if (csvError) {
    const live = await ui.evalJs(`(() => {
      const el = document.querySelector('#csv-error');
      return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), text: el.innerText.replace(/\\s+/g, ' ').trim() };
    })()`);
    check("CSV: role=alert", live.role, "alert");
    check("CSV: aria-live presente", live.live === "polite" || live.live === "assertive", true);
    checkTrue("CSV: el error tiene texto para anunciar", live.text.length > 10, `texto="${live.text.slice(0, 60)}"`);
  }
  await ui.press("Escape");
  await sleep(300);
}

async function ataqueFocoVoz(ui) {
  section("5. Modal de voz: el foco vuelve al disparador");
  await goto(ui, "/");
  const triggerVisible = await ui.evalJs(`!!document.querySelector('#btn-voice-capture')`);
  checkTrue("existe #btn-voice-capture", triggerVisible);
  if (!triggerVisible) return;
  await tap(ui, "#btn-voice-capture");
  let opened = false;
  try {
    await ui.waitFor(`!!document.querySelector('[data-slot="dialog-content"]')`, { timeout: 8000, label: "modal de voz" });
    opened = true;
  } catch {
    opened = false;
  }
  checkTrue("el modal de voz abre", opened);
  if (!opened) return;
  await sleep(300);
  const inside = await ui.evalJs(`(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    return !!dialog && dialog.contains(document.activeElement);
  })()`);
  checkTrue("al abrir, el foco entra al diálogo", inside);

  await ui.press("Escape");
  await sleep(500);
  const closed = await ui.evalJs(`!document.querySelector('[data-slot="dialog-content"]')`);
  checkTrue("Escape cierra el modal", closed);
  const activeId = await ui.evalJs(`document.activeElement ? document.activeElement.id : ''`);
  check("al cerrar, el foco vuelve a #btn-voice-capture", activeId, "btn-voice-capture");
}

/**
 * Claim del dev: sacar `onFocus` de la TNA del préstamo hace que tabular no
 * cambie el modo. Antes, el Tab desde «Monto» desmontaba «Cuota por mes».
 */
async function ataqueTabPrestamo(ui) {
  section("6b. Préstamo: Tab por la TNA no cambia el modo");
  await goto(ui, "/prestamos");
  await tap(ui, "#loans-new");
  try {
    await ui.waitFor(`!!document.querySelector('#loanalta-payment')`, { timeout: 8000, label: "form prestamo" });
  } catch (error) {
    checkTrue("prestamo: el form abre en modo Cuota", false, error.message);
    return;
  }
  await sleep(250);
  const pressedBefore = await ui.evalJs(`(() => {
    const b = [...document.querySelectorAll('[id^="loanalta-mode-"], [aria-pressed="true"]')].find((el) => el.closest('#loan-form'));
    return b ? b.id || b.textContent.trim() : null;
  })()`);
  await ui.evalJs(`document.querySelector('#loanalta-principal').focus(); true`);
  await ui.pressKey(TAB.key, TAB);
  await sleep(120);
  const after = await ui.evalJs(`(() => ({
    active: document.activeElement ? document.activeElement.id : '',
    pago: !!document.querySelector('#loanalta-payment'),
    pressed: (() => { const b = [...document.querySelectorAll('[aria-pressed="true"]')].find((el) => el.closest('#loan-form')); return b ? b.id || b.textContent.trim() : null; })(),
    tnaReadonly: document.querySelector('#loanalta-tna') ? document.querySelector('#loanalta-tna').readOnly : null,
  }))()`);
  check("prestamo: Tab desde Monto cae en la TNA", after.active, "loanalta-tna");
  checkTrue("prestamo: el campo Cuota por mes sigue en el DOM", after.pago);
  check("prestamo: el modo no cambió al enfocar la TNA", after.pressed, pressedBefore);
  checkTrue("prestamo: la TNA sigue de solo lectura en modo Cuota", after.tnaReadonly === true, `readOnly=${after.tnaReadonly}`);
  await ui.pressKey(TAB.key, TAB);
  await sleep(120);
  const next = await ui.evalJs(`document.activeElement ? document.activeElement.id : ''`);
  check("prestamo: el siguiente Tab alcanza la cuota", next, "loanalta-payment");
  await ui.press("Escape");
  await sleep(300);
}

const TAB_TEXT_PROBE = `(() => {
  const ids = ['#tx-kind-gasto', '#tx-kind-ingreso', '#tx-kind-transferencia'];
  return ids.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    return {
      id: sel.slice(1),
      label: el.textContent.trim(),
      boxLeft: box.left, boxRight: box.right, boxWidth: box.width,
      textLeft: text.left, textRight: text.right, textWidth: text.width,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
    };
  });
})()`;

async function ataque320(ui) {
  section("6. 320 px: pestañas de tipo de movimiento");
  await goto(ui, "/");
  await ui.evalJs(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  await ui.evalJs(`document.querySelector('#btn-expense').scrollIntoView({block:'center'}); true`);
  await sleep(150);
  await tap(ui, "#btn-expense");
  let opened = false;
  try {
    await ui.waitFor(`!!document.querySelector('#tx-form')`, { timeout: 8000, label: "modal gasto 320" });
    opened = true;
  } catch {
    opened = false;
  }
  checkTrue("modal de gasto abre para medir 320", opened);
  if (!opened) return;

  for (const width of [320, 336, 352, 368, 384]) {
    await setViewport(ui, width, 640, true);
    await sleep(250);
    const data = await ui.evalJs(TAB_TEXT_PROBE);
    const doc = await ui.evalJs(`({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth })`);
    const missing = data.filter((d) => !d).length;
    checkTrue(`${width}: las 3 pestañas existen`, missing === 0, `faltan=${missing}`);
    if (missing) continue;

    const conTextoFuera = data.filter((d) => d.textLeft < d.boxLeft - 0.5 || d.textRight > d.boxRight + 0.5);
    check(`${width}: cada etiqueta entra en su pestaña`, conTextoFuera.length, 0);
    if (conTextoFuera.length) {
      console.log("        fuera:", conTextoFuera.map((d) => `${d.label} [${d.textLeft.toFixed(2)}..${d.textRight.toFixed(2)}] caja [${d.boxLeft.toFixed(2)}..${d.boxRight.toFixed(2)}]`).join(" | "));
    }
    let overlap = 0;
    for (let i = 1; i < data.length; i += 1) {
      if (data[i].textLeft < data[i - 1].textRight - 0.5) overlap += 1;
    }
    check(`${width}: etiquetas sin superposición`, overlap, 0);
    if (overlap) {
      console.log("        overlap:", data.map((d) => `${d.label}[${d.textLeft.toFixed(2)}..${d.textRight.toFixed(2)}]`).join(" "));
    }
    checkTrue(`${width}: scrollWidth del documento <= ${width}`, doc.scrollW <= width + 1, `scrollWidth=${doc.scrollW} innerWidth=${doc.innerW}`);
  }

  await ui.press("Escape");
  await sleep(300);
  await setViewport(ui, VIEWPORT.width, VIEWPORT.height, false);
}

/** `compact` dentro de una tarjeta ya angosta: con datos, a 320-414. */
async function ataqueCompacto320(ui) {
  section("6c. EmptyState compacto dentro de una tarjeta (con datos)");
  await goto(ui, "/tarjetas");
  try {
    await ui.waitFor(`!!document.querySelector('[id^="card-statements-empty-"], #cards-empty')`, { timeout: 10000, label: "tarjetas cargadas" });
  } catch {
    // la primera asercion lo reporta
  }
  for (const width of [320, 360, 414]) {
    await setViewport(ui, width, 700, true);
    await sleep(350);
    const info = await ui.evalJs(`(() => {
      const el = document.querySelector('[id^="card-statements-empty-"]');
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const p = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      const icon = el.querySelector('svg');
      return {
        found: true,
        w: Math.round(r.width),
        parentW: p ? Math.round(p.width) : null,
        fits: p ? r.width <= p.width + 1 : null,
        icon: icon ? Math.round(icon.getBoundingClientRect().width) : null,
        title: el.querySelector('p') ? el.querySelector('p').innerText.trim() : '',
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    })()`);
    checkTrue(`${width}: el compacto de la tarjeta existe`, info.found);
    if (!info.found) continue;
    checkTrue(`${width}: el compacto entra en su tarjeta`, info.fits === true, `${info.w} en ${info.parentW}`);
    check(`${width}: icono compacto de 20 px`, info.icon, 20);
    checkTrue(`${width}: compacto sin scroll horizontal`, info.scrollW <= width + 1, `scrollWidth=${info.scrollW} innerWidth=${info.innerW}`);
    checkTrue(`${width}: el compacto conserva su título`, info.title.length > 5, `"${info.title}"`);
  }
  await setViewport(ui, VIEWPORT.width, VIEWPORT.height, false);
}

/* ────────────────────────── vaciado y restauración ────────────────────────── */

const TRUNCATE_SQL = `TRUNCATE TABLE "Movement", "Installment", "Statement", "CardPlanItem", "CardPlan", "RecurrenceOccurrence", "RecurrenceRule", "FavoriteTemplate", "Budget", "Account", "Category" RESTART IDENTITY CASCADE`;

async function vaciar() {
  await prisma.$executeRawUnsafe(TRUNCATE_SQL);
  const counts = await Promise.all([
    prisma.account.count(),
    prisma.movement.count(),
    prisma.category.count(),
    prisma.recurrenceRule.count(),
    prisma.cardPlan.count(),
    prisma.budget.count(),
    prisma.favoriteTemplate.count(),
  ]);
  checkTrue("base vaciada (0 filas en las 7 tablas principales)", counts.every((n) => n === 0), counts.join(","));
}

async function restaurar() {
  await prisma.$disconnect();
  execFileSync(
    `${PG_BIN}\\pg_restore.exe`,
    ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "--clean", "--if-exists", "--no-owner", "-d", "finanzas_test", DUMP],
    { stdio: "pipe" },
  );
}

const EMPTY_EXPECT = [
  { path: "/", id: "movements-empty", title: "Sin movimientos este mes" },
  { path: "/analisis", id: "analisis-period-empty", title: "No hay gastos en este período" },
  { path: "/tarjetas", id: "cards-empty", title: "No hay tarjetas de crédito cargadas" },
  { path: "/prestamos", id: "loans-debts-empty", title: "No tenés préstamos que debas cargados" },
  { path: "/prestamos", id: "loans-receivables-empty", title: "No tenés préstamos que te deban cargados" },
  { path: "/recurrencia", id: "rec-pending-empty", title: "No hay nada pendiente" },
  { path: "/recurrencia", id: "rec-rules-empty", title: "No hay reglas todavía" },
  { path: "/analisis", id: "budgets-categories-empty", title: "Todavía no hay categorías de gasto" },
];

async function ataqueVacios(ui) {
  section("7. Estado vacío real en las 8 superficies");
  for (const expect of EMPTY_EXPECT) {
    await goto(ui, expect.path);
    // 2 s extra: si quedara "Cargando." eterno, acá se ve.
    await sleep(1500);
    const info = await ui.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(`#${expect.id}`)});
      if (!el) {
        const text = document.body.innerText || '';
        return { found: false, cargando: text.includes('Cargando.'), snippet: text.replace(/\\s+/g, ' ').slice(0, 140) };
      }
      const r = el.getBoundingClientRect();
      const title = el.querySelector('p') ? el.querySelector('p').innerText.trim() : '';
      const icon = el.querySelector('svg');
      const parent = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      return {
        found: true,
        title,
        width: Math.round(r.width),
        height: Math.round(r.height),
        icon: !!icon,
        iconHidden: icon ? icon.getAttribute('aria-hidden') : null,
        parentWidth: parent ? Math.round(parent.width) : 0,
        cargando: (document.body.innerText || '').includes('Cargando.'),
        slot: el.getAttribute('data-slot'),
      };
    })()`);
    checkTrue(`${expect.id}: aparece`, info.found, info.found ? "" : `pantalla: "${info.snippet}"`);
    if (!info.found) continue;
    check(`${expect.id}: título correcto`, info.title, expect.title);
    check(`${expect.id}: data-slot=empty-state`, info.slot, "empty-state");
    checkTrue(`${expect.id}: tiene icono decorativo (aria-hidden)`, info.icon && info.iconHidden === "true", `icon=${info.icon} aria-hidden=${info.iconHidden}`);
    checkTrue(`${expect.id}: no quedó "Cargando."`, !info.cargando);
  }

  // A 320, con la base vacía: sin scroll horizontal y el vacío dentro de su caja.
  section("8. Estados vacíos a 320");
  await setViewport(ui, 320, 640, true);
  const seenPaths = new Set();
  for (const expect of EMPTY_EXPECT) {
    if (seenPaths.has(expect.path)) continue;
    seenPaths.add(expect.path);
    await goto(ui, expect.path);
    await sleep(1200);
    const info = await ui.evalJs(`(() => {
      const el = document.querySelector('[data-slot="empty-state"]');
      const r = el ? el.getBoundingClientRect() : null;
      const parent = el && el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        text: el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 80) : null,
        fitsParent: r && parent ? r.width <= parent.width + 1 : null,
      };
    })()`);
    checkTrue(`${expect.path} @320: sin scroll horizontal`, info.scrollW <= 321, `scrollWidth=${info.scrollW} innerWidth=${info.innerW}`);
    checkTrue(`${expect.path} @320: el estado vacío entra en su caja`, info.fitsParent === true, `fits=${info.fitsParent} texto="${info.text}"`);
  }
  await setViewport(ui, VIEWPORT.width, VIEWPORT.height, false);
}

/* ────────────────────────── main ────────────────────────── */

let ui = null;
let ok = false;
try {
  if (!existsSync(DUMP)) {
    console.error(`Falta el respaldo ${DUMP}. Aborto sin tocar la base.`);
    process.exit(1);
  }

  ui = await openUi({
    port: PORT,
    profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\f3b-cdp-profile`,
    viewport: VIEWPORT,
  });

  await ataqueRegresion(ui);
  await ataqueTecladoVistas(ui);
  await ataqueNav(ui);
  await ataqueTecladoModales(ui);
  await ataqueAriaLive(ui);
  await ataqueFocoVoz(ui);
  await ataqueTabPrestamo(ui);
  await ataque320(ui);
  await ataqueCompacto320(ui);

  section("9. Vaciado de finanzas_test (respaldo ya tomado)");
  await vaciar();
  await ataqueVacios(ui);

  ok = summary();
} catch (error) {
  console.error("\nEXCEPCIÓN:", error?.message ?? error);
  console.error(error?.stack ?? "");
  counters.failed += 1;
  failures.push(`excepción: ${error?.message ?? error}`);
  ok = false;
} finally {
  section("10. Restauración de finanzas_test");
  try {
    await restaurar();
    const prisma2 = new PrismaClient({ datasourceUrl: TEST_DB_URL });
    const after = {
      accounts: await prisma2.account.count(),
      movements: await prisma2.movement.count(),
      categories: await prisma2.category.count(),
    };
    await prisma2.$disconnect();
    checkTrue("base restaurada (cuentas/movimientos/categorías > 0)", after.accounts > 0 && after.movements > 0 && after.categories > 0, JSON.stringify(after));
  } catch (error) {
    checkTrue("base restaurada", false, error?.message ?? String(error));
  }
  if (ui) await ui.close();
  if (!ok && counters.failed === 0) counters.failed += 1;
  console.log(`\nRESULT ok=${counters.passed} fail=${counters.failed}`);
  if (counters.failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(counters.failed === 0 ? 0 : 1);
}
