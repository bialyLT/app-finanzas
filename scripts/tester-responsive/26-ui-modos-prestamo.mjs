#!/usr/bin/env node
/**
 * Batería 26 · LA INTERFAZ del alta de préstamo por cuota (y total, y tasa)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * El formulario cambió: ahora pregunta "¿cómo lo cargás?" con tres modos
 * (`#loanalta-mode-PAYMENT|TOTAL|RATE`) y, en los dos modos derivados, el
 * campo de la tasa es de SOLO LECTURA (muestra la que derivó la app).
 *
 * Lo que se mide (con `elementFromPoint`, no con visibilidad):
 *
 *   1. GEOMETRÍA a 320 y 375 (y en landscape): los tres botones nuevos a 44 px
 *      con su malla 5×5 PROPIA, el botón de guardar NO tapado, el campo nuevo
 *      bajo el pliegue (no bajo la banda del pie) y el error visible.
 *   2. LOS TRES MODOS: el campo que corresponde en cada modo, la tasa de sólo
 *      lectura con su texto («te sale al 60,00 % anual»), y el paso a RATE al
 *      TOCAR el campo de la tasa (el invariante del flow 22: el texto derivado
 *      queda SELECCIONADO, así que el «60» que se tipea reemplaza al número).
 *   3. LA VISTA PREVIA EN VIVO: los cuatro números (cuota, interés total, total
 *      a devolver y tasa) y el error de la cuota insuficiente SIN scrollear.
 *   4. CAMBIAR DE MODO no pierde lo tipeado.
 *   5. El DEBOUNCE: la app no golpea la API en cada tecla.
 *   6. El DOBLE TOQUE en «Crear préstamo»: un solo préstamo.
 *   7. Lo que se MUESTRA es lo que se GUARDA (tasa y cronograma).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CDP Y NO MAESTRO
 * ─────────────────────────────────────────────────────────────────────────────
 * La geometría se JUZGA POR EL PUNTO DE TOQUE: un tap que cae bajo una capa
 * fija «completa sin error» y se pierde el dato. Maestro sólo expone un árbol
 * de sus artefactos; medir en vivo exige `getBoundingClientRect` +
 * `elementFromPoint`. Y el invariante del flow 22 (el texto seleccionado) no
 * se puede ver en un árbol.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS RIENDAS
 * ─────────────────────────────────────────────────────────────────────────────
 * Todo contra la instancia de PRUEBAS (`:3101`, base `finanzas_test`): la
 * persona está usando `:3000` y su base tiene datos reales.
 */

import {
  abrirModal,
  applyViewport,
  check,
  checkTrue,
  openUi,
  section,
  sleep,
  verifyViewport,
} from "./lib.mjs";
import { correrBateria } from "./lib-fase9r3.mjs";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3101";
const TAG = "T9R6";

/**
 * La medición: el rect VISIBLE de cada control (recortado por los
 * contenedores con overflow) y a quién le llega el punto de toque.
 *
 * Se hit-testea una malla de 5×5 puntos: un control al que le sobra un punto
 * de otro es un control con un borde que dispara al vecino.
 */
const MEDIR = `(() => {
  const panel = document.querySelector('[role="dialog"]');
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

  const controles = [];
  for (const el of panel.querySelectorAll("button, a, input, select, textarea, [role=button]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const vis = visibleRect(el);
    const invisible = vis.bottom - vis.top < 1 || vis.right - vis.left < 1;
    const malla = { total: 0, propio: 0, otros: {} };
    let hitCentro = null;
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
      hitCentro = nombre(document.elementFromPoint(cx, cy));
    }
    controles.push({
      id: el.id || null,
      tag: el.tagName.toLowerCase(),
      readOnly: el.readOnly === true,
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      visible: !invisible,
      hitCentro,
      malla,
      llegaCentro: !!(malla.total && malla.propio === malla.total),
    });
  }

  // La banda del pie: el HERMANO del área que scrollea (no un ancestro).
  const scroller = (() => {
    for (const el of panel.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") return el;
    }
    return null;
  })();
  const pie = scroller && scroller.nextElementSibling
    ? scroller.nextElementSibling.getBoundingClientRect()
    : null;

  return {
    controles,
    banda: pie ? { top: Math.round(pie.top), bottom: Math.round(pie.bottom) } : null,
    altoVentana: window.innerHeight,
    anchoVentana: window.innerWidth,
    scroll: scroller ? { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null,
  };
})()`;

