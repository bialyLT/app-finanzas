#!/usr/bin/env node
/**
 * a11y-foco-1.mjs — verificación independiente de la ronda `a11y-foco`.
 *
 * Ataques:
 *   1. CICLO REAL en los 8 diálogos: foco inicial adentro, Tab último→primero,
 *      Shift+Tab primero→último, N tabs sin aterrizar en BODY, cierre por botón
 *      devuelve el foco al disparador. Escape donde ya existía.
 *   2. ANIDAMIENTO: paleta → CSV (¿se restaura el foco al disparador cuando el
 *      diálogo anidado se monta sobre el desmontaje de otro?) y Select de Radix
 *      dentro de AccountForm.
 *   3. PRESUPUESTOS: lista visible, confirmación inline, Cancelar conserva,
 *      Eliminar borra, window.confirm jamás se llama.
 *   4. REGRESIÓN DE TECLADO: tipear + Tab en TransactionForm, autoFocus del
 *      buscador de la paleta.
 *   5. 320 px: cada modal entra en el device y no genera scroll horizontal.
 *
 * Contrato: RESULT ok=N fail=M, exit 1 si falla.
 * Sólo finanzas_test (se aborta si DATABASE_URL_TEST no apunta ahí).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:3101";
const PORT = 9371;
const TAG = "T_A11Y";

function dotEnvValue(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return "";
}

const TEST_DB_URL =
  process.env.DATABASE_URL_TEST || dotEnvValue("DATABASE_URL_TEST");
if (!TEST_DB_URL || !/\/finanzas_test(\?|$)/.test(TEST_DB_URL)) {
  console.error("Destino IMPERMITIDO: no apunta a finanzas_test. Aborto.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB_URL;
process.env.SMOKE_BASE_URL = BASE;

const { openUi } = await import("../tester-fase7/cdp.mjs");
const { check, checkTrue, section, counters, summary } = await import(
  "../tester-fase7/helpers.mjs"
);
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

const DIALOG = '[role="dialog"][aria-modal="true"]';
const FOCUSABLE_SEL =
  'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,[contenteditable]:not([contenteditable=false]),[tabindex]';

/* Inyectable: lista de enfocables con el MISMO criterio del hook. */
const focusablesFn = `(root) => {
  const sel = ${JSON.stringify(FOCUSABLE_SEL)};
  const visible = (el) => (typeof el.checkVisibility === "function"
    ? el.checkVisibility()
    : el.getClientRects().length > 0);
  return [...root.querySelectorAll(sel)].filter((el) =>
    !el.hidden && !el.disabled && el.tabIndex >= 0 && visible(el));
}`;

let ui;
let trigger = {};

/* ── Semilla ─────────────────────────────────────────────────────────────── */
let seed = { accountIds: [], categoryId: null, budgetId: null };

async function seedData() {
  const month = new Date();
  const monthStart = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1),
  );
  const [cash, bank, card] = await Promise.all([
    prisma.account.create({
      data: { name: `${TAG} Efectivo`, kind: "CASH", currency: "ARS" },
    }),
    prisma.account.create({
      data: { name: `${TAG} Banco`, kind: "BANK", currency: "ARS" },
    }),
    prisma.account.create({
      data: {
        name: `${TAG} Visa`,
        kind: "CREDIT_CARD",
        currency: "ARS",
        closingDay: 25,
        dueDay: 5,
        creditLimit: 100000,
      },
    }),
  ]);
  const category = await prisma.category.create({
    data: { name: `${TAG} Comida`, normalizedName: `${TAG.toLowerCase()}_comida`, kind: "EXPENSE" },
  });
  const budget = await prisma.budget.create({
    data: {
      month: monthStart,
      amount: 50000,
      currency: "ARS",
      categoryId: category.id,
    },
  });
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { enabledCurrencies: ["ARS", "USD"] },
    create: { id: 1, enabledCurrencies: ["ARS", "USD"] },
  });
  seed = {
    accountIds: [cash.id, bank.id, card.id],
    categoryId: category.id,
    budgetId: budget.id,
  };
}

