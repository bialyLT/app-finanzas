#!/usr/bin/env node
/**
 * f44a-responsive.mjs — geometría de los DOS estados que esta fase agrega.
 *
 * La auditoría (`audit-mobile`) mide el estado en REPOSO de 11 modales. Lo que
 * la fase 4.4a suma es un estado NUEVO que la auditoría no recorre:
 *
 *   · transferencia ARS→USD, con el campo "¿Cuánto llega?" visible (+70 px de
 *     formulario dentro de un modal que ya rozaba el pie fijo).
 *   · alta/edición de cuenta con el selector de moneda.
 *
 * Se barre 320 / 375 / 768 en las DOS orientaciones (6 ventanas) y se mide con
 * LA MISMA definición de la auditoría (`scripts/responsive/measure.mjs`):
 * desborde contra el ANCHO DEL DEVICE (no `innerWidth`), texto cortado, targets
 * < 44 px y taps muertos.
 *
 * Los taps muertos del `<select>` espejo de Radix se cuentan aparte y se
 * reportan como artefacto del instrumento: son `aria-hidden` + `tabindex=-1`,
 * la sonda `f44a-monedas.mjs` (sección A) mide con toque real que no reciben
 * ni un toque. Acá se exige que NINGÚN control VISIBLE quede tapado.
 *
 * Uso: node scripts/tester-ui/f44a-responsive.mjs
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
import { measureExpression } from "../responsive/measure.mjs";

try {
  process.loadEnvFile();
} catch {
  // Sin `.env`.
}

const TAG = "T_F44A_RESP";
const BASE = "http://127.0.0.1:3101";
const PORT = 9374;

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

/** La cuenta USD que se usa como destino (se crea y se borra por id). */
async function crearCuentaUsd() {
  const existing = await prisma.account.findFirst({ where: { name: `${TAG}_USD` } });
  if (existing) await prisma.account.delete({ where: { id: existing.id } });
  return prisma.account.create({
    data: { name: `${TAG}_USD`, kind: "CASH", currency: "USD", openingBalance: "0" },
    select: { id: true, name: true },
  });
}

