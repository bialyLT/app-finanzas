#!/usr/bin/env node
/**
 * measure.mjs — la medición de la auditoría de responsive.
 *
 * Este archivo NO abre Chrome ni navega: arma la expresión JavaScript que se
 * corre dentro de la página (vía CDP) y devuelve los números. Está aparte del
 * runner para que cualquier otra sonda pueda reutilizar LA MISMA definición de
 * «desborde» y de «target táctil chico»: si la medición viviera duplicada,
 * dos auditorías podrían discrepar y nadie sabría cuál miente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES COSAS QUE MIDE
 *
 * 1. DESBORDE HORIZONTAL
 *    El CONTENIDO (documentElement.scrollWidth) no puede superar el ancho del
 *    DEVICE. Ojo: `innerWidth` no sirve para esto, porque cuando el contenido
 *    no puede achicarse Chrome EXPANDE el viewport de layout y `innerWidth`
 *    miente (medido: 375 -> 664 en el inicio). El ancho del device es la
 *    verdad, y el desborde real se ve en `scrollWidth`.
 *
 * 2. TARGETS TÁCTILES CHICOS
 *    Todo elemento interactivo (button, a, input, select, textarea,
 *    role=button) con alto o ancho menor a 44 px. En un teléfono, 36 px de
 *    alto es un blunder de dedo.
 *
 * 3. TAPS MUERTOS
 *    Un control puede estar «visible» y aun así no recibir el toque: si una
 *    capa fija (el pie pegajoso del modal, un toast) queda por encima, el
 *    punto de toque aterriza en la capa y el control nunca se entera. Se
 *    mide con `elementFromPoint` en el centro de la parte VISIBLE del
 *    control: si el elemento que recibe el toque no es el control (ni un
 *    descendiente suyo), el tap está tapado.
 *
 *    IMPORTANTE — la parte visible es la que importa: un control que quedó
 *    arriba, fuera del recorte del contenedor con scroll, NO está tapado
 *    (no se ve, no se toca: no es un tap muerto). Por eso el recorte se
 *    calcula contra los ancestros con `overflow` y no contra el viewport
 *    solamente. Y el runner decide si un tap es muerto mirando TODAS las
 *    posiciones de scroll: un control tapado en una posición pero
 *    alcanzable en otra no es un tap muerto (el usuario scrollea).
 */

/** Etiqueta legible de un elemento (tag + id + clases + texto). */
const LABEL_FN = `
  const label = (el) => {
    if (!el || !el.tagName) return "(nada)";
    const id = el.id ? "#" + el.id : "";
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\\s+/).slice(0, 4).join(".")
      : "";
    const txt = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 32);
    return el.tagName.toLowerCase() + id + cls + (txt ? " [" + txt + "]" : "");
  };
`;

/**
 * Expresión JS para `Runtime.evaluate`.
 *
 * @param {object} options
 * @param {number} options.deviceWidth  ancho del device emulado (la verdad)
 * @param {string|null} options.scopeSelector  mide sólo este subtree (el
 *        panel de un modal). `null` mide el documento entero.
 * @param {number} options.minTarget  mínimo táctil en px (44)
 */
