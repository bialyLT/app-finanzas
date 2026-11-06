#!/usr/bin/env node
/**
 * f3b-a11y.mjs — la verificación de accesibilidad de la fase F3b, sobre el DOM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ MIDE (y por qué no «a ojo»)
 *   1. FOCO VISIBLE: recorre cada pantalla y cada modal con Tab REAL
 *      (`Input.dispatchKeyEvent`) y, para cada control enfocado, lee el estilo
 *      computado: tiene que haber un `outline` (la regla base de F3b) o un
 *      `box-shadow` (el anillo de las primitivas). Un control al que se llega
 *      con Tab y no se ve dónde está es una falla.
 *   2. ALCANCE POR TECLADO: compara los controles que DECLARAN ser focusables
 *      (visibles, no `disabled`, `tabindex >= 0`) contra los que el recorrido
 *      realmente tocó. La diferencia son los inalcanzables.
 *   3. BOTONES SÓLO-ICONO: lista de botones/enlaces sin `aria-label`, sin
 *      texto y sin `title`. Tiene que quedar vacía.
 *   4. `aria-live`: un guardado exitoso (el aviso «Movimiento guardado») y un
 *      error async (el preview del CSV) se leen del DOM y tienen que estar en
 *      una región `aria-live="polite"`.
 *   5. FOCO AL CERRAR EL MODAL DE VOZ: se abre, se cierra con Escape y se
 *      verifica que el foco volvió al botón «Carga por voz».
 *   6. GLIFO DE 320: la pestaña «Transferencia» no se sale de su columna y el
 *      texto no toca las pestañas vecinas.
 *
 * Uso:  node scripts/f3b-a11y.mjs
 *       BASE_URL=http://127.0.0.1:3101 node scripts/f3b-a11y.mjs
 */

import { openUi } from "./tester-fase7/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3101";
const TAG = "F3B_A11Y";

let ok = 0;
const fallas = [];

function check(cond, label, detail = "") {
  if (cond) {
    ok += 1;
  } else {
    fallas.push(detail ? `${label} — ${detail}` : label);
  }
}

/** Los selectores que DECLARAN intención de ser focusables. */
const FOCUSABLE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="tab"]',
  '[role="switch"]',
].join(",");

/** Prefijo común: una clave estable por nodo (WeakMap) y el filtro de visibles. */
const PRELUDIO = `
  const sel = ${JSON.stringify(FOCUSABLE)};
  window.__a11ySeq = window.__a11ySeq || 0;
  window.__a11yKeys = window.__a11yKeys || new WeakMap();
  const keyOf = (el) => {
    let k = window.__a11yKeys.get(el);
    if (!k) { k = "n" + (++window.__a11ySeq); window.__a11yKeys.set(el, k); }
    return k;
  };
  const esFocusable = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (el.disabled) return false;
    if (el.closest("[inert]")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const tab = el.getAttribute("tabindex");
    if (tab !== null && Number(tab) < 0) return false;
    return true;
  };
`;

function focusablesExpr(scopeSelector = null) {
  return `(() => {
    ${PRELUDIO}
    const scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : "document"};
    if (!scope) return [];
    return [...scope.querySelectorAll(sel)]
      .filter(esFocusable)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          key: keyOf(el),
          tag: el.tagName,
          id: el.id || "",
          text: (el.textContent || "").trim().slice(0, 40),
          top: Math.round(r.top),
        };
      });
  })()`;
}

/** El estado del control enfocado: foco visible sí/no y su identidad. */
const ACTIVE_INFO = `(() => {
  ${PRELUDIO}
  const el = document.activeElement;
  if (!el || el === document.body) return { body: true };
  const cs = getComputedStyle(el);
  const outline =
    cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0;
  const shadow = !!cs.boxShadow && cs.boxShadow !== "none";
  const r = el.getBoundingClientRect();
  return {
    body: false,
    key: keyOf(el),
    tag: el.tagName,
    id: el.id || "",
    text: (el.textContent || "").trim().slice(0, 40),
    outline,
    shadow,
    visible: r.width >= 1 && r.height >= 1,
    focusVisible: el.matches(":focus-visible"),
    style: { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow.slice(0, 40) },
  };
})()`;

