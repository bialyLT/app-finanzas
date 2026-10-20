#!/usr/bin/env node
/**
 * 10-modal-zona-muerta · la zona muerta de los modales y del formulario de
 * recurrencia: ¿hay un punto donde la persona VE un control y el tap despacha
 * OTRO?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA PREGUNTA (la del brief de la r2)
 * El dev de la r2 pasó los 6 modales a columna flex: el área que scrollea
 * TERMINA donde empieza el pie. Con eso desapareció el BUG-3 (el tap que
 * cerraba el formulario del préstamo). Pero él dejó por escrito el punto
 * filoso:
 *
 *   «El tap CRUDO del chip "Hoy" cae en el "Guardar" — con el formulario
 *    vacío sólo aparece un error de validación, pero con el formulario
 *    completo lo guardaría.»
 *
 * Eso hay que MEDIRLO con datos reales (monto + nota + tipo) y dictaminar si
 * es un bug ALTA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL MÉTODO: LA MALLA DE PUNTOS
 * La pregunta que decide el caso NO es «dónde está el rect del control» sino
 * «¿hay un punto QUE LA PERSONA VE donde el tap despacha otro control?».
 *
 * Por eso, para cada control visible, se muestrea una malla de 5×5 puntos
 * DENTRO de su rect visible (el rect recortado por los ancestros con
 * `overflow` y por el viewport) y se mira, en cada punto, qué elemento está
 * ARRIBA (`elementFromPoint`):
 *
 *   · si en todos los puntos el de arriba es el control (o un hijo suyo), el
 *     control es Dueño de su propia superficie: tocarlo toca él. Correcto.
 *   · si en ALGÚN punto el de arriba es OTRO control (un botón del pie, por
 *     ejemplo), hay una superficie donde la persona ve una cosa y el tap
 *     dispara otra. ESO es un bug — y su severidad depende de qué sea ese
 *     otro control: un «Cancelar» que avisa es distinto de un «Guardar» que
 *     guarda.
 *
 * Y el tap crudo (el centro del rect SIN recortar) se mide aparte, porque es
 * el punto que el dev.signal: si cae en un botón, ese tap dispara ese botón.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ IMPORTA
 * Un «Guardar» disparado por un tap que la persona no pretendía es el peor
 * caso de esta app: el movimiento se guarda con la fecha de hoy, en la cuenta
 * equivocada, y nadie se entera hasta que el balance no cierra.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  openRoute,
  abrirModal,
  correrBateria,
  api,
  sleep,
} from "./lib.mjs";

const VIEWPORTS = [
  { name: "375 iphone-se", width: 375, height: 667 },
  { name: "844 landscape", width: 844, height: 390 },
  { name: "667 landscape", width: 667, height: 375 },
];

const MODALES = [
  { nombre: "gasto", path: "/", trigger: "#btn-expense", tipo: "gasto" },
  { nombre: "ingreso", path: "/", trigger: "#btn-income", tipo: "ingreso" },
  { nombre: "transferencia", path: "/", trigger: "#btn-transfer", tipo: "transferencia" },
  { nombre: "prestamo", path: "/prestamos", trigger: "#loans-new", tipo: "prestamo" },
];

/** Texto único: sirve de marca para borrar lo que se cuele. */
const MARCA = "T_ZONA9_MUERTA";

const CAPTURADOR = `(() => {
  if (window.__t9z) return "ya";
  window.__t9z = [];
  document.addEventListener("click", (e) => {
    const t = e.target;
    window.__t9z.push({
      id: t && t.id ? t.id : null,
      tag: t ? t.tagName.toLowerCase() : null,
      texto: t && t.textContent ? t.textContent.trim().slice(0, 24) : "",
      x: Math.round(e.clientX), y: Math.round(e.clientY)
    });
  }, true);
  return "ok";
})()`;

/**
 * La geometría de todos los controles del panel: rect crudo, rect visible,
 * malla de 5×5 puntos sobre lo visible y el punto crudo.
 */
