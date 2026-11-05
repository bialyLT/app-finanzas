#!/usr/bin/env node
/**
 * lint-r1.mjs — verificación de UI de la ronda "deuda de lint".
 *
 * Ataca lo que el refactor de 11 archivos pudo romper SIN cambiar lo visible:
 *   A. Panel: carga con datos, mes ida/vuelta + A→B→A, moneda, sin loops.
 *   B. Presupuestos: carga, sale de "cargando", cambia de mes.
 *   C. Paleta (Ctrl+K): abre, Enter ejecuta la primera, "Nada coincide",
 *      exportar CSV/JSON descarga (no navega a la API).
 *   D. Nav: el menú abre y navegar lo cierra.
 *   E. Sugerencias de descripción: aparecen con 2+ y se limpian al borrar.
 *   F. Préstamos: vista y cuenta de pago preseleccionada (banco).
 *   G. Recurrencia y tarjetas: cargan (con regla/plan sembrados).
 *   H. Vistas previas (préstamo y plan de tarjeta): aparecen, se actualizan
 *      al cambiar el dato y NO reaparecen con números viejos al vaciar.
 *
 * Siembra su propio escenario con prefijo T_LINT_* y lo borra por id.
 * Destino: :3101 + finanzas_test. Un solo Chrome (CDP) a la vez.
 *
 * Uso: node scripts/tester-ui/lint-r1.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openUi } from "../tester-fase7/cdp.mjs";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: variables del entorno.
}

const TAG = "T_LINT_";
const BASE = "http://127.0.0.1:3101";
const PORT = 9395;
const VIEWPORT = { width: 1019, height: 700 };
const PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

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

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

/* ── contadores (contrato RESULT ok=N fail=M) ───────────────────────────── */
let ok = 0;
let fail = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) {
    ok += 1;
    console.log(`[OK]   ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`[FAIL] ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  check(name, String(actual) === String(expected), `esperado ${expected} | obtenido ${actual}`);
}
function section(t) {
  console.log(`\n── ${t}`);
}

/* ── datos ─────────────────────────────────────────────────────────────── */
function todayCalendar() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = todayCalendar();
const THIS_MONTH = TODAY.slice(0, 7);
const DAY = Number(TODAY.slice(8, 10));
const MONTH_START = new Date(`${THIS_MONTH}-01T00:00:00`);
const PREV_MONTH = new Date(MONTH_START);
PREV_MONTH.setMonth(PREV_MONTH.getMonth() - 1);
const PREV_KEY = `${PREV_MONTH.getFullYear()}-${String(PREV_MONTH.getMonth() + 1).padStart(2, "0")}`;
const NEXT_MONTH = new Date(MONTH_START);
NEXT_MONTH.setMonth(NEXT_MONTH.getMonth() + 1);

let seed = null;

async function cleanup() {
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  const cats = await prisma.category.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const catIds = cats.map((c) => c.id);
  // Dependientes que apuntan a nuestras cuentas/categorías.
  const movs = await prisma.movement.findMany({
    where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }, { categoryId: { in: catIds } }, { description: { startsWith: TAG } }] },
    select: { id: true },
  });
  const movIds = movs.map((m) => m.id);
  await prisma.statement.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.cardPlanItem.deleteMany({ where: { plan: { accountId: { in: ids } } } });
  await prisma.cardPlan.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.recurrenceOccurrence.deleteMany({ where: { rule: { title: { startsWith: TAG } } } });
  await prisma.recurrenceRule.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.budget.deleteMany({ where: { OR: [{ categoryId: { in: catIds } }, { month: MONTH_START }] } });
  await prisma.favoriteTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.movement.deleteMany({ where: { id: { in: movIds } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { id: { in: catIds } } });
  if (seed?.settingsWasNull) {
    await prisma.appSettings.deleteMany({ where: { id: 1 } });
  } else if (seed?.enabledCurrencies) {
    await prisma.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: seed.enabledCurrencies },
    });
  }
}