export function measureExpression({
  deviceWidth,
  scopeSelector = null,
  minTarget = 44,
  sliver = 8,
  maxOverflow = 1,
}) {
  return `(() => {
  const VW = ${Number(deviceWidth)};
  const MIN = ${Number(minTarget)};
  const SLIVER = ${Number(sliver)};
  const UMBRAL = ${Number(maxOverflow)};
  const SCOPE = ${scopeSelector === null ? "null" : JSON.stringify(scopeSelector)};
  const root = SCOPE ? document.querySelector(SCOPE) : document.documentElement;
  if (SCOPE && !root) return { error: "no se encontro el panel: " + SCOPE };
  ${LABEL_FN}
  const out = {
    vw: VW,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body ? document.body.scrollWidth : 0,
    scopeScrollWidth: root.scrollWidth,
    scopeClientWidth: root.clientWidth,
    culprits: [],
    smallTargets: [],
    taps: [],
    innerScroll: [],
    overflowers: [],
    fixed: []
  };

  const limit = SCOPE ? root.clientWidth : VW;

  const inScroller = (el) => {
    let p = el.parentElement;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      p = p.parentElement;
    }
    return false;
  };
  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    return (
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      role === "button" ||
      role === "combobox" ||
      role === "listbox"
    );
  };

  const isExemptHit = (el, hit) => {
    if (hit === el || el.contains(hit)) return true;
    if (hit.tagName.toLowerCase() === "label" && hit.contains(el)) return true;
    // El hit es un ANCESTRO del control (contenedor del pie, div que envuelve
    // al botón) y no es un overlay fijo: el usuario toca el control que está
    // DENTRO de ese contenedor. No es tap muerto.
    if (hit.contains(el) && getComputedStyle(hit).position !== "fixed" && getComputedStyle(hit).position !== "sticky") return true;
    if (
      (el.closest('[data-slot="select-trigger"]') || el.closest('[data-slot="select"]')) &&
      (hit.closest('label') || hit.closest('[data-slot="select-content"]') || hit.closest('[data-slot="select-trigger"]'))
    ) return true;
    return false;
  };

  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
      p = p.parentElement;
    }
    top = Math.max(top, 0);
    bottom = Math.min(bottom, window.innerHeight);
    left = Math.max(left, 0);
    right = Math.min(right, window.innerWidth);
    const empty = bottom - top < SLIVER || right - left < SLIVER;
    return { top, bottom, left, right, empty };
  };

  const vh = window.innerHeight;
  const iw = window.innerWidth;

  for (const el of root.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);

    if (cs.position === "fixed" || cs.position === "sticky") {
      out.fixed.push({
        el: label(el),
        pos: cs.position,
        z: cs.zIndex,
        h: Math.round(r.height),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom)
      });
    }

    const selfWide = r.width > limit + 1;
    const contentWide = el.scrollWidth > limit + 1 &&
      cs.overflowX !== "auto" && cs.overflowX !== "scroll";
    if ((selfWide || contentWide) && !inScroller(el)) {
      out.culprits.push({
        el: label(el),
        parent: el.parentElement ? label(el.parentElement) : "",
        w: Math.round(r.width),
        scrollW: el.scrollWidth,
        minW: cs.minWidth,
        display: cs.display,
        gridCols: cs.gridTemplateColumns ? cs.gridTemplateColumns.slice(0, 60) : ""
      });
    }

    const parent = el.parentElement;
    const cs2 = cs;
    const textoPropio = (() => {
      let ancho = 0;
      const rango = document.createRange();
      for (const nodo of el.childNodes) {
        if (nodo.nodeType !== 3) continue;
        const bruto = nodo.textContent || "";
        if (bruto.trim() === "") continue;
        const largo = bruto.replace(/\\s+$/, "").length;
        if (largo === 0) continue;
        rango.setStart(nodo, 0);
        rango.setEnd(nodo, largo);
        const r = rango.getBoundingClientRect();
        if (r.width > ancho) ancho = r.width;
      }
      return ancho;
    })();
    if (
      parent &&
      !(el instanceof SVGElement) &&
      cs2.overflowX === "visible" &&
      cs2.textOverflow !== "ellipsis" &&
      el.clientWidth > 0 &&
      textoPropio > 0
    ) {
      const caja = el.clientWidth;
      if (textoPropio > caja + UMBRAL) {
        out.overflowers.push({
          el: label(el),
          parent: label(parent),
          scrollW: Math.round(textoPropio),
          parentW: Math.round(caja),
          sobra: Math.round(textoPropio - caja),
          text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40)
        });
      }
    }

    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") &&
        el.scrollWidth > el.clientWidth + 1) {
      out.innerScroll.push({
        el: label(el),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth
      });
    }

    if (!isInteractive(el)) continue;

    const small = r.width > 0 && r.height > 0 && (r.height < MIN || r.width < MIN);
    if (small) {
      out.smallTargets.push({
        el: label(el),
        w: Math.round(r.width),
        h: Math.round(r.height),
        why: r.height < MIN && r.width < MIN ? "alto+ancho" : (r.height < MIN ? "alto" : "ancho")
      });
    }

    const vis = visibleRect(el);
    if (vis.empty) {
      out.taps.push({ el: label(el), status: "fuera" });
      continue;
    }
    const x = (vis.left + vis.right) / 2;
    const y = (vis.top + vis.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) {
      out.taps.push({ el: label(el), status: "fuera" });
      continue;
    }
    if (isExemptHit(el, hit)) {
      out.taps.push({ el: label(el), status: "ok" });
      continue;
    }
    out.taps.push({
      el: label(el),
      status: "blocked",
      blockedBy: label(hit),
      x: Math.round(x),
      y: Math.round(y)
    });
  }

  out.culpritCount = out.culprits.length;
  out.smallTargetCount = out.smallTargets.length;
  out.culprits.sort((a, b) => Math.max(b.w, b.scrollW) - Math.max(a.w, a.scrollW));
  out.culprits = out.culprits.slice(0, 10);
  out.smallTargets = out.smallTargets.slice(0, 25);
  out.overflowers.sort((a, b) => b.sobra - a.sobra);
  out.overflowers = out.overflowers.slice(0, 20);
  out.taps = out.taps.slice(0, 60);
  return out;
})()`;
}