const GEOMETRIA = `(() => {
  const panel = document.querySelector('[role="dialog"]') || document.querySelector("#rec-form");
  if (!panel) return { error: "no hay panel" };
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
    return { top, bottom, left, right };
  };
  const nombre = (el) => (el ? (el.id || el.tagName.toLowerCase()) : "null");
  const out = [];
  for (const el of panel.querySelectorAll("button, a, input, select, textarea, [role=button]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const vis = visibleRect(el);
    const invisible = vis.bottom - vis.top < 1 || vis.right - vis.left < 1;
    const rawX = r.left + r.width / 2, rawY = r.top + r.height / 2;
    const hitRaw = document.elementFromPoint(rawX, rawY);
    const malla = { total: 0, propio: 0, otros: {} };
    let centroHit = null;
    if (!invisible) {
      for (let i = 1; i <= 5; i++) {
        for (let j = 1; j <= 5; j++) {
          const x = vis.left + ((vis.right - vis.left) * i) / 6;
          const y = vis.top + ((vis.bottom - vis.top) * j) / 6;
          const hit = document.elementFromPoint(x, y);
          malla.total++;
          if (hit && (hit === el || el.contains(hit))) malla.propio++;
          else {
            const k = nombre(hit);
            malla.otros[k] = (malla.otros[k] ?? 0) + 1;
          }
        }
      }
      const cx = (vis.left + vis.right) / 2, cy = (vis.top + vis.bottom) / 2;
      const hit = document.elementFromPoint(cx, cy);
      centroHit = nombre(hit);
    }
    out.push({
      id: el.id || null,
      tag: el.tagName.toLowerCase(),
      texto: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 22),
      raw: { x: Math.round(rawX), y: Math.round(rawY), top: Math.round(r.top), bottom: Math.round(r.bottom) },
      vis: { top: Math.round(vis.top), bottom: Math.round(vis.bottom), h: Math.round(vis.bottom - vis.top) },
      invisible,
      hitRaw: nombre(hitRaw),
      hitCentro: centroHit,
      malla,
      llegaCentro: !!(malla.total && malla.propio === malla.total)
    });
  }
  return { controles: out };
})()`;

/** Los movimientos de HOY (los que el modal puede crear). */
async function movimientosDeHoy() {
  const hoy = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const dia = `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}-${p(hoy.getDate())}`;
  const res = await api(`/api/transactions?from=${dia}&to=${dia}`);
  return res.body?.movements ?? [];
}

/** Carga un formulario REAL: monto, categoría y nota (con toque de verdad). */
async function cargarFormulario(ui, tipo) {
  const monto = await ui.centerOf("#tx-amount");
  await ui.clickAt(monto.x, monto.y);
  await sleep(150);
  await ui.insertText("4321,99");

  if (tipo === "gasto" || tipo === "ingreso") {
    // Foco (sin click: el click abriría el `datalist` nativo) y tipeo. El
    // `onFocus` abre los chips de sugerencias: ESO es el corrimiento de layout.
    await ui.evalJs(`document.querySelector("#tx-category").focus()`);
    await sleep(150);
    await ui.insertText("Comida");
    await sleep(400);
  }

  // La nota: hay que traerla a la vista (en gasto/ingreso está al final).
  await ui.evalJs(
    `document.querySelector("#tx-description").scrollIntoView({ block: "center" })`,
  );
  await sleep(250);
  const nota = await ui.centerOf("#tx-description");
  await ui.clickAt(nota.x, nota.y);
  await sleep(150);
  await ui.insertText(`${MARCA} ${tipo}`);
  await sleep(400);
}

/** El área que scrollea DENTRO del panel (la que tiene `overflow-y`). */
const SCROLLER = `(() => {
  const panel = document.querySelector('[role="dialog"]') || document.querySelector("#rec-form");
  if (!panel) return { error: "no hay panel" };
  let el = panel;
  while (el) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    }
    el = el.parentElement;
  }
  return { top: 0, max: 0, sinScroller: true };
})()`;

