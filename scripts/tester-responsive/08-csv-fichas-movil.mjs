#!/usr/bin/env node
/**
 * 08-csv-fichas-movil · la previsualización del CSV en el teléfono son FICHAS,
 * no tabla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE DECLARA EL DEV
 * «La tabla del CSV: antes medía 496 px dentro de un contenedor de 333 (con
 * whitespace-nowrap en fecha, tipo y monto) y había que arrastrarla
 * horizontalmente. Ahora, en teléfono, la previsualización es una lista de
 * fichas (#csv-rows-movil) y la tabla queda para sm: y para arriba.»
 *
 * Y el aviso del dev: «Si el tester agrega una previsualización, el assert va
 * a tener que buscar el texto de la ficha, no el de la tabla.»
 *
 * Esta batería hace exactamente eso: precarga un CSV, pide la previsualización
 * y comprueba que en el teléfono:
 *   · las FICHAS están (y la tabla NO);
 *   · el texto de la ficha (el de la fila, con su fecha y su monto) se ve;
 *   · el modal no se pasa de ancho ni deja contenido fuera de su caja.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section, counters, failures } from "../tester-fase7/helpers.mjs";
import { openUi, applyViewport, verifyViewport, openRoute, correrBateria } from "./lib.mjs";

const MOVIL = { name: "375 iphone-se", width: 375, height: 667 };
const ESCRITORIO = { name: "1019 ventana de tests", width: 1019, height: 557 };

const CSV = [
  "fecha,tipo,monto,cuenta,categoria,descripcion",
  "2026-08-03,EXPENSE,1500,Banco Galicia,Comida,Café",
  "2026-08-04,INCOME,250000,Banco Galicia,Sueldo,Agosto",
  "2026-08-05,TRANSFER,50000,Efectivo,,Traslado entre mis cuentas",
].join("\n");

async function abrirImportador(ui) {
  // Con reintentos: el primer clic tras cargar puede perderse (la «ventana
  // sorda» del CDP) y eso es un artefacto de medición, no del producto.
  for (let intento = 0; intento < 4; intento += 1) {
    await ui.evalJs(
      `document.getElementById("btn-import-csv").scrollIntoView({ block: "center" })`,
    );
    await new Promise((r) => setTimeout(r, intento === 0 ? 250 : 350));
    const r = await ui.centerOf("#btn-import-csv");
    if (!r) throw new Error("no existe #btn-import-csv");
    await ui.clickAt(r.x, r.y);
    const abierto = await ui
      .waitFor(`!!document.querySelector("#csv-text")`, { timeout: 2500, label: "el importador" })
      .then(() => true)
      .catch(() => false);
    if (abierto) break;
  }
  await ui.waitFor(`!!document.querySelector("#csv-text")`, { timeout: 15000, label: "el importador" });
  await ui.evalJs(`(() => {
    const ta = document.querySelector("#csv-text");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(CSV)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  for (let intento = 0; intento < 4; intento += 1) {
    const b = await ui.centerOf("#csv-preview-button");
    if (!b) throw new Error("no existe #csv-preview-button");
    await ui.clickAt(b.x, b.y);
    const ok = await ui
      .waitFor(`!!document.querySelector("#csv-preview")`, { timeout: 4000, label: "la previsualización" })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
  }
  await ui.waitFor(`!!document.querySelector("#csv-preview")`, { timeout: 20000, label: "la previsualización" });
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  const ui = await openUi({
    port: 9362,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9362`,
  });
  try {
    /* ── 1 · en el teléfono: fichas, no tabla ──────────────────────────── */
    section("1 · 375 px: la previsualización son fichas");
    await applyViewport(ui, MOVIL, { touch: true });
    await openRoute(ui, "/");
    await verifyViewport(ui, MOVIL, { touch: true });
    await abrirImportador(ui);

    const movil = await ui.evalJs(`(() => {
      const fichas = document.getElementById("csv-rows-movil");
      const tabla = document.querySelector("#csv-preview table");
      const panel = document.querySelector('[role="dialog"]');
      const fr = fichas ? fichas.getBoundingClientRect() : null;
      const tr = tabla ? tabla.getBoundingClientRect() : null;
      const pr = panel ? panel.getBoundingClientRect() : null;
      return {
        hayFichas: !!fichas,
        hayTabla: !!tabla,
        altoFichas: fr ? fr.height : 0,
        anchoFichas: fr ? fr.width : 0,
        anchoTabla: tr ? tr.width : 0,
        textoFichas: fichas ? (fichas.textContent || "").replace(/\\s+/g, " ").trim() : "",
        documento: document.documentElement.scrollWidth,
        panelScroll: panel ? panel.scrollWidth : 0,
        panelClient: panel ? panel.clientWidth : 0
      };
    })()`);
    checkTrue("en el teléfono existen las fichas (#csv-rows-movil)", movil.hayFichas === true);
    checkTrue(
      "en el teléfono las fichas tienen contenido (alto > 0)",
      movil.altoFichas > 0,
      `alto=${movil.altoFichas}`,
    );
    checkTrue(
      "en el teléfono la tabla NO se muestra",
      movil.hayTabla === false || movil.anchoTabla === 0,
      `anchoTabla=${movil.anchoTabla}`,
    );
    checkIncluyeTexto(movil.textoFichas, "Café", "el texto de la ficha (la descripción)");
    checkIncluyeTexto(movil.textoFichas, "1.500,00", "el texto de la ficha (el monto)");
    checkTrue(
      "las fichas no se pasan del ancho del device",
      movil.anchoFichas <= MOVIL.width + 1,
      `ancho=${movil.anchoFichas}`,
    );
    checkTrue(
      "el documento no se pasa del device con la previsualización abierta",
      movil.documento <= MOVIL.width + 1,
      `documento=${movil.documento}`,
    );
    checkTrue(
      "el contenido del modal entra en el panel",
      movil.panelScroll <= movil.panelClient + 1,
      `${movil.panelScroll} en ${movil.panelClient}`,
    );
    console.log(
      `  · fichas: alto=${Math.round(movil.altoFichas)} ancho=${Math.round(movil.anchoFichas)} ` +
        `tabla=${movil.anchoTabla} documento=${movil.documento}`,
    );
    console.log(`  · texto de las fichas: "${movil.textoFichas.slice(0, 120)}"`);

    /* ── 2 · en pantalla ancha: la tabla sigue estando ─────────────────── */
    section("2 · 1019 px: la tabla sigue estando (y las fichas no)");
    await openRoute(ui, "/");
    await applyViewport(ui, ESCRITORIO, { touch: true });
    await verifyViewport(ui, ESCRITORIO, { touch: true });
    await abrirImportador(ui);
    const escritorio = await ui.evalJs(`(() => {
      const fichas = document.getElementById("csv-rows-movil");
      const tabla = document.querySelector("#csv-preview table");
      const fr = fichas ? fichas.getBoundingClientRect() : null;
      const tr = tabla ? tabla.getBoundingClientRect() : null;
      return {
        altoFichas: fr ? fr.height : 0,
        anchoTabla: tr ? tr.width : 0,
        documento: document.documentElement.scrollWidth
      };
    })()`);
    checkTrue(
      "en pantalla ancha las fichas no se ven",
      escritorio.altoFichas === 0,
      `alto=${escritorio.altoFichas}`,
    );
    checkTrue(
      "en pantalla ancha la tabla se ve",
      escritorio.anchoTabla > 0,
      `ancho=${escritorio.anchoTabla}`,
    );
    checkTrue(
      "en pantalla ancha el documento no se pasa del device",
      escritorio.documento <= ESCRITORIO.width + 1,
      `documento=${escritorio.documento}`,
    );
  } finally {
    await ui.close();
  }
}

/** `check` propio: el texto de la ficha (no el de la tabla). */
function checkIncluyeTexto(texto, aguja, que) {
  const ok = String(texto ?? "").includes(aguja);
  if (ok) {
    counters.passed += 1;
    console.log(`  ok    ${que}: «${aguja}» está en pantalla`);
  } else {
    counters.failed += 1;
    failures.push(`${que}: «${aguja}» no está en pantalla`);
    console.log(`  FALLA ${que}: «${aguja}» no está en pantalla`);
    console.log(`        obtenido: ${String(texto ?? "").slice(0, 200)}`);
  }
}

await correrBateria({ main, etiqueta: "08-csv-fichas-movil", conSesion: true });
