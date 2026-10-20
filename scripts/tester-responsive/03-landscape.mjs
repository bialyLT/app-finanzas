#!/usr/bin/env node
/**
 * 03-landscape · el teléfono acostado (844×390 y compañía)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL HUECO QUE NADIE MIDIÓ
 * La auditoría del dev barre 320, 360, 390, 414, 480, 640, 768 y 1024 — TODOS
 * en portrait. Un teléfono de verdad se usa en las dos orientaciones, y la
 * horizontal es la que se usa en la calle, con la pantalla completa. En
 * landscape la app cambia de mundo:
 *
 *   · la ALTURA es la que escasea (390 px contra los 667 del portrait): los
 *     modales tienen `max-h-[92vh]`, así que el panel se achica a 358 px y el
 *     pie pegajoso se come una parte cada vez mayor;
 *   · el ancho pasa a ser de tablet (844 px), así que aparecen las grillas
 *     de 4 columnas, la fila de navegación de escritorio y los anchos de
 *     `sm:`/`md:` que en portrait no se veían;
 *   · la emulación de toque sigue activa (es un teléfono): la regla de los
 *     44 px también.
 *
 * Esta batería mide las 6 vistas y los modales en TRES phones de landscape
 * (667×375, 844×390, 926×428) y, además, hace TAPS REALES sobre los campos
 * de los formularios: un control que se ve pero que no recibe el toque es
 * un tap muerto, y un tap muerto se pierde en silencio.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  medir,
  desborde,
  openRoute,
  abrirModal,
  geometria,
  correrBateria,
  BASE_URL,
} from "./lib.mjs";

const LANDSCAPE = [
  { name: "667x375 (SE landscape)", width: 667, height: 375 },
  { name: "844x390 (iPhone 14 landscape)", width: 844, height: 390 },
  { name: "926x428 (iPhone 11 Pro Max landscape)", width: 926, height: 428 },
];

const VISTAS = [
  { path: "/", name: "inicio" },
  { path: "/analisis", name: "analisis" },
  { path: "/prestamos", name: "prestamos" },
  { path: "/tarjetas", name: "tarjetas" },
  { path: "/recurrencia", name: "recurrencia" },
  { path: "/login", name: "login" },
];

/** Modales que se miden en landscape: disparador, panel y pie pegajoso. */
const MODALES = [
  { name: "gasto", path: "/", trigger: "#btn-expense", panel: '[role="dialog"]', pie: "#tx-submit" },
  { name: "ingreso", path: "/", trigger: "#btn-income", panel: '[role="dialog"]', pie: "#tx-submit" },
  { name: "transferencia", path: "/", trigger: "#btn-transfer", panel: '[role="dialog"]', pie: "#tx-submit" },
  { name: "cuenta", path: "/", trigger: "#btn-add-account", panel: '[role="dialog"]', pie: null },
  { name: "csv", path: "/", trigger: "#btn-import-csv", panel: '[role="dialog"]', pie: "#csv-confirm" },
  { name: "paleta", path: "/", trigger: "#btn-palette", panel: '[role="dialog"]', pie: null },
  { name: "prestamo", path: "/prestamos", trigger: "#loans-new", panel: '[role="dialog"]', pie: null },
];

/** Campos que tienen que ser alcanzables con un dedo dentro del modal. */
const CAMPOS_TX = ["#tx-description", "#tx-amount", "#tx-account", "#tx-category", "#tx-date"];