/** Abre la app en una ruta y deja la sesión iniciada. */
async function abrir(ui, ruta) {
  await ui.navigate(`${BASE}${ruta}`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(700);
  await ui.loginIfNeeded();
  await sleep(400);
}

/**
 * Escribe un texto en un campo (con foco real).
 *
 * PRIMERO lo scrollea hasta el centro: a 320 y 375 el campo de la cuota
 * queda DEBAJO del pliegue y un click en unas coordenadas fuera de la
 * ventana no enfoca nada (el texto se pierde en silencio: el «tap muerto»
 * de las trampas de `flows/README.md`).
 */
async function escribir(ui, selector, texto, { porTecla = false } = {}) {
  await ui.evalJs(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
  );
  await sleep(280);
  const c = await ui.centerOf(selector);
  if (!c) throw new Error(`No existe ${selector}`);
  await ui.clickAt(c.x, c.y);
  await sleep(120);
  if (porTecla) {
    for (const ch of texto) {
      await ui.insertText(ch);
      await sleep(45);
    }
  } else {
    await ui.insertText(texto);
  }
  await sleep(250);
}

/** Vacía un campo de la forma que React ve (el setter nativo + input). */
async function vaciar(ui, selector) {
  await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    ).set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
}

/**
 * El área que scrollea del modal, arriba del todo.
 *
 * Importa porque un click en unas coordenadas FUERA de la ventana no enfoca
 * nada: es el «tap muerto» de las trampas de `flows/README.md`. Si el
 * formulario quedó scrolleado, tocar un botón de arriba es tocar la nada.
 */
async function scrollAlTope(ui) {
  await ui.evalJs(`(() => {
    const panel = document.querySelector('[role="dialog"]');
    for (const el of panel.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        el.scrollTop = 0;
        return true;
      }
    }
    return false;
  })()`);
  await sleep(300);
}

/** El estado del formulario, leído del DOM. */
const ESTADO = `(() => {
  const q = (s) => document.querySelector(s);
  const modo = (m) => {
    const b = q("#loanalta-mode-" + m);
    return b ? b.getAttribute("aria-pressed") === "true" : null;
  };
  const tna = q("#loanalta-tna");
  const previews = q("#loanalta-preview");
  const error = q("#loanalta-preview-error");
  return {
    modoPAYMENT: modo("PAYMENT"),
    modoTOTAL: modo("TOTAL"),
    modoRATE: modo("RATE"),
    tnaReadOnly: tna ? tna.readOnly : null,
    tnaValue: tna ? tna.value : null,
    tnaSeleccionado: tna
      ? (tna.selectionStart === 0 && tna.selectionEnd === tna.value.length && tna.value.length > 0)
      : null,
    paymentValue: q("#loanalta-payment") ? q("#loanalta-payment").value : null,
    totalValue: q("#loanalta-total") ? q("#loanalta-total").value : null,
    derivado: q("#loanalta-tna-derived") ? q("#loanalta-tna-derived").textContent.trim() : null,
    preview: previews ? previews.textContent.replace(/\\s+/g, " ").trim() : null,
    previewRate: q("#loanalta-preview-rate") ? q("#loanalta-preview-rate").textContent.replace(/\\s+/g, " ").trim() : null,
    error: error ? error.textContent.replace(/\\s+/g, " ").trim() : null,
    errorVisible: error ? (() => {
      const r = error.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.height > 0;
    })() : null,
    foco: document.activeElement ? document.activeElement.id : null,
  };
})()`;