async function cleanup() {
  if (seed.budgetId) {
    await prisma.budget.deleteMany({ where: { id: seed.budgetId } }).catch(() => {});
  }
  if (seed.categoryId) {
    await prisma.category.deleteMany({ where: { id: seed.categoryId } }).catch(() => {});
  }
  if (seed.accountIds.length) {
    const ids = seed.accountIds;
    await prisma.movement
      .deleteMany({ where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] } })
      .catch(() => {});
    await prisma.account.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }
  await prisma.appSettings
    .upsert({ where: { id: 1 }, update: { enabledCurrencies: ["ARS"] }, create: { id: 1, enabledCurrencies: ["ARS"] } })
    .catch(() => {});
}

/* ── Primitivas de la sonda ──────────────────────────────────────────────── */
const q = (s) => JSON.stringify(s);

async function tab(shift = false) {
  const base = {
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: shift ? 8 : 0,
  };
  await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await sleep(15);
  await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(60);
}

async function esc() {
  await ui.press("Escape");
  await sleep(200);
}

async function clickCenter(selector) {
  await ui.evalJs(`(() => {
    const el = document.querySelector(${q(selector)});
    if (el) el.scrollIntoView({ block: "center" });
  })()`);
  await sleep(120);
  return ui.clickEl(selector);
}

async function clickByText(text, within = "body") {
  const rect = await ui.evalJs(`(() => {
    const root = document.querySelector(${q(within)});
    if (!root) return null;
    const el = [...root.querySelectorAll("button")].find((b) =>
      b.textContent.trim() === ${q(text)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`No hay botón "${text}" dentro de ${within}`);
  await sleep(100);
  await ui.clickAt(rect.x, rect.y);
  await sleep(150);
}

async function dialogState() {
  return ui.evalJs(`(() => {
    const all = [...document.querySelectorAll(${q(DIALOG)})];
    const d = all[0] ?? null;
    const a = document.activeElement;
    return {
      count: all.length,
      exists: !!d,
      inside: !!(d && a && d.contains(a)),
      active: a ? (a.id || a.tagName) : "none",
      body: a === document.body,
      focusables: d ? (${focusablesFn})(d).map((el) => el.id || el.tagName) : [],
    };
  })()`);
}

async function openDialog(triggerSel, { already = false } = {}) {
  trigger = { selector: triggerSel, id: null };
  if (!already) {
    await ui.evalJs(`(() => {
      const el = document.querySelector(${q(triggerSel)});
      if (!el) throw new Error("trigger inexistente: " + ${q(triggerSel)});
      el.scrollIntoView({ block: "center" });
      el.focus();
    })()`);
    trigger.id = await ui.evalJs(
      `document.activeElement && (document.activeElement.id || document.activeElement.tagName)`,
    );
    await sleep(100);
    await clickCenter(triggerSel);
    // Ventana sorda: el primer clic puede caer antes de que la isla hidrate.
    // Se cuenta como interacción y se reintenta una sola vez.
    try {
      await ui.waitFor(`!!document.querySelector(${q(DIALOG)})`, {
        timeout: 2500,
        label: `abrir ${triggerSel}`,
      });
    } catch {
      await sleep(500);
      await clickCenter(triggerSel);
    }
  }
  await ui.waitFor(`!!document.querySelector(${q(DIALOG)})`, {
    timeout: 8000,
    label: `abrir ${triggerSel}`,
  });
  await sleep(250);
  return dialogState();
}

async function waitDialogGone(timeout = 8000) {
  await ui.waitFor(`!document.querySelector(${q(DIALOG)})`, {
    timeout,
    label: "diálogo cerrado",
  });
  await sleep(200);
}

async function closeByButton(selector) {
  const rect = await ui.evalJs(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
    };
  })()`);
  if (!rect) throw new Error(`No existe el botón de cierre ${selector}`);
  const reachable =
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= rect.vh && rect.right <= rect.vw;
  if (reachable) {
    await ui.clickAt(rect.x, rect.y);
  } else {
    // El nodo existe pero un tap real no lo alcanza: se cierra por código para
    // no abortar la sonda. La alcanzabilidad se reporta como check aparte.
    await ui.evalJs(`document.querySelector(${q(selector)}).click()`);
  }
  await waitDialogGone();
  return { reachable, rect };
}