async function seedData() {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  seed = {
    settingsWasNull: !settings,
    enabledCurrencies: settings?.enabledCurrencies ?? null,
  };
  await prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1, enabledCurrencies: ["ARS", "USD"] },
    update: { enabledCurrencies: ["ARS", "USD"] },
  });

  const catExp = await prisma.category.create({
    data: { name: `${TAG}Super`, normalizedName: `${TAG}super`, kind: "EXPENSE" },
  });
  const catInc = await prisma.category.create({
    data: { name: `${TAG}Sueldo`, normalizedName: `${TAG}sueldo`, kind: "INCOME" },
  });

  const cash = await prisma.account.create({
    data: { name: `${TAG}Efectivo`, kind: "CASH", openingBalance: "50000.00" },
  });
  const bank = await prisma.account.create({
    data: { name: `${TAG}Banco`, kind: "BANK", openingBalance: "500000.00" },
  });
  const card = await prisma.account.create({
    data: {
      name: `${TAG}Visa`,
      kind: "CREDIT_CARD",
      openingBalance: "-80000.00",
      closingDay: 25,
      dueDay: 5,
      creditLimit: "300000.00",
    },
  });
  const loan = await prisma.account.create({
    data: {
      name: `${TAG}Prestamo`,
      kind: "LOAN",
      openingBalance: "-120000.00",
      principal: "120000.00",
      tnaPercent: "60.0000",
      installmentCount: 6,
      firstInstallmentDate: NEXT_MONTH,
    },
  });

  const monthStart = MONTH_START;
  const prev15 = new Date(`${PREV_KEY}-15T00:00:00`);
  const today = new Date(`${TODAY}T00:00:00`);

  await prisma.movement.createMany({
    data: [
      { kind: "INCOME", amount: "800000.00", date: today, description: `${TAG}Sueldo de noviembre`, categoryId: catInc.id, accountId: bank.id },
      { kind: "EXPENSE", amount: "45000.00", date: today, description: `${TAG}Supermercado del mes`, categoryId: catExp.id, accountId: bank.id },
      { kind: "EXPENSE", amount: "20000.00", date: today, description: `${TAG}Compra con tarjeta`, categoryId: catExp.id, accountId: card.id },
      { kind: "EXPENSE", amount: "30000.00", date: prev15, description: `${TAG}Gasto del mes anterior`, categoryId: catExp.id, accountId: bank.id },
    ],
  });

  await prisma.budget.create({
    data: { month: monthStart, amount: "100000.00", currency: "ARS", categoryId: catExp.id },
  });

  await prisma.recurrenceRule.create({
    data: {
      title: `${TAG}Alquiler`,
      kind: "EXPENSE",
      amount: "15000.00",
      accountId: bank.id,
      categoryId: catExp.id,
      freq: "MONTHLY",
      interval: 1,
      dayOfMonth: DAY,
      startDate: monthStart,
    },
  });

  // Un plan de tarjeta con su compra (movementId es obligatorio).
  const purchase = await prisma.movement.create({
    data: {
      kind: "EXPENSE",
      amount: "60000.00",
      date: today,
      description: `${TAG}Compra en cuotas`,
      categoryId: catExp.id,
      accountId: card.id,
    },
  });
  const plan = await prisma.cardPlan.create({
    data: {
      accountId: card.id,
      label: `${TAG}Plan 3 cuotas`,
      totalAmount: "60000.00",
      installments: 3,
      purchaseDate: today,
      movementId: purchase.id,
    },
  });
  await prisma.cardPlanItem.createMany({
    data: [0, 1, 2].map((i) => ({
      planId: plan.id,
      number: i + 1,
      periodYear: NEXT_MONTH.getFullYear(),
      periodMonth: NEXT_MONTH.getMonth() + 1,
      amount: "20000.00",
    })),
  });

  return { cash, bank, card, loan, catExp, catInc, plan };
}

/* ── helpers de página ─────────────────────────────────────────────────── */
const PROBE = `(() => {
  window.__probe = { errors: [], fetches: {}, href: null, consoleErrors: [] };
  const origError = console.error;
  console.error = (...args) => {
    try { window.__probe.consoleErrors.push(args.map((a) => String(a)).join(" ")); } catch {}
    origError.apply(console, args);
  };
  window.addEventListener("error", (e) => window.__probe.errors.push("error: " + e.message));
  window.addEventListener("unhandledrejection", (e) => window.__probe.errors.push("rejection: " + String(e.reason)));
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      window.__probe.fetches[url] = (window.__probe.fetches[url] || 0) + 1;
    } catch {}
    return origFetch.apply(this, args);
  };
})();`;

async function setInput(ui, selector, value) {
  const done = await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!done) throw new Error(`no existe ${selector}`);
  await sleep(40);
}