/**
 * Recorre con Tab hasta volver al control inicial (o al techo de pasos).
 * Si `scopeSelector` no es null, empieza en el primer control del scope y se
 * detiene cuando el foco sale de él.
 */
async function traverse(ui, { max = 220, label, scopeSelector = null } = {}) {
  // Esperar a que la lista de controles se ESTABILICE: las vistas cargan datos
  // por fetch y los filtros/selectores aparecen después del primer render. Sin
  // esto, el test podía declarar 23 controles y recorrer 30 (o al revés), y la
  // diferencia se reportaba como "inalcanzable" sin serlo.
  let ultimoConteo = -1;
  for (let i = 0; i < 12; i += 1) {
    const conteo = (await ui.evalJs(focusablesExpr(scopeSelector))).length;
    if (conteo === ultimoConteo) break;
    ultimoConteo = conteo;
    await sleep(350);
  }

  let primero = null;

  if (scopeSelector) {
    const inicial = await ui.evalJs(`(() => {
      ${PRELUDIO}
      const scope = document.querySelector(${JSON.stringify(scopeSelector)});
      if (!scope) return null;
      const first = [...scope.querySelectorAll(sel)].find(esFocusable);
      if (!first) return null;
      first.focus();
      return keyOf(first);
    })()`);
    if (!inicial) {
      return { label, declarados: 0, tocados: 0, sinFoco: [], inalcanzables: [], declaradosDetalle: [] };
    }
    primero = inicial;
    await sleep(50);
  } else {
    await ui.evalJs(
      `(() => { if (document.activeElement?.blur) document.activeElement.blur(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); return true; })()`,
    );
    await sleep(60);
  }

  const declarados = await ui.evalJs(focusablesExpr(scopeSelector));
  const tocados = [];
  const unicos = new Set();
  const sinFoco = [];
  const sinFocoVistos = new Set();

  for (let i = 0; i < max; i += 1) {
    await ui.pressKey("Tab", { code: "Tab", keyCode: 9 });
    await sleep(35);
    const info = await ui.evalJs(ACTIVE_INFO);
    if (info.body) break;

    if (scopeSelector) {
      const within = await ui.evalJs(
        `(() => { const el = document.activeElement; return !!el && !!el.closest(${JSON.stringify(scopeSelector)}); })()`,
      );
      if (!within) break;
    }

    if (primero === null) primero = info.key;
    if (info.key === primero && unicos.size > 1) {
      if (info.visible && !(info.outline || info.shadow) && !sinFocoVistos.has(info.key)) {
        sinFocoVistos.add(info.key);
        sinFoco.push(
          `${info.tag.toLowerCase()}${info.id ? "#" + info.id : ""} «${info.text}» (outline=${info.style.outlineStyle}/${info.style.outlineWidth}, shadow=${info.style.boxShadow})`,
        );
      }
      break;
    }
    // Un control puede repetirse en el recorrido (un `<input type="date">` de
    // Chrome recorre mes/día/año con la misma `activeElement`): se cuenta una
    // vez, pero NO se corta el recorrido —cortar ahí es lo que dejaba "sin
    // alcanzar" a los campos que vienen después de la fecha—.
    unicos.add(info.key);
    tocados.push(info.key);

    if (!info.visible) continue;
    if (!(info.outline || info.shadow) && !sinFocoVistos.has(info.key)) {
      sinFocoVistos.add(info.key);
      sinFoco.push(
        `${info.tag.toLowerCase()}${info.id ? "#" + info.id : ""} «${info.text}» (outline=${info.style.outlineStyle}/${info.style.outlineWidth}, shadow=${info.style.boxShadow})`,
      );
    }
  }

  const alcanzables = new Set(declarados.map((d) => d.key));
  const alcanzados = new Set(tocados);
  if (primero) alcanzados.add(primero);
  const inalcanzables = [...alcanzables].filter((k) => !alcanzados.has(k));

  return {
    label,
    declarados: declarados.length,
    tocados: unicos.size + (primero ? 1 : 0),
    sinFoco,
    inalcanzables: inalcanzables.slice(0, 6),
    declaradosDetalle: declarados.filter((d) => inalcanzables.includes(d.key)),
  };
}

