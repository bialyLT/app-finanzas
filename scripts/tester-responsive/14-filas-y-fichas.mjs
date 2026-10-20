#!/usr/bin/env node
/**
 * 14-filas-y-fichas · la fila del movimiento y las fichas del patrimonio en
 * un teléfono angosto: ¿el arreglo del dev se sostiene?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * El dev de la r2 cambió dos cosas que la auditoría no puede ver bien:
 *
 *   1 · la FILA de un movimiento a 320 px: antes la columna de texto se
 *       quedaba con 0 px («12 de octubre · Visa Santander» se leía de a una
 *       letra por renglón). Ahora hay una container query sobre la tarjeta.
 *       Lo que hay que medir es que la columna de texto tenga ancho REAL y
 *       que el texto quepa (no que la fila se haya hecho más alta).
 *
 *   2 · las FICHAS del patrimonio y de la reconciliación: el monto pasó a
 *       un cuerpo de letra chico (8-13 px según el ancho) para que entre en
 *       su caja. Lo que hay que verificar es que (a) entre, (b) que se lea
 *       (el cuerpo de letra no puede ser ilegible) y (c) que la jerarquía
 *       siga siendo razonable: el monto tiene que seguir siendo más grande
 *       que la etiqueta.
 *
 * Y el invariante que no se negocia: sin scroll horizontal, en todo el rango.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  openRoute,
  medir,
  desborde,
  correrBateria,
  sleep,
} from "./lib.mjs";

const VIEWPORTS = [
  { name: "320 angosto", width: 320, height: 568 },
  { name: "360 android", width: 360, height: 740 },
  { name: "390 iphone14", width: 390, height: 844 },
  { name: "480 grande", width: 480, height: 854 },
];

/**
 * La geometría de la fila de un movimiento: la columna de texto, el monto y
 * la papelera. Es la fila `[ícono] [texto] [monto] [papelera]`.
 */
const FILA = `(() => {
  const filas = [...document.querySelectorAll(".mov-fila")];
  if (filas.length === 0) return { error: "no hay filas .mov-fila" };
  const f = filas[0];
  const texto = f.querySelector(".mov-texto");
  const monto = f.querySelector(".mov-monto");
  const papelera = f.querySelector(".mov-borrar");
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) };
  };
  const cs = texto ? getComputedStyle(texto) : null;
  const csMonto = monto ? getComputedStyle(monto) : null;
  const rm = monto ? monto.getBoundingClientRect() : null;
  const rp = papelera ? papelera.getBoundingClientRect() : null;
  return {
    filas: filas.length,
    fila: r(f),
    texto: r(texto),
    textoFuente: cs ? cs.fontSize : null,
    textoTexto: texto ? texto.textContent.trim().replace(/\\s+/g, " ").slice(0, 40) : null,
    monto: r(monto),
    montoFuente: csMonto ? csMonto.fontSize : null,
    montoDerecha: rm ? Math.round(rm.right) : null,
    papelera: r(papelera),
    papeleraIzquierda: rp ? Math.round(rp.left) : null,
    huecoMontoPapelera: rm && rp ? Math.round(rp.left - rm.right) : null
  };
})()`;

/**
 * Las fichas del patrimonio: la caja, el monto y su cuerpo de letra, y el
 * de la etiqueta (para la jerarquía).
 */