/**
 * Expresión JS que devuelve cuánto se puede scrollear, para saber si hay
 * posiciones intermedias que medir. Se mira el panel (si scrollea) y el
 * documento: un formulario en línea no scrollea solo, pero la página sí, y
 * el pie pegajoso se pega al borde de la ventana.
 */
export function scrollerExpression(scopeSelector) {
  return `(() => {
  const panel = document.querySelector(${JSON.stringify(scopeSelector)});
  let panelMax = 0;
  if (panel) {
    let el = panel;
    while (el) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 1) {
        panelMax = el.scrollHeight - el.clientHeight;
        break;
      }
      el = el.parentElement;
    }
  }
  const doc = document.scrollingElement || document.documentElement;
  const docMax = doc ? Math.max(0, doc.scrollHeight - doc.clientHeight) : 0;
  return { panelMax, docMax, max: Math.max(panelMax, docMax) };
})()`;
}

/**
 * Expresión JS: los TAP MUERTOS de verdad.
 *
 * Un control tapado en la posición actual no es necesariamente un tap muerto:
 * si lo que lo tapa es el pie pegajoso del modal, el usuario lo alcanza
 * scrolleando. Por eso, para cada control tapado, la prueba definitive es
 * otra: se lo trae al centro de la pantalla (`scrollIntoView`) y se vuelve a
 * medir el punto de toque.
 *
 *   · Si después de traerlo al centro el toque llega al control → NO es un
 *     tap muerto (era cuestión de dónde estaba la página).
 *   · Si el toque sigue cayendo en otra capa → ES un tap muerto: esa capa no
 *     se mueve (un overlay, un toast, un backdrop) y el control es
 *     inalcanzable.
 */
