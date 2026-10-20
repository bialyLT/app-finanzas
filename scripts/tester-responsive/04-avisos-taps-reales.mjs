#!/usr/bin/env node
/**
 * 04-avisos-taps-reales · los 8 controles que quedan bajo el pie pegajoso:
 * ¿son AVISOS o TAPS MUERTOS?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA PREGUNTA
 * La auditoría del dev reporta 8 «avisos»: controles que, EN REPOSO, quedan
 * debajo de la banda del pie pegajoso del modal. El dev los llamó avisos
 * («se alcanzan scrolleando») y no fallas. Eso hay que VERLO, no creerlo: un
 * tap bajo la banda «completa sin error» y se pierde el dato en silencio (la
 * clase de la ronda 7 r1).
 *
 * El método NO es mirar si el elemento se ve: es TOCARLO.
 *   1. se mide dónde cae el punto de toque del control frente a la banda del
 *      pie, en reposo;
 *   2. se hace un TAP REAL (evento de mouse de verdad, no un click de JS) en
 *      la parte visible del control;
 *   3. se mira QUIÉN recibió el clic: un capturador en `document` (fase de
 *      captura) anota el objetivo de cada clic. Si el objetivo no es el
 *      control, el tap se lo comió el pie;
 *   4. y para los campos: el FOCO tiene que caer en el campo, y el texto
 *      tipeado tiene que llegar.
 *
 * Un control que se alcanza scrolleando es un AVISO (el producto lo banca: el
 * pie pegajoso es una decisión consciente). Un control que NO se alcanza ni
 * scrolleando es un TAP MUERTO y se reporta como bug.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  openRoute,
  abrirModal,
  geometria,
  correrBateria,
} from "./lib.mjs";

const VP = { name: "375 iphone-se", width: 375, height: 667 };

/** Capturador de clics: anota quién recibió cada clic, en la fase de captura. */
const CAPTURADOR = `(() => {
  if (window.__t9clicks) return "ya";
  window.__t9clicks = [];
  document.addEventListener("click", (e) => {
    const t = e.target;
    window.__t9clicks.push({
      id: t && t.id ? t.id : null,
      tag: t ? t.tagName.toLowerCase() : null,
      texto: t && t.textContent ? t.textContent.trim().slice(0, 24) : "",
      x: Math.round(e.clientX), y: Math.round(e.clientY)
    });
  }, true);
  return "ok";
})()`;

/**
 * Los 8 avisos que reporta la auditoría, con el modal al que pertenecen y
 * cómo se comprueba que el tap LLEGÓ.
 */
const AVISOS = [
  {
    modal: "gasto",
    path: "/",
    trigger: "#btn-expense",
    pie: "#tx-submit",
    control: "#tx-description",
    tipo: "campo",
  },
  {
    modal: "ingreso",
    path: "/",
    trigger: "#btn-income",
    pie: "#tx-submit",
    control: "#tx-description",
    tipo: "campo",
  },
  {
    modal: "transferencia",
    path: "/",
    trigger: "#btn-transfer",
    pie: "#tx-submit",
    control: "#tx-date-hoy",
    tipo: "boton",
    /** El botón «Hoy» tiene que poner la fecha de hoy en el campo. */
    efecto: `(() => {
      const campo = document.getElementById("tx-date");
      const hoy = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const esperado = hoy.getFullYear() + "-" + p(hoy.getMonth() + 1) + "-" + p(hoy.getDate());
      return { valor: campo ? campo.value : null, esperado };
    })()`,
  },
  {
    modal: "transferencia",
    path: "/",
    trigger: "#btn-transfer",
    pie: "#tx-submit",
    control: "#tx-date-ayer",
    tipo: "boton",
  },
  {
    modal: "prestamo",
    path: "/prestamos",
    trigger: "#loans-new",
    pie: "#loanalta-submit",
    control: "#loanalta-system-FRENCH",
    tipo: "boton",
  },
  {
    modal: "prestamo",
    path: "/prestamos",
    trigger: "#loans-new",
    pie: "#loanalta-submit",
    control: "#loanalta-system-GERMAN",
    tipo: "boton",
  },
  {
    modal: "recurrencia",
    path: "/recurrencia",
    trigger: "#rec-add-rule",
    pie: "#rec-form-submit",
    control: "#rec-freq-DAILY",
    tipo: "boton",
  },
  {
    modal: "recurrencia",
    path: "/recurrencia",
    trigger: "#rec-add-rule",
    pie: "#rec-form-submit",
    control: "#rec-freq-WEEKLY",
    tipo: "boton",
  },
];

