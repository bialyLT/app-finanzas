#!/usr/bin/env node
/**
 * 06-corte-940 · el corte de las cuatro tarjetas: 939, 940 y 941.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE DECLARA EL DEV
 * «El corte de 940 px: entre 768 y 939 hay dos columnas de tarjetas y a 940
 * hay cuatro. Probalo en 939 y 941 y mirá que no haya ni un px de scroll.»
 *
 * El corte existe por una razón medible: el monto («+$ 310.000,00») es UNA
 * palabra —no tiene dónde partirse— y con cuatro tarjetas, tres huecos y los
 * 32 px de padding hacen falta 940 px para que entre.
 *
 * Esta batería mide los tres anchos que rodean el corte y afirma las DOS
 * cosas:
 *   · la cantidad de columnas es la que corresponde (2 antes, 4 desde 940);
 *   · no hay ni un px de scroll horizontal en ninguno de los tres.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { openUi, applyViewport, verifyViewport, openRoute, correrBateria } from "./lib.mjs";

const ANCHOS = [
  { width: 768, columnas: 2 },
  { width: 939, columnas: 2 },
  { width: 940, columnas: 4 },
  { width: 941, columnas: 4 },
  { width: 1024, columnas: 4 },
];

/** La grilla de las cuatro tarjetas del panel. */
const GRILLA = `(() => {
  const grilla = document.querySelector(".grid.grid-cols-1");
  if (!grilla) return { error: "no se encontró la grilla" };
  const cs = getComputedStyle(grilla);
  const columnas = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
  const montos = [...grilla.querySelectorAll("p.monto-tarjeta")].map((p) => {
    const r = p.getBoundingClientRect();
    const caja = p.parentElement.getBoundingClientRect();
    return {
      texto: (p.textContent || "").trim(),
      fuente: getComputedStyle(p).fontSize,
      ancho: p.clientWidth,
      contenido: p.scrollWidth,
      sobra: p.scrollWidth - p.clientWidth,
      fuera: Math.round(r.right - caja.right)
    };
  });
  return {
    documento: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    columnas,
    montos
  };
})()`;

async function main() {
  const ui = await openUi({
    port: 9358,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9358`,
  });
  try {
    for (const vp of ANCHOS) {
      section(`${vp.width} px · ${vp.columnas} columnas esperadas`);
      const emulado = { name: `${vp.width}px`, width: vp.width, height: 800 };
      await applyViewport(ui, emulado, { touch: true });
      await openRoute(ui, "/");
      await verifyViewport(ui, emulado, { touch: true });
      const m = await ui.evalJs(GRILLA);
      checkTrue(`${vp.width}px · se encontró la grilla de las tarjetas`, !m.error, m.error ?? "");
      check(`${vp.width}px · la grilla tiene ${vp.columnas} columnas`, m.columnas, vp.columnas);
      check(
        `${vp.width}px · el documento no se pasa del device`,
        m.documento <= vp.width + 1,
        true,
      );
      checkTrue(
        `${vp.width}px · ni un px de scroll horizontal`,
        m.documento === vp.width,
        `documento=${m.documento} innerWidth=${m.innerWidth}`,
      );
      for (const monto of m.montos) {
        check(
          `${vp.width}px · el monto «${monto.texto}» entra en su caja`,
          monto.sobra,
          0,
        );
      }
      console.log(
        `  · ${vp.width}px · columnas=${m.columnas} documento=${m.documento} ` +
          `montos=${m.montos.map((x) => `${x.fuente}/${x.ancho}px`).join(" ")}`,
      );
    }
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "06-corte-940", conSesion: true });
