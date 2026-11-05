#!/usr/bin/env node
/**
 * f44b-monedas.mjs — batería de UI de F4.4b (settings de monedas, patrimonio
 * por moneda, selector persistente, modal), contra :3101 + `finanzas_test`.
 *
 * Ataques, en orden de riesgo:
 *
 *   1. ESTADO VACÍO → PRIMERA CUENTA → HABILITAR USD. Sin cuentas se puede
 *      crear la primera (`#btn-add-account`) y el selector NO existe con una
 *      sola moneda. Al habilitar USD el selector aparece, cambiar a USD cambia
 *      los totales y la elección sobrevive a un refresh.
 *   2. 409 VISIBLE Y ACCIONABLE. Con el modal abierto (USD sin cuentas), se
 *      crea una cuenta USD por API: la lista de conteos quedó vieja. Al
 *      deshabilitar USD, el servidor responde 409; la UI tiene que mostrar el
 *      mensaje inline y seguir viva (no cerrarse, no romperse).
 *   3. DOS BLOQUES, CERO MEZCLA. Con ARS y USD, `#networth-ARS` y
 *      `#networth-USD` muestran cada uno SU neto, comparado contra las cuentas
 *      de la base. Ningún bloque contiene el número del otro.
 *   4. RESPONSIVE POR RANGO. 320/375/768 × dos orientaciones: scrollWidth del
 *      documento contra el ANCHO DEL DEVICE, montos dentro de su bloque y
 *      targets ≥44 px en las superficies de la ronda (+ modal en 2 tamaños).
 *   5. UNA SOLA MONEDA. Al quedar sólo ARS el selector desaparece y una
 *      preferencia vieja en localStorage ("USD") no deja la pantalla vacía.
 *
 * Contrato: imprime `RESULT ok=N fail=M`, sale 1 si hay fallas.
 * Limpieza: borra por nombre con prefijo `T_F44B_` (por id) y deja
 * `AppSettings` en ["ARS"].
 *
 * Uso:
 *   node scripts/tester-ui/f44b-monedas.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TAG = "T_F44B";
const BASE = "http://127.0.0.1:3101";
const PORT = 9372;
const APP_PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

function dotEnvValue(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Sin .env.
  }
  return "";
}

const TEST_DB_URL = process.env.DATABASE_URL_TEST || dotEnvValue("DATABASE_URL_TEST");
if (!TEST_DB_URL || !/\/finanzas_test(\?|$)/.test(TEST_DB_URL)) {
  console.error("Destino IMPERMITIDO: DATABASE_URL_TEST no apunta a finanzas_test. Aborto.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB_URL;
// Los helpers resuelven BASE_URL al importarse: se fija ANTES del import.
process.env.SMOKE_BASE_URL = BASE;

const { openUi } = await import("../tester-fase7/cdp.mjs");
const { check, checkTrue, checkIncluye, counters, failures, section, summary } =
  await import("../tester-fase7/helpers.mjs");
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

/* ── Limpieza por prefijo (por id, nunca por schema) ───────────────────────── */
async function cleanup() {
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  if (ids.length > 0) {
    await prisma.statement.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.cardPlan.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.movement.deleteMany({
      where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
    });
    await prisma.account.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.movement.deleteMany({ where: { description: { startsWith: TAG } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function resetSettings(currencies = ["ARS"]) {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { enabledCurrencies: currencies },
    create: { id: 1, enabledCurrencies: currencies },
  });
}

/* ── API autenticada (para preparar estado y atacar el 409) ───────────────── */
let cookie = "";
async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("finanzas_session=")) cookie = pair;
  }
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // texto plano
  }
  return { status: response.status, body };
}

async function loginApi() {
  const res = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: APP_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login API ${res.status}`);
}

/* ── Emulación de device: se aplica y DESPUÉS se navega ───────────────────── */
async function device(ui, width, height) {
  await ui.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await ui.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  await ui.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: {
      type: height >= width ? "portraitPrimary" : "landscapePrimary",
      angle: height >= width ? 0 : 90,
    },
  });
  const probe = await ui.evalJs(`({
    screen: window.screen.width,
    coarse: window.matchMedia("(any-pointer: coarse)").matches
  })`);
  if (probe.screen !== width || probe.coarse !== true) {
    throw new Error(
      `la emulación de ${width}px NO aplicó (screen=${probe.screen}, coarse=${probe.coarse})`,
    );
  }
}

async function openPanel(ui, path = "/") {
  await ui.navigate(`${BASE}${path}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(500);
  await ui.loginIfNeeded();
  const ready = await ui
    .waitFor(`!!document.querySelector('#btn-add-account')`, {
      timeout: 30000,
      label: "el panel hidratado",
    })
    .catch(() => false);
  if (!ready) throw new Error("el panel no terminó de hidratar (#btn-add-account)");
  await sleep(600);
}

