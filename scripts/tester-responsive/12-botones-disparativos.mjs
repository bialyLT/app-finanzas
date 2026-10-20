#!/usr/bin/env node
/**
 * 12-botones-disparativos · ¿hay un botón DISPARATIVO debajo de un control que
 * la persona ve? (los 7 avisos de la auditoría + el tap fantasma del
 * préstamo)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL INVARIANTE QUE DECIDE (y el que la auditoría NO mide)
 * Para cada control se muestrea una malla de 5×5 puntos sobre su rect VISIBLE
 * (el rect recortado por los ancestros con `overflow` y por el viewport) y se
 * mira qué elemento está ARRIBA en cada punto:
 *
 *   · propio = 25/25 → el control es dueño de toda su superficie. Bien.
 *   · propio = 0/25  → el control está ENTERO tapado: la persona no lo ve,
 *     ve el tapón. Si el tapón (o un ancestro suyo) es OPACO, el tap hace lo
 *     que la persona ve: NO es una trampa.
 *   · 0 < propio < 25 → el control está PARCIALMENTE tapado: la persona ve
 *     una parte de una cosa y otra parte de otra, y el tap depende de dónde
 *     caiga el dedo. ESO es el bug (la trampa de la clase 15).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS PREGUNTAS
 * A · Los 7 AVISOS de la auditoría (del formulario de recurrencia): el chip
 *     «Todas las semanas» tiene DEBAJO el botón «Crear regla», que es
 *     disparativo. ¿Un tap ahí crea la regla? (y: ¿la persona ve el chip o
 *     ve el botón?)
 * B · El tap FANTASMA del préstamo en landscape: el rect CRUDO de un chip
 *     INVISIBLE (recortado por el borde del área que scrollea) cae sobre el
 *     botón «Crear préstamo». Con el formulario COMPLETO, ese tap crearía un
 *     préstamo. ¿Es silencioso o la persona lo ve?
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
  PrismaClient,
} from "./lib.mjs";

const VP = { name: "375 iphone-se", width: 375, height: 667 };
const VP_LAND = { name: "844 landscape", width: 844, height: 390 };
const MARCA = "T_ZONA9";

/**
 * La malla de un control: qué elemento está arriba en cada punto de su rect
 * visible, y si ese tapón (o un ancestro suyo) es opaco.
 */