async function main(prisma) {
  const ui = await openUi({
    port: 9376,
    profileDir: `${process.env.TEMP}\\opencode\\tester-r6-profile-9376`,
  });

  try {
    /* ───────────────────────────────────────────────────────────────────────
     * 0 · EL FIXTURE QUE FALTA: una cuenta de DINERO
     * ───────────────────────────────────────────────────────────────────────
     * El formulario de préstamo sólo habilita «Crear préstamo» si hay una
     * cuenta de banco o efectivo (el desembolso es una transferencia entre
     * cuentas): sin ella el botón queda DESHABILITADO y el alta no ocurre
     * (no es un error: es el botón apagado). La batería tiene que sembrar esa
     * cuenta o el alta que prueba no se puede hacer.
     *
     * Se borra por id en el `limpiar` (que corre antes y después).
     */
    const caja = await prisma.account.create({
      data: {
        name: `${TAG} caja`,
        kind: "CASH",
        openingBalance: "100000.00",
      },
    });
    console.log(`  fixture de dinero: ${caja.id}`);

    /* ───────────────────────────────────────────────────────────────────────
     * 1 · GEOMETRÍA (320 · 375 · landscape)
     * ─────────────────────────────────────────────────────────────────────── */
    const VIEWPORTS = [
      { name: "320 angosto", width: 320, height: 568 },
      { name: "375 iphone", width: 375, height: 667 },
      { name: "667 landscape", width: 667, height: 375 },
    ];

    for (const vp of VIEWPORTS) {
      section(`Geometria · ${vp.name}`);
      await applyViewport(ui, vp, { touch: true });
      await abrir(ui, "/prestamos");
      await verifyViewport(ui, vp, { touch: true });
      await abrirModal(ui, "#loans-new", '[role="dialog"]');
      await sleep(300);

      // El formulario CARGADO (con la vista previa): el estado real.
      await escribir(ui, "#loanalta-name", "Sonda");
      await escribir(ui, "#loanalta-principal", "500000");
      await escribir(ui, "#loanalta-count", "12");
      await escribir(ui, "#loanalta-payment", "56412,71");
      await sleep(1200);

      // La geometría se mide en el estado donde el control es ALCANZABLE:
      // el selector de modo está ARRIBA (con el scroll en cero) y el campo de
      // la cuota está ABAJO (hay que scrollearlo). Medir un control en un
      // estado donde nadie lo alcanzaría es medirlo mal.
      await scrollAlTope(ui);
      const datos = await ui.evalJs(MEDIR);
      const porId = Object.fromEntries(
        datos.controles.filter((c) => c.id).map((c) => [c.id, c]),
      );

      // (a) Los tres botones de modo: 44 px y con su malla PROPIA.
      for (const modo of ["PAYMENT", "TOTAL", "RATE"]) {
        const id = `loanalta-mode-${modo}`;
        const c = porId[id];
        checkTrue(`${vp.name}: existe ${id}`, !!c, "no esta en el DOM");
        if (!c) continue;
        checkTrue(
          `${vp.name}: ${id} mide 44 px o mas de alto`,
          c.h >= 44,
          `mide ${c.h} px`,
        );
        checkTrue(
          `${vp.name}: ${id} es VISIBLE`,
          c.visible,
          `y=${c.top}..${c.bottom}`,
        );
        checkTrue(
          `${vp.name}: la malla 5x5 de ${id} es 100 % propia`,
          c.malla.total === 25 && c.malla.propio === 25,
          `propio ${c.malla.propio}/${c.malla.total} · otros ${JSON.stringify(c.malla.otros)}`,
        );
      }

      // (b) El botón de guardar: NO tapado.
      const submit = porId["loanalta-submit"];
      checkTrue(`${vp.name}: existe #loanalta-submit`, !!submit, "no esta en el DOM");
      if (submit) {
        checkTrue(
          `${vp.name}: el boton de guardar es visible`,
          submit.visible,
          `y=${submit.top}..${submit.bottom}`,
        );
        checkTrue(
          `${vp.name}: el centro del boton de guardar llega al boton`,
          submit.hitCentro === "loanalta-submit",
          `llega a ${submit.hitCentro}`,
        );
        checkTrue(
          `${vp.name}: la malla 5x5 del boton de guardar es 100 % propia`,
          submit.malla.total === 25 && submit.malla.propio === 25,
          `propio ${submit.malla.propio}/${submit.malla.total} · otros ${JSON.stringify(submit.malla.otros)}`,
        );
      }

      // (c) El campo nuevo: bajo el pliegue (alcanzable scrolleando) y NUNCA
      //     bajo la banda del pie (que es un hermano del scroller).
      const payment = porId["loanalta-payment"];
      checkTrue(`${vp.name}: existe #loanalta-payment`, !!payment, "no esta en el DOM");
      if (payment) {
        checkTrue(
          `${vp.name}: el campo de la cuota NO esta tapado por la banda del pie`,
          !(datos.banda && payment.visible && payment.top >= datos.banda.top),
          `campo y=${payment.top}..${payment.bottom} · banda ${datos.banda?.top}`,
        );
      }

      // (d) El campo nuevo tiene que ser ALCANZABLE: al scrollear hasta él
      //     queda ENTERO, con su malla propia y por encima de la banda.
      //     (No se mide «al final del scroll»: el campo de la cuota está en
      //     el MEDIO del formulario, así que al final del scroll queda arriba
      //     de la ventana: eso no es un defecto, es la posición del campo.)
      await ui.evalJs(
        `document.querySelector("#loanalta-payment")?.scrollIntoView({ block: "center" })`,
      );
      await sleep(500);
      const alcance = await ui.evalJs(MEDIR);
      const alcancePorId = Object.fromEntries(
        alcance.controles.filter((c) => c.id).map((c) => [c.id, c]),
      );
      const paymentAlcanzable = alcancePorId["loanalta-payment"];
      if (paymentAlcanzable) {
        checkTrue(
          `${vp.name}: el campo de la cuota es ALCANZABLE (visible al scrollear)`,
          paymentAlcanzable.visible,
          `y=${paymentAlcanzable.top}..${paymentAlcanzable.bottom}`,
        );
        checkTrue(
          `${vp.name}: el campo de la cuota llega a si mismo cuando se lo alcanza`,
          paymentAlcanzable.hitCentro === "loanalta-payment",
          `llega a ${paymentAlcanzable.hitCentro}`,
        );
        checkTrue(
          `${vp.name}: la malla 5x5 del campo de la cuota es 100 % propia`,
          paymentAlcanzable.malla.total === 25 &&
            paymentAlcanzable.malla.propio === 25,
          `propio ${paymentAlcanzable.malla.propio}/${paymentAlcanzable.malla.total} · otros ${JSON.stringify(paymentAlcanzable.malla.otros)}`,
        );
        checkTrue(
          `${vp.name}: el campo de la cuota NO queda bajo la banda del pie`,
          !(alcance.banda && paymentAlcanzable.bottom > alcance.banda.top),
          `campo hasta ${paymentAlcanzable.bottom} · banda desde ${alcance.banda?.top}`,
        );
      }
      const submitAlcance = alcancePorId["loanalta-submit"];
      if (submitAlcance) {
        checkTrue(
          `${vp.name}: el boton de guardar sigue llegando a si mismo con el formulario scrolleado`,
          submitAlcance.hitCentro === "loanalta-submit",
          `llega a ${submitAlcance.hitCentro}`,
        );
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * 2 · LOS TRES MODOS (a 375, con la ventana real del runner)
     * ─────────────────────────────────────────────────────────────────────── */
    section("Los tres modos (375)");

    await applyViewport(ui, { width: 375, height: 667 }, { touch: true });
    await abrir(ui, "/prestamos");
    await verifyViewport(ui, { width: 375, height: 667 }, { touch: true });
    await abrirModal(ui, "#loans-new", '[role="dialog"]');
    await sleep(300);

    // El estado inicial: PAYMENT (el default) y la tasa de sólo lectura.
    let estado = await ui.evalJs(ESTADO);
    check("modo inicial: PAYMENT", estado.modoPAYMENT, true);
    check("modo inicial: la tasa es de SOLO LECTURA", estado.tnaReadOnly, true);
    check("modo inicial: no hay campo de total", estado.totalValue, null);
    checkTrue(
      "modo inicial: hay campo de cuota",
      estado.paymentValue !== null,
      JSON.stringify(estado),
    );

    // Cargar los datos y ver la vista previa EN VIVO.
    await escribir(ui, "#loanalta-principal", "500000");
    await escribir(ui, "#loanalta-count", "12");
    await escribir(ui, "#loanalta-payment", "56412,71");
    await sleep(1500);

    estado = await ui.evalJs(ESTADO);
    checkTrue(
      "la vista previa muestra la cuota (56.412,71)",
      /12 cuotas de .*56\.412,71/.test(estado.preview ?? ""),
      estado.preview,
    );
    checkTrue(
      "la vista previa muestra el total a devolver (676.952,44)",
      /676\.952,44/.test(estado.preview ?? ""),
      estado.preview,
    );
    checkTrue(
      "la vista previa muestra el interes total (176.952,44)",
      /176\.952,44/.test(estado.preview ?? ""),
      estado.preview,
    );
    checkTrue(
      "la vista previa muestra la tasa (60,00 % anual)",
      /60,00\s*%\s*anual/.test(estado.previewRate ?? ""),
      estado.previewRate,
    );
    check(
      "el campo de la tasa muestra la tasa derivada",
      estado.tnaValue,
      "60.0000",
    );
    checkTrue(
      "el texto de la tasa derivada dice «te sale al ...»",
      /te sale al/i.test(estado.derivado ?? ""),
      estado.derivado,
    );

    // El DEBOUNCE: los requests a la vista previa mientras se tipea.
    await ui.evalJs(`(() => {
      window.__calls = [];
      if (!window.__fetchOriginal) window.__fetchOriginal = window.fetch;
      window.fetch = function (...args) {
        const url = String(args[0]);
        if (url.includes("/api/loans/preview")) window.__calls.push(url);
        return window.__fetchOriginal.apply(this, args);
      };
      return true;
    })()`);
    await vaciar(ui, "#loanalta-payment");
    await escribir(ui, "#loanalta-payment", "123456,78", { porTecla: true });
    await sleep(1500);
    const calls = await ui.evalJs(`window.__calls.length`);
    checkTrue(
      "la app NO golpea la API en cada tecla (debounce)",
      calls <= 2,
      `${calls} requests a /api/loans/preview por 9 teclas`,
    );

    // La cuota insuficiente: el error tiene que verse SIN scrollear.
    await vaciar(ui, "#loanalta-payment");
    await escribir(ui, "#loanalta-payment", "41666,66");
    await sleep(1500);
    estado = await ui.evalJs(ESTADO);
    checkTrue(
      "la cuota insuficiente muestra un error",
      !!estado.error,
      JSON.stringify(estado),
    );
    checkTrue(
      "el error dice que no alcanza para cubrir el capital",
      /no alcanza para cubrir el capital/i.test(estado.error ?? ""),
      estado.error,
    );
    checkTrue(
      "el error trae la cuota minima (41.666,67)",
      /41666\.67/.test(estado.error ?? ""),
      estado.error,
    );
    check(
      "el error es VISIBLE sin scrollear",
      estado.errorVisible,
      true,
    );

    // Cambiar de modo NO pierde lo tipeado.
    await vaciar(ui, "#loanalta-payment");
    await escribir(ui, "#loanalta-payment", "56412,71");
    await sleep(900);
    await scrollAlTope(ui);
    await ui.clickEl("#loanalta-mode-TOTAL");
    await sleep(600);
    estado = await ui.evalJs(ESTADO);
    check("modo TOTAL: el modo es TOTAL", estado.modoTOTAL, true);
    check("modo TOTAL: aparece el campo de total", estado.totalValue !== null, true);
    check("modo TOTAL: NO aparece el campo de cuota", estado.paymentValue, null);
    await escribir(ui, "#loanalta-total", "676952,44");
    await sleep(1500);
    estado = await ui.evalJs(ESTADO);
    checkTrue(
      "modo TOTAL: la vista previa da la misma cuota (56.412,71)",
      /12 cuotas de .*56\.412,71/.test(estado.preview ?? ""),
      estado.preview,
    );
    checkTrue(
      "modo TOTAL: la misma tasa (60,00 % anual)",
      /60,00\s*%\s*anual/.test(estado.previewRate ?? ""),
      estado.previewRate,
    );

    // Volver a «Por mes»: la cuota tipeada sigue ahí.
    await scrollAlTope(ui);
    await ui.clickEl("#loanalta-mode-PAYMENT");
    await sleep(600);
    estado = await ui.evalJs(ESTADO);
    check(
      "volver a «Por mes»: la cuota tipeada NO se perdio",
      estado.paymentValue,
      "56412,71",
    );
    check(
      "volver a «Por mes»: el campo de total desaparece",
      estado.totalValue,
      null,
    );

    /* ───────────────────────────────────────────────────────────────────────
     * 3 · EL INVARIANTE DEL FLOW 22 (tocar la tasa → modo RATE, texto
     *     seleccionado) y el modo RATE editable de verdad
     * ─────────────────────────────────────────────────────────────────────── */
    section("El modo RATE y el invariante del flow 22");

    // TOCAR el campo de la tasa (que en PAYMENT es de sólo lectura).
    await scrollAlTope(ui);
    const c = await ui.centerOf("#loanalta-tna");
    await ui.clickAt(c.x, c.y);
    await sleep(800);
    estado = await ui.evalJs(ESTADO);
    check("tocar la tasa: el modo pasa a RATE", estado.modoRATE, true);
    check("tocar la tasa: el campo deja de ser de solo lectura", estado.tnaReadOnly, false);
    checkTrue(
      "tocar la tasa: el texto derivado queda SELECCIONADO",
      estado.tnaSeleccionado === true,
      JSON.stringify(estado),
    );

    // Escribir «60»: tiene que REEMPLAZAR al número, no pegarse al final.
    await ui.insertText("60");
    await sleep(1200);
    estado = await ui.evalJs(ESTADO);
    check(
      "tipear 60: el campo de la tasa queda en «60» (no «60.000060»)",
      estado.tnaValue,
      "60",
    );
    checkTrue(
      "tipear 60 a mano: la vista previa da la MISMA cuota que la cuota cargada",
      /12 cuotas de .*56\.412,71/.test(estado.preview ?? ""),
      estado.preview,
    );

    /* ───────────────────────────────────────────────────────────────────────
     * 4 · EL DOBLE TOQUE en «Crear préstamo»: UN solo préstamo
     * ─────────────────────────────────────────────────────────────────────── */
    section("El doble toque en «Crear prestamo»");

    await vaciar(ui, "#loanalta-name");
    await escribir(ui, "#loanalta-name", `${TAG} doble toque`);
    const antes = await prisma.account.count({
      where: { name: `${TAG} doble toque` },
    });
    // El botón tiene que estar HABILITADO: sin una cuenta de dinero el
    // formulario lo deja apagado (el desembolso es una transferencia entre
    // cuentas) y el alta no ocurre. Conviene que el diagnóstico esté explícito.
    const submitHabilitado = await ui.evalJs(
      `(() => { const b = document.querySelector("#loanalta-submit"); return b ? !b.disabled : null; })()`,
    );
    check("el boton de guardar esta HABILITADO", submitHabilitado, true);
    const s1 = await ui.centerOf("#loanalta-submit");
    await ui.clickAt(s1.x, s1.y);
    await sleep(60);
    await ui.clickAt(s1.x, s1.y);
    await sleep(3000);
    const despues = await prisma.account.count({
      where: { name: `${TAG} doble toque` },
    });
    check(
      "el doble toque crea UN SOLO prestamo",
      despues - antes,
      1,
    );

    // Cerrar el modal (el paso del desembolso: «Ahora no»).
    await ui.evalJs(`(() => {
      const b = document.querySelector("#loanalta-disburse-skip");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(1500);

    /* ───────────────────────────────────────────────────────────────────────
     * 5 · EL ALTA POR CUOTA: lo que se guarda es lo que se mostró
     * ─────────────────────────────────────────────────────────────────────── */
    section("El alta por cuota: lo guardado es lo mostrado");

    await abrir(ui, "/prestamos");
    await abrirModal(ui, "#loans-new", '[role="dialog"]');
    await sleep(300);
    await escribir(ui, "#loanalta-name", `${TAG} alta por cuota`);
    await escribir(ui, "#loanalta-principal", "500000");
    await escribir(ui, "#loanalta-count", "12");
    await escribir(ui, "#loanalta-payment", "56412,71");
    await sleep(1500);
    const estadoPrevio = await ui.evalJs(ESTADO);
    checkTrue(
      "antes de guardar: la vista previa muestra la cuota (56.412,71)",
      /12 cuotas de .*56\.412,71/.test(estadoPrevio.preview ?? ""),
      estadoPrevio.preview,
    );
    await ui.clickEl("#loanalta-submit");
    await sleep(3000);
    await ui.evalJs(`(() => {
      const b = document.querySelector("#loanalta-disburse-skip");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(1500);

    const cuenta = await prisma.account.findFirst({
      where: { name: `${TAG} alta por cuota` },
      orderBy: { createdAt: "desc" },
    });
    checkTrue("el prestamo se creo", !!cuenta, "no esta en la base");
    if (cuenta) {
      check(
        "la tasa guardada es la derivada (60,0000 %)",
        cuenta.tnaPercent.toFixed(4),
        "60.0000",
      );
      const filas = await prisma.installment.findMany({
        where: { accountId: cuenta.id },
        orderBy: { number: "asc" },
      });
      check(
        "la primera cuota guardada es 56.412,71",
        filas[0].payment.toFixed(2),
        "56412.71",
      );
      check(
        "el cronograma cierra en 0 EXACTO",
        filas[filas.length - 1].remainingBalance.toFixed(2),
        "0.00",
      );
      check(
        "el cronograma amortiza exactamente el capital",
        filas
          .reduce((acc, i) => acc + Number(i.principal.toFixed(2)), 0)
          .toFixed(2),
        "500000.00",
      );
    }
  } finally {
    await ui.close();
  }
}

correrBateria({
  etiqueta: "bateria 26 (UI)",
  main,
  limpiar: async (prisma) => {
    const cuentas = await prisma.account.findMany({
      where: { name: { startsWith: `${TAG} ` } },
      select: { id: true },
    });
    const ids = cuentas.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
      await prisma.movement.deleteMany({
        where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
      });
      await prisma.account.deleteMany({ where: { id: { in: ids } } });
    }
  },
});