async function tapUntil(ui, selector, readyExpr, label, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    await ui.evalJs(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`,
    );
    await sleep(200);
    await ui.clickEl(selector);
    const ok = await ui
      .waitFor(readyExpr, { timeout: i === attempts ? 8000 : 4000, label })
      .then(() => true)
      .catch(() => false);
    if (ok) return i;
    await sleep(250);
  }
  throw new Error(`No se pudo tocar ${selector} (${label})`);
}

/** React controlado: setter nativo + input/change burbujeante. */
const SET_VALUE_HELPER = `window.__setValue = (el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};`;

function digits(text) {
  return String(text ?? "").replace(/\D/g, "");
}

/** `innerText` devuelve el texto RENDERIZADO: los rótulos van en mayúsculas
 *  por CSS (`uppercase`), así que la comparación de copy tiene que ignorar
 *  el caso. */
function checkIncluyeCI(label, actual, needle) {
  const value = String(actual ?? "").toLowerCase();
  checkTrue(label, value.includes(String(needle).toLowerCase()), value.slice(0, 160));
}

function formatted(amount, currency) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/* ── Medición de geometría en una vista ───────────────────────────────────── */
const MEASURE = `(() => {
  const de = document.documentElement;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const blocks = [...document.querySelectorAll('#networth-por-moneda > section')].map((s) => ({
    id: s.id,
    scrollWidth: s.scrollWidth,
    clientWidth: s.clientWidth,
    rect: rect(s),
  }));
  const amounts = [...document.querySelectorAll('#networth-por-moneda .monto-tarjeta')].map((p) => {
    const own = rect(p);
    const box = rect(p.closest('section'));
    return { text: p.textContent.trim(), own, box, overflow: p.scrollWidth > p.clientWidth + 1 };
  });
  const targets = ['#btn-currency-settings', '#currency-selector', '#btn-add-account', '#nav-toggle']
    .map((sel) => { const el = document.querySelector(sel); return el && visible(el) ? { sel, ...rect(el) } : null; })
    .filter(Boolean);
  return {
    device: window.screen.width,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    blocks,
    amounts,
    targets,
  };
})()`;

/* ── Modal: medición de controles y desborde ──────────────────────────────── */
const MEASURE_MODAL = `(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]');
  if (!dlg) return null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const controls = [...dlg.querySelectorAll('button, input, label')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((el) => ({ tag: el.tagName, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), ...rect(el) }));
  return {
    dialog: rect(dlg),
    scrollWidth: dlg.scrollWidth,
    clientWidth: dlg.clientWidth,
    device: window.screen.width,
    docScrollWidth: document.documentElement.scrollWidth,
    controls,
  };
})()`;

async function main() {
  section(`Limpieza previa (${TAG})`);
  await cleanup();
  await resetSettings(["ARS"]);
  console.log("  lista");

  await loginApi();

  const ui = await openUi({
    port: PORT,
    profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\f44b-cdp-profile`,
    viewport: { width: 1020, height: 720 },
  });

  try {
    /* ══════════════════════════════════════════════════════════════════════
     * A. ESTADO VACÍO: primera cuenta desde la UI y sin selector.
     * ══════════════════════════════════════════════════════════════════════ */
    section("A · Estado vacío, primera cuenta y selector oculto");
    await openPanel(ui);

    check(
      "sin cuentas no hay selector de moneda (#currency-selector)",
      await ui.evalJs(`!!document.querySelector('#currency-selector')`),
      false,
    );
    const addBtn = await ui.evalJs(`(() => {
      const el = document.querySelector('#btn-add-account');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height, text: el.textContent.trim() };
    })()`);
    checkTrue("#btn-add-account existe y es visible en el estado vacío", addBtn && addBtn.width > 0);
    checkIncluye("#btn-add-account dice 'Agregar cuenta'", addBtn?.text, "Agregar cuenta");
    checkTrue(
      "el estado vacío se explica ('Todavía no tenés cuentas')",
      (await ui.evalJs(`document.body.innerText.includes('Todavía no tenés cuentas')`)),
    );

    // Primera cuenta desde la UI (camino real del estado vacío).
    await ui.evalJs(SET_VALUE_HELPER);
    await tapUntil(ui, "#btn-add-account", `!!document.querySelector('#acc-form')`, "form de cuenta");
    await ui.evalJs(`__setValue(document.querySelector('#acc-name'), '${TAG}_Pesos')`);
    await ui.evalJs(`__setValue(document.querySelector('#acc-opening'), '1234567.89')`);
    await ui.evalJs(`document.querySelector('#acc-submit').click()`);
    await ui.waitFor(`!document.querySelector('#acc-form')`, { timeout: 20000, label: "alta de cuenta" });
    await sleep(900);
    const arsAccounts = await prisma.account.findMany({
      where: { name: { startsWith: `${TAG}_Pesos` } },
      select: { id: true, name: true, currency: true, openingBalance: true },
    });
    check("la primera cuenta quedó en la base (ARS)", arsAccounts.length, 1);
    check("la cuenta creada desde la UI es ARS", arsAccounts[0]?.currency, "ARS");
    check(
      "el saldo inicial llegó entero",
      arsAccounts[0]?.openingBalance?.toFixed(2),
      "1234567.89",
    );
    checkTrue(
      "el panel ya muestra el bloque ARS",
      await ui.waitFor(`!!document.querySelector('#networth-ARS')`, { timeout: 10000, label: "bloque ARS" }).then(() => true).catch(() => false),
    );

    /* ══════════════════════════════════════════════════════════════════════
     * B. MODAL: habilitar USD, selector aparece, cambio y persistencia.
     * ══════════════════════════════════════════════════════════════════════ */
    section("B · Modal: habilitar USD, selector y persistencia");
    await tapUntil(
      ui,
      "#btn-currency-settings",
      `!!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`,
      "modal de monedas",
    );
    await ui.waitFor(`!document.body.innerText.includes('Cargando…')`, { timeout: 10000, label: "conteos" });
    await sleep(300);

    const modalState = await ui.evalJs(`(() => {
      const ars = document.querySelector('#currency-toggle-ARS');
      const usd = document.querySelector('#currency-toggle-USD');
      return {
        ars: ars ? { checked: ars.checked, disabled: ars.disabled } : null,
        usd: usd ? { checked: usd.checked, disabled: usd.disabled } : null,
        reason: [...document.querySelectorAll('[role="dialog"] span')].some((s) => s.textContent.includes('No se puede deshabilitar con cuentas')),
        saveDisabled: document.querySelector('#currency-settings-save')?.disabled,
      };
    })()`);
    check("ARS aparece habilitada en el modal", modalState.ars?.checked, true);
    check("ARS con una cuenta está BLOQUEADA para deshabilitar", modalState.ars?.disabled, true);
    checkTrue("el motivo del bloqueo se explica al lado", modalState.reason, JSON.stringify(modalState));
    check("USD aparece apagada", modalState.usd?.checked, false);
    check("USD sin cuentas se puede habilitar", modalState.usd?.disabled, false);

    await ui.evalJs(`document.querySelector('#currency-toggle-USD').click()`);
    await sleep(150);
    check(
      "al tocar USD queda marcada",
      await ui.evalJs(`document.querySelector('#currency-toggle-USD').checked`),
      true,
    );
    await ui.evalJs(`document.querySelector('#currency-settings-save').click()`);
    await ui.waitFor(`!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`, {
      timeout: 15000,
      label: "que el modal guarde y cierre",
    });
    const storedSettings = await prisma.appSettings.findUnique({ where: { id: 1 } });
    check(
      "la base quedó con ARS+USD",
      JSON.stringify(storedSettings?.enabledCurrencies),
      JSON.stringify(["ARS", "USD"]),
    );

    const selector = await ui.waitFor(`document.querySelector('#currency-selector')?.options.length === 2`, {
      timeout: 15000,
      label: "selector con dos opciones",
    }).then(() => true).catch(() => false);
    checkTrue("el selector aparece con dos monedas habilitadas", selector);
    check(
      "las opciones son sólo las habilitadas",
      await ui.evalJs(`[...document.querySelectorAll('#currency-selector option')].map(o => o.value).join(',')`),
      "ARS,USD",
    );

    // Cambiar a USD con un cambio nativo (Maestro web no maneja <select> nativo).
    await ui.evalJs(`(() => {
      const el = document.querySelector('#currency-selector');
      el.value = 'USD';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ui.waitFor(`localStorage.getItem('finanzas.moneda') === 'USD'`, {
      timeout: 5000,
      label: "preferencia persistida",
    });
    await sleep(1200);
    check(
      "la preferencia quedó en localStorage",
      await ui.evalJs(`localStorage.getItem('finanzas.moneda')`),
      "USD",
    );
    checkTrue(
      "los totales cambiaron a dólares (US$ a la vista)",
      await ui.evalJs(`document.body.innerText.includes('US$')`),
    );
    checkTrue(
      "la reconciliación declara la moneda elegida",
      await ui.evalJs(`document.body.innerText.toLowerCase().includes('reconciliación') && (document.querySelector('#reconciliation')?.innerText ?? '').toLowerCase().includes('dólares')`),
    );

    // Refresh: la preferencia sobrevive.
    await openPanel(ui);
    check(
      "tras el refresh el selector sigue en USD",
      await ui.evalJs(`document.querySelector('#currency-selector')?.value`),
      "USD",
    );
    check(
      "tras el refresh la preferencia sigue en localStorage",
      await ui.evalJs(`localStorage.getItem('finanzas.moneda')`),
      "USD",
    );

    /* ══════════════════════════════════════════════════════════════════════
     * C. 409 VISIBLE: el modal cargó USD sin cuentas y aparece una por API.
     * ══════════════════════════════════════════════════════════════════════ */
    section("C · Carrera: 409 del servidor visible y UI intacta");
    await tapUntil(
      ui,
      "#btn-currency-settings",
      `!!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`,
      "modal de monedas",
    );
    await ui.waitFor(`!document.body.innerText.includes('Cargando…')`, { timeout: 10000, label: "conteos" });
    await sleep(200);

    // La cuenta USD nace DESPUÉS de que el modal contó: su lista quedó vieja.
    const usdAccount = await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG}_CajaDolares`, kind: "BANK", openingBalance: "987.65", currency: "USD" }),
    });
    check("cuenta USD creada por API mientras el modal está abierto", usdAccount.status, 201);

    // Deshabilitar USD (sin cuentas para el modal) → dos pasos → 409.
    await ui.evalJs(`document.querySelector('#currency-toggle-USD').click()`);
    await sleep(150);
    await ui.evalJs(`document.querySelector('#currency-settings-save').click()`);
    await sleep(300);
    checkTrue(
      "el primer toque pide confirmación inline",
      await ui.evalJs(`document.body.innerText.includes('Tocá de nuevo para confirmar')`),
    );
    await ui.evalJs(`document.querySelector('#currency-settings-save').click()`);
    const inlineError = await ui
      .waitFor(`(() => {
        const alert = [...document.querySelectorAll('[role="alert"]')].find((el) => el.textContent.includes('deshabilitar'));
        return alert ? alert.textContent.trim() : '';
      })()`, { timeout: 15000, label: "error inline del 409" })
      .catch(() => "");
    checkTrue("el 409 se muestra INLINE en el modal", inlineError.length > 0, inlineError);
    checkIncluye("el 409 dice cuántas cuentas hay", inlineError, "1 cuenta en dólares");
    checkIncluye("el 409 dice qué hacer", inlineError, "Archivá esas cuentas o cambialas a otra moneda primero");
    check(
      "el modal sigue abierto después del 409",
      await ui.evalJs(`!!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`),
      true,
    );
    check(
      "la base NO cambió por el 409",
      JSON.stringify((await prisma.appSettings.findUnique({ where: { id: 1 } }))?.enabledCurrencies),
      JSON.stringify(["ARS", "USD"]),
    );
    await ui.evalJs(`document.querySelector('#currency-settings-close').click()`);
    await sleep(500);
    check(
      "cerrar el modal no rompe la pantalla (sigue el botón de alta)",
      await ui.evalJs(`!!document.querySelector('#btn-add-account')`),
      true,
    );

    /* ══════════════════════════════════════════════════════════════════════
     * D. DOS BLOQUES: números por moneda comparados contra la base.
     * ══════════════════════════════════════════════════════════════════════ */
    section("D · Un bloque por moneda, cero total mezclado");
    await openPanel(ui);
    await ui.waitFor(`!!document.querySelector('#networth-ARS') && !!document.querySelector('#networth-USD')`, {
      timeout: 15000,
      label: "los dos bloques",
    });
    await sleep(500);

    const dbAccounts = await prisma.account.findMany({
      where: { name: { startsWith: TAG }, archived: false },
      select: { currency: true, openingBalance: true, kind: true },
    });
    const openingByCurrency = { ARS: 0, USD: 0 };
    for (const account of dbAccounts) {
      openingByCurrency[account.currency] += Number(account.openingBalance);
    }
    // Sin movimientos: el neto es la suma de saldos iniciales.
    const movements = await prisma.movement.count({
      where: { description: { startsWith: TAG } },
    });
    check("no hay movimientos que alteren el neto de la prueba", movements, 0);

    const blocks = await ui.evalJs(`(() => {
      const pick = (id) => {
        const el = document.querySelector(id);
        return el ? el.innerText : null;
      };
      return { ars: pick('#networth-ARS'), usd: pick('#networth-USD') };
    })()`);
    checkTrue("existe #networth-ARS", Boolean(blocks.ars), JSON.stringify(blocks));
    checkTrue("existe #networth-USD", Boolean(blocks.usd), JSON.stringify(blocks));

    const arsNet = formatted(openingByCurrency.ARS, "ARS");
    const usdNet = formatted(openingByCurrency.USD, "USD");
    checkIncluyeCI("el bloque ARS declara su moneda", blocks.ars, "Patrimonio en pesos (ARS)");
    checkIncluyeCI("el bloque USD declara su moneda", blocks.usd, "Patrimonio en dólares (USD)");
    check(
      "el neto ARS en pantalla es el de las cuentas ARS de la base",
      digits(blocks.ars).includes(digits(arsNet)),
      true,
    );
    check(
      "el neto USD en pantalla es el de las cuentas USD de la base",
      digits(blocks.usd).includes(digits(usdNet)),
      true,
    );
    check(
      "el bloque ARS NO contiene el número de USD",
      digits(blocks.ars).includes(digits(usdNet)),
      false,
    );
    check(
      "el bloque USD NO contiene el número de ARS",
      digits(blocks.usd).includes(digits(arsNet)),
      false,
    );
    // El neto de la base no es una suma mezclada: si los dos netos suman, el
    // bloque ARS tendría que contener ese total. Se verifica que no exista.
    check(
      "no hay un 'total' que sume las dos monedas",
      digits(blocks.ars).includes(digits(formatted(openingByCurrency.ARS + openingByCurrency.USD, "ARS"))),
      false,
    );
    const headings = await ui.evalJs(`document.querySelectorAll('#networth-por-moneda > section').length`);
    check("hay exactamente dos bloques de patrimonio", headings, 2);

    const accountCards = await ui.evalJs(`document.querySelector('#account-cards')?.innerText ?? ''`);
    checkIncluye("las cuentas activas marcan la moneda ARS", accountCards, "· ARS");
    checkIncluye("las cuentas activas marcan la moneda USD", accountCards, "· USD");

    /* ══════════════════════════════════════════════════════════════════════
     * D2. CAMBIAR DE MONEDA CAMBIA LOS TOTALES (con movimientos reales).
     * ══════════════════════════════════════════════════════════════════════ */
    section("D2 · El selector cambia los totales, no sólo el rótulo");
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const arsId = arsAccounts[0].id;
    const usdId = usdAccount.body.id;
    const expense = await api("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        kind: "EXPENSE",
        amount: "1000",
        date: today,
        accountId: arsId,
        categoryName: `${TAG}_Gastos`,
        description: `${TAG} gasto en pesos`,
      }),
    });
    const income = await api("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        kind: "INCOME",
        amount: "50",
        date: today,
        accountId: usdId,
        categoryName: `${TAG}_Sueldo`,
        description: `${TAG} ingreso en dolares`,
      }),
    });
    check("gasto ARS creado", expense.status, 201);
    check("ingreso USD creado", income.status, 201);

    const readTotals = () => ui.evalJs(`(() => {
      const byLabel = (label) => {
        const p = [...document.querySelectorAll('p')].find((el) => el.textContent.trim() === label);
        return p ? (p.parentElement.querySelector('.monto-tarjeta')?.innerText.trim() ?? null) : null;
      };
      return { income: byLabel('Ingresos'), expenses: byLabel('Gastos') };
    })()`);

    await openPanel(ui);
    await sleep(1200);
    // La preferencia sigue en USD desde B/C.
    check("la pantalla arranca en USD", await ui.evalJs(`document.querySelector('#currency-selector')?.value`), "USD");
    const totalsUsd = await readTotals();
    check("en USD, Ingresos es US$ 50,00", digits(totalsUsd.income), digits(formatted(50, "USD")));
    check("en USD, Gastos es US$ 0,00 (no el gasto en pesos)", digits(totalsUsd.expenses), digits(formatted(0, "USD")));
    check("en USD, Ingresos NO muestra el gasto ARS", digits(totalsUsd.income).includes("100000"), false);

    await ui.evalJs(`(() => {
      const el = document.querySelector('#currency-selector');
      el.value = 'ARS';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ui.waitFor(`localStorage.getItem('finanzas.moneda') === 'ARS'`, { timeout: 5000, label: "ARS" });
    const arsTotals = await ui.waitFor(`(() => {
      const p = [...document.querySelectorAll('p')].find((el) => el.textContent.trim() === 'Gastos');
      const monto = p?.parentElement.querySelector('.monto-tarjeta')?.innerText.trim();
      return monto && monto.includes('1.000') ? monto : null;
    })()`, { timeout: 15000, label: "totales ARS" }).catch(() => null);
    checkTrue("en ARS, Gastos es $ 1.000,00", Boolean(arsTotals), String(arsTotals));
    const totalsArs = await readTotals();
    check("en ARS, Ingresos es $ 0,00 (no el ingreso en dólares)", digits(totalsArs.income), digits(formatted(0, "ARS")));
    check("en ARS, Gastos NO muestra el ingreso USD", digits(totalsArs.expenses).includes("5000"), false);

    /* ══════════════════════════════════════════════════════════════════════
     * E. RESPONSIVE: rango de anchos × dos orientaciones.
     * ══════════════════════════════════════════════════════════════════════ */
    section("E · Responsive 320/375/768 × dos orientaciones");
    const sizes = [
      [320, 568],
      [568, 320],
      [375, 667],
      [667, 375],
      [768, 1024],
      [1024, 768],
    ];
    for (const [width, height] of sizes) {
      await device(ui, width, height);
      await openPanel(ui);
      await ui.waitFor(`!!document.querySelector('#networth-USD')`, { timeout: 15000, label: "bloques" });
      await sleep(400);
      const m = await ui.evalJs(MEASURE);
      const label = `${width}×${height}`;
      check(`${label}: sin scroll horizontal (scrollWidth ≤ device)`, m.scrollWidth <= width, true);
      check(
        `${label}: el viewport de layout no se expandió (clientWidth ≤ device)`,
        m.clientWidth <= width,
        true,
      );
      check(`${label}: los dos bloques están`, m.blocks.length, 2);
      for (const block of m.blocks) {
        check(
          `${label}: ${block.id} no impone ancho (${block.scrollWidth} ≤ ${block.clientWidth})`,
          block.scrollWidth <= block.clientWidth + 1,
          true,
        );
      }
      for (const amount of m.amounts) {
        check(
          `${label}: el monto "${amount.text}" entra en su bloque`,
          amount.own.left >= amount.box.left - 1 && amount.own.right <= amount.box.right + 1 && !amount.overflow,
          true,
        );
      }
      for (const target of m.targets) {
        check(
          `${label}: target ${target.sel} ≥44px (${target.width.toFixed(1)}×${target.height.toFixed(1)})`,
          target.width >= 44 && target.height >= 44,
          true,
        );
      }
    }

    // Modal en 375 portrait y 667 landscape.
    for (const [width, height] of [[375, 667], [667, 375]]) {
      await device(ui, width, height);
      await openPanel(ui);
      await tapUntil(
        ui,
        "#btn-currency-settings",
        `!!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`,
        "modal",
      );
      await ui.waitFor(`!document.body.innerText.includes('Cargando…')`, { timeout: 10000, label: "conteos" });
      await sleep(300);
      const m = await ui.evalJs(MEASURE_MODAL);
      const label = `modal ${width}×${height}`;
      checkTrue(`${label}: el modal se midió`, m !== null);
      check(`${label}: sin scroll horizontal`, m.docScrollWidth <= width, true);
      check(`${label}: el modal entra en el ancho`, m.dialog.left >= -1 && m.dialog.right <= width + 1, true);
      check(`${label}: el contenido no desborda su caja`, m.scrollWidth <= m.clientWidth + 1, true);
      for (const control of m.controls) {
        check(
          `${label}: control ${control.tag} "${control.text}" ≥44px (${control.width.toFixed(1)}×${control.height.toFixed(1)})`,
          control.width >= 44 && control.height >= 44,
          true,
        );
      }
      await ui.evalJs(`document.querySelector('#currency-settings-close').click()`);
      await sleep(400);
    }

    /* ══════════════════════════════════════════════════════════════════════
     * F. UNA SOLA MONEDA: el selector desaparece y la preferencia vieja cae.
     * ══════════════════════════════════════════════════════════════════════ */
    section("F · Una sola moneda: sin selector y sin pantalla vacía");
    await device(ui, 1020, 720);
    await prisma.movement.deleteMany({ where: { accountId: usdAccount.body?.id } });
    await api(`/api/accounts?id=${usdAccount.body.id}`, { method: "DELETE" });
    const patch = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ enabledCurrencies: ["ARS"] }),
    });
    check("PATCH a ['ARS'] sin cuentas USD responde 200", patch.status, 200);

    await openPanel(ui);
    await sleep(800);
    check(
      "con una sola moneda el selector NO se muestra",
      await ui.evalJs(`!!document.querySelector('#currency-selector')`),
      false,
    );
    check(
      "la preferencia vieja (USD) no rompe: la pantalla trabaja en ARS",
      await ui.evalJs(`document.body.innerText.includes('US$')`),
      false,
    );
    checkTrue(
      "el bloque ARS sigue en pantalla",
      await ui.evalJs(`!!document.querySelector('#networth-ARS')`),
    );

    // El 409 de quitar ARS con cuentas, directo contra la API.
    section("F2 · API: quitar ARS con cuentas da 409 accionable");
    const conflict = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ enabledCurrencies: ["USD"] }),
    });
    check("quitar ARS con una cuenta responde 409", conflict.status, 409);
    checkIncluye("el 409 nombra la moneda", conflict.body?.error ?? "", "pesos");
    checkIncluye(
      "el 409 dice qué hacer",
      conflict.body?.error ?? "",
      "Archivá esas cuentas o cambialas a otra moneda primero",
    );

    // Y el modal, con la lista real, bloquea ARS.
    await tapUntil(
      ui,
      "#btn-currency-settings",
      `!!document.querySelector('[role="dialog"][aria-label="Monedas habilitadas"]')`,
      "modal",
    );
    await ui.waitFor(`!document.body.innerText.includes('Cargando…')`, { timeout: 10000, label: "conteos" });
    check(
      "el modal bloquea ARS con cuentas (no ofrece un camino al 409)",
      await ui.evalJs(`document.querySelector('#currency-toggle-ARS')?.disabled`),
      true,
    );
    await ui.evalJs(`document.querySelector('#currency-settings-close').click()`);
  } finally {
    await ui.close();
  }
}

let ok = false;
try {
  await main();
  ok = summary();
} catch (error) {
  counters.failed += 1;
  failures.push(`excepción: ${error.message}`);
  console.error(`\nEXCEPCIÓN: ${error.stack ?? error.message}`);
  summary();
} finally {
  section(`Limpieza (${TAG})`);
  await cleanup();
  await resetSettings(["ARS"]);
  await prisma.$disconnect();
  console.log("  lista");
  console.log(`RESULT ok=${counters.passed} fail=${counters.failed}`);
}
process.exit(ok ? 0 : 1);
