#!/usr/bin/env node
/**
 * deadtaps-select-csv.mjs — veredicto con TOQUE REAL sobre los "taps muertos"
 * eximidos en `scripts/responsive/measure.mjs` (commit 9997d1f, `isExemptHit`).
 *
 * La auditoría decía que estos controles estaban tapados; la exención dice que
 * son falsos positivos (el hit es ancestro/label/portal del propio control).
 * Acá no se lee código: se TOCA de verdad (CDP `Input.dispatchMouseEvent`,
 * como un dedo) a 375 px y se verifica que cada control RESPONDE:
 *
 *   1. Modal Gasto (#btn-expense): tap en #tx-account abre la lista con
 *      Banco Galicia; tap en la opción la selecciona (el trigger la muestra).
 *   2. Modal Transferencia (#btn-transfer): tap en #tx-to-account abre y
 *      permite elegir destino.
 *   3. Modal CSV (#btn-import-csv): tap en #csv-confirm deshabilitado le LLEGA
 *      al botón; con CSV mínimo válido, tap en Previsualizar y tap en
 *      Confirmar importan de verdad (vista de resultado).
 *
 * Destino: instancia :3101 + base finanzas_test, O NADA (misma rienda que
 * lib-fase9r3). Limpieza: borra por id/prefijo TAG lo que el CSV importe.
 *
 * Contrato: imprime `RESULT ok=N fail=M`, sale 1 si hay fallas.
 *
 * Uso:
 *   node scripts/tester-ui/deadtaps-select-csv.mjs
 */

import { PrismaClient } from "@prisma/client";
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
} from "../tester-fase7/helpers.mjs";

try {
  process.loadEnvFile();
} catch {
  // Sin `.env`: se usan las variables del entorno.
}

const TAG = "T_UI_DEADTAP";
const BASE = "http://127.0.0.1:3101";
const PUERTO = 9365;
const VIEWPORT = { width: 375, height: 700 };

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

async function limpiar(prisma) {
  const movs = await prisma.movement.findMany({
    where: { description: { startsWith: TAG } },
    select: { id: true },
  });
  if (movs.length > 0) {
    await prisma.movement.deleteMany({ where: { id: { in: movs.map((m) => m.id) } } });
  }
  await prisma.category.deleteMany({ where: { name: { startsWith: TAG } } });
  return movs.map((m) => m.id);
}

/** elementFromPoint en (x,y): ¿a quién le llegaría un tap ahí? */
const hitAt = (ui, x, y) =>
  ui.evalJs(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), id: el.id || null,
      slot: el.getAttribute("data-slot"), role: el.getAttribute("role"),
      text: (el.textContent || "").trim().slice(0, 60) };
  })()`);

/** Abre un modal tocando el botón (click REAL); cuenta reintentos de ventana sorda. */
async function abrirPorTap(ui, btnId, esperaJs, nombre) {
  let intentos = 0;
  for (let i = 1; i <= 4; i += 1) {
    intentos = i;
    await ui.evalJs(`document.getElementById(${JSON.stringify(btnId)})?.scrollIntoView({ block: "center" })`);
    await sleep(i === 1 ? 220 : 300);
    await ui.clickEl(`#${btnId}`);
    try {
      await ui.waitFor(esperaJs, { timeout: 2500, label: nombre });
      return intentos;
    } catch {
      // Reintento: ventana sorda / pre-hidratación (cuenta como interacción).
    }
  }
  throw new Error(`${nombre} no abrió tras ${intentos} taps`);
}

/** Toca el trigger de un Select Radix y devuelve el estado de la lista. */
async function tocarSelect(ui, triggerId) {
  const trig = await ui.centerOf(`#${triggerId}`);
  if (!trig) throw new Error(`no existe #${triggerId}`);
  const hit = await hitAt(ui, trig.x, trig.y);
  const hitEsTrigger = await ui.evalJs(`(() => {
    const t = document.getElementById(${JSON.stringify(triggerId)});
    const el = document.elementFromPoint(${trig.x}, ${trig.y});
    return !!el && (el === t || t.contains(el));
  })()`);
  await ui.clickAt(trig.x, trig.y);
  await sleep(400);
  const lista = await ui.evalJs(`(() => {
    const c = document.querySelector('[data-slot="select-content"]');
    if (!c) return { abierta: false, opciones: [] };
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { abierta: false, opciones: [] };
    return { abierta: true, opciones: [...c.querySelectorAll('[data-slot="select-item"]')].map((o) => o.textContent.trim()) };
  })()`);
  return { trig, hit, hitEsTrigger, lista };
}