export function deadTapsExpression({ scopeSelector = null, sliver = 8 }) {
  return `(() => {
  const SLIVER = ${Number(sliver)};
  const SCOPE = ${scopeSelector === null ? "null" : JSON.stringify(scopeSelector)};
  const root = SCOPE ? document.querySelector(SCOPE) : document.documentElement;
  if (SCOPE && !root) return { error: "no se encontro el panel: " + SCOPE };
  ${LABEL_FN}
  const out = { deadTaps: [], tapados: 0, avisos: [] };

  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    return (
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      role === "button" ||
      role === "combobox" ||
      role === "listbox"
    );
  };

  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
      p = p.parentElement;
    }
    top = Math.max(top, 0);
    bottom = Math.min(bottom, window.innerHeight);
    left = Math.max(left, 0);
    right = Math.min(right, window.innerWidth);
    return { top, bottom, left, right, empty: bottom - top < SLIVER || right - left < SLIVER };
  };

  const hitTest = (el, vis) => {
    const x = (vis.left + vis.right) / 2;
    const y = (vis.top + vis.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (hit === el || el.contains(hit)) return "ok";
    if (hit.tagName.toLowerCase() === "label" && hit.contains(el)) return "ok";
    // El elemento que recibe el toque es un ANCESTRO del control (el
    // contenedor del pie, el div que envuelve al botón) y no es un overlay
    // fijo: el usuario toca el control que está DENTRO de ese contenedor.
    // No es un tap muerto.
    if (hit.contains(el) && getComputedStyle(hit).position !== "fixed" && getComputedStyle(hit).position !== "sticky") return "ok";
    // Exención de controles de formulario: el trigger de un Select Radix
    // está pegado al Label (que lo precede o lo sigue en el DOM) y el
    // punto de toque cae en ese label. El Label no lo tapa: es un
    // contiguo en el flujo.
    if (
      (el.closest('[data-slot="select-trigger"]') || el.closest('[data-slot="select"]')) &&
      (hit.closest('label') || hit.closest('[data-slot="select-content"]') || hit.closest('[data-slot="select-trigger"]'))
    ) return "ok";
    return hit;
  };

  for (const el of root.querySelectorAll("*")) {
    if (!isInteractive(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    const vis = visibleRect(el);
    if (vis.empty) continue;
    const hit = hitTest(el, vis);
    if (hit === null || hit === "ok") continue;

    out.tapados += 1;
    const blocker = label(hit);

    // La prueba definitiva: traerlo al centro y volver a medir.
    const saved = [];
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        saved.push([p, p.scrollTop]);
      }
      p = p.parentElement;
    }
    const doc = document.scrollingElement || document.documentElement;
    const savedDoc = doc ? doc.scrollTop : 0;

    el.scrollIntoView({ block: "center", inline: "nearest" });
    const vis2 = visibleRect(el);
    const hit2 = vis2.empty ? null : hitTest(el, vis2);

    for (const [node, top] of saved) node.scrollTop = top;
    if (doc) doc.scrollTop = savedDoc;

    if (hit2 !== "ok" && hit2 !== null) {
      out.deadTaps.push({ el: label(el), blockedBy: blocker });
    } else {
      // Aviso (no falla): en reposo el toque cae en la capa que lo tapa,
      // pero scrolleando el control queda a la vista y se alcanza. Es la
      // clase de la trampa 15: se reporta para que quede a la vista.
      out.avisos.push({ el: label(el), blockedBy: blocker });
    }
  }
  return out;
})()`;
}

/**
 * Expresión JS que desplaza a una posición (0 a 1) el contenedor con scroll
 * del panel Y el documento. Si el panel no scrollea (un formulario en línea,
 * por ejemplo), scrollea el documento: el pie pegajoso se pega al borde de
 * la ventana y sólo se ve el efecto real al mover la página.
 */
export function scrollExpression(scopeSelector, position) {
  return `(() => {
  const panel = document.querySelector(${JSON.stringify(scopeSelector)});
  let el = panel;
  while (el) {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 1) {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${position});
      break;
    }
    el = el.parentElement;
  }
  const doc = document.scrollingElement || document.documentElement;
  if (doc && doc.scrollHeight > doc.clientHeight + 1) {
    window.scrollTo(0, Math.round((doc.scrollHeight - doc.clientHeight) * ${position}));
  }
  return Math.round(window.scrollY);
})()`;
}