function reportar(recorrido) {
  check(
    recorrido.sinFoco.length === 0,
    `${recorrido.label}: todos los controles con foco visible`,
    recorrido.sinFoco.slice(0, 4).join(" | "),
  );
  check(
    recorrido.inalcanzables.length === 0,
    `${recorrido.label}: ningún control inalcanzable por teclado (${recorrido.declarados} declarados, ${recorrido.tocados} tocados)`,
    recorrido.declaradosDetalle
      .slice(0, 4)
      .map((d) => `${d.tag.toLowerCase()}${d.id ? "#" + d.id : ""}`)
      .join(" | "),
  );
}

/** Botones/enlaces sin nombre accesible (aria-label, aria-labelledby, title o texto). */
const iconOnlyExpression = `(() => {
  const sel = 'button, [role="button"], a[href]';
  return [...document.querySelectorAll(sel)]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1 && !el.disabled;
    })
    .filter((el) => {
      const aria = (el.getAttribute("aria-label") || "").trim();
      const labelledby = el.getAttribute("aria-labelledby");
      const labelledbyText = labelledby
        ? labelledby.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim()
        : "";
      const title = (el.getAttribute("title") || "").trim();
      const text = (el.textContent || "").trim();
      const imgAlt = [...el.querySelectorAll("img")].some((img) => (img.getAttribute("alt") || "").trim());
      return !aria && !labelledbyText && !title && !text && !imgAlt;
    })
    .map((el) => el.outerHTML.slice(0, 160));
})()`;

async function abrir(ui, selector, esperado, label) {
  for (let intento = 0; intento < 3; intento += 1) {
    await ui.evalJs(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
    );
    await sleep(150);
    await ui.clickEl(selector);
    try {
      await ui.waitFor(esperado, { timeout: 2500, label });
      return true;
    } catch {
      // La ventana sorda del CDP: se reintenta el clic.
    }
  }
  await ui.waitFor(esperado, { timeout: 3000, label });
  return true;
}