/* ── 1. Ciclo de foco por diálogo ────────────────────────────────────────── */
async function cycleDialog({ name, triggerSel, closeSel, escape = false, nav, ready }) {
  if (nav) {
    await ui.navigate(`${BASE}${nav}`);
    await ui.waitFor(`!document.querySelector("#password")`, { timeout: 20000 });
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(triggerSel)})`, {
      timeout: 25000,
      label: `trigger ${triggerSel} en ${nav}`,
    });
    await sleep(300);
  }
  const initial = await openDialog(triggerSel);
  if (ready) {
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(ready)})`, {
      timeout: 10000,
      label: `${name}: contenido cargado`,
    });
    await sleep(200);
  }
  checkTrue(`${name}: el diálogo abre`, initial.exists);
  check(`${name}: un solo diálogo`, initial.count, 1);
  checkTrue(`${name}: foco inicial ADENTRO`, initial.inside, initial.active);

  const n = initial.focusables.length;
  checkTrue(`${name}: tiene controles enfocables (${n})`, n > 1);

  // último → Tab → primero
  await ui.evalJs(`(() => {
    const d = document.querySelector(${q(DIALOG)});
    const f = (${focusablesFn})(d);
    f[f.length - 1].focus();
  })()`);
  const lastId = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
  await tab(false);
  const afterLast = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
  check(`${name}: Tab desde el último vuelve al primero`, afterLast, initial.focusables[0]);
  checkTrue(`${name}: último era distinto del primero`, lastId !== initial.focusables[0], lastId);

  // primero → Shift+Tab → último
  await ui.evalJs(`(() => {
    const d = document.querySelector(${q(DIALOG)});
    const f = (${focusablesFn})(d);
    f[0].focus();
  })()`);
  await tab(true);
  const afterFirst = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
  check(`${name}: Shift+Tab desde el primero va al último`, afterFirst, initial.focusables[n - 1]);

  // barrido completo: N+2 tabs, nunca BODY ni afuera
  await ui.evalJs(`(() => {
    const d = document.querySelector(${q(DIALOG)});
    (${focusablesFn})(d)[0].focus();
  })()`);
  let escaped = null;
  for (let i = 0; i < n + 2; i += 1) {
    const s = await dialogState();
    if (!s.inside) {
      escaped = { step: i, active: s.active };
      break;
    }
    await tab(false);
  }
  checkTrue(`${name}: N+2 Tabs nunca salen del diálogo`, escaped === null, JSON.stringify(escaped));

  // cierre por botón devuelve el foco al disparador
  const close = await closeByButton(closeSel);
  checkTrue(
    `${name}: el botón de cierre es alcanzable con un tap real`,
    close.reachable,
    `rect ${JSON.stringify(close.rect)}`,
  );
  const returned = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
  check(`${name}: el botón devuelve el foco al disparador`, returned, trigger.id);

  if (escape) {
    const reopened = await openDialog(triggerSel);
    checkTrue(`${name}: reabre para Escape`, reopened.exists);
    await esc();
    await waitDialogGone();
    const returnedEsc = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
    check(`${name}: Escape devuelve el foco al disparador`, returnedEsc, trigger.id);
  }
}

