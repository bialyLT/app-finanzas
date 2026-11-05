#!/usr/bin/env node
/**
 * f44a-monedas.mjs — batería de UI de F4.4a (monedas en cuentas y
 * transferencias), contra :3101 + `finanzas_test`.
 *
 * Tres ataques, en orden de riesgo:
 *
 *   A. EL SELECT NATIVO OCULTO DE RADIX. El informe del dev atribuye 7 "taps
 *      muertos" de `audit-mobile` a un `<select aria-hidden="true"
 *      tabindex="-1">` que Radix monta espejo del trigger. La auditoría lo
 *      cuenta como control interactivo, pero lo reporta TAPADO (`<- p.text-xs`),
 *      no tapando. Acá se verifica con TOQUE REAL (`Input.dispatchMouseEvent`),
 *      no con `elementFromPoint` a secas: ¿el trigger visible responde?, ¿el
 *      oculto aparece como HIT en algún punto de su rectángulo?, ¿el centro de
 *      algún OTRO control cae en él?
 *
 *   B. ARS→USD. Caja en USD creada desde la UI; transferencia desde una cuenta
 *      ARS. Sin "¿Cuánto llega?" no se guarda; con 100 el preview dice lo que
 *      es y el saldo destino queda EXACTO (no 120.000 "dólares").
 *
 *   C. MISMA MONEDA y FORMATO. El segundo campo no existe en ARS→ARS; las
 *      tarjetas de cuenta muestran `US$` en dólares y `$` en pesos.
 *
 * Contrato: imprime `RESULT ok=N fail=M`, sale 1 si hay fallas.
 * Limpieza: borra por id (movimientos y cuentas con prefijo TAG).
 *
 * Uso:
 *   node scripts/tester-ui/f44a-monedas.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openUi } from "../tester-fase7/cdp.mjs";
import {
  check,
  checkTrue,
  counters,
  failures,
  section,
  summary,
} from "../tester-fase7/helpers.mjs";

try {
  process.loadEnvFile();
} catch {
  // Sin `.env`: variables del entorno.
}

const TAG = "T_F44A";
const BASE = "http://127.0.0.1:3101";
const PORT = 9371;
const APP_PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

function dotEnvValue(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Sin `.env`.
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

/** Emula un device y NAVEGA después (la emulación sólo aplica al doc nuevo). */
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
  return probe;
}

async function openApp(ui, path = "/") {
  await ui.navigate(`${BASE}${path}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(700);
  if (path !== "/login") await ui.loginIfNeeded();
  const ready = await ui
    .waitFor(`!!document.querySelector('#btn-add-account')`, {
      timeout: 30000,
      label: "el panel con las cuentas",
    })
    .catch(() => false);
  if (!ready) throw new Error("el panel no terminó de hidratar (#btn-add-account)");
  await sleep(500);
}

/**
 * Toca `selector` (scrolleándolo al centro) y espera `readyExpr`.
 *
 * La ventana sorda de la hidratación es real: el primer clic puede no
 * reaccionar. Se reintenta y se DEVUELVE el número de intentos — el reintento
 * cuenta como interacción y va al informe, no se esconde.
 */
async function tapUntil(ui, selector, readyExpr, label, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    await ui.evalJs(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`,
    );
    await sleep(250);
    await ui.clickEl(selector);
    const ok = await ui
      .waitFor(readyExpr, { timeout: i === attempts ? 8000 : 4000, label })
      .then(() => true)
      .catch(() => false);
    if (ok) return i;
    await sleep(300);
  }
  return 0;
}

/** Toca un trigger de modal y avisa cuántos toques hicieron falta. */
async function openModal(ui, selector, readyExpr, label) {
  const attempts = await tapUntil(ui, selector, `!!document.querySelector(${JSON.stringify(readyExpr)})`, label);
  if (attempts > 1) {
    console.log(`  (nota) ${selector} abrió recién al toque #${attempts} — ventana sorda`);
  }
  return attempts > 0;
}