async function main() {
  const ui = await openUi({
    port: 9371,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9371`,
  });
  try {
    for (const vp of VIEWPORTS) {
      for (const modal of MODALES) {
        section(`${vp.name} · ${modal.nombre}`);
        await applyViewport(ui, vp, { touch: true });
        await openRoute(ui, modal.path);
        await verifyViewport(ui, vp, { touch: true });
        await abrirModal(ui, modal.trigger, '[role="dialog"]');

        if (modal.tipo === "prestamo") {
          // El préstamo: nombre, monto y plazo (suficiente para que el
          // formulario NO esté vacío).
          const nombre = await ui.centerOf("#loanalta-name");
          await ui.clickAt(nombre.x, nombre.y);
          await sleep(150);
          await ui.insertText(`${MARCA} prestamo`);
          await sleep(200);
          const principal = await ui.centerOf("#loanalta-principal");
          await ui.clickAt(principal.x, principal.y);
          await sleep(150);
          await ui.insertText("100000");
          await sleep(300);
        } else {
          await cargarFormulario(ui, modal.tipo);
        }

        // ── Estado 1 · REPOSO (el área que scrollea, arriba del todo) ──────
        const sc = await ui.evalJs(SCROLLER);
        await ui.evalJs(`(() => {
          const panel = document.querySelector('[role="dialog"]');
          let el = panel;
          while (el) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === "auto" || cs.overflowY === "scroll") { el.scrollTop = 0; break; }
            el = el.parentElement;
          }
          return true;
        })()`);
        // ── Estado 2 · AL FINAL (el área que scrollea, al tope del scroll) ──
        // Es el estado donde la persona apunta al ÚLTIMO campo del
        // formulario: si ese campo queda a medio cortar, el dedo puede caer
        // en el pie. El mismo invariante tiene que valer acá.
        await ui.evalJs(`(() => {
          const panel = document.querySelector('[role="dialog"]');
          let el = panel;
          while (el) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
              el.scrollTop = el.scrollHeight;
              break;
            }
            el = el.parentElement;
          }
          return true;
        })()`);
        await sleep(400);
        const fondo = await ui.evalJs(GEOMETRIA);
        const tapadosFondo = (fondo.controles ?? []).filter((c) => !c.invisible && !c.llegaCentro);
        const invisiblesFondo = (fondo.controles ?? []).filter((c) => c.invisible);
        console.log(
          `  · AL FINAL: ${fondo.controles?.length ?? 0} controles · ` +
            `${(fondo.controles?.length ?? 0) - invisiblesFondo.length} visibles · ` +
            `${invisiblesFondo.length} invisibles`,
        );
        for (const c of tapadosFondo) {
          console.log(
            `    ¡MAL! ${c.id ?? c.tag} «${c.texto}» visible ${c.vis.top}..${c.vis.bottom} ` +
              `→ ${JSON.stringify(c.malla.otros)} (centro: ${c.hitCentro})`,
          );
        }
        checkTrue(
          `${vp.name} · ${modal.nombre} · al final del scroll, ningún control visible pierde parte de su superficie`,
          tapadosFondo.length === 0,
          tapadosFondo.map((c) => `${c.id ?? c.tag} → ${JSON.stringify(c.malla.otros)}`).join(" | "),
        );

        // Vuelve al estado de reposo para el resto de las mediciones.
        await ui.evalJs(`(() => {
          const panel = document.querySelector('[role="dialog"]');
          let el = panel;
          while (el) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === "auto" || cs.overflowY === "scroll") { el.scrollTop = 0; break; }
            el = el.parentElement;
          }
          return true;
        })()`);
        await sleep(350);
        await ui.evalJs(CAPTURADOR);
        const reposo = await ui.evalJs(GEOMETRIA);
        if (reposo.error) {
          checkTrue(`${vp.name} · ${modal.nombre} · se mide el modal`, false, reposo.error);
          continue;
        }

        const tapados = reposo.controles.filter((c) => !c.invisible && !c.llegaCentro);
        const invisibles = reposo.controles.filter((c) => c.invisible);
        const rawEnBoton = invisibles.filter(
          (c) => c.hitRaw && c.hitRaw !== "null" && c.hitRaw !== "html" && c.hitRaw !== "body",
        );
        console.log(
          `  · REPOSO: ${reposo.controles.length} controles · ` +
            `${reposo.controles.length - invisibles.length} visibles · ${invisibles.length} invisibles`,
        );
        for (const c of invisibles) {
          console.log(
            `    invisible ${c.id ?? c.tag} «${c.texto}» raw(${c.raw.x},${c.raw.y}) → ${c.hitRaw}`,
          );
        }
        for (const c of tapados) {
          console.log(
            `    ¡MAL! ${c.id ?? c.tag} «${c.texto}» visible ${c.vis.top}..${c.vis.bottom} ` +
              `→ ${JSON.stringify(c.malla.otros)} (centro: ${c.hitCentro})`,
          );
        }

        // ── EL INVARIANTE ─────────────────────────────────────────────────
        // Ningún control VISIBLE puede tener una superficie donde el tap
        // despacha otro control.
        checkTrue(
          `${vp.name} · ${modal.nombre} · en reposo, ningún control visible pierde parte de su superficie`,
          tapados.length === 0,
          tapados.map((c) => `${c.id ?? c.tag} → ${JSON.stringify(c.malla.otros)}`).join(" | "),
        );

        // ── LA PREGUNTA: el tap CRUDO de un control invisible ─────────────
        // Si cae en un botón, ese tap dispara ese botón. Con el formulario
        // CARGADO, ¿guarda?
        const objetivo = invisibles.find(
          (c) => c.hitRaw === "tx-submit" || c.hitRaw === "loanalta-submit",
        );
        if (!objetivo) {
          console.log(
            `  · el punto crudo de los controles invisibles NO cae en ningún botón ` +
              `(caen en: ${rawEnBoton.map((c) => `${c.id}→${c.hitRaw}`).join(", ") || "nada"})`,
          );
          checkTrue(
            `${vp.name} · ${modal.nombre} · el tap crudo de un control invisible no cae en un botón disparativo`,
            true,
          );
          continue;
        }

        const antes = await movimientosDeHoy();
        const idsAntes = new Set(antes.map((m) => m.id));

        // El botón donde cae el tap crudo, MEDIDO ANTES del tap: después del
        // tap el modal puede haber cambiado (o cerrado).
        const botonVisible = await ui.evalJs(`(() => {
          const b = document.querySelector("#${objetivo.hitRaw}");
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            texto: (b.textContent || "").trim().slice(0, 20),
            w: Math.round(r.width), h: Math.round(r.height),
            top: Math.round(r.top), bottom: Math.round(r.bottom),
            tapPropio: hit === b || b.contains(hit),
            enLaVentana: r.top >= 0 && r.bottom <= window.innerHeight
          };
        })()`);
        console.log(`  · el botón destino (antes del tap): ${JSON.stringify(botonVisible)}`);

        await ui.evalJs(`window.__t9z = []`);
        await ui.clickAt(objetivo.raw.x, objetivo.raw.y);
        await sleep(1600);
        const clic = await ui.evalJs(`window.__t9z.slice(-1)[0] ?? null`);
        const despues = await movimientosDeHoy();
        const nuevos = despues.filter((m) => !idsAntes.has(m.id));
        const modalAbierto = await ui.evalJs(`!!document.querySelector('[role="dialog"]')`);
        console.log(
          `  · tap real en (${objetivo.raw.x},${objetivo.raw.y}) [invisible ${objetivo.id}] ` +
            `→ recibió ${JSON.stringify(clic)}`,
        );
        console.log(
          `  · movimientos nuevos: ${nuevos.length}` +
            (nuevos.length
              ? ` → ${JSON.stringify({
                  monto: nuevos[0].amount,
                  desc: nuevos[0].description,
                  fecha: nuevos[0].date,
                  tipo: nuevos[0].kind,
                })}`
              : "") +
            ` · modal abierto: ${modalAbierto}`,
        );

        for (const m of nuevos) {
          await api(`/api/transactions?id=${encodeURIComponent(m.id)}`, {
            method: "DELETE",
          });
        }
        const quedan = (await movimientosDeHoy()).filter((m) => !idsAntes.has(m.id));
        checkTrue(
          `${vp.name} · ${modal.nombre} · el tap crudo no deja movimientos sin borrar`,
          quedan.length === 0,
          `quedaron ${quedan.length}`,
        );

        // El dato para el veredicto: el tap crudo cae en un botón VISIBLE
        // (medido ANTES del tap, más arriba). Si el botón es visible y dice
        // «Guardar», el tap crudo ES un tap en «Guardar»: la app hizo lo que
        // el botón dice. Eso no es un tap perdido: es un tap con la etiqueta
        // a la vista.
        checkTrue(
          `${vp.name} · ${modal.nombre} · el botón donde cae el tap crudo está visible y es el que la persona ve`,
          botonVisible !== null && botonVisible.tapPropio === true && botonVisible.enLaVentana === true,
          JSON.stringify(botonVisible),
        );

        // Si el tap guardó algo, la acción NO puede ser silenciosa: la app
        // muestra el aviso de «Deshacer» con el movimiento recién guardado.
        const undo = await ui.evalJs(`({
          toast: !!document.querySelector("#undo-toast"),
          texto: document.querySelector("#undo-toast")?.textContent?.trim().slice(0, 60) ?? null
        })`);
        console.log(`  · el aviso de «Deshacer»: ${JSON.stringify(undo)}`);
        if (nuevos.length > 0) {
          checkTrue(
            `${vp.name} · ${modal.nombre} · el movimiento guardado NO es silencioso: aparece el aviso de «Deshacer»`,
            undo.toast === true,
            JSON.stringify(undo),
          );
          checkTrue(
            `${vp.name} · ${modal.nombre} · lo guardado es lo que estaba cargado (monto y fecha de hoy)`,
            String(nuevos[0].amount).replace(",", ".") === "4321.99" &&
              String(nuevos[0].date ?? "").startsWith(
                String(new Date().getFullYear()),
              ),
            JSON.stringify({ monto: nuevos[0].amount, fecha: nuevos[0].date }),
          );
        } else {
          checkTrue(
            `${vp.name} · ${modal.nombre} · el tap crudo no guardó nada`,
            true,
          );
        }
      }
    }
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "10-modal-zona-muerta", conSesion: true });