const bodyText = (ui) => ui.evalJs(`document.body.innerText`);
const present = (ui, selector) => ui.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);
const textOf = (ui, selector) =>
  ui.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.trim() : ""; })()`);
const probe = (ui) => ui.evalJs(`window.__probe ?? { errors: [], fetches: {}, consoleErrors: [] }`);

async function goto(ui, path) {
  await ui.navigate(`${BASE}${path}`);
  await ui.waitFor(`document.readyState === 'complete'`, { label: `carga ${path}` });
  await sleep(500);
  await ui.loginIfNeeded();
  // Ventana sorda: esperar a que React hidrate (el botón de la paleta existe
  // sólo después de hidratar; reintentamos el primer foco una vez).
  await sleep(300);
}

async function waitSettled(ui, label) {
  await ui.waitFor(
    `!document.body.innerText.includes("Cargando.")`,
    { timeout: 8000, label },
  );
}

/**
 * Suscribe una segunda conexión CDP a la página para escuchar descargas
 * (`Page.downloadWillBegin`). El cliente de `cdp.mjs` sólo expone request →
 * response; esto es lo que Maestro/CDP sí puede afirmar y una sonda de DOM no.
 */
async function openDownloadWatcher(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = list.find((t) => t.type === "page" && String(t.url).startsWith(BASE));
  if (!target) throw new Error("no encontré el target de la app para escuchar descargas");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const events = [];
  ws.addEventListener("message", (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.method) events.push(msg);
    } catch {
      // ignora frames no JSON
    }
  });
  let id = 0;
  const send = (method, params = {}) =>
    ws.send(JSON.stringify({ id: ++id, method, params }));
  send("Page.enable");
  send("Page.setDownloadBehavior", { behavior: "allow" });
  await sleep(100);
  return {
    events,
    downloadUrls: () =>
      events
        .filter((e) => e.method === "Page.downloadWillBegin")
        .map((e) => e.params?.url ?? ""),
    close: () => {
      try { ws.close(); } catch {}
    },
  };
}

async function monthLabel(ui) {
  return ui.evalJs(`(() => {
    const prev = document.querySelector("#btn-prev-month");
    if (!prev) return "";
    const p = prev.parentElement.querySelector("p.font-bold");
    return p ? p.textContent.trim() : "";
  })()`);
}

async function clickCtrlK(ui) {
  await ui.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2,
  });
  await sleep(30);
  await ui.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2,
  });
}

/** Abre un modal tocando y reintenta si la ventana estaba sorda (hidratación). */
async function abrirModal(ui, btnSelector, readySelector, label) {
  for (let i = 1; i <= 3; i += 1) {
    await ui.evalJs(`document.querySelector(${JSON.stringify(btnSelector)})?.scrollIntoView({ block: "center" })`).catch(() => {});
    await sleep(120);
    await ui.clickEl(btnSelector);
    try {
      await ui.waitFor(`!!document.querySelector(${JSON.stringify(readySelector)})`, { timeout: 2500, label });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

async function clickOptionByText(ui, text) {  const rect = await ui.evalJs(`(() => {
    const c = document.querySelector('[data-slot="select-content"]');
    if (!c) return null;
    const op = [...c.querySelectorAll('[data-slot="select-item"]')].find((o) => (o.textContent || "").includes(${JSON.stringify(text)}));
    if (!op) return null;
    const r = op.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`no encontré la opción "${text}"`);
  await ui.clickAt(rect.x, rect.y);
  await sleep(250);
}

/* ── ataques ───────────────────────────────────────────────────────────── */
async function atacarPanel(ui) {
  section("A · Panel: carga, mes ida/vuelta, moneda");
  await goto(ui, "/");
  await ui.waitFor(`!!document.querySelector("#btn-prev-month")`, { label: "panel montado" });
  await waitSettled(ui, "panel cargado");

  const t = await bodyText(ui);
  check("panel muestra patrimonio", /patrimonio/i.test(t));
  check("panel muestra una cuenta sembrada", t.includes(`${TAG}Banco`));
  check("panel muestra el movimiento del mes", t.includes(`${TAG}Supermercado del mes`));
  check("panel no muestra el aviso de error de carga", !t.includes("No se pudieron cargar los datos"));

  const firstMonth = await monthLabel(ui);
  check("el mes visible es el actual", firstMonth.toLowerCase().includes("noviembre") || firstMonth !== "", `mes="${firstMonth}"`);

  const before = await probe(ui);
  const txBefore = Object.keys(before.fetches).filter((u) => u.includes("/api/transactions?")).length;

  // Ida y vuelta.
  await ui.clickEl("#btn-prev-month");
  await waitSettled(ui, "mes anterior cargado");
  const prevMonth = await monthLabel(ui);
  check("cambiar de mes mueve la etiqueta", prevMonth !== firstMonth, `antes="${firstMonth}" ahora="${prevMonth}"`);

  await ui.clickEl("#btn-next-month");
  await waitSettled(ui, "vuelta al mes actual");
  eq("volver de mes restaura la etiqueta", await monthLabel(ui), firstMonth);

  // Ráfaga A→B→A sin esperar: no debe quedar "Cargando." pegado ni un loop.
  await ui.clickEl("#btn-prev-month");
  await sleep(80);
  await ui.clickEl("#btn-next-month");
  await waitSettled(ui, "ráfaga A→B→A");
  eq("la ráfaga termina en el mes actual", await monthLabel(ui), firstMonth);

  // Moneda: la preferencia arranca en ARS; pasar a USD y volver.
  const hasSelector = await present(ui, "#currency-selector");
  check("hay selector de moneda (2 habilitadas)", hasSelector);
  if (hasSelector) {
    await setInput(ui, "#currency-selector", "USD");
    await ui.waitFor(
      `Object.keys(window.__probe?.fetches ?? {}).some((u) => u.includes("currency=USD"))`,
      { timeout: 8000, label: "pedido del panel en USD" },
    );
    await waitSettled(ui, "panel en USD");
    const usdBody = await bodyText(ui);
    check("el panel dice que está en dólares", /patrimonio en d[oó]lares|US\$/i.test(usdBody), usdBody.slice(0, 120));
    const usdProbe = await probe(ui);
    check(
      "el pedido del panel viaja con currency=USD",
      Object.keys(usdProbe.fetches).some((u) => u.includes("currency=USD")),
    );
    const arsBefore = await ui.evalJs(`Object.entries(window.__probe?.fetches ?? {}).filter(([u]) => u.includes("currency=ARS")).reduce((a, [, n]) => a + n, 0)`);
    await setInput(ui, "#currency-selector", "ARS");
    await ui.waitFor(
      `Object.entries(window.__probe?.fetches ?? {}).filter(([u]) => u.includes("currency=ARS")).reduce((a, [, n]) => a + n, 0) > ${arsBefore}`,
      { timeout: 8000, label: "pedido del panel de vuelta en ARS" },
    );
    await waitSettled(ui, "panel de vuelta en ARS");
    check("vuelve a pesos", /patrimonio en pesos/i.test(await bodyText(ui)));
  }

  const after = await probe(ui);
  const totalTx = Object.entries(after.fetches)
    .filter(([u]) => u.includes("/api/transactions?"))
    .reduce((acc, [, n]) => acc + n, 0);
  check("no hay loop de pedidos del panel", totalTx <= 16, `pedidos a /api/transactions: ${totalTx} (antes ${txBefore})`);
  check("sin errores de React/consola en el panel", after.consoleErrors.length === 0, after.consoleErrors.slice(0, 3).join(" | "));
  check("sin excepciones sueltas en el panel", after.errors.length === 0, after.errors.slice(0, 3).join(" | "));

  return after;
}