async function main() {
  const ui = await openUi({
    port: 9356,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9356`,
  });
  try {
    for (const aviso of AVISOS) {
      section(`${aviso.modal} · ${aviso.control}`);
      await applyViewport(ui, VP, { touch: true });
      await openRoute(ui, aviso.path);
      await verifyViewport(ui, VP, { touch: true });
      await abrirModal(ui, aviso.trigger, aviso.pie ? '[role="dialog"], #rec-form' : '[role="dialog"], #rec-form');
      await ui.evalJs(CAPTURADOR);

      // 1 · en reposo: ¿el punto de toque cae bajo la banda del pie?
      const gReposo = await geometria(ui, aviso.control, aviso.pie);
      checkTrue(
        `${aviso.modal} · ${aviso.control} · el control existe`,
        gReposo.existe === true,
      );
      console.log(
        `  · en reposo: control(${Math.round(gReposo.x)},${Math.round(gReposo.y)}) ` +
          `banda=${gReposo.bandaTop}..${gReposo.bandaBottom} ` +
          `bajoLaBanda=${gReposo.bajoLaBanda} hit=${gReposo.hit}`,
      );
      checkTrue(
        `${aviso.modal} · ${aviso.control} · en reposo el tap cae bajo la banda del pie (es un aviso)`,
        gReposo.bajoLaBanda === true,
        `banda=${gReposo.bandaTop}..${gReposo.bandaBottom} y=${Math.round(gReposo.y)}`,
      );
      checkTrue(
        `${aviso.modal} · ${aviso.control} · en reposo el tap NO llega al control`,
        gReposo.llega === false,
        `hit=${gReposo.hit}`,
      );

      // 2 · TAP REAL en la posición de reposo: ¿a quién llega?
      await ui.evalJs(`window.__t9clicks = []`);
      await ui.clickAt(gReposo.x, gReposo.y);
      await new Promise((r) => setTimeout(r, 400));
      const clicEnReposo = await ui.evalJs(`window.__t9clicks.slice(-1)[0] ?? null`);
      console.log(`  · tap real en reposo → recibió: ${JSON.stringify(clicEnReposo)}`);
      checkTrue(
        `${aviso.modal} · ${aviso.control} · el tap en reposo lo recibe el pie (no el control)`,
        !clicEnReposo || clicEnReposo.id !== aviso.control.replace("#", ""),
        `recibió ${JSON.stringify(clicEnReposo)}`,
      );

      // 2b · el pie tiene algo DISPARATIVO debajo? Un tap en la zona muerta
      // que cae en «Cancelar» descarta el formulario y lo que se había
      // cargado: eso ya no es un aviso, es una trampa.
      const sigueAbierto = await ui.evalJs(
        `!!document.querySelector(${JSON.stringify(aviso.pie ?? "body")})`,
      );
      if (!sigueAbierto) {
        console.log(
          `  · el tap en reposo CERRÓ el formulario: el pie tenía «${clicEnReposo?.id}» debajo`,
        );
        checkTrue(
          `${aviso.modal} · ${aviso.control} · el tap en la zona muerta NO cierra el formulario`,
          false,
          `el pie tenía «${clicEnReposo?.id}» (${clicEnReposo?.texto}) debajo del control`,
        );
        // Se reabre para seguir midiendo.
        await abrirModal(ui, aviso.trigger, '[role="dialog"], #rec-form');
        await ui.evalJs(CAPTURADOR);
      } else {
        checkTrue(
          `${aviso.modal} · ${aviso.control} · el tap en la zona muerta no cierra el formulario`,
          true,
        );
      }

      // 3 · scrolleando: el control tiene que quedar a la vista y recibir el tap.
      await ui.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(aviso.control)});
        if (el) el.scrollIntoView({ block: "center", inline: "nearest" });
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const gScrolleado = await geometria(ui, aviso.control, aviso.pie);
      console.log(
        `  · scrolleado: control(${Math.round(gScrolleado.x)},${Math.round(gScrolleado.y)}) ` +
          `hit=${gScrolleado.hit} llega=${gScrolleado.llega}`,
      );
      checkTrue(
        `${aviso.modal} · ${aviso.control} · scrolleando, el punto de toque llega al control`,
        gScrolleado.llega === true,
        `hit=${gScrolleado.hit}`,
      );
      checkTrue(
        `${aviso.modal} · ${aviso.control} · scrolleando, el control queda FUERA de la banda del pie`,
        gScrolleado.bajoLaBanda === false,
        `banda=${gScrolleado.bandaTop}..${gScrolleado.bandaBottom} y=${Math.round(gScrolleado.y)}`,
      );

      await ui.evalJs(`window.__t9clicks = []`);
      await ui.clickAt(gScrolleado.x, gScrolleado.y);
      await new Promise((r) => setTimeout(r, 400));
      const clicScrolleado = await ui.evalJs(`window.__t9clicks.slice(-1)[0] ?? null`);
      console.log(`  · tap real scrolleado → recibió: ${JSON.stringify(clicScrolleado)}`);
      checkTrue(
        `${aviso.modal} · ${aviso.control} · el tap scrolleado lo recibe el CONTROL`,
        Boolean(clicScrolleado) && clicScrolleado.id === aviso.control.replace("#", ""),
        `recibió ${JSON.stringify(clicScrolleado)}`,
      );

      // 4 · para los campos: el foco tiene que caer en el campo y el texto llegar.
      if (aviso.tipo === "campo") {
        const foco = await ui.evalJs(`(() => {
          const el = document.activeElement;
          return { id: el ? el.id : null, tag: el ? el.tagName.toLowerCase() : null };
        })()`);
        checkTrue(
          `${aviso.modal} · ${aviso.control} · el foco cae en el campo`,
          foco.id === aviso.control.replace("#", ""),
          `activeElement=${foco.id ?? foco.tag}`,
        );
        await ui.insertText("prueba de dedo");
        const valor = await ui.evalJs(
          `document.querySelector(${JSON.stringify(aviso.control)}).value`,
        );
        checkTrue(
          `${aviso.modal} · ${aviso.control} · el texto tipeado llega al campo (el dato NO se pierde)`,
          String(valor).includes("prueba de dedo"),
          `valor="${valor}"`,
        );
      } else if (aviso.efecto) {
        const efecto = await ui.evalJs(aviso.efecto);
        checkTrue(
          `${aviso.modal} · ${aviso.control} · el botón hace su efecto`,
          Boolean(efecto && efecto.valor === efecto.esperado),
          JSON.stringify(efecto),
        );
      }
    }
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "04-avisos-taps-reales", conSesion: true });