async function cerrar(ui, selector, esperadoAusente) {
  for (let intento = 0; intento < 3; intento += 1) {
    if (await ui.evalJs(`!document.querySelector(${JSON.stringify(esperadoAusente)})`)) {
      await sleep(150);
      return;
    }
    if (await ui.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) {
      await ui.evalJs(
        `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
      );
      await sleep(120);
      await ui.clickEl(selector);
    }
    try {
      await ui.waitFor(`!document.querySelector(${JSON.stringify(esperadoAusente)})`, {
        timeout: 2500,
        label: "que el modal cierre",
      });
      await sleep(150);
      return;
    } catch {
      // La ventana sorda del CDP: se reintenta el cierre.
    }
  }
  await ui.waitFor(`!document.querySelector(${JSON.stringify(esperadoAusente)})`, {
    timeout: 3000,
    label: "que el modal cierre tras reintentos",
  });
  await sleep(150);
}

/** Vuelve al panel y espera la hidratación. */
async function panel(ui) {
  await ui.navigate(`${BASE_URL}/`);
  await ui.loginIfNeeded();
  await ui.waitFor(`!!document.getElementById("btn-expense")`, {
    timeout: 30000,
    label: "el panel",
  });
  await sleep(300);
}

/**
 * Tipea en un campo y VERIFICA que el valor quedó. `insertText` depende del
 * foco real; cuando el CDP pierde un foco (la ventana sorda), el fallback es el
 * setter nativo + `input`, que es lo que React escucha en `onChange`.
 */
async function tipearEn(ui, selector, texto) {
  const leer = () =>
    ui.evalJs(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
  for (let intento = 0; intento < 2; intento += 1) {
    await ui.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true; })()`,
    );
    await sleep(70);
    await ui.insertText(texto);
    if ((await leer()) === texto) return true;

    await ui.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(texto)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if ((await leer()) === texto) return true;
  }
  return false;
}

async function main() {
  const ui = await openUi({ port: 9366 });
  try {
    /* ── 1 · Las cinco vistas: recorrido completo con Tab ─────────────────── */
    const vistas = [
      ["/", "panel"],
      ["/analisis", "análisis"],
      ["/tarjetas", "tarjetas"],
      ["/prestamos", "préstamos"],
      ["/recurrencia", "recurrencia"],
    ];
    for (const [ruta, nombre] of vistas) {
      await ui.navigate(`${BASE_URL}${ruta}`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.querySelector("main")`, {
        timeout: 30000,
        label: `la vista ${nombre}`,
      });
      await sleep(700);
      const rec = await traverse(ui, { label: `vista ${nombre}` });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(
        vacios.length === 0,
        `vista ${nombre}: ningún botón sólo-icono sin nombre`,
        vacios.join(" | "),
      );
      console.log(
        `  · vista ${nombre}: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`,
      );
    }

    /* ── 2 · Modales de movimiento y cuenta: recorrido dentro del formulario ─ */
    await panel(ui);

    const modales = [
      ["#btn-expense", "#tx-form", "gasto", "#tx-cancel"],
      ["#btn-income", "#tx-form", "ingreso", "#tx-cancel"],
      ["#btn-transfer", "#tx-form", "transferencia", "#tx-cancel"],
      ["#btn-add-account", "#acc-form", "cuenta", "#acc-cancel"],
    ];
    for (const [abridor, form, nombre, cancelar] of modales) {
      await abrir(ui, abridor, `!!document.querySelector(${JSON.stringify(form)})`, `modal ${nombre}`);
      const rec = await traverse(ui, {
        label: `modal ${nombre}`,
        scopeSelector: form,
        max: 160,
      });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(
        vacios.length === 0,
        `modal ${nombre}: ningún botón sólo-icono sin nombre`,
        vacios.join(" | "),
      );
      console.log(
        `  · modal ${nombre}: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`,
      );
      await cerrar(ui, cancelar, form);
    }

    /* ── 3 · Préstamo, tarjeta y regla: los otros modales ─────────────────── */
    await ui.navigate(`${BASE_URL}/prestamos`);
    await ui.waitFor(`!!document.getElementById("loans-new")`, { timeout: 30000 });
    await sleep(600);
    await abrir(ui, "#loans-new", `!!document.getElementById("loan-form")`, "modal préstamo");
    {
      const rec = await traverse(ui, {
        label: "modal préstamo",
        scopeSelector: "#loan-form",
        max: 160,
      });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(vacios.length === 0, "modal préstamo: ningún botón sólo-icono sin nombre", vacios.join(" | "));
      console.log(`  · modal préstamo: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`);
    }
    await cerrar(ui, "#loanalta-close", "#loan-form");

    await ui.navigate(`${BASE_URL}/tarjetas`);
    await ui.waitFor(`!!document.querySelector('[id^="card-config-"]')`, { timeout: 30000 });
    await sleep(600);
    {
      const id = await ui.evalJs(`document.querySelector('[id^="card-config-"]')?.id ?? null`);
      await abrir(ui, `#${id}`, `!!document.getElementById("cardconf-form")`, "modal tarjeta");
      const rec = await traverse(ui, {
        label: "modal tarjeta",
        scopeSelector: "#cardconf-form",
        max: 120,
      });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(vacios.length === 0, "modal tarjeta: ningún botón sólo-icono sin nombre", vacios.join(" | "));
      console.log(`  · modal tarjeta: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`);
      await cerrar(ui, "#cardconf-close", "#cardconf-form");
    }

    await ui.navigate(`${BASE_URL}/recurrencia`);
    await ui.waitFor(`!!document.getElementById("rec-add-rule")`, { timeout: 30000 });
    await sleep(600);
    await abrir(ui, "#rec-add-rule", `!!document.getElementById("rec-form")`, "modal regla");
    {
      const rec = await traverse(ui, {
        label: "modal regla",
        scopeSelector: "#rec-form",
        max: 160,
      });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(vacios.length === 0, "modal regla: ningún botón sólo-icono sin nombre", vacios.join(" | "));
      console.log(`  · modal regla: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`);
    }
    await cerrar(ui, "#rec-form-close", "#rec-form");

    /* ── 4 · CSV, monedas y paleta: el foco del documento entero ──────────── */
    const otros = [
      ["#btn-import-csv", "#csv-text", "csv"],
      ["#btn-currency-settings", "#currency-settings-close", "monedas"],
      ["#btn-palette", "#palette-input", "paleta"],
    ];
    for (const [abridor, dentro, nombre] of otros) {
      await panel(ui);
      await abrir(ui, abridor, `!!document.querySelector(${JSON.stringify(dentro)})`, `modal ${nombre}`);
      const rec = await traverse(ui, {
        label: `modal ${nombre}`,
        scopeSelector: nombre === "paleta" ? "#command-palette" : "body",
        max: 220,
      });
      reportar(rec);
      const vacios = await ui.evalJs(iconOnlyExpression);
      check(
        vacios.length === 0,
        `modal ${nombre}: ningún botón sólo-icono sin nombre`,
        vacios.join(" | "),
      );
      console.log(
        `  · modal ${nombre}: ${rec.declarados} declarados / ${rec.tocados} tocados · sin foco: ${rec.sinFoco.length} · inalcanzables: ${rec.inalcanzables.length} · icon-only vacíos: ${vacios.length}`,
      );
      await ui.press("Escape");
      await sleep(400);
    }

    /* ── 4 · aria-live: guardado exitoso ──────────────────────────────────── */
    await panel(ui);
    await abrir(ui, "#btn-expense", `!!document.getElementById("tx-form")`, "modal gasto para guardar");
    // Monto único por corrida: el chequeo de duplicados compara cuenta + monto +
    // fecha + tipo. Un monto fijo haría que la SEGUNDA corrida se detenga en el
    // aviso de duplicado (y ese aviso también es correcto: por eso se usa un
    // monto distinto y, si igual aparece, se elige «Guardar igual»).
    const montoPrueba = `${1 + Math.floor(Math.random() * 8)},${String(
      Math.floor(Math.random() * 90),
    ).padStart(2, "0")}`;
    await ui.evalJs(`(() => { const el = document.getElementById("tx-amount"); el.focus(); el.select?.(); return true; })()`);
    const montoEscrito = await tipearEn(ui, "#tx-amount", montoPrueba);
    check(montoEscrito, "guardado exitoso: el monto de prueba quedó tipeado", montoPrueba);
    let toast = null;
    for (let intento = 0; intento < 3 && !toast; intento += 1) {
      await ui.evalJs(
        `document.getElementById("tx-submit")?.scrollIntoView({ block: "center" })`,
      );
      await sleep(150);
      await ui.clickEl("#tx-submit");
      await sleep(400);
      if (await ui.evalJs(`!!document.getElementById("tx-duplicate-warning")`)) {
        await ui.clickEl("#tx-duplicate-save");
      }
      try {
        toast = await ui.waitFor(
          `(() => {
            const t = document.getElementById("undo-toast");
            return t ? { live: t.getAttribute("aria-live"), role: t.getAttribute("role"), text: t.textContent.trim() } : null;
          })()`,
          { timeout: 5000, label: "el aviso de guardado" },
        );
      } catch {
        // La ventana sorda del CDP: se reintenta el guardado.
      }
    }
    if (!toast) {
      const estado = await ui.evalJs(`(() => ({
        amount: document.getElementById("tx-amount")?.value ?? null,
        submitDisabled: document.getElementById("tx-submit")?.disabled ?? null,
        form: !!document.getElementById("tx-form"),
        error: document.getElementById("tx-error")?.textContent?.trim() ?? null,
        duplicate: !!document.getElementById("tx-duplicate-warning"),
      }))()`);
      console.log(`  · estado del guardado que no llegó: ${JSON.stringify(estado)}`);
      toast = await ui.evalJs(`(() => {
        const t = document.getElementById("undo-toast");
        return t ? { live: t.getAttribute("aria-live"), role: t.getAttribute("role"), text: t.textContent.trim() } : null;
      })()`);
    }
    check(
      toast?.live === "polite" && toast?.role === "status",
      "guardado exitoso: el aviso está en una región aria-live=polite (role=status)",
      JSON.stringify(toast),
    );
    check(
      !!toast?.text?.includes("Movimiento guardado"),
      "guardado exitoso: el aviso dice «Movimiento guardado»",
      toast?.text ?? "",
    );
    for (let intento = 0; intento < 3; intento += 1) {
      if (!(await ui.evalJs(`!!document.getElementById("undo-button")`))) break;
      await ui.clickEl("#undo-button");
      try {
        await ui.waitFor(`!document.getElementById("undo-toast")`, {
          timeout: 4000,
          label: "que el deshacer cierre",
        });
        break;
      } catch {
        // Reintento.
      }
    }

    /* ── 5 · aria-live: error async (preview del CSV) ─────────────────────── */
    await panel(ui);
    await abrir(ui, "#btn-import-csv", `!!document.getElementById("csv-text")`, "modal csv");
    await ui.evalJs(`(() => { const el = document.getElementById("csv-text"); el.focus(); el.select?.(); return true; })()`);
    await ui.insertText("esto no es un csv");
    let csvError = null;
    for (let intento = 0; intento < 3 && !csvError; intento += 1) {
      await ui.clickEl("#csv-preview-button");
      try {
        csvError = await ui.waitFor(
          `(() => {
            const e = document.getElementById("csv-error");
            return e ? { live: e.getAttribute("aria-live"), role: e.getAttribute("role"), text: e.textContent.trim() } : null;
          })()`,
          { timeout: 4000, label: "el error del CSV" },
        );
      } catch {
        // Reintento.
      }
    }
    await ui.waitFor(`!!document.getElementById("csv-error")`, {
      timeout: 5000,
      label: "el error del CSV tras reintentos",
    });
    csvError =
      csvError ??
      (await ui.evalJs(`(() => {
        const e = document.getElementById("csv-error");
        return e ? { live: e.getAttribute("aria-live"), role: e.getAttribute("role"), text: e.textContent.trim() } : null;
      })()`));
    check(
      csvError?.live === "polite",
      "error async: el error del preview del CSV está en una región aria-live=polite",
      JSON.stringify(csvError),
    );
    await cerrar(ui, "#csv-cancel", "#csv-text");

    /* ── 5b · El error de validación se asocia al CAMPO ───────────────────── */
    await panel(ui);
    await abrir(ui, "#btn-expense", `!!document.getElementById("tx-form")`, "modal gasto para validar");
    await ui.evalJs(`(() => { const el = document.getElementById("tx-amount"); el.focus(); el.select?.(); return true; })()`);
    // Sin monto, el submit deja el error «Escribí un monto mayor a cero».
    for (let intento = 0; intento < 3; intento += 1) {
      await ui.clickEl("#tx-submit");
      await sleep(300);
      if (await ui.evalJs(`!!document.getElementById("tx-error")`)) break;
    }
    const validacion = await ui.evalJs(`(() => {
      const campo = document.getElementById("tx-amount");
      const error = document.getElementById("tx-error");
      return {
        invalid: campo?.getAttribute("aria-invalid"),
        describedby: campo?.getAttribute("aria-describedby"),
        error: error?.textContent?.trim() ?? null,
        errorLive: error?.getAttribute("aria-live") ?? null,
      };
    })()`);
    check(
      validacion.invalid === "true" &&
        validacion.describedby === "tx-error" &&
        validacion.error?.includes("monto"),
      "validación: el error del monto se asocia al campo (aria-invalid + aria-describedby)",
      JSON.stringify(validacion),
    );
    check(
      validacion.errorLive === "polite",
      "validación: el mensaje de error del formulario está en aria-live=polite",
      JSON.stringify(validacion),
    );
    await cerrar(ui, "#tx-cancel", "#tx-form");

    /* ── 6 · El foco vuelve al botón «Carga por voz» ──────────────────────── */
    await panel(ui);
    const trigger = await ui.evalJs(`(() => {
      const b = document.getElementById("btn-voice-capture");
      return b ? { aria: b.getAttribute("aria-label"), text: b.textContent.trim(), visible: b.getBoundingClientRect().width > 0 } : null;
    })()`);
    check(!!trigger, "el disparador de voz tiene id estable (#btn-voice-capture)", JSON.stringify(trigger));
    await abrir(ui, "#btn-voice-capture", `!!document.querySelector('[data-slot="dialog-content"]')`, "modal de voz");
    const focoEnModal = await ui.evalJs(`(() => {
      const el = document.activeElement;
      return { dentro: !!el?.closest('[data-slot="dialog-content"]'), tag: el?.tagName, id: el?.id };
    })()`);
    check(focoEnModal.dentro, "el modal de voz recibe el foco al abrir", JSON.stringify(focoEnModal));
    const vaciosVoz = await ui.evalJs(iconOnlyExpression);
    check(vaciosVoz.length === 0, "modal de voz: ningún botón sólo-icono sin nombre", vaciosVoz.join(" | "));
    await ui.press("Escape");
    await sleep(600);
    const focoAlCerrar = await ui.evalJs(`(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, id: el?.id || "", label: el?.getAttribute?.("aria-label") || "" };
    })()`);
    check(
      focoAlCerrar.id === "btn-voice-capture",
      "al cerrar el modal de voz el foco vuelve a «Carga por voz»",
      JSON.stringify(focoAlCerrar),
    );

    /* ── 7 · El glifo de 320: la pestaña «Transferencia» no roza la vecina ── */
    await ui.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 740,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await panel(ui);
    await abrir(ui, "#btn-expense", `!!document.getElementById("tx-form")`, "modal gasto a 320");
    const tabs = await ui.evalJs(`(() => {
      const ids = ["tx-kind-gasto", "tx-kind-ingreso", "tx-kind-transferencia"];
      const out = ids.map((id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const range = document.createRange();
        range.selectNodeContents(el);
        const tr = range.getBoundingClientRect();
        return {
          id,
          text: el.textContent,
          left: +r.left.toFixed(2),
          right: +r.right.toFixed(2),
          width: +r.width.toFixed(2),
          content: +(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)).toFixed(2),
          textLeft: +tr.left.toFixed(2),
          textRight: +tr.right.toFixed(2),
          textWidth: +tr.width.toFixed(2),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
        };
      });
      return {
        viewport: window.innerWidth,
        docScroll: document.documentElement.scrollWidth,
        tabs: out,
      };
    })()`);
    const transfer = tabs.tabs.find((t) => t.id === "tx-kind-transferencia");
    const ingreso = tabs.tabs.find((t) => t.id === "tx-kind-ingreso");
    check(
      transfer.textLeft >= transfer.left && transfer.textRight <= transfer.right,
      "320: el texto de «Transferencia» entra en su pestaña (no se adelanta)",
      JSON.stringify(transfer),
    );
    check(
      transfer.textLeft >= ingreso.right,
      "320: el texto de «Transferencia» no toca la pestaña vecina",
      `ingreso.right=${ingreso.right} · transferencia.textLeft=${transfer.textLeft}`,
    );
    check(
      tabs.docScroll <= tabs.viewport,
      "320: la vista no impone scroll horizontal",
      `docScroll=${tabs.docScroll} viewport=${tabs.viewport}`,
    );
    console.log(`  · pestañas a 320: ${JSON.stringify(tabs.tabs)}`);

    await ui.close();
  } catch (error) {
    await ui.close();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n[${TAG}] ERROR: ${error?.stack ?? error}`);
  fallas.push(`error de ejecución: ${error?.message ?? error}`);
}

console.log("");
if (fallas.length > 0) {
  console.log(`Fallaron ${fallas.length} checks:`);
  for (const f of fallas) console.log(`  · ${f}`);
} else {
  console.log("Todo OK.");
}
console.log(`RESULT ok=${ok} fail=${fallas.length}`);
process.exit(fallas.length === 0 ? 0 : 1);