async function atacarPresupuestos(ui) {
  section("B · Presupuestos: carga y cambio de mes");
  await goto(ui, "/analisis");
  await ui.waitFor(`/Presupuestos/.test(document.body.innerText)`, { timeout: 8000, label: "sección de presupuestos" });
  await ui.waitFor(`!document.body.innerText.includes("Cargando presupuestos")`, { timeout: 8000, label: "presupuestos cargados" });
  let t = await bodyText(ui);
  check("presupuestos sale de cargando", !t.includes("Cargando presupuestos"));
  check("presupuestos muestra la categoría sembrada", t.includes(`${TAG}Super`), t.match(/Presupuestos[\s\S]{0,300}/)?.[0] ?? "");
  check("sin error de presupuestos", !t.includes("No se pudieron cargar los presupuestos"));

  // Cambiar de mes: debe pedir el mes nuevo y asentarse.
  const beforeBudget = await probe(ui);
  await ui.evalJs(`document.querySelector('[aria-label="Período anterior"]')?.click()`);
  await sleep(200);
  await ui.waitFor(`!document.body.innerText.includes("Cargando presupuestos")`, { timeout: 8000, label: "presupuestos del mes anterior" });
  const afterBudget = await probe(ui);
  const budgetUrls = [
    ...Object.keys(beforeBudget.fetches).filter((u) => u.includes("/api/budgets")),
    ...Object.keys(afterBudget.fetches).filter((u) => u.includes("/api/budgets")),
  ];
  check(
    "cambiar de mes pide los presupuestos del mes nuevo",
    budgetUrls.some((u) => u.includes(`month=${PREV_KEY}`)),
    budgetUrls.join(" | "),
  );
  check("el mes anterior no deja el error pegado", !(await bodyText(ui)).includes("No se pudieron cargar los presupuestos"));

  const p = await probe(ui);
  check("sin errores de React en presupuestos", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
}

async function atacarPaleta(ui, downloads) {
  section("C · Paleta: abrir, Enter, 'Nada coincide', exportar");
  await goto(ui, "/");
  await ui.waitFor(`!!document.querySelector("#btn-palette")`, { label: "panel listo para la paleta" });

  check("hay un observador de descargas CDP", Boolean(downloads));

  await clickCtrlK(ui);
  await ui.waitFor(`!!document.querySelector("#palette-input")`, { timeout: 4000, label: "paleta abierta con Ctrl+K" });
  check("Ctrl+K abre la paleta", await present(ui, "#palette-input"));

  await setInput(ui, "#palette-input", "Préstamos");
  await sleep(250);
  const first = await textOf(ui, "#palette-listbox [role='option']");
  check("la búsqueda filtra a 'Ir a Préstamos'", /Préstamos/.test(first), first);
  const active = await ui.evalJs(`document.querySelector('[aria-activedescendant]')?.getAttribute('aria-activedescendant') ?? ""`);
  check("hay una fila activa válida", active === "palette-item-0", active);

  await ui.press("Enter");
  await ui.waitFor(`location.pathname === "/prestamos"`, { timeout: 6000, label: "Enter ejecuta 'Ir a Préstamos'" });
  eq("Enter ejecuta la primera acción", await ui.evalJs(`location.pathname`), "/prestamos");

  // Nada coincide.
  await goto(ui, "/");
  await clickCtrlK(ui);
  await ui.waitFor(`!!document.querySelector("#palette-input")`, { timeout: 4000, label: "paleta abierta (2)" });
  await setInput(ui, "#palette-input", "zzzzzz");
  await sleep(250);
  check("con basura dice 'Nada coincide'", /Nada coincide/.test(await bodyText(ui)));
  await ui.press("Escape");
  await sleep(200);
  check("Escape cierra la paleta", !(await present(ui, "#palette-input")));

  // Exportar CSV y JSON: la descarga real se ve en Page.downloadWillBegin.
  await clickCtrlK(ui);
  await ui.waitFor(`!!document.querySelector("#palette-input")`, { timeout: 4000, label: "paleta abierta (3)" });
  await setInput(ui, "#palette-input", "Descargar movimientos en CSV");
  await sleep(250);
  await ui.press("Enter");
  await sleep(1200);
  let urls = downloads.downloadUrls();
  check(
    "exportar CSV dispara una descarga de /api/export?format=csv",
    urls.some((u) => u.includes("/api/export?format=csv")),
    `descargas: ${urls.join(" | ") || "(ninguna)"}`,
  );
  check("exportar CSV no navegó a la API", (await ui.evalJs(`location.pathname`)) === "/");

  await clickCtrlK(ui);
  await ui.waitFor(`!!document.querySelector("#palette-input")`, { timeout: 4000, label: "paleta abierta (4)" });
  await setInput(ui, "#palette-input", "Descargar movimientos en JSON");
  await sleep(250);
  await ui.press("Enter");
  await sleep(1200);
  urls = downloads.downloadUrls();
  check(
    "exportar JSON dispara una descarga de /api/export?format=json",
    urls.some((u) => u.includes("/api/export?format=json")),
    `descargas: ${urls.join(" | ") || "(ninguna)"}`,
  );

  const p = await probe(ui);
  check("sin errores de React en la paleta", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
}

async function atacarNav(ui) {
  section("D · Nav: menú abre y navegar lo cierra");
  await goto(ui, "/");
  // En escritorio el Sheet no existe; emular un ancho de teléfono después de
  // cargar (el CSS se re-evalúa sin recargar).
  await ui.send("Emulation.setDeviceMetricsOverride", {
    width: 375, height: 700, screenWidth: 375, screenHeight: 700, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(300);
  const toggle = await present(ui, "#nav-toggle");
  check("en teléfono aparece el botón del menú", toggle);
  if (!toggle) return;
  await ui.clickEl("#nav-toggle");
  await ui.waitFor(`!!document.querySelector("#nav-sheet")`, { timeout: 4000, label: "menú abierto" });
  check("el menú abre", await present(ui, "#nav-sheet"));

  // Navegar desde el menú.
  await ui.evalJs(`(() => {
    const link = [...document.querySelectorAll("#nav-sheet a")].find((a) => (a.textContent || "").includes("Préstamos"));
    link?.click();
  })()`);
  await ui.waitFor(`location.pathname === "/prestamos"`, { timeout: 6000, label: "nav a préstamos" });
  await sleep(400);
  const sheetOpen = await ui.evalJs(`(() => {
    const s = document.querySelector("#nav-sheet");
    if (!s) return false;
    const r = s.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(s).visibility !== "hidden";
  })()`);
  check("navegar cierra el menú", !sheetOpen);

  // Atrás: tampoco reabre.
  await ui.evalJs(`history.back()`);
  await sleep(700);
  await ui.waitFor(`location.pathname === "/"`, { timeout: 5000, label: "volver atrás" });
  await sleep(300);
  const sheetBack = await ui.evalJs(`(() => {
    const s = document.querySelector("#nav-sheet");
    if (!s) return false;
    const r = s.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
  check("atrás no reabre el menú", !sheetBack);
  await ui.send("Emulation.clearDeviceMetricsOverride");
}

async function atacarSugerencias(ui) {
  section("E · Formulario de movimiento: sugerencias de descripción");
  await goto(ui, "/");
  await waitSettled(ui, "panel listo");
  await ui.waitFor(`!!document.querySelector("#btn-expense")`, { timeout: 8000, label: "botón de gasto" });
  const opened = await abrirModal(ui, "#btn-expense", "#tx-description", "formulario de gasto");
  check("el formulario de gasto abre", opened);
  if (!opened) return;

  await ui.evalJs(`document.querySelector("#tx-description").focus()`);
  await setInput(ui, "#tx-description", "Sup");
  await ui.waitFor(`!!document.querySelector("#tx-description-suggestions")`, { timeout: 5000, label: "sugerencias con 2+ caracteres" });
  const sug = await textOf(ui, "#tx-description-suggestions");
  check("las sugerencias aparecen con 2 caracteres", sug.includes("Supermercado") || sug.length > 0, sug);

  // Borrar hasta 1 carácter: la lista se limpia en el evento (no en un efecto).
  await setInput(ui, "#tx-description", "S");
  await sleep(350);
  const gone = !(await present(ui, "#tx-description-suggestions"));
  check("al borrar hasta 1 carácter se limpian", gone);

  // Volver a 2: reaparecen (no quedó 'dismissed' pegado).
  await setInput(ui, "#tx-description", "Sup");
  await ui.waitFor(`!!document.querySelector("#tx-description-suggestions")`, { timeout: 5000, label: "sugerencias de nuevo" });
  check("vuelven al escribir de nuevo", await present(ui, "#tx-description-suggestions"));

  await ui.press("Escape");
  await sleep(200);
  const closed = await present(ui, "#tx-form");
  if (closed) {
    const discard = await present(ui, "#tx-discard-confirm");
    if (discard) { await ui.clickEl("#tx-discard-confirm"); await sleep(200); }
    else { await ui.evalJs(`document.querySelector("#tx-close")?.click()`); await sleep(200); }
  }
  const p = await probe(ui);
  check("sin errores de React en sugerencias", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
}

async function atacarPrestamos(ui, data) {
  section("F · Préstamos: carga y cuenta de pago preseleccionada");
  await goto(ui, "/prestamos");
  await ui.waitFor(`!!document.querySelector("#loans-new")`, { label: "préstamos montado" });
  await ui.waitFor(`!document.body.innerText.includes("Cargando.")`, { timeout: 8000, label: "préstamos cargados" });
  const t = await bodyText(ui);
  check("préstamos muestra la cuenta sembrada", t.includes(`${TAG}Prestamo`));
  check("préstamos no muestra error de carga", !t.includes("No se pudieron cargar los préstamos"));

  const opened = await ui.evalJs(`(() => {
    const b = document.querySelector('[id^="loan-pay-open-"]');
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    b.click();
    return b.id.replace("loan-pay-open-", "");
  })()`);
  check("hay un bloque de pago para abrir", Boolean(opened));
  if (opened) {
    await sleep(300);
    const selected = await textOf(ui, `#loan-pay-account-${opened}`);
    check("la cuenta de pago queda preseleccionada (Banco)", selected.includes(`${TAG}Banco`), `seleccionada="${selected}"`);
    const p = await probe(ui);
    check("sin errores de React en préstamos", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
  }
  return opened;
}

async function atacarPrestamosSinBanco(ui, data) {
  section("F2 · Préstamos sin cuenta de banco: la de pago cae a efectivo");
  let abierta = null;
  try {
    // Escenario: la única cuenta de dinero es EFECTIVO (el banco se archiva).
    await prisma.account.update({ where: { id: data.bank.id }, data: { archived: true } });
    await goto(ui, "/prestamos");
    await ui.waitFor(`!!document.querySelector("#loans-new")`, { label: "préstamos sin banco" });
    await ui.waitFor(`!document.body.innerText.includes("Cargando.")`, { timeout: 8000, label: "préstamos sin banco cargados" });
    abierta = await ui.evalJs(`(() => {
      const b = document.querySelector('[id^="loan-pay-open-"]');
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      b.click();
      return b.id.replace("loan-pay-open-", "");
    })()`);
    check("hay un bloque de pago con solo efectivo", Boolean(abierta));
    if (abierta) {
      await sleep(300);
      const selected = await textOf(ui, `#loan-pay-account-${abierta}`);
      check(
        "sin banco la cuenta de pago sigue preseleccionada (efectivo)",
        selected.includes(`${TAG}Efectivo`),
        `seleccionada="${selected}"`,
      );
    }
  } finally {
    await prisma.account.update({ where: { id: data.bank.id }, data: { archived: false } });
    await goto(ui, "/prestamos");
    await ui.waitFor(`!document.body.innerText.includes("Cargando.")`, { timeout: 8000, label: "préstamos restaurados" });
  }
}

async function atacarRecurrenciaYTarjetas(ui) {
  section("G · Recurrencia y tarjetas cargan");
  await goto(ui, "/recurrencia");
  await ui.waitFor(`!!document.querySelector("#rec-add-rule")`, { label: "recurrencia montada" });
  await ui.waitFor(
    `document.body.innerText.includes(${JSON.stringify(TAG + "Alquiler")}) || !!document.querySelector("#rec-rules-empty")`,
    { timeout: 8000, label: "lista de reglas" },
  );
  await ui.waitFor(`!document.body.innerText.includes("Cargando.")`, { timeout: 8000, label: "recurrencia cargada" });
  let t = await bodyText(ui);
  check("recurrencia muestra la regla sembrada", t.includes(`${TAG}Alquiler`));
  check("recurrencia no muestra error de lectura", !t.includes("No se pudieron cargar los datos"));
  check("el generador no falló", !(await present(ui, "#rec-run-error")));
  let p = await probe(ui);
  check("sin errores de React en recurrencia", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));

  await goto(ui, "/tarjetas");
  await ui.waitFor(`!!document.querySelector("#cards-toggle-archived")`, { label: "tarjetas montado" });
  await ui.waitFor(`!document.body.innerText.includes("Cargando.")`, { timeout: 8000, label: "tarjetas cargadas" });
  t = await bodyText(ui);
  check("tarjetas muestra la tarjeta sembrada", t.includes(`${TAG}Visa`));
  check("tarjetas muestra el plan sembrado", t.includes(`${TAG}Plan 3 cuotas`));
  check("tarjetas no muestra error de carga", !t.includes("No se pudieron cargar las tarjetas"));
  p = await probe(ui);
  check("sin errores de React en tarjetas", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
}

async function atacarPreviewPrestamo(ui) {
  section("H1 · Vista previa del alta de préstamo");
  await goto(ui, "/prestamos");
  await ui.waitFor(`!!document.querySelector("#loans-new")`, { label: "préstamos montado" });
  const abierto = await abrirModal(ui, "#loans-new", "#loanalta-principal", "alta de préstamo");
  check("el alta de préstamo abre", abierto);
  if (!abierto) return;

  await setInput(ui, "#loanalta-name", `${TAG}Preview`);
  await setInput(ui, "#loanalta-principal", "100000");
  // Modo "Por %": es el único en el que la TNA se escribe y el que ejercita el
  // foco/selección del campo (focusTnaRequest).
  await ui.clickEl("#loanalta-mode-RATE");
  await sleep(250);
  const focusTna = await ui.evalJs(`(() => {
    const a = document.activeElement;
    return { id: a?.id ?? "", start: a?.selectionStart ?? -1, end: a?.selectionEnd ?? -1, len: (a?.value ?? "").length };
  })()`);
  check(
    "cambiar a modo % enfoca la TNA",
    focusTna.id === "loanalta-tna" && focusTna.start === 0 && focusTna.end === focusTna.len,
    JSON.stringify(focusTna),
  );
  await setInput(ui, "#loanalta-tna", "60");
  await setInput(ui, "#loanalta-count", "6");
  // Volver a modo RATE: el pedido de foco/selección tiene que atenderse OTRA
  // vez (contador + ref), y con la TNA ya escrita el texto queda seleccionado
  // para que lo que se tipee la reemplace.
  await ui.clickEl("#loanalta-mode-PAYMENT");
  await sleep(200);
  await ui.clickEl("#loanalta-mode-RATE");
  await sleep(250);
  const reselect = await ui.evalJs(`(() => {
    const a = document.activeElement;
    return { id: a?.id ?? "", start: a?.selectionStart ?? -1, end: a?.selectionEnd ?? -1, len: (a?.value ?? "").length };
  })()`);
  check(
    "al volver a modo % la TNA ya escrita queda seleccionada",
    reselect.id === "loanalta-tna" && reselect.len === 2 && reselect.start === 0 && reselect.end === 2,
    JSON.stringify(reselect),
  );
  await ui.waitFor(`!!document.querySelector("#loanalta-preview")`, { timeout: 6000, label: "preview del préstamo" });
  const first = await textOf(ui, "#loanalta-preview");
  check("la preview aparece con los datos completos", first.length > 0, first.slice(0, 80));

  // Cambiar el principal: la preview se ACTUALIZA (no queda con datos viejos).
  await setInput(ui, "#loanalta-principal", "200000");
  await sleep(900);
  const second = await textOf(ui, "#loanalta-preview");
  check("la preview se actualiza al cambiar el monto", second !== first && second.length > 0, `antes="${first.slice(0, 40)}" ahora="${second.slice(0, 40)}"`);

  // Vaciar: se descarta en el mismo render (sin números viejos).
  await setInput(ui, "#loanalta-principal", "");
  await sleep(350);
  check("al vaciar un dato la preview desaparece", !(await present(ui, "#loanalta-preview")));

  // Volver a completar: aparece de nuevo (el ajuste en render no la clava).
  await setInput(ui, "#loanalta-principal", "200000");
  await ui.waitFor(`!!document.querySelector("#loanalta-preview")`, { timeout: 6000, label: "preview de nuevo" });
  const third = await textOf(ui, "#loanalta-preview");
  check("al recompletar la preview vuelve con números nuevos", third.length > 0 && third !== first, third.slice(0, 60));

  const p = await probe(ui);
  check("sin errores de React en la preview del préstamo", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
  await ui.evalJs(`document.querySelector("#loanalta-cancel")?.click()`);
  await sleep(250);
}

async function atacarPreviewPlan(ui, data) {
  section("H2 · Vista previa del plan de tarjeta");
  await goto(ui, "/tarjetas");
  await ui.waitFor(`!!document.querySelector("#cards-toggle-archived")`, { label: "tarjetas montado" });
  const cardId = data?.card?.id;
  const btn = `#card-new-plan-${cardId}`;
  check("hay botón de nuevo plan", await present(ui, btn), btn);
  if (!(await present(ui, btn))) return;
  const abierto = await abrirModal(ui, btn, "#plan-total", "formulario de plan");
  check("el plan de tarjeta abre", abierto);
  if (!abierto) return;

  await setInput(ui, "#plan-total", "120000");
  await setInput(ui, "#plan-installments", "6");
  await ui.waitFor(`!!document.querySelector("#plan-preview")`, { timeout: 6000, label: "preview del plan" });
  const first = await textOf(ui, "#plan-preview");
  check("la preview del plan aparece", first.length > 0, first.slice(0, 80));

  await setInput(ui, "#plan-installments", "12");
  await sleep(900);
  const second = await textOf(ui, "#plan-preview");
  check("la preview del plan se actualiza al cambiar las cuotas", second !== first, `antes="${first.slice(0, 40)}" ahora="${second.slice(0, 40)}"`);

  await setInput(ui, "#plan-total", "");
  await sleep(350);
  check("al vaciar el total la preview del plan desaparece", !(await present(ui, "#plan-preview")));

  await setInput(ui, "#plan-total", "120000");
  await ui.waitFor(`!!document.querySelector("#plan-preview")`, { timeout: 6000, label: "preview del plan de nuevo" });
  check("al recompletar vuelve la preview del plan", await present(ui, "#plan-preview"));

  const p = await probe(ui);
  check("sin errores de React en la preview del plan", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
  await ui.evalJs(`document.querySelector("#plan-cancel")?.click()`);
  await sleep(250);
}

async function atacarPreviewCuenta(ui) {
  section("H3 · Vista previa del alta de cuenta tipo préstamo");
  await goto(ui, "/");
  await ui.waitFor(`!!document.querySelector("#btn-add-account")`, { label: "panel listo" });
  const abierto = await abrirModal(ui, "#btn-add-account", "#acc-kind", "formulario de cuenta");
  check("el alta de cuenta abre", abierto);
  if (!abierto) return;

  // Radix: abrir el select y elegir Préstamo (la vista previa sólo existe ahí).
  await ui.clickEl("#acc-kind");
  await ui.waitFor(`!!document.querySelector('[data-slot="select-content"]')`, { timeout: 3000, label: "lista de tipos" });
  await clickOptionByText(ui, "Préstamo");
  await ui.waitFor(`!!document.querySelector("#loan-principal")`, { timeout: 3000, label: "campos de préstamo" });
  check("elegir Préstamo muestra los campos del préstamo", await present(ui, "#loan-principal"));

  await setInput(ui, "#acc-name", `${TAG}CuentaPreview`);
  await setInput(ui, "#loan-principal", "100000");
  await setInput(ui, "#loan-tna", "60");
  await setInput(ui, "#loan-count", "6");
  await ui.waitFor(`/cuotas de/.test(document.body.innerText)`, { timeout: 6000, label: "preview de la cuenta" });
  const first = (await bodyText(ui)).match(/\d+\s+cuotas de[^\n]+/)?.[0] ?? "";
  check("la preview de la cuenta aparece", first.length > 0, first);

  await setInput(ui, "#loan-principal", "");
  await sleep(350);
  const gone = !/cuotas de/.test(await bodyText(ui));
  check("al vaciar el monto la preview de la cuenta desaparece", gone);

  await setInput(ui, "#loan-principal", "100000");
  await ui.waitFor(`/cuotas de/.test(document.body.innerText)`, { timeout: 6000, label: "preview de la cuenta de nuevo" });
  check("al recompletar vuelve la preview de la cuenta", /cuotas de/.test(await bodyText(ui)));

  const p = await probe(ui);
  check("sin errores de React en la preview de la cuenta", p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(" | "));
  await ui.evalJs(`document.querySelector("#acc-cancel")?.click()`);
  await sleep(250);
}

/* ── main ──────────────────────────────────────────────────────────────── */
let ui = null;
let downloads = null;
let data = null;
try {
  console.log(`Siembra ${TAG}* en finanzas_test…`);
  await cleanup();
  data = await seedData();
  console.log(`  cuentas: efectivo=${data.cash.id} banco=${data.bank.id} tarjeta=${data.card.id} préstamo=${data.loan.id}`);

  ui = await openUi({ port: PORT, viewport: VIEWPORT, profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\lint-r1-profile` });
  await ui.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  await ui.send("Network.enable");
  await ui.send("Network.setCacheDisabled", { cacheDisabled: true });
  await goto(ui, "/");
  downloads = await openDownloadWatcher(PORT);

  await atacarPanel(ui);
  await atacarPresupuestos(ui);
  await atacarPaleta(ui, downloads);
  await atacarNav(ui);
  await atacarSugerencias(ui);
  await atacarPrestamos(ui, data);
  await atacarPrestamosSinBanco(ui, data);
  await atacarRecurrenciaYTarjetas(ui);
  await atacarPreviewPrestamo(ui);
  await atacarPreviewPlan(ui, data);
  await atacarPreviewCuenta(ui);

  section("Estado final");
  check("la app quedó viva al final", (await ui.evalJs(`document.body.innerText.length > 0`)));
} catch (error) {
  fail += 1;
  failed.push("excepción no controlada");
  console.log(`[FAIL] excepción no controlada -> ${error?.stack ?? error}`);
} finally {
  try {
    if (downloads) downloads.close();
  } catch {
    // ya cerrado
  }
  try {
    if (ui) await ui.close();
  } catch {
    // Chrome ya cerrado.
  }
  try {
    await cleanup();
    console.log("Limpieza: datos del escenario borrados por id.");
  } catch (error) {
    console.log(`[FAIL] limpieza -> ${error?.message ?? error}`);
    fail += 1;
  }
  await prisma.$disconnect();
  if (failed.length > 0) {
    console.log(`\nFallaron: ${failed.join(" | ")}`);
  }
  console.log(`\nRESULT ok=${ok} fail=${fail} suite=lint-r1 file=scripts/tester-ui/lint-r1.mjs`);
  process.exit(fail === 0 ? 0 : 1);
}