async function main() {
  await seedData();
  ui = await openUi({
    port: PORT,
    profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\a11y-foco-profile`,
    viewport: { width: 1024, height: 768 },
  });
  try {
    await ui.navigate(`${BASE}/`);
    await ui.loginIfNeeded();
    await ui.waitFor(`!!document.querySelector("#btn-expense")`, { timeout: 25000 });
    await sleep(800);

    section("1. Ciclo de foco en los 8 diálogos (1024×768)");
    await cycleDialog({ name: "gasto", triggerSel: "#btn-expense", closeSel: "#tx-close", escape: true });
    await cycleDialog({ name: "ingreso", triggerSel: "#btn-income", closeSel: "#tx-close" });
    await cycleDialog({ name: "transferencia", triggerSel: "#btn-transfer", closeSel: "#tx-close" });
    await cycleDialog({ name: "cuenta", triggerSel: "#btn-add-account", closeSel: "#acc-close" });
    await cycleDialog({
      name: "préstamo",
      triggerSel: "#loans-new",
      closeSel: "#loanalta-close",
      nav: "/prestamos",
    });
    await cycleDialog({
      name: "tarjeta (config)",
      triggerSel: "[id^=card-config-]",
      closeSel: "#cardconf-close",
      nav: "/tarjetas",
    });
    await cycleDialog({
      name: "tarjeta (plan)",
      triggerSel: "[id^=card-new-plan-]",
      closeSel: "#plan-close",
    });
    await cycleDialog({ name: "CSV", triggerSel: "#btn-import-csv", closeSel: "#csv-close", nav: "/" });
    await cycleDialog({
      name: "monedas",
      triggerSel: "#btn-currency-settings",
      closeSel: "#currency-settings-close",
      ready: "#currency-toggle-ARS",
    });
    await cycleDialog({ name: "paleta", triggerSel: "#btn-palette", closeSel: "#palette-close", escape: true });

    section("2. Anidamiento");
    // Paleta → acción "Importar CSV": se desmonta una trampa y se monta otra.
    const pal = await openDialog("#btn-palette");
    checkTrue("paleta: foco inicial en el buscador", pal.active === "palette-input", pal.active);
    await ui.insertText("importar csv");
    await sleep(300);
    await ui.press("Enter");
    await ui.waitFor(`!!document.querySelector("#csv-text")`, { timeout: 8000, label: "CSV desde paleta" });
    await sleep(300);
    let nested = await dialogState();
    checkTrue("paleta→CSV: queda UN diálogo", nested.count === 1, nested.count);
    checkTrue("paleta→CSV: foco adentro del CSV", nested.inside, nested.active);
    await tab(false);
    nested = await dialogState();
    checkTrue("paleta→CSV: Tab no se escapa al panel de atrás", nested.inside, nested.active);
    await closeByButton("#csv-close");
    const nestedReturned = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
    check("paleta→CSV: al cerrar el CSV el foco vuelve a #btn-palette", nestedReturned, "btn-palette");

    // Select de Radix dentro de un diálogo: Escape cierra el popup, no el modal.
    await ui.navigate(`${BASE}/`);
    await ui.waitFor(`!!document.querySelector("#btn-add-account")`, { timeout: 25000 });
    await sleep(600);
    await openDialog("#btn-add-account");
    await clickCenter("#acc-kind");
    await ui.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeout: 6000, label: "popup select" });
    await esc();
    const selClosed = await ui.evalJs(`!document.querySelector('[role="listbox"]')`);
    const modalAlive = await ui.evalJs(`!!document.querySelector(${q(DIALOG)})`);
    checkTrue("Select Radix: Escape cierra el popup", selClosed);
    checkTrue("Select Radix: el diálogo sigue abierto", modalAlive);
    await closeByButton("#acc-close");

    // Monedas + confirmación inline: la trampa no pelea con el paso extra.
    await openDialog("#btn-currency-settings");
    await ui.waitFor(`!!document.querySelector("#currency-toggle-USD")`, {
      timeout: 10000,
      label: "lista de monedas cargada",
    });
    checkTrue(
      "monedas: la semilla habilitó USD",
      (await ui.evalJs(`document.querySelector("#currency-toggle-USD").checked`)) === true,
    );
    await clickCenter("#currency-toggle-USD");
    await clickCenter("#currency-settings-save");
    await sleep(300);
    checkTrue(
      "monedas: la confirmación inline aparece dentro del modal",
      (await ui.evalJs(`document.body.innerText.includes("Tocá de nuevo para confirmar")`)) === true,
    );
    const currencyState = await dialogState();
    check("monedas+confirmación: sigue habiendo UN diálogo", currencyState.count, 1);
    await ui.evalJs(`(() => {
      const d = document.querySelector(${q(DIALOG)});
      const f = (${focusablesFn})(d);
      f[f.length - 1].focus();
    })()`);
    await tab(false);
    const wrapCurrency = await ui.evalJs(`(() => {
      const d = document.querySelector(${q(DIALOG)});
      const f = (${focusablesFn})(d);
      return d.contains(document.activeElement) && document.activeElement === f[0];
    })()`);
    checkTrue("monedas+confirmación: Tab último→primero sin salir del modal", wrapCurrency);
    await clickByText("Cancelar", DIALOG);
    await waitDialogGone();
    check(
      "monedas+confirmación: al cerrar vuelve el foco al disparador",
      await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`),
      "btn-currency-settings",
    );

    section("3. Presupuestos (confirmación en la UI)");
    await ui.navigate(`${BASE}/analisis`);
    await ui.waitFor(`!document.querySelector("#password")`, { timeout: 20000 });
    await ui.waitFor(`document.body.innerText.includes("Presupuestos mensuales")`, {
      timeout: 25000,
      label: "sección de presupuestos",
    });
    await ui.evalJs(`window.__confirmCalls = 0; window.confirm = ((orig) => (...a) => { window.__confirmCalls++; return orig.apply(window, a); })(window.confirm)`);
    await ui.waitFor(
      `!!document.querySelector('[aria-label="Eliminar el presupuesto de ${TAG} Comida"]')`,
      { timeout: 20000, label: "fila del presupuesto sembrado" },
    );
    const listVisible = await ui.evalJs(`document.body.innerText.includes(${q(`${TAG} Comida`)})`);
    checkTrue("presupuestos: la lista se ve (bug de parseo corregido)", listVisible);

    const trash = `[aria-label="Eliminar el presupuesto de ${TAG} Comida"]`;
    await clickCenter(trash);
    await sleep(300);
    const confirmShown = await ui.evalJs(`document.body.innerText.includes("¿Eliminar este presupuesto mensual?")`);
    checkTrue("presupuestos: 1er toque abre confirmación inline", confirmShown);
    checkTrue(
      "presupuestos: el presupuesto sigue en la base antes de confirmar",
      (await prisma.budget.count({ where: { id: seed.budgetId } })) === 1,
    );

    await clickByText("Cancelar", '[role="alert"]');
    await sleep(300);
    const cancelled = await ui.evalJs(`!document.body.innerText.includes("¿Eliminar este presupuesto mensual?")`);
    checkTrue("presupuestos: Cancelar oculta la confirmación", cancelled);
    checkTrue(
      "presupuestos: Cancelar CONSERVA el presupuesto",
      (await prisma.budget.count({ where: { id: seed.budgetId } })) === 1,
    );

    await clickCenter(trash);
    await sleep(250);
    await clickByText("Eliminar", '[role="alert"]');
    await ui.waitFor(`true`, { timeout: 100 });
    let gone = false;
    for (let i = 0; i < 20 && !gone; i += 1) {
      gone = (await prisma.budget.count({ where: { id: seed.budgetId } })) === 0;
      if (!gone) await sleep(250);
    }
    checkTrue("presupuestos: Eliminar BORRA en la base", gone);
    const nativeCalls = await ui.evalJs(`window.__confirmCalls`);
    check("presupuestos: window.confirm llamado 0 veces", nativeCalls, 0);
    seed.budgetId = null;

    section("4. Regresión de teclado");
    await ui.navigate(`${BASE}/`);
    await ui.waitFor(`!!document.querySelector("#btn-expense")`, { timeout: 25000 });
    await sleep(700);
    await openDialog("#btn-expense");
    await ui.insertText("1234");
    const typed = await ui.evalJs(`document.querySelector("#tx-amount").value`);
    check("regresión: tipear en el monto funciona", typed, "1234");
    const beforeTab = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
    await tab(false);
    const afterTab = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
    const stillInside = (await dialogState()).inside;
    checkTrue("regresión: Tab avanza el foco dentro del diálogo", beforeTab !== afterTab && stillInside, `${beforeTab}→${afterTab}`);
    await esc(); // primer Escape abre aviso de descarte
    await sleep(250);
    await esc(); // segundo Escape descarta y cierra
    await waitDialogGone();
    const afterEsc = await ui.evalJs(`document.activeElement?.id || document.activeElement?.tagName`);
    check("regresión: doble Escape cierra y devuelve el foco", afterEsc, "btn-expense");

    await ui.navigate(`${BASE}/`);
    await ui.waitFor(`!!document.querySelector("#btn-palette")`, { timeout: 25000 });
    await sleep(600);
    await openDialog("#btn-palette");
    const paletteFocus = await ui.evalJs(
      `document.activeElement === document.querySelector("#palette-input")`,
    );
    checkTrue("regresión: autoFocus del buscador de la paleta", paletteFocus);
    await ui.press("Escape");
    await waitDialogGone();

    section("5. 320 px: cada modal entra sin scroll horizontal");
    await ui.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const modals320 = [
      ["gasto", "#btn-expense", "#tx-close", "/"],
      ["cuenta", "#btn-add-account", "#acc-close", "/"],
      ["CSV", "#btn-import-csv", "#csv-close", "/"],
      ["paleta", "#btn-palette", "#palette-close", "/"],
      ["monedas", "#btn-currency-settings", "#currency-settings-close", "/"],
      ["préstamo", "#loans-new", "#loanalta-close", "/prestamos"],
      ["tarjeta plan", "[id^=card-new-plan-]", "#plan-close", "/tarjetas"],
    ];
    for (const [name, triggerSel, closeSel, nav] of modals320) {
      await ui.navigate(`${BASE}${nav}`);
      try {
        await ui.waitFor(`!!document.querySelector(${q(triggerSel)})`, { timeout: 20000 });
      } catch {
        checkTrue(`${name} @320: el disparador existe`, false, triggerSel);
        continue;
      }
      await sleep(700);
      await openDialog(triggerSel);
      const geo = await ui.evalJs(`(() => {
        const d = document.querySelector(${q(DIALOG)});
        const r = d.getBoundingClientRect();
        const de = document.documentElement;
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          viewport: de.clientWidth,
          overflows: d.scrollWidth > d.clientWidth + 1,
          docScroll: de.scrollWidth,
        };
      })()`);
      checkTrue(`${name} @320: entra en el device (${geo.left}..${geo.right}/${geo.viewport})`, geo.left >= 0 && geo.right <= geo.viewport + 0.5);
      checkTrue(`${name} @320: sin scroll horizontal propio`, !geo.overflows);
      await closeByButton(closeSel);
    }
    await ui.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } finally {
    await ui.close().catch(() => {});
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\nRESULT ok=${counters.passed} fail=${counters.failed}`);
  process.exit(summary() ? 0 : 1);
}

main().catch(async (error) => {
  console.error("ERROR FATAL:", error?.stack ?? error);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  await ui?.close().catch(() => {});
  console.log(`\nRESULT ok=${counters.passed} fail=${counters.failed + 1}`);
  process.exit(1);
});