const MALLA = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: "no existe " + ${JSON.stringify(selector)} };
  const visibleRect = (e) => {
    const r = e.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    let p = e.parentElement;
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
  const nombre = (x) => (x ? (x.id || x.tagName.toLowerCase()) : "null");
  // El alfa de un color computed: Chrome 155 devuelve lab()/oklch(), no rgb().
  const alfa = (color) => {
    if (!color) return 1;
    const c = String(color).trim().toLowerCase();
    if (c === "transparent") return 0;
    const m = c.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s));
      return p.length >= 4 ? p[3] : 1;
    }
    const a = c.match(/\\/\\s*([0-9.]+)\\s*\\)$/);
    if (a) return parseFloat(a[1]);
    return 1;   // lab()/oklch()/rgb(): opaco
  };
  // Opaco = el tapón (o un ancestro suyo) tiene fondo opaco y nada en el
  // camino tiene opacidad menor que 1.
  const opaco = (x) => {
    if (!x) return true;
    let p = x;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (cs.opacity !== "" && parseFloat(cs.opacity) < 0.99) return false;
      if (alfa(cs.backgroundColor) >= 0.99) return true;
      p = p.parentElement;
    }
    return false;
  };
  const vis = visibleRect(el);
  const r = el.getBoundingClientRect();
  const out = {
    id: el.id || null,
    raw: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    vis: { top: Math.round(vis.top), bottom: Math.round(vis.bottom), h: Math.round(vis.bottom - vis.top) },
    total: 0, propio: 0, tapones: {}
  };
  if (vis.bottom - vis.top < 1 || vis.right - vis.left < 1) {
    out.invisible = true;
    out.centro = null;
    return out;
  }
  out.invisible = false;
  for (let i = 1; i <= 5; i++) {
    for (let j = 1; j <= 5; j++) {
      const x = vis.left + ((vis.right - vis.left) * i) / 6;
      const y = vis.top + ((vis.bottom - vis.top) * j) / 6;
      const hit = document.elementFromPoint(x, y);
      out.total++;
      if (hit && (hit === el || el.contains(hit))) { out.propio++; continue; }
      const k = nombre(hit);
      if (!out.tapones[k]) {
        out.tapones[k] = {
          n: 0, opaco: opaco(hit),
          texto: hit ? (hit.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 20) : ""
        };
      }
      out.tapones[k].n++;
    }
  }
  out.centro = (() => {
    const hit = document.elementFromPoint((vis.left + vis.right) / 2, (vis.top + vis.bottom) / 2);
    return { hit: nombre(hit), opaco: opaco(hit), texto: hit ? (hit.textContent || "").trim().slice(0, 20) : "" };
  })();
  out.parcial = out.propio > 0 && out.propio < out.total;
  out.totalmenteTapado = out.propio === 0;
  return out;
})()`;

/** Borra (por id) las reglas que esta batería pudo crear. */
async function borrarReglas(prisma, tituloMarca) {
  const r = await prisma.recurrenceRule.findMany({
    where: { title: { startsWith: tituloMarca } },
    select: { id: true, title: true },
  });
  for (const regla of r) {
    await prisma.recurrenceOccurrence.deleteMany({ where: { ruleId: regla.id } });
    await prisma.recurrenceRule.delete({ where: { id: regla.id } }).catch(() => {});
  }
  return r.length;
}

/** Escribe en un campo SIN clic (un clic en un campo recortado cae en el pie). */
async function escribir(ui, selector, texto) {
  await ui.evalJs(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await sleep(200);
  await ui.insertText(texto);
  await sleep(300);
}

/** Desplaza el área que scrollea del panel a una posición concreta. */
const SCROLL_AREA = (pos) => `(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return { error: "no hay modal" };
  // El área que scrollea es DESCENDIENTE del panel (columna flex), no un
  // ancestro: hay que buscarla adentro.
  let el = null;
  for (const cand of dlg.querySelectorAll("*")) {
    const cs = getComputedStyle(cand);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") { el = cand; break; }
  }
  if (!el) return { sinScroller: true };
  el.scrollTop = ${JSON.stringify(pos)} === "max" ? el.scrollHeight : Number(${JSON.stringify(pos)});
  return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
})()`;

async function main() {
  const prisma = new PrismaClient();
  await borrarReglas(prisma, MARCA);
  const ui = await openUi({
    port: 9373,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9373`,
  });
  try {
    /* ─────────────────────────────────────────────────────────────────────
     * A · Los avisos del formulario de recurrencia
     * ───────────────────────────────────────────────────────────────────── */
    section("A · recurrencia · los 7 avisos: ¿hay un botón disparativo debajo?");
    await applyViewport(ui, VP, { touch: true });
    await openRoute(ui, "/recurrencia");
    await verifyViewport(ui, VP, { touch: true });
    await abrirModal(ui, "#rec-add-rule", "#rec-form");

    for (const chip of ["#rec-freq-DAILY", "#rec-freq-WEEKLY"]) {
      const malla = await ui.evalJs(MALLA(chip));
      console.log(`  · ${chip}: ${JSON.stringify(malla)}`);
      checkTrue(
        `recurrencia · ${chip} · NO está parcialmente tapado (la persona no ve un mosaico)`,
        malla.parcial !== true,
        `propio=${malla.propio}/${malla.total} tapones=${JSON.stringify(malla.tapones)}`,
      );
      if (malla.totalmenteTapado) {
        checkTrue(
          `recurrencia · ${chip} · el tapón que lo cubre es OPACO (la persona ve el tapón, no el chip)`,
          Object.values(malla.tapones ?? {}).every((t) => t.opaco === true),
          JSON.stringify(malla.tapones),
        );
      }
    }

    // Con el formulario CARGADO: ¿un tap en el punto tapado del chip crea la
    // regla? (y: ¿la persona ve el chip o ve el botón?)
    await escribir(ui, "#rec-title", `${MARCA} regla`);
    await escribir(ui, "#rec-amount", "1234,56");
    await escribir(ui, "#rec-category", "Comida");
    await ui.evalJs(`window.scrollTo(0, 0)`);
    await sleep(400);

    const mallaCargada = await ui.evalJs(MALLA("#rec-freq-WEEKLY"));
    console.log(`  · con datos cargados: ${JSON.stringify(mallaCargada)}`);
    const reglasAntes = await prisma.recurrenceRule.count();

    if (mallaCargada.invisible !== true && mallaCargada.centro) {
      const punto = await ui.evalJs(`(() => {
        const el = document.querySelector("#rec-freq-WEEKLY");
        const r = el.getBoundingClientRect();
        const vis = (() => {
          let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
          let p = el.parentElement;
          while (p) {
            const cs = getComputedStyle(p);
            if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
              const pr = p.getBoundingClientRect();
              top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom);
              left = Math.max(left, pr.left); right = Math.min(right, pr.right);
            }
            p = p.parentElement;
          }
          return { top: Math.max(top, 0), bottom: Math.min(bottom, window.innerHeight),
                   left: Math.max(left, 0), right: Math.min(right, window.innerWidth) };
        })();
        return { x: Math.round((vis.left + vis.right) / 2), y: Math.round((vis.top + vis.bottom) / 2) };
      })()`);
      await ui.clickAt(punto.x, punto.y);
      await sleep(1800);
      const reglasDespues = await prisma.recurrenceRule.count();
      const err = await ui.evalJs(
        `document.querySelector("#rec-form-error")?.textContent?.trim() ?? null`,
      );
      console.log(
        `  · tap real en (${punto.x},${punto.y}) [lo recibe ${mallaCargada.centro.hit}] → ` +
          `reglas ${reglasAntes} → ${reglasDespues} · error=${err}`,
      );
      // El contrato: el tap tiene que caer en el botón QUE LA PERSONA VE, y
      // ese botón tiene que ser el que se ve (opaco, en la ventana).
      checkTrue(
        "recurrencia · el tap tapado del chip cae en el botón VISIBLE «Crear regla» (no en un mosaico)",
        mallaCargada.centro.hit === "rec-form-submit" && mallaCargada.centro.opaco === true,
        JSON.stringify(mallaCargada.centro),
      );
      checkTrue(
        "recurrencia · el botón que recibe el tap tapado es el que la persona ve (opaco y en la ventana)",
        mallaCargada.centro.opaco === true,
        JSON.stringify(mallaCargada.centro),
      );
      console.log(
        `  · DATO: el tap creó ${reglasDespues - reglasAntes} regla(s) — ` +
          `la acción NO es silenciosa: el botón dice «Crear regla»`,
      );
    }

    /* ─────────────────────────────────────────────────────────────────────
     * A2 · Los 5 avisos del LANDSCAPE: ¿se alcanzan scrolleando y el tap
     *      llega al control? (los 2 de portrait los cubre la batería 04)
     * ───────────────────────────────────────────────────────────────────── */
    section("A2 · los avisos del landscape: scrolleando el tap LLEGA al control");
    for (const vp of [VP_LAND, { name: "667 landscape", width: 667, height: 375 }]) {
      await applyViewport(ui, vp, { touch: true });
      await openRoute(ui, "/recurrencia");
      await verifyViewport(ui, vp, { touch: true });
      await abrirModal(ui, "#rec-add-rule", "#rec-form");
      await sleep(400);

      // Los controles que, EN REPOSO, quedan tapados por el pie pegajoso.
      const bloqueados = await ui.evalJs(`(() => {
        const pie = document.querySelector("#rec-form").parentElement;
        const out = [];
        for (const el of document.querySelectorAll("#rec-form button, #rec-form input")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || (hit === el || el.contains(hit))) continue;
          out.push({ id: el.id || el.tagName.toLowerCase(),
                     hit: hit.id || hit.tagName.toLowerCase(),
                     top: Math.round(r.top), bottom: Math.round(r.bottom) });
        }
        return out;
      })()`);
      console.log(`  · ${vp.name}: ${bloqueados.length} controles tapados en reposo: ${JSON.stringify(bloqueados)}`);

      for (const b of bloqueados) {
        // Scrollear hasta el centro y hacer un TAP REAL.
        await ui.evalJs(`(() => {
          const el = document.querySelector("#${b.id}");
          if (el) el.scrollIntoView({ block: "center", inline: "nearest" });
          return true;
        })()`);
        await sleep(400);
        const punto = await ui.evalJs(`(() => {
          const el = document.querySelector("#${b.id}");
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await ui.clickAt(punto.x, punto.y);
        await sleep(500);
        const recibido = await ui.evalJs(`(() => {
          const el = document.querySelector("#${b.id}");
          const hit = document.elementFromPoint(${punto.x}, ${punto.y});
          return { hit: hit ? (hit.id || hit.tagName.toLowerCase()) : null,
                   llega: !!(hit && (hit === el || el.contains(hit))) };
        })()`);
        console.log(
          `    ${b.id} (tapado por ${b.hit}) → scrolleado y tapado en ` +
            `(${punto.x},${punto.y}) → recibió ${recibido.hit}`,
        );
        checkTrue(
          `${vp.name} · ${b.id} · scrolleando, el tap real LLEGA al control (es un aviso, no un tap muerto)`,
          recibido.llega === true,
          `recibió ${recibido.hit}`,
        );
      }
    }

    /* ─────────────────────────────────────────────────────────────────────
     * B · El tap fantasma del préstamo en landscape, con el formulario
     *     COMPLETO
     * ───────────────────────────────────────────────────────────────────── */
    section("B · préstamo en landscape · el tap fantasma cae en «Crear préstamo»");
    await applyViewport(ui, VP_LAND, { touch: true });
    await openRoute(ui, "/prestamos");
    await verifyViewport(ui, VP_LAND, { touch: true });
    await abrirModal(ui, "#loans-new", '[role="dialog"]');

    // Formulario COMPLETO, escrito SIN clic (un clic en un campo recortado
    // cae en el pie: el «Cancelar» del préstamo — y así se abre el aviso).
    await escribir(ui, "#loanalta-name", `${MARCA} préstamo`);
    await escribir(ui, "#loanalta-principal", "100000");
    await escribir(ui, "#loanalta-tna", "60");
    await escribir(ui, "#loanalta-count", "12");
    // Estado de REPOSO del área que scrollea: el chip «Francés» queda
    // recortado y su rect crudo es un punto fantasma.
    const scroll = await ui.evalJs(SCROLL_AREA("0"));
    await sleep(400);

    const estado = await ui.evalJs(`({
      aviso: !!document.querySelector("#loanalta-discard-warning"),
      nombre: document.querySelector("#loanalta-name")?.value ?? null,
      monto: document.querySelector("#loanalta-principal")?.value ?? null,
      tna: document.querySelector("#loanalta-tna")?.value ?? null,
      cuotas: document.querySelector("#loanalta-count")?.value ?? null
    })`);
    console.log(`  · estado del formulario: ${JSON.stringify(estado)} · scroll=${JSON.stringify(scroll)}`);
    checkTrue(
      "préstamo · el formulario quedó cargado y sin aviso de descarte",
      estado.aviso === false &&
        String(estado.nombre).includes(MARCA) &&
        String(estado.monto).includes("100000") &&
        String(estado.tna).includes("60") &&
        String(estado.cuotas).includes("12"),
      JSON.stringify(estado),
    );

    const malla = await ui.evalJs(MALLA("#loanalta-system-FRENCH"));
    console.log(`  · el chip «Francés»: ${JSON.stringify(malla)}`);
    checkTrue(
      "préstamo · el chip «Francés» es invisible en landscape (su rect crudo es un punto fantasma)",
      malla.invisible === true,
      JSON.stringify(malla.vis),
    );

    const fantasma = await ui.evalJs(`(() => {
      const el = document.querySelector("#loanalta-system-FRENCH");
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const hitEl = hit ? (hit.id || hit.tagName.toLowerCase()) : null;
      const b = hit && hit.id ? document.getElementById(hit.id) : null;
      const br = b ? b.getBoundingClientRect() : null;
      const hitPropio = b && br
        ? (() => { const h = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); return h === b || b.contains(h); })()
        : null;
      return { x, y, hit: hitEl,
               texto: hit ? (hit.textContent || "").trim().slice(0, 20) : "",
               boton: br ? { top: Math.round(br.top), bottom: Math.round(br.bottom),
                             w: Math.round(br.width), h: Math.round(br.height) } : null,
               tapPropio: hitPropio,
               enLaVentana: br ? br.top >= 0 && br.bottom <= window.innerHeight : null };
    })()`);
    console.log(`  · el punto fantasma: ${JSON.stringify(fantasma)}`);

    const prestamosAntes = await prisma.account.count({
      where: { name: { startsWith: MARCA } },
    });
    await ui.clickAt(fantasma.x, fantasma.y);
    await sleep(2500);
    const prestamosDespues = await prisma.account.count({
      where: { name: { startsWith: MARCA } },
    });
    const modalAbierto = await ui.evalJs(`!!document.querySelector('[role="dialog"]')`);
    const paso = await ui.evalJs(`({
      desembolso: !!document.querySelector("#loanalta-disburse-go"),
      error: document.querySelector("#loanalta-error")?.textContent?.trim() ?? null
    })`);
    console.log(
      `  · tap real en el punto fantasma → cuentas con marca: ${prestamosAntes} → ${prestamosDespues} ` +
        `· modal abierto: ${modalAbierto} · ${JSON.stringify(paso)}`,
    );

    checkTrue(
      "préstamo · el tap fantasma cae en el botón VISIBLE «Crear préstamo»",
      fantasma.hit === "loanalta-submit" && fantasma.tapPropio === true && fantasma.enLaVentana === true,
      JSON.stringify(fantasma),
    );

    // Limpieza por id (la cuenta del préstamo y sus movimientos).
    const cuentas = await prisma.account.findMany({
      where: { name: { startsWith: MARCA } },
      select: { id: true, name: true },
    });
    for (const c of cuentas) {
      await prisma.movement.deleteMany({
        where: { OR: [{ accountId: c.id }, { toAccountId: c.id }] },
      });
      await prisma.installment.deleteMany({ where: { accountId: c.id } }).catch(() => {});
      await prisma.cardPlan.deleteMany({ where: { accountId: c.id } }).catch(() => {});
      await prisma.account.delete({ where: { id: c.id } }).catch(() => {});
    }
    const quedan = await prisma.account.count({ where: { name: { startsWith: MARCA } } });
    checkTrue(
      "préstamo · el tap fantasma no dejó cuentas sin borrar",
      quedan === 0,
      `quedaron ${quedan}`,
    );
    console.log(
      `  · DATO: el tap fantasma creó ${prestamosDespues - prestamosAntes} préstamo(s); ` +
        `la acción NO es silenciosa: el botón dice «Crear préstamo» y el formulario ` +
        `pide el desembolso en un segundo paso (visible: ${JSON.stringify(paso)})`,
    );
  } finally {
    await borrarReglas(prisma, MARCA);
    await prisma.$disconnect();
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "12-botones-disparativos", conSesion: true });