async function limpiar() {
  const movs = await prisma.movement.findMany({
    where: { OR: [{ description: { startsWith: TAG } }, { account: { name: { startsWith: TAG } } }] },
    select: { id: true },
  });
  if (movs.length) {
    await prisma.movement.deleteMany({ where: { id: { in: movs.map((m) => m.id) } } });
  }
  await prisma.account.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function device(ui, width, height) {
  await ui.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
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
    inner: window.innerWidth,
    coarse: window.matchMedia('(any-pointer: coarse)').matches
  })`);
  // La emulación tiene que estar puesta ANTES de navegar: si no, se mediría la
  // ventana real y el informe diría "todo bien" sin haber medido nada.
  if (probe.screen !== width || probe.coarse !== true) {
    throw new Error(
      `la emulación de ${width}px NO aplicó (screen=${probe.screen}, coarse=${probe.coarse})`,
    );
  }
  return probe;
}

async function pickOption(ui, triggerSelector, optionText) {
  await ui.evalJs(
    `document.querySelector(${JSON.stringify(triggerSelector)})?.scrollIntoView({ block: 'center' })`,
  );
  await sleep(200);
  await ui.clickEl(triggerSelector);
  const opened = await ui
    .waitFor(`!!document.querySelector('[role="option"]')`, { timeout: 4000, label: "lista" })
    .catch(() => false);
  if (!opened) return false;
  const hit = await ui.evalJs(`(() => {
    const o = [...document.querySelectorAll('[role="option"]')]
      .find((n) => (n.textContent || '').includes(${JSON.stringify(optionText)}));
    if (!o) return null;
    o.scrollIntoView({ block: 'nearest' });
    const r = o.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
  })()`);
  if (!hit || hit.w === 0) return false;
  await ui.clickAt(hit.x, hit.y);
  await sleep(300);
  return true;
}

async function medir(ui, scope) {
  const expr = measureExpression({ deviceWidth: await ui.evalJs("window.screen.width"), scopeSelector: scope });
  return ui.evalJs(expr);
}

const ui = await openUi({ port: PORT, viewport: { width: 375, height: 667 } });
let usd = null;

try {
  await limpiar();
  usd = await crearCuentaUsd();

  const VENTANAS = [
    { w: 320, h: 568, nombre: "320x568" },
    { w: 568, h: 320, nombre: "568x320 (landscape)" },
    { w: 375, h: 667, nombre: "375x667" },
    { w: 667, h: 375, nombre: "667x375 (landscape)" },
    { w: 768, h: 1024, nombre: "768x1024" },
    { w: 1024, h: 768, nombre: "1024x768 (landscape)" },
  ];

  section("D · transferencia ARS→USD con '¿Cuánto llega?' — 320/375/768 × 2 orientaciones");

  for (const vp of VENTANAS) {
    await device(ui, vp.w, vp.h);
    await ui.navigate(`${BASE}/`);
    await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
    await sleep(800);
    await ui.loginIfNeeded();
    await ui.waitFor("!!document.querySelector('#btn-add-account')", { timeout: 30000 });
    await sleep(500);

    const rect = await ui.centerOf("#btn-transfer");
    await ui.clickAt(rect.x, rect.y);
    const abierto = await ui
      .waitFor("!!document.querySelector('#tx-form')", { timeout: 8000, label: "modal" })
      .then(() => true)
      .catch(() => false);
    if (!abierto) {
      // Ventana sorda: un reintento cuenta como interacción.
      await ui.evalJs(`document.querySelector('#btn-transfer').scrollIntoView({block:'center'})`);
      await sleep(250);
      await ui.clickEl("#btn-transfer");
      await ui.waitFor("!!document.querySelector('#tx-form')", { timeout: 8000, label: "modal (reintento)" });
    }
    await sleep(500);

    await pickOption(ui, "#tx-account", "Banco Galicia");
    await pickOption(ui, "#tx-to-account", `${TAG}_USD`);
    await sleep(400);

    const conCampo = await ui.evalJs(`!!document.querySelector('#tx-to-amount')`);
    checkTrue(`${vp.nombre} · el campo '¿Cuánto llega?' está visible`, conCampo, "no apareció");

    const m = await medir(ui, '[role="dialog"]');
    const etiqueta = `${vp.nombre} · transferencia USD`;

    checkTrue(
      `${etiqueta} · sin desborde (scrollWidth = device)`,
      m.scrollWidth <= vp.w,
      `scrollWidth=${m.scrollWidth} device=${vp.w} innerWidth=${m.innerWidth}`,
    );
    check(`${etiqueta} · nada se sale de su caja`, m.culprits.length, 0);
    // "Texto cortado" crudo. Un adelanto de glifo de 1-2 px dentro de un botón
    // (borde redondeado, `overflow: visible`) no corta nada: no se puede leer
    // mal un número. Se exige que no haya NADA cortado de verdad (>2 px) y se
    // imprime el residuo sub-píxel para que quede medido, no escondido.
    const cortes = m.overflowers.filter((o) => o.sobra > 2);
    if (m.overflowers.length > cortes.length) {
      console.log(
        `      (nota) ${m.overflowers.length - cortes.length} desborde(s) sub-píxel: ` +
          m.overflowers.filter((o) => o.sobra <= 2).map((o) => `${o.text}:${o.sobra}px`).join(", "),
      );
    }
    checkTrue(
      `${etiqueta} · sin texto cortado`,
      cortes.length === 0,
      JSON.stringify(cortes.slice(0, 3)),
    );
    check(`${etiqueta} · sin targets < 44px`, m.smallTargetCount, 0);

    // Taps muertos: los del espejo oculto son artefacto; los VISIBLES son bug.
    const bloqueados = m.taps.filter((t) => t.status === "blocked");
    const espejos = bloqueados.filter((t) => String(t.el).startsWith("select"));
    const visibles = bloqueados.filter((t) => !String(t.el).startsWith("select"));
    check(`${etiqueta} · ningún control VISIBLE tapado`, visibles.length, 0);
    if (visibles.length) {
      console.log(`      tapado por: ${visibles.map((t) => `${t.el} <- ${t.blockedBy}`).join(" | ")}`);
    }
    if (espejos.length) {
      console.log(`      (artefacto) ${espejos.length} taps del <select> espejo oculto`);
    }

    // El panel del modal tiene que entrar: el pie fijo, visible y con su botón.
    const pie = await ui.evalJs(`(() => {
      const b = document.querySelector('#tx-submit');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: window.innerHeight };
    })()`);
    checkTrue(
      `${etiqueta} · el botón de guardar entra en la ventana`,
      !!pie && pie.top >= 0 && pie.bottom <= pie.vh && pie.h >= 44,
      JSON.stringify(pie),
    );

    // Cerrar (puede pedir descarte si quedó texto).
    await ui.evalJs(`document.querySelector('#tx-close')?.click()`);
    await sleep(400);
    const discard = await ui.evalJs(`!!document.querySelector('#tx-discard-confirm')`);
    if (discard) {
      await ui.evalJs(`document.querySelector('#tx-discard-confirm').click()`);
      await sleep(300);
    }
  }

  section("E · alta de cuenta con selector de moneda — 320/375/768 × 2 orientaciones");

  for (const vp of VENTANAS) {
    await device(ui, vp.w, vp.h);
    await ui.navigate(`${BASE}/`);
    await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
    await sleep(700);
    await ui.loginIfNeeded();
    await ui.waitFor("!!document.querySelector('#btn-add-account')", { timeout: 30000 });
    await sleep(400);

    const rect = await ui.centerOf("#btn-add-account");
    await ui.clickAt(rect.x, rect.y);
    const abierto = await ui
      .waitFor("!!document.querySelector('#acc-form')", { timeout: 8000, label: "modal cuenta" })
      .then(() => true)
      .catch(() => false);
    if (!abierto) {
      await ui.evalJs(`document.querySelector('#btn-add-account').scrollIntoView({block:'center'})`);
      await sleep(250);
      await ui.clickEl("#btn-add-account");
      await ui.waitFor("!!document.querySelector('#acc-form')", { timeout: 8000, label: "modal cuenta (reintento)" });
    }
    await sleep(400);

    const m = await medir(ui, '[role="dialog"]');
    const etiqueta = `${vp.nombre} · alta de cuenta`;
    checkTrue(
      `${etiqueta} · sin desborde`,
      m.scrollWidth <= vp.w,
      `scrollWidth=${m.scrollWidth} device=${vp.w} innerWidth=${m.innerWidth}`,
    );
    check(`${etiqueta} · nada se sale de su caja`, m.culprits.length, 0);
    checkTrue(
      `${etiqueta} · sin texto cortado`,
      m.overflowers.length === 0,
      JSON.stringify(m.overflowers.slice(0, 3)),
    );
    check(`${etiqueta} · sin targets < 44px`, m.smallTargetCount, 0);
    const visibles = m.taps.filter((t) => t.status === "blocked" && !String(t.el).startsWith("select"));
    check(`${etiqueta} · ningún control VISIBLE tapado`, visibles.length, 0);

    const moneda = await ui.evalJs(`(() => {
      const el = document.querySelector('#acc-currency');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    })()`);
    checkTrue(
      `${etiqueta} · el selector de moneda es un target de 44px`,
      !!moneda && moneda.h >= 44 && moneda.visible,
      JSON.stringify(moneda),
    );

    const cancel = await ui.centerOf("#acc-cancel");
    await ui.clickAt(cancel.x, cancel.y);
    await sleep(300);
  }
} catch (error) {
  counters.failed += 1;
  failures.push(`excepción: ${error.message}`);
  console.error(`  EXCEPCIÓN ${error.message}`);
  console.error(error.stack);
} finally {
  try {
    await ui.close();
  } catch {
    // Ya cerrado.
  }
  await limpiar();
  const sobra = await prisma.account.count({ where: { name: { startsWith: TAG } } });
  check("limpieza · no quedan cuentas de la batería", sobra, 0);
  await prisma.$disconnect();
  process.exitCode = summary() ? 0 : 1;
}
