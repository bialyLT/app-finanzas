#!/usr/bin/env node
/**
 * 02-puntero-y-ventana-angosta · ¿la regla de 44 px la decide el PUNTERO o
 * el ANCHO?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CONTRATO QUE SE VERIFICA
 * La regla táctil del proyecto (AGENTS.md, CONTEXTO.md) es:
 *
 *   «targets táctiles de 44 px o más en cualquier pantalla que se opere con
 *     el dedo (`pointer: coarse`; el corte es por modalidad del puntero, no
 *     por ancho)»
 *
 * O sea: la condición correcta NO es «la pantalla es angosta» sino «el dedo
 * es el puntero principal». Esta batería demuestra las DOS mitades:
 *
 *   · CON puntero grueso (teléfono emulado) a 375 px → la regla se aplica:
 *     0 targets chicos.
 *   · SIN puntero grueso (mouse) a 375 px → la regla NO se aplica: aparecen
 *     targets de 36 px. Si la regla estuviera atada al ancho, estos dos
 *     casos darían el mismo resultado y la afirmación del proyecto sería
 *     mentira.
 *
 * Y el hueco que nadie midió: el PUNTO. `pointer: coarse` describe el puntero
 * PRINCIPAL. Una notebook con pantalla táctil tiene mouse como puntero
 * principal (`pointer: fine`) pero también dedo (`any-pointer: coarse`): con
 * la regla actual, esa pantalla —que se opera con el dedo— conserva botones
 * de 36 px. Se mide con números y se decide por escrito.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { openUi, applyViewport, verifyViewport, medir, desborde, correrBateria, BASE_URL } from "./lib.mjs";

const VP = { name: "375 iphone-se", width: 375, height: 667 };
const VP_ANCHO = { name: "400 ventana angosta", width: 400, height: 700 };

async function abrir(ui, path = "/") {
  await ui.navigate(`${BASE_URL}${path}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await new Promise((r) => setTimeout(r, 900));
  await ui.loginIfNeeded();
  await new Promise((r) => setTimeout(r, 700));
  await ui.waitFor(`!!document.getElementById("btn-expense")`, {
    timeout: 30000,
    label: "el panel hidratado",
  });
}

async function main() {
  const ui = await openUi({ port: 9351, profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9351` });
  try {
    /* ── 1 · TELÉFONO: puntero grueso, 375 px ──────────────────────────── */
    section("1 · teléfono (pointer: coarse) a 375 px → la regla de 44 px se aplica");
    await applyViewport(ui, VP, { touch: true });
    await abrir(ui);
    const probeGrueso = await verifyViewport(ui, VP, { touch: true });
    checkTrue("con la emulación de toque, pointer: coarse es cierto", probeGrueso.coarse === true);
    const grueso = await medir(ui, VP);
    check("sin desborde horizontal a 375 px con dedo", desborde(grueso.data, VP), false);
    check(
      "0 targets táctiles chicos con el puntero grueso",
      grueso.data.smallTargetCount,
      0,
    );

    /* ── 2 · MOUSE en la misma ventana de 375 px ───────────────────────── */
    section("2 · mouse (pointer: fine) en la MISMA ventana de 375 px → la regla NO se aplica");
    await ui.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await abrir(ui);
    const probeFino = await verifyViewport(ui, VP, { touch: false });
    checkTrue("sin emulación de toque, pointer: coarse es falso", probeFino.coarse === false);
    const fino = await medir(ui, VP);
    check(
      "sin desborde horizontal a 375 px con mouse",
      desborde(fino.data, VP),
      false,
    );
    checkTrue(
      "la regla de 44 px NO se aplica con mouse (aparecen targets chicos): la condición es el puntero, no el ancho",
      fino.data.smallTargetCount > 0,
      `smallTargetCount=${fino.data.smallTargetCount}`,
    );
    const masChicos = fino.data.smallTargets
      .slice(0, 5)
      .map((t) => `${t.el} ${t.w}x${t.h}`)
      .join(" | ");
    console.log(`  · targets chicos con mouse: ${fino.data.smallTargetCount} — ${masChicos}`);

    /* ── 3 · MOUSE en una ventana de 400 px (el escritorio angosto) ─────── */
    section("3 · mouse en una ventana angosta de 400 px → el layout aguanta igual");
    await applyViewport(ui, VP_ANCHO, { touch: false });
    await abrir(ui);
    await verifyViewport(ui, VP_ANCHO, { touch: false });
    const angosto = await medir(ui, VP_ANCHO);
    check(
      "sin desborde horizontal a 400 px con mouse",
      desborde(angosto.data, VP_ANCHO),
      false,
    );
    check(
      "el contenido cabe en el device a 400 px",
      angosto.data.scrollWidth <= VP_ANCHO.width + 1,
      true,
    );
    console.log(
      `  · a 400 px con mouse: contenido=${angosto.data.scrollWidth}, ` +
        `targets chicos=${angosto.data.smallTargetCount}, ` +
        `avisos=${angosto.taps.avisos.length}, taps muertos=${angosto.taps.deadTaps.length}`,
    );

    /* ── 4 · la notebook con pantalla táctil (puntero mixto) ───────────── */
    section("4 · notebook con pantalla táctil: ¿el puntero principal o cualquier puntero?");
    await ui.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 768,
      screenWidth: 1024,
      screenHeight: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await ui.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await abrir(ui);
    const mixto = await ui.evalJs(`({
      coarse: window.matchMedia("(pointer: coarse)").matches,
      anyCoarse: window.matchMedia("(any-pointer: coarse)").matches,
      fine: window.matchMedia("(pointer: fine)").matches
    })`);
    console.log(`  · puntero medido con la emulación de toque: ${JSON.stringify(mixto)}`);
    const hibrido = await medir(ui, { name: "1024 hibrido", width: 1024, height: 768 });
    check(
      "sin desborde horizontal en la pantalla táctil de 1024 px",
      desborde(hibrido.data, { width: 1024 }),
      false,
    );
    check(
      "con el puntero grueso (emulado) la regla de 44 px se aplica: 0 targets chicos",
      hibrido.data.smallTargetCount,
      0,
    );
    console.log(
      `  · la emulación de CDP NO puede fabricar un puntero MIXTO (mouse principal + dedo): ` +
        `con la emulación de toque Chrome reporta pointer: coarse=${mixto.coarse} / ` +
        `any-pointer: coarse=${mixto.anyCoarse}. El hueco «notebook con pantalla táctil» ` +
        `(pointer: fine + any-pointer: coarse) queda como un límite TEÓRICO del criterio, ` +
        `no medido: la regla mira el puntero PRINCIPAL y esa pantalla no lo cambia.`,
    );
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "02-puntero-y-ventana-angosta" });