async function main() {
  const ui = await openUi({
    port: 9352,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9352`,
  });
  try {
    /* ── 1 · LAS VISTAS en landscape ───────────────────────────────────── */
    for (const vp of LANDSCAPE) {
      section(`1 · vista ${vp.name}`);
      await applyViewport(ui, vp, { touch: true });
      for (const vista of VISTAS) {
        await openRoute(ui, vista.path);
        await verifyViewport(ui, vp, { touch: true });
        const m = await medir(ui, vp);
        const desb = desborde(m.data, vp);
        console.log(
          `  · ${vista.name.padEnd(12)} contenido=${m.data.scrollWidth} device=${vp.width} ` +
            `${desb ? "DESBORDE" : "ok"} | innerWidth=${m.data.innerWidth} | ` +
            `chicos=${m.data.smallTargetCount} | taps muertos=${m.taps.deadTaps.length} | ` +
            `avisos=${m.taps.avisos.length}`,
        );
        checkTrue(
          `${vp.name} · vista ${vista.name} · sin desborde horizontal`,
          !desb,
          `contenido=${m.data.scrollWidth} device=${vp.width} innerWidth=${m.data.innerWidth}`,
        );
        check(
          `${vp.name} · vista ${vista.name} · sin targets táctiles < 44 px`,
          m.data.smallTargetCount,
          0,
        );
        check(
          `${vp.name} · vista ${vista.name} · sin taps muertos`,
          m.taps.deadTaps.length,
          0,
        );
      }
    }

    /* ── 2 · LOS MODALES en landscape: ¿entran? ¿se tocan? ────────────── */
    const vp = LANDSCAPE[1]; // 844x390
    section(`2 · modales en ${vp.name}`);
    await applyViewport(ui, vp, { touch: true });

    for (const modal of MODALES) {
      await openRoute(ui, modal.path);
      await verifyViewport(ui, vp, { touch: true });
      const reintentos = await abrirModal(ui, modal.trigger, modal.panel);
      if (reintentos > 0) {
        console.log(`  · ${modal.name}: la apertura necesitó ${reintentos} reintento(s) (ventana sorda)`);
      }
      const m = await medir(ui, vp, { scope: modal.panel });
      const panel = await ui.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(modal.panel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height, w: r.width };
      })()`);
      const pie = modal.pie
        ? await ui.evalJs(`(() => {
            const el = document.querySelector(${JSON.stringify(modal.pie)});
            if (!el) return null;
            const foot = el.closest(".sticky") ?? el.parentElement;
            const r = foot.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, h: r.height };
          })()`)
        : null;
      console.log(
        `  · ${modal.name.padEnd(13)} panel h=${panel ? Math.round(panel.h) : "?"} ` +
          `(viewport ${vp.height}) | pie=${pie ? `${Math.round(pie.top)}..${Math.round(pie.bottom)}` : "—"} | ` +
          `chicos=${m.data.smallTargetCount} | taps muertos=${m.taps.deadTaps.length} | ` +
          `avisos=${m.taps.avisos.length} | desborde panel=${desborde(m.data, vp, { scope: true })}`,
      );
      check(
        `${vp.name} · modal ${modal.name} · sin targets táctiles < 44 px`,
        m.data.smallTargetCount,
        0,
      );
      check(
        `${vp.name} · modal ${modal.name} · sin taps muertos`,
        m.taps.deadTaps.length,
        0,
      );
      checkTrue(
        `${vp.name} · modal ${modal.name} · el panel no se sale de la pantalla por arriba`,
        !panel || panel.top >= -1,
        `panel.top=${panel ? Math.round(panel.top) : "?"}`,
      );
      checkTrue(
        `${vp.name} · modal ${modal.name} · el panel entra en la ventana (o scrollea adentro)`,
        !panel || panel.bottom <= vp.height + 1 || panel.h <= vp.height + 1,
        `panel.bottom=${panel ? Math.round(panel.bottom) : "?"} viewport=${vp.height}`,
      );
    }

    /* ── 3 · TAPS REALES sobre los campos del modal de gasto ───────────── */
    section(`3 · taps REALES sobre los campos del modal de gasto en ${vp.name}`);
    await openRoute(ui, "/");
    await verifyViewport(ui, vp, { touch: true });
    await abrirModal(ui, "#btn-expense", '[role="dialog"]');

    for (const campo of CAMPOS_TX) {
      // Se trae al centro y se mide el punto de toque REAL.
      const info = await ui.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(campo)});
        if (!el) return { existe: false };
        el.scrollIntoView({ block: "center" });
        return { existe: true };
      })()`);
      if (!info.existe) {
        checkTrue(`${vp.name} · el campo ${campo} existe en el modal de gasto`, false);
        continue;
      }
      await new Promise((r) => setTimeout(r, 250));
      const g = await geometria(ui, campo, "#tx-submit");
      checkTrue(
        `${vp.name} · ${campo} · el punto de toque llega al campo`,
        g.llega,
        `hit=${g.hit} en (${Math.round(g.x)},${Math.round(g.y)})`,
      );
      checkTrue(
        `${vp.name} · ${campo} · el campo no queda debajo de la banda del pie`,
        !g.bajoLaBanda,
        `banda=${g.bandaTop}..${g.bandaBottom} · y=${Math.round(g.y)}`,
      );
    }

    // Y un tap de verdad: el foco tiene que caer en el campo.
    await ui.evalJs(`document.querySelector("#tx-description").scrollIntoView({ block: "center" })`);
    await new Promise((r) => setTimeout(r, 250));
    const rect = await ui.centerOf("#tx-description");
    await ui.clickAt(rect.x, rect.y);
    await new Promise((r) => setTimeout(r, 300));
    const foco = await ui.evalJs(`(() => {
      const el = document.activeElement;
      return { id: el ? el.id : null, tag: el ? el.tagName : null };
    })()`);
    checkTrue(
      `${vp.name} · un toque real en «Descripción» pone el foco en el campo`,
      foco.id === "tx-description" || foco.tag === "TEXTAREA" || foco.tag === "INPUT",
      `activeElement=${foco.id ?? foco.tag}`,
    );
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "03-landscape" });