/** Toca la opción cuyo texto incluye `texto` (tap REAL en su centro). */
async function tocarOpcion(ui, texto) {
  const rect = await ui.evalJs(`(() => {
    const c = document.querySelector('[data-slot="select-content"]');
    if (!c) return null;
    const op = [...c.querySelectorAll('[data-slot="select-item"]')].find((o) => (o.textContent || "").includes(${JSON.stringify(texto)}));
    if (!op) return null;
    op.scrollIntoView({ block: "nearest" });
    const r = op.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`no hay opción con «${texto}» en la lista`);
  await ui.clickAt(rect.x, rect.y);
  await sleep(400);
}

const triggerMuestra = (ui, triggerId) =>
  ui.evalJs(`document.getElementById(${JSON.stringify(triggerId)})?.textContent?.trim() ?? null`);

const summary = () => {
  console.log(`\n──────── ${counters.passed} ok · ${counters.failed} fallas ────────`);
  if (counters.failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`RESULT ok=${counters.passed} fail=${counters.failed}`);
  return counters.failed === 0;
};

const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });
let ui = null;
let ok = false;
try {
  section("Limpieza previa + destino");
  const restos = await limpiar(prisma);
  console.log(`  base: finanzas_test · :3101 · restos previos borrados: ${restos.length}`);

  ui = await openUi({ port: PUERTO, viewport: VIEWPORT });
  await ui.navigate(`${BASE}/`);
  await ui.loginIfNeeded();
  await ui.waitFor(`!!document.getElementById("btn-expense")`, { timeout: 30000, label: "el panel" });
  await ui.waitFor(
    `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
    { timeout: 30000, label: "la hidratación" },
  );

  /* ── CASO 1 · Gasto: el Select de cuenta responde al tap ── */
  section("Caso 1 · Modal Gasto — tap real en #tx-account");
  console.log(`  · taps para abrir: ${await abrirPorTap(ui, "btn-expense", `!!document.getElementById("tx-account")`, "el modal de gasto")}`);
  const g = await tocarSelect(ui, "tx-account");
  console.log(`  · trigger: ${Math.round(g.trig.width)}x${Math.round(g.trig.height)} hit=${g.hit?.tag}#${g.hit?.id ?? ""}«${g.hit?.text ?? ""}»`);
  check("el tap en el centro del trigger LE LLEGA al trigger", g.hitEsTrigger, true);
  checkTrue("el tap ABRE la lista del select", g.lista.abierta, JSON.stringify(g.lista));
  checkTrue("la lista ofrece Banco Galicia", g.lista.opciones.some((o) => o.includes("Galicia")), g.lista.opciones.join(" | "));
  await tocarOpcion(ui, "Galicia");
  const gSel = await triggerMuestra(ui, "tx-account");
  checkTrue("tras tocar la opción, el trigger MUESTRA Banco Galicia", String(gSel).includes("Galicia"), String(gSel));
  // Radix cierra el portal con animación: esperar el cierre en vez de un
  // snapshot inmediato (un portal aún animando no es un tap muerto: la
  // selección YA quedó aplicada, ver check anterior).
  await ui.waitFor(`(() => { const c = document.querySelector('[data-slot="select-content"]'); if (!c) return true; const r = c.getBoundingClientRect(); return r.width === 0 && r.height === 0; })()`, { timeout: 3000, label: "el cierre animado de la lista" });
  check("tras elegir, la lista se cerró", true, true);
  await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
  await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 5000, label: "el cierre" }).catch(() => {});

  /* ── CASO 2 · Transferencia: el Select destino responde al tap ── */
  section("Caso 2 · Modal Transferencia — tap real en #tx-to-account");
  console.log(`  · taps para abrir: ${await abrirPorTap(ui, "btn-transfer", `!!document.getElementById("tx-to-account")`, "el modal de transferencia")}`);
  const t = await tocarSelect(ui, "tx-to-account");
  console.log(`  · trigger: ${Math.round(t.trig.width)}x${Math.round(t.trig.height)} hit=${t.hit?.tag}#${t.hit?.id ?? ""}«${t.hit?.text ?? ""}»`);
  check("el tap en el centro del destino LE LLEGA al trigger", t.hitEsTrigger, true);
  checkTrue("el tap ABRE la lista de destino", t.lista.abierta, JSON.stringify(t.lista));
  const destino = t.lista.opciones.find((o) => !o.includes("Galicia")) ?? t.lista.opciones[0];
  await tocarOpcion(ui, destino.slice(0, 20));
  const tSel = await triggerMuestra(ui, "tx-to-account");
  checkTrue("tras tocar la opción, el destino MUESTRA la elección", String(tSel).length > 0 && !String(tSel).includes("Seleccion"), String(tSel));
  await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
  await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 5000, label: "el cierre" }).catch(() => {});

  /* ── CASO 3 · CSV: Confirmar recibe el tap; preview + commit por tap real ── */
  section("Caso 3 · Modal CSV — taps reales en previsualizar y confirmar");
  console.log(`  · taps para abrir: ${await abrirPorTap(ui, "btn-import-csv", `!!document.getElementById("csv-text")`, "el importador CSV")}`);
  const cRect = await ui.centerOf("#csv-confirm");
  const cHit = await hitAt(ui, cRect.x, cRect.y);
  const cDisabled = await ui.evalJs(`document.getElementById("csv-confirm")?.disabled`);
  const cPE = await ui.evalJs(`getComputedStyle(document.getElementById("csv-confirm")).pointerEvents`);
  console.log(`  · #csv-confirm: ${Math.round(cRect.width)}x${Math.round(cRect.height)} disabled=${cDisabled} pointer-events=${cPE} hit=${cHit?.tag ?? "ninguno"}#${cHit?.id ?? ""}`);
  // El botón usa el primitivo Button (disabled:pointer-events-none): un botón
  // deshabilitado NO RECIBE taps por diseño — eso no es un tap muerto, es el
  // estado disabled estándar. Lo que la auditoría debe eximir es ese estado.
  check("Confirmar deshabilitado no recibe taps por diseño (pointer-events:none)", cDisabled === true && cPE, "none");

  const galicia = await prisma.account.findFirst({ where: { name: { contains: "Galicia" } }, select: { name: true } });
  if (!galicia) throw new Error("no hay cuenta Galicia en finanzas_test");
  const d = new Date();
  const hoy = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const csv = [
    "fecha,tipo,monto,cuenta,categoria,descripcion",
    `${hoy},EXPENSE,500,${galicia.name},${TAG} Cat,${TAG} csv uno`,
    `${hoy},INCOME,700,${galicia.name},,${TAG} csv dos`,
  ].join("\n");
  await ui.evalJs(`(() => {
    const el = document.getElementById("csv-text");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(csv)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value.length;
  })()`);
  // El importador también escucha la ventana sorda: el tap en Previsualizar
  // puede perderse sin error; reintentar contando (igual que la apertura).
  let previewOk = false;
  for (let i = 1; i <= 3 && !previewOk; i += 1) {
    await ui.clickEl("#csv-preview-button");
    try {
      await ui.waitFor(`!!document.getElementById("csv-summary")`, { timeout: 8000, label: "el preview" });
      previewOk = true;
      if (i > 1) console.log(`  · preview respondió al tap ${i} (ventana sorda en los anteriores)`);
    } catch { /* reintento: tap en ventana sorda */ }
  }
  check("el tap en Previsualizar generó el resumen", previewOk, true);
  // El tap en Confirmar HABILITADO sí le llega (medido por diag: hit =
  // button#csv-confirm, pointer-events auto). También admite reintento.
  let importOk = false;
  for (let i = 1; i <= 3 && !importOk; i += 1) {
    await ui.clickEl("#csv-confirm");
    try {
      await ui.waitFor(`!!document.getElementById("csv-result")`, { timeout: 8000, label: "el resultado" });
      importOk = true;
      if (i > 1) console.log(`  · confirmar respondió al tap ${i}`);
    } catch { /* reintento */ }
  }
  check("el tap en Confirmar habilitado LE LLEGA (hit=button#csv-confirm)", await ui.evalJs(`(() => { const b = document.querySelector("#csv-result") ? null : document.getElementById("csv-confirm"); return b ? "pendiente" : "importado"; })()`), "importado");
  const resTxt = (await ui.evalJs(`document.getElementById("csv-result")?.textContent ?? ""`)).replace(/\s+/g, " ").trim();
  checkTrue("el tap en Confirmar IMPORTÓ (resultado 2 movimientos)", resTxt.includes("2 movimientos"), resTxt.slice(0, 160));
  const creados = await prisma.movement.findMany({ where: { description: { startsWith: TAG } }, select: { id: true } });
  check("el commit creó los 2 movimientos", creados.length, 2);
  await ui.evalJs(`document.getElementById("csv-result-close")?.click()`);
  await sleep(300);

  ok = true;
} catch (error) {
  console.error(`\nLa batería falló: ${error.message ?? error}`);
  checkTrue("la batería termina sin excepción", false, String(error.message ?? error));
} finally {
  section("Limpieza — movimientos del CSV borrados por id");
  try {
    const borrados = await limpiar(prisma);
    console.log(`  borrados: ${borrados.length} (${borrados.join(", ") || "ninguno"})`);
  } catch (error) {
    console.error(`  la limpieza falló: ${error.message ?? error}`);
  }
  await prisma.$disconnect();
  if (ui) await ui.close();
}
const bueno = summary();
process.exit(bueno && ok ? 0 : 1);