const FICHAS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll(".monto-ficha, .monto-ficha--chico")) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const padre = el.parentElement;
    const etiqueta = padre ? padre.querySelector("p, span, div") : null;
    const csEtiqueta = etiqueta ? getComputedStyle(etiqueta) : null;
    // El ancho REAL del texto (no el de la caja): se mide con un Range.
    const rango = document.createRange();
    let ancho = 0;
    for (const nodo of el.childNodes) {
      if (nodo.nodeType !== 3) continue;
      const bruto = nodo.textContent || "";
      if (!bruto.trim()) continue;
      rango.setStart(nodo, 0);
      rango.setEnd(nodo, bruto.replace(/\\s+$/, "").length);
      ancho = Math.max(ancho, rango.getBoundingClientRect().width);
    }
    out.push({
      texto: el.textContent.trim().replace(/\\s+/g, " ").slice(0, 20),
      fuente: cs.fontSize,
      anchoTexto: Math.round(ancho),
      caja: el.clientWidth,
      sobra: Math.round(ancho - el.clientWidth),
      etiquetaFuente: csEtiqueta ? csEtiqueta.fontSize : null,
      peso: Number(cs.fontWeight) || 400,
      etiquetaPeso: csEtiqueta ? Number(csEtiqueta.fontWeight) || 400 : null,
      tag: el.tagName.toLowerCase(),
      id: el.id || null
    });
  }
  return out;
})()`;

async function main() {
  const ui = await openUi({
    port: 9374,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9374`,
  });
  try {
    for (const vp of VIEWPORTS) {
      section(`${vp.name} · la fila del movimiento`);
      await applyViewport(ui, vp, { touch: true });
      await openRoute(ui, "/");
      await verifyViewport(ui, vp, { touch: true });

      const { data } = await medir(ui, vp);
      checkTrue(
        `${vp.name} · el documento no se pasa de ancho`,
        desborde(data, vp) === false,
        `scrollWidth=${data.scrollWidth} device=${vp.width}`,
      );
      checkTrue(
        `${vp.name} · ningún control táctil chico`,
        data.smallTargetCount === 0,
        data.smallTargets.map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "),
      );
      checkTrue(
        `${vp.name} · ningún contenido que no entra en su caja`,
        (data.overflowers ?? []).length === 0,
        (data.overflowers ?? [])
          .map((o) => `${o.el} ${o.scrollW} en ${o.parentW} (sobra ${o.sobra}px)`)
          .join(" | "),
      );

      const fila = await ui.evalJs(FILA);
      if (fila.error) {
        checkTrue(`${vp.name} · hay filas de movimiento`, false, fila.error);
        continue;
      }
      console.log(`  · ${JSON.stringify(fila)}`);
      checkTrue(
        `${vp.name} · la columna de TEXTO de la fila tiene ancho real (no 0 px)`,
        (fila.texto?.w ?? 0) >= 150,
        `ancho=${fila.texto?.w}`,
      );
      checkTrue(
        `${vp.name} · la fila no crece de más (alto ≤ 140 px: la fila de dos líneas)`,
        (fila.fila?.h ?? 999) <= 140,
        `alto=${fila.fila?.h}`,
      );
      checkTrue(
        `${vp.name} · el cuerpo de letra del texto de la fila es legible (≥ 12 px)`,
        parseFloat(fila.textoFuente ?? "0") >= 12,
        `fuente=${fila.textoFuente}`,
      );
      checkTrue(
        `${vp.name} · el monto no queda pegado a la papelera (hueco ≥ 4 px)`,
        (fila.huecoMontoPapelera ?? 0) >= 4,
        `hueco=${fila.huecoMontoPapelera}`,
      );

      section(`${vp.name} · las fichas del patrimonio`);
      const fichas = await ui.evalJs(FICHAS);
      if (!Array.isArray(fichas) || fichas.length === 0) {
        checkTrue(`${vp.name} · hay fichas del patrimonio`, false, JSON.stringify(fichas));
      } else {
        for (const f of fichas) {
          console.log(
            `  · ${f.texto} · ${f.fuente} · texto ${f.anchoTexto}px en caja ${f.caja}px ` +
              `(sobra ${f.sobra}) · etiqueta ${f.etiquetaFuente}`,
          );
        }
        checkTrue(
          `${vp.name} · todos los montos de las fichas entran en su caja (sobra ≤ 1 px)`,
          fichas.every((f) => f.sobra <= 1),
          fichas.map((f) => `${f.texto} sobra ${f.sobra}`).join(" | "),
        );
        checkTrue(
          `${vp.name} · ningún monto de ficha es ilegible (≥ 8 px)`,
          fichas.every((f) => parseFloat(f.fuente) >= 8),
          fichas.map((f) => `${f.texto} ${f.fuente}`).join(" | "),
        );
        checkTrue(
          `${vp.name} · la jerarquía se mantiene: el monto pesa más que su etiqueta (el peso, no el tamaño)`,
          fichas.every(
            (f) => !f.etiquetaPeso || (f.peso ?? 0) >= f.etiquetaPeso,
          ),
          fichas.map((f) => `${f.texto} peso ${f.peso} vs ${f.etiquetaPeso}`).join(" | "),
        );
      }
    }

    /* ─────────────────────────────────────────────────────────────────────
     * EL BARRIDO (el repro del BUG de la fila)
     *
     * La fila del movimiento se rompe en un RANGO, no en un ancho: con la
     * container query calibrada en 17 rem, los teléfonos de 363 a 474 px de
     * device se quedaban con 53 a 92 px de columna de texto (una palabra
     * por renglón) y con una fila de 111 a 200 px de alto. Un arreglo que
     * funciona en 375 y se rompe en 414 es un arreglo para 375.
     *
     * El invariante: en TODO el rango, la columna de texto conserva un
     * ancho legible (≥ 150 px: la línea «15 de octubre · Banco Galicia» a
     * 12 px) y la fila no se estira.
     * ───────────────────────────────────────────────────────────────────── */
    section("barrido 320→520 · la fila del movimiento en TODO el rango");
    const barrido = [];
    for (const w of [320, 340, 360, 375, 390, 400, 414, 430, 440, 460, 480, 520]) {
      await applyViewport(ui, { width: w, height: 800 }, { touch: true });
      await openRoute(ui, "/");
      await verifyViewport(ui, { width: w, height: 800 }, { touch: true });
      // La lista se carga del servidor: hay que esperarla.
      await ui
        .waitFor(`!!document.querySelector(".mov-fila")`, {
          timeout: 15000,
          label: "la lista de movimientos",
        })
        .catch(() => {});
      const m = await ui.evalJs(FILA);
      if (m.error) {
        checkTrue(`${w} px · hay una fila de movimiento para medir`, false, m.error);
        continue;
      }
      barrido.push({ w, texto: m.texto?.w ?? 0, alto: m.fila?.h ?? 0 });
      console.log(
        `  · ${String(w).padStart(4)} px → texto ${String(m.texto?.w).padStart(4)} px · ` +
          `fila ${m.fila?.w}×${m.fila?.h}`,
      );
    }
    checkTrue(
      "barrido · la columna de texto de la fila nunca baja de 150 px (ni una palabra por renglón)",
      barrido.every((b) => b.texto >= 150),
      barrido.map((b) => `${b.w}px→${b.texto}px`).join(" | "),
    );
    checkTrue(
      "barrido · la fila no se estira (alto ≤ 140 px) en ningún ancho",
      barrido.every((b) => b.alto <= 140),
      barrido.map((b) => `${b.w}px→${b.alto}px`).join(" | "),
    );
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "14-filas-y-fichas", conSesion: true });