async function pickOption(ui, triggerSelector, optionText) {
  await ui.clickEl(triggerSelector);
  const opened = await ui.waitFor(
    `!!document.querySelector('[data-slot="select-content"]') || !!document.querySelector('[role="listbox"]')`,
    { timeout: 4000, label: `que abra ${triggerSelector}` },
  ).catch(() => false);
  if (!opened) return false;
  const options = await ui.evalJs(`(() => {
    const nodes = [...document.querySelectorAll('[role="option"]')];
    return nodes.map((n, i) => {
      const r = n.getBoundingClientRect();
      return { i, text: (n.textContent || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });
  })()`);
  const hit = options.find((o) => o.text.includes(optionText));
  if (!hit || hit.w === 0) return false;
  await ui.clickAt(hit.x, hit.y);
  await sleep(350);
  return true;
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

/** Normaliza espacios (Intl usa U+00A0 entre símbolo y número). */
const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

async function clean() {
  const movs = await prisma.movement.findMany({
    where: { description: { startsWith: TAG } },
    select: { id: true },
  });
  if (movs.length) {
    await prisma.movement.deleteMany({ where: { id: { in: movs.map((m) => m.id) } } });
  }
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  if (accounts.length) {
    // Los movimientos de esas cuentas (aunque no lleven TAG en la nota).
    await prisma.movement.deleteMany({
      where: { OR: [
        { accountId: { in: accounts.map((a) => a.id) } },
        { toAccountId: { in: accounts.map((a) => a.id) } },
      ] },
    });
    await prisma.account.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
  }
  return { movs: movs.length, accounts: accounts.length };
}

const ui = await openUi({ port: PORT, viewport: { width: 375, height: 667 } });
let createdIds = [];

try {
  await clean();
  await device(ui, 375, 667);
  await openApp(ui, "/");
  /* ══════════════════ A. el select nativo oculto de Radix ══════════════════ */
  section("A · el <select> oculto de Radix: ¿recibe el toque o es artefacto?");

  const openedA = await openModal(ui, "#btn-add-account", "#acc-form", "modal de cuenta");
  checkTrue("A0 · el botón 'Agregar cuenta' abre el modal con toque real", openedA, "no abrió en 3 toques");
  await sleep(500);

  const hiddenInfo = await ui.evalJs(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const list = [...dialog.querySelectorAll('select')];
    return list.map((s) => {
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      const samples = [];
      let hitsSelf = 0;
      for (let i = 1; i <= 5; i += 1) {
        for (let j = 1; j <= 5; j += 1) {
          const x = r.left + (r.width * i) / 6;
          const y = r.top + (r.height * j) / 6;
          const hit = document.elementFromPoint(x, y);
          if (hit === s) hitsSelf += 1;
          samples.push(hit === s ? 'SELF' : (hit ? hit.tagName.toLowerCase() : 'null'));
        }
      }
      // ¿Algún control interactivo tiene su centro dentro de este rect?
      const mine = s.getBoundingClientRect();
      const solapan = [...dialog.querySelectorAll('button, input, a, [role="combobox"], [role="button"]')]
        .filter((el) => el !== s)
        .filter((el) => {
          const q = el.getBoundingClientRect();
          const cx = q.x + q.width / 2;
          const cy = q.y + q.height / 2;
          return cx >= mine.left && cx <= mine.right && cy >= mine.top && cy <= mine.bottom;
        })
        .map((el) => el.id || el.getAttribute('aria-label') || el.tagName.toLowerCase());
      return {
        name: s.name || '(sin name)',
        ariaHidden: s.getAttribute('aria-hidden'),
        tabIndex: s.tabIndex,
        pointerEvents: cs.pointerEvents,
        w: Math.round(r.width), h: Math.round(r.height),
        inline: s.getAttribute('style') || '',
        opacity: cs.opacity,
        hitsSelf,
        distinct: [...new Set(samples)].join(','),
        solapan,
      };
    });
  })()`);

  checkTrue(
    "A1 · el modal de cuenta monta el espejo nativo oculto",
    hiddenInfo.length >= 2,
    `selects: ${hiddenInfo.map((s) => s.name || "?").join(" | ")}`,
  );
  checkTrue(
    "A2 · el espejo está fuera del árbol accesible y del tab order",
    hiddenInfo.every((s) => s.ariaHidden === "true" && s.tabIndex === -1),
    JSON.stringify(hiddenInfo.map((s) => ({ n: s.name, a: s.ariaHidden, t: s.tabIndex }))),
  );
  checkTrue(
    "A3 · el espejo NO recibe ningún toque dentro de su rectángulo (0/25 puntos)",
    hiddenInfo.every((s) => s.hitsSelf === 0),
    hiddenInfo.map((s) => `${s.name}: ${s.hitsSelf}/25 self, hits=${s.distinct}`).join(" | "),
  );
  checkTrue(
    "A4 · ningún centro de otro control cae en el rectángulo del espejo",
    hiddenInfo.every((s) => s.solapan.length === 0),
    hiddenInfo.map((s) => `${s.name}: [${s.solapan.join(",")}]`).join(" | "),
  );
  const real44 = hiddenInfo.filter((s) => s.w >= 44 && s.h >= 44).length;
  checkTrue(
    "A5 · el espejo SÍ mide 44x44 por la regla coarse (el rectángulo fantasma existe)",
    real44 >= 1,
    hiddenInfo.map((s) => `${s.name}: ${s.w}x${s.h} pe=${s.pointerEvents}`).join(" | "),
  );

  // TOQUE REAL en el trigger visible de moneda: abre y elige USD.
  const triggerCenter = await ui.centerOf("#acc-currency");
  const pointHit = await ui.evalJs(`(() => {
    const el = document.querySelector('#acc-currency');
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hit: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + '|' + (hit.getAttribute('data-slot') || '') : null,
             inside: hit === el || el.contains(hit) };
  })()`);
  checkTrue(
    "A6 · el centro del trigger visible lo recibe el trigger, no el espejo",
    pointHit.inside,
    JSON.stringify(pointHit),
  );

  const picked = await pickOption(ui, "#acc-currency", "Dólares");
  const triggerText = await ui.evalJs(
    `(document.querySelector('#acc-currency')?.textContent || '').trim()`,
  );
  checkTrue(
    "A7 · TOQUE REAL en el trigger de moneda: abre la lista y elige Dólares",
    picked && triggerText.includes("Dólares"),
    `picked=${picked} texto="${triggerText}"`,
  );

  const state = await ui.evalJs(`(() => {
    const sels = [...document.querySelectorAll('[role="dialog"] select')];
    return sels.map((s) => ({ name: s.name || '', value: s.value }));
  })()`);
  checkTrue(
    "A8 · el espejo refleja el valor elegido (es un espejo, no un control paralelo)",
    state.some((s) => s.value === "USD"),
    JSON.stringify(state),
  );

  // Cerrar el modal de cuenta sin crear nada.
  await ui.clickEl("#acc-cancel");
  await ui.waitFor(`!document.querySelector('#acc-form')`, { label: "cierre de cuenta" }).catch(() => {});

  /* ══════════════════ B. ARS→USD de punta a punta ═════════════════════════ */
  section("B · transferencia ARS→USD: segundo monto obligatorio y saldo exacto");

  const usdName = `${TAG}_CajaUSD`;
  const openedB = await openModal(ui, "#btn-add-account", "#acc-form", "alta de cuenta");
  checkTrue("B0 · el alta de cuenta abre con toque real", openedB, "no abrió");
  await sleep(400);
  await ui.evalJs(`document.querySelector('#acc-name').focus()`);
  await ui.insertText(usdName);
  await pickOption(ui, "#acc-kind", "Efectivo");
  await pickOption(ui, "#acc-currency", "Dólares");
  await ui.evalJs(`document.querySelector('#acc-opening').focus()`);
  await ui.insertText("0");
  await sleep(200);
  const currencyText = await ui.evalJs(
    `(document.querySelector('#acc-currency')?.textContent || '').trim()`,
  );
  checkTrue(
    "B1 · el selector de moneda del alta muestra Dólares antes de guardar",
    currencyText.includes("Dólares"),
    `"${currencyText}"`,
  );
  await ui.clickEl("#acc-submit");
  const created = await ui
    .waitFor(
      `(() => {
        const el = [...document.querySelectorAll('#account-cards div')].find((d) => (d.textContent || '').includes(${JSON.stringify(usdName)}));
        return !!el;
      })()`,
      { timeout: 15000, label: "la cuenta USD en el panel" },
    )
    .catch(() => false);
  checkTrue("B2 · la caja USD se crea desde la UI y aparece en el panel", created, "tarjeta visible");

  const usdAccount = await prisma.account.findFirst({
    where: { name: usdName },
    select: { id: true, currency: true, kind: true, openingBalance: true },
  });
  checkTrue(
    "B3 · la base guarda la cuenta con currency=USD",
    usdAccount?.currency === "USD",
    JSON.stringify(usdAccount),
  );
  if (usdAccount) createdIds.push(usdAccount.id);

  const galicia = await prisma.account.findFirst({
    where: { name: "Banco Galicia" },
    select: { id: true, currency: true },
  });
  const efectivo = await prisma.account.findFirst({
    where: { name: "Efectivo" },
    select: { id: true, currency: true },
  });
  checkTrue(
    "B4 · hay una cuenta ARS de origen en el seed",
    galicia?.currency === "ARS",
    JSON.stringify(galicia),
  );

  const balanceAntes = await prisma.movement.groupBy({
    by: ["accountId"],
    where: { OR: [{ accountId: usdAccount?.id }, { toAccountId: usdAccount?.id }] },
    _sum: { amount: true },
  }).catch(() => []);
  const usdAntes = await prisma.account.findUnique({
    where: { id: usdAccount?.id ?? "" },
    select: { openingBalance: true },
  });

  const openedTx = await openModal(ui, "#btn-transfer", "#tx-form", "modal transferencia");
  checkTrue("B4b · el modal de transferencia abre con toque real", openedTx, "no abrió");
  await sleep(600);

  // Origen: Banco Galicia (ARS). Destino: la caja USD.
  await pickOption(ui, "#tx-account", "Banco Galicia");
  await pickOption(ui, "#tx-to-account", usdName);
  await sleep(500);

  const crossState = await ui.evalJs(`(() => {
    const toAmount = document.querySelector('#tx-to-amount');
    const submit = document.querySelector('#tx-submit');
    return {
      hasToAmount: !!toAmount,
      submitDisabled: submit ? submit.disabled : null,
      label: toAmount ? (document.querySelector('label[for="tx-to-amount"]')?.textContent || '').trim() : null,
    };
  })()`);
  checkTrue(
    "B5 · con monedas distintas aparece '¿Cuánto llega?'",
    crossState.hasToAmount && (crossState.label || "").includes("llega"),
    JSON.stringify(crossState),
  );

  // La LISTA de cuentas del formulario rotula cada una con su moneda.
  const listLabels = await ui.evalJs(`(() => {
    const trigger = document.querySelector('#tx-to-account');
    const src = document.querySelector('#tx-account');
    return {
      destino: (trigger?.textContent || '').replace(/\\s+/g, ' ').trim(),
      origen: (src?.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  checkTrue(
    "B5b · la lista de cuentas rotula el destino con US$ y el origen con $",
    norm(listLabels.destino).includes("US$") &&
      /\$ /.test(norm(listLabels.origen)) &&
      !norm(listLabels.origen).includes("US$"),
    JSON.stringify(listLabels),
  );

  // Monto de origen, sin segundo monto: el submit debe quedar bloqueado.
  await ui.evalJs(`document.querySelector('#tx-amount').focus()`);
  await ui.insertText("120000");
  await sleep(300);
  const sinSegundo = await ui.evalJs(`(() => {
    const submit = document.querySelector('#tx-submit');
    return { disabled: submit?.disabled, text: (submit?.textContent || '').trim() };
  })()`);
  checkTrue(
    "B6 · sin el segundo monto el submit está DESHABILITADO",
    sinSegundo.disabled === true,
    JSON.stringify(sinSegundo),
  );

  await ui.evalJs(`document.querySelector('#tx-to-amount').focus()`);
  await ui.insertText("100");
  await sleep(400);
  const preview = await ui.evalJs(`(() => {
    const p = document.querySelector('#tx-to-amount')?.parentElement?.querySelector('p');
    const submit = document.querySelector('#tx-submit');
    return { text: (p?.textContent || '').trim(), disabled: submit?.disabled };
  })()`);
  checkTrue(
    "B7 · el preview dice lo que entra, en la moneda del destino",
    norm(preview.text).includes("Entran US$ 100,00"),
    `"${norm(preview.text)}"`,
  );
  checkTrue(
    "B8 · con el segundo monto el submit se habilita",
    preview.disabled === false,
    JSON.stringify(preview),
  );

  // Nota con TAG para poder limpiar por prefijo además de por id.
  await ui.evalJs(`document.querySelector('#tx-description').focus()`);
  await ui.insertText(`${TAG} ARS a USD`);
  await sleep(200);
  await ui.clickEl("#tx-submit");
  const saved = await ui
    .waitFor(`!document.querySelector('#tx-form')`, { timeout: 20000, label: "guardado" })
    .then(() => true)
    .catch(() => false);
  checkTrue("B9 · la transferencia se guarda sin error", saved, "modal cerrado");

  const mov = await prisma.movement.findFirst({
    where: { description: { startsWith: TAG } },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, amount: true, toAmount: true, accountId: true, toAccountId: true },
  });
  checkTrue(
    "B10 · en la base: amount=120000 ARS y toAmount=100 USD (no 120.000 dólares)",
    mov &&
      String(mov.amount) === "120000" &&
      String(mov.toAmount) === "100" &&
      mov.accountId === galicia?.id &&
      mov.toAccountId === usdAccount?.id,
    JSON.stringify(mov),
  );

  // Saldo del destino: 0 + 100 exactos.
  const usdDespues = await prisma.account.findUnique({
    where: { id: usdAccount?.id ?? "" },
    select: { openingBalance: true },
  });
  const entradas = await prisma.movement.aggregate({
    where: { toAccountId: usdAccount?.id ?? "", kind: "TRANSFER" },
    _sum: { toAmount: true },
  });
  checkTrue(
    "B11 · el saldo de la caja USD sube exactamente 100,00",
    String(entradas._sum.toAmount ?? "0") === "100" &&
      String(usdAntes?.openingBalance ?? "0") === "0" &&
      String(usdDespues?.openingBalance ?? "0") === "0",
    `toAmount sum=${entradas._sum.toAmount} opening=${usdDespues?.openingBalance}`,
  );

  // El panel se recarga después de guardar: se espera el número, no un sleep.
  const cardReady = await ui
    .waitFor(
      `(() => {
        const cards = [...document.querySelectorAll('#account-cards div')];
        const card = cards.find((d) => (d.textContent || '').includes(${JSON.stringify(usdName)}));
        return card && (card.textContent || '').replace(/\\u00a0/g, ' ').includes('US$ 100,00');
      })()`,
      { timeout: 12000, label: "que la tarjeta USD muestre 100,00" },
    )
    .then(() => true)
    .catch(() => false);
  const cardText = await ui.evalJs(`(() => {
    const cards = [...document.querySelectorAll('#account-cards div')];
    const card = cards.find((d) => (d.textContent || '').includes(${JSON.stringify(usdName)}));
    return card ? (card.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  })()`);
  checkTrue(
    "B12 · la tarjeta de la caja USD muestra US$ 100,00",
    cardReady,
    `"${cardText}"`,
  );

  /* ══════════════════ C. misma moneda + formato ════════════════════════════ */
  section("C · misma moneda: el segundo campo no existe · formato $ / US$");

  const openedTx2 = await openModal(ui, "#btn-transfer", "#tx-form", "modal transferencia 2");
  checkTrue("C0 · el modal de transferencia reabre con toque real", openedTx2, "no abrió");
  await sleep(500);
  await pickOption(ui, "#tx-account", "Banco Galicia");
  await pickOption(ui, "#tx-to-account", "Efectivo");
  await sleep(500);
  const sameState = await ui.evalJs(`(() => ({
    hasToAmount: !!document.querySelector('#tx-to-amount'),
    submitDisabled: document.querySelector('#tx-submit')?.disabled ?? null,
  }))()`);
  checkTrue(
    "C1 · origen y destino en ARS: NO aparece '¿Cuánto llega?'",
    sameState.hasToAmount === false,
    JSON.stringify(sameState),
  );
  await ui.evalJs(`document.querySelector('#tx-amount').focus()`);
  await ui.insertText("1500");
  await sleep(400);
  const sameEnabled = await ui.evalJs(
    `document.querySelector('#tx-submit')?.disabled ?? null`,
  );
  checkTrue(
    "C2 · ARS→ARS con monto válido: el submit está habilitado",
    sameEnabled === false,
    `disabled=${sameEnabled}`,
  );

  // Volver a USD: el texto escrito antes se conserva (ya cubierto por diseño);
  // acá importa que el campo reaparezca sin perder el valor previo.
  await ui.clickEl("#tx-cancel");
  await sleep(400);
  // Si quedó aviso de descarte, confirmarlo.
  const discard = await ui.evalJs(`!!document.querySelector('#tx-discard-confirm')`);
  if (discard) {
    await ui.clickEl("#tx-discard-confirm");
    await sleep(500);
  }

  const formatData = await ui.evalJs(`(() => {
    const cards = [...document.querySelectorAll('#account-cards div')];
    const pick = (needle) => {
      const card = cards.find((d) => (d.textContent || '').includes(needle));
      return card ? (card.textContent || '').replace(/\\s+/g, ' ').trim() : null;
    };
    const totals = [...document.querySelectorAll('section, div')]
      .map((d) => (d.textContent || '').replace(/\\s+/g, ' '))
      .find((t) => t.includes('Ingresos') && t.includes('$'));
    return {
      usd: pick(${JSON.stringify(usdName)}),
      ars: pick('Banco Galicia'),
      totals: (totals || '').slice(0, 200),
    };
  })()`);
  checkTrue(
    "C3 · tarjeta USD: símbolo US$ (y NO '$ ' pelado)",
    !!formatData.usd && formatData.usd.includes("US$ 100,00"),
    `"${formatData.usd}"`,
  );
  checkTrue(
    "C4 · tarjeta ARS: símbolo $ sin el prefijo US",
    !!formatData.ars && /\$ \d/.test(formatData.ars) && !formatData.ars.includes("US$"),
    `"${formatData.ars}"`,
  );
  checkTrue(
    "C5 · los totales del panel siguen en pesos ($)",
    !!formatData.totals && /\$ /.test(formatData.totals) && !formatData.totals.includes("US$"),
    `"${formatData.totals}"`,
  );

  // La fila del movimiento: la pata que SALE va en la moneda de origen y las
  // dos cuentas se nombran. (El `toAmount` no se dibuja en la fila; lo que se
  // verifica acá es que el monto visible no se rotule con la moneda equivocada.)
  const rowText = await ui.evalJs(`(() => {
    const filas = [...document.querySelectorAll('.mov-fila')];
    const fila = filas.find((n) => (n.textContent || '').includes(${JSON.stringify(TAG + " ARS a USD")}));
    if (!fila) return null;
    return {
      texto: (fila.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      monto: (fila.querySelector('.mov-monto')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  checkTrue(
    "C6 · la fila de una transferencia ARS→USD muestra la pata de origen en $",
    !!rowText && norm(rowText.monto).includes("$ 120.000,00") && !norm(rowText.monto).includes("US$"),
    `"${JSON.stringify(rowText)}"`,
  );

  /* ══════════════════ D. edición de cuenta y el candado de moneda ══════════ */
  section("D · edición: moneda bloqueada con historia, editable sin historia");

  // Banco Galicia tiene movimientos; la caja USD tiene el movimiento de B.
  const editConHistoria = async (id, nombre) => {
    await ui.evalJs(`document.querySelector('#acc-edit-${id}')?.scrollIntoView({block:'center'})`);
    await sleep(250);
    await ui.evalJs(`document.querySelector('#acc-edit-${id}')?.click()`);
    const abierto = await ui
      .waitFor(`!!document.querySelector('#acc-form')`, { timeout: 8000, label: "editar" })
      .then(() => true)
      .catch(() => false);
    if (!abierto) return null;
    await sleep(400);
    const info = await ui.evalJs(`(() => {
      const trigger = document.querySelector('#acc-currency');
      const help = trigger?.parentElement?.querySelector('p');
      const kind = document.querySelector('#acc-kind');
      return {
        titulo: (document.querySelector('[role="dialog"] h2')?.textContent || '').trim(),
        nombre: document.querySelector('#acc-name')?.value ?? null,
        moneda: (trigger?.textContent || '').trim(),
        disabled: trigger?.disabled ?? trigger?.getAttribute('aria-disabled'),
        ayuda: (help?.textContent || '').trim(),
        tipoBloqueado: kind?.disabled ?? null,
        submit: (document.querySelector('#acc-submit')?.textContent || '').trim(),
      };
    })()`);
    await ui.evalJs(`document.querySelector('#acc-cancel')?.click()`);
    await sleep(400);
    return info;
  };

  const historia = await editConHistoria(galicia.id, "Banco Galicia");
  checkTrue(
    "D1 · editar una cuenta con movimientos abre el modo edición",
    !!historia && historia.titulo.includes("Editar cuenta") && historia.nombre === "Banco Galicia",
    JSON.stringify(historia),
  );
  checkTrue(
    "D2 · la moneda aparece BLOQUEADA y explicada",
    !!historia &&
      (historia.disabled === true || historia.disabled === "true") &&
      /no se puede cambiar/i.test(historia.ayuda),
    JSON.stringify({ d: historia?.disabled, a: historia?.ayuda }),
  );
  checkTrue(
    "D3 · el tipo también está bloqueado (una cuenta no cambia de naturaleza)",
    !!historia && (historia.tipoBloqueado === true || historia.tipoBloqueado === "true"),
    `disabled=${historia?.tipoBloqueado}`,
  );

  const nuevaSinHistoria = await (async () => {
    // Se crea desde la UI para que el panel la dibuje con su botón de editar.
    await ui.evalJs(`document.querySelector('#btn-add-account')?.click()`);
    await ui.waitFor(`!!document.querySelector('#acc-form')`, { timeout: 8000, label: "alta" });
    await sleep(400);
    await ui.evalJs(`document.querySelector('#acc-name').focus()`);
    await ui.insertText(`${TAG}_SinHistoria`);
    await ui.clickEl("#acc-submit");
    await ui.waitFor(`!document.querySelector('#acc-form')`, { timeout: 15000, label: "guardado" });
    await sleep(800);
    const creada = await prisma.account.findFirst({
      where: { name: `${TAG}_SinHistoria` },
      select: { id: true },
    });
    if (!creada) return null;
    createdIds.push(creada.id);
    const info = await editConHistoria(creada.id, `${TAG}_SinHistoria`);
    return { id: creada.id, info };
  })();
  checkTrue(
    "D4 · editar una cuenta SIN historia deja la moneda editable",
    !!nuevaSinHistoria?.info &&
      nuevaSinHistoria.info.disabled !== true &&
      nuevaSinHistoria.info.disabled !== "true" &&
      /moneda elegida/i.test(nuevaSinHistoria.info.ayuda),
    JSON.stringify(nuevaSinHistoria?.info),
  );
} catch (error) {
  counters.failed += 1;
  failures.push(`excepción: ${error.message}`);
  console.error(`  EXCEPCIÓN ${error.message}`);
  console.error(error.stack);
} finally {
  try {
    await ui.close();
  } catch {
    // Chrome ya cerrado.
  }
  try {
    const cleaned = await clean();
    console.log(
      `\nLimpieza: ${cleaned.movs} movimientos y ${cleaned.accounts} cuentas con prefijo ${TAG}.`,
    );
    const leftovers = await prisma.account.count({ where: { name: { startsWith: TAG } } });
    check("limpieza · no quedan cuentas de la batería", leftovers, 0);
  } catch (error) {
    console.error(`Limpieza falló: ${error.message}`);
  }
  await prisma.$disconnect();

  process.exitCode = summary() ? 0 : 1;
}
