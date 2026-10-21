#!/usr/bin/env node
/**
 * 20-formulario-y-panel-320 · EL AVISO DEL CRUCE Y LA GEOMETRÍA A 320 px
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * QUÉ VERIFICA
 *
 * A · EL FORMULARIO DE RECURRENCIA: si escribís a mano el nombre de una
 *     categoría del OTRO TIPO, tiene que aparecer un aviso junto al campo y un
 *     botón que deriva el tipo de la regla sin perder lo escrito.
 *
 * B · LA GEOMETRÍA A 320 px: el formulario es una SECCIÓN DE PÁGINA con pie
 *     pegajoso, no un modal. El aviso agrega altura: si tapa el botón de
 *     guardar, o si el pie pegajoso tapa el aviso, es un bug (un aviso que no
 *     se lee es un aviso que no existe).
 *
 * C · EL TEXTO NUEVO DEL PANEL en el rango 320→1024: las tarjetas crecen (dos
 *     textos más) y los montos tienen que SEGUIR ENTRANDO en sus cajas. Un
 *     número partido dentro de su tarjeta es una mentira.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE MIDE
 *
 * Con CDP (Chrome real), no con Maestro: hacen falta números de geometría
 * (`getBoundingClientRect`) y el punto de toque real (`elementFromPoint`). La
 * emulación de device se VERIFICA: si el viewport emulado no es el pedido, la
 * batería falla (medir sobre otro viewport es peor que no medir).
 *
 * Las dos categorías que usa son PROPIAS (se crean y se borran): el aviso
 * depende del cruce de tipos, no del seed.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { setTimeout as sleep } from "node:timers/promises";
import { openUi } from "../tester-fase7/cdp.mjs";
import {
  applyViewport,
  verifyViewport,
  medir,
  desborde,
  geometria,
} from "./lib.mjs";
import {
  BASE,
  check,
  checkTrue,
  checkIncluye,
  counters,
  failures,
  login,
  post,
  del,
  get,
  section,
} from "./lib-fase9r3.mjs";

const VP = { width: 320, height: 640 };
const ANCHOS = [320, 360, 414, 480, 600, 768, 900, 1024];

const NOMBRE_GASTO = "T F9R3 UI Gasto";
const NOMBRE_INGRESO = "T F9R3 UI Ingreso";

function resumen() {
  const { passed, failed } = counters;
  console.log(`\n──────── ${passed} ok · ${failed} fallas ────────`);
  if (failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`RESULT ok=${passed} fail=${failed}`);
  return failed === 0;
}

/** El texto de un elemento (o null). */
const textoDe = (ui, selector) =>
  ui.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
       return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : null; })()`,
  );

const existe = (ui, selector) =>
  ui.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);

/** El tipo de la regla que está seleccionado en el formulario. */
const tipoSeleccionado = (ui) =>
  ui.evalJs(
    `(() => {
       const activo = (b) => b && (b.className.includes("bg-emerald") || b.className.includes("bg-rose") || b.className.includes("bg-sky"));
       const ing = document.querySelector("#rec-kind-INCOME");
       const gas = document.querySelector("#rec-kind-EXPENSE");
       if (activo(ing)) return "INCOME";
       if (activo(gas)) return "EXPENSE";
       return "NINGUNO";
     })()`,
  );

const ui = await openUi({
  port: 9334,
  profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\f9r3-cdp-profile`,
});

const categoriasCreadas = [];
let fallo = null;

try {
  /* ── Sesión de API (para crear y borrar las categorías propias) ───────── */
  await login();

  /* ── Las dos categorías propias (una de cada tipo) ───────────────────── */
  const catGasto = await post("/api/categories", { name: NOMBRE_GASTO, kind: "EXPENSE" });
  const catIngreso = await post("/api/categories", { name: NOMBRE_INGRESO, kind: "INCOME" });
  checkTrue("A0 · se pudo crear la categoría de Gasto", catGasto.status === 200 || catGasto.status === 201, `status ${catGasto.status}`);
  checkTrue("A0 · se pudo crear la categoría de Ingreso", catIngreso.status === 200 || catIngreso.status === 201, `status ${catIngreso.status}`);
  if (catGasto.body?.id) categoriasCreadas.push(catGasto.body.id);
  if (catIngreso.body?.id) categoriasCreadas.push(catIngreso.body.id);

  /* ══════════════════════════════════════════════════════════════════════
   * A + B · EL FORMULARIO DE RECURRENCIA A 320 px
   * ══════════════════════════════════════════════════════════════════════ */
  section("A · El aviso del cruce (formulario de recurrencia, 320 px)");

  await applyViewport(ui, VP);
  await ui.navigate(`${BASE}/recurrencia`);
  await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
  await sleep(900);
  await ui.loginIfNeeded();
  await sleep(700);
  await verifyViewport(ui, VP);

  checkTrue(
    "A0 · la pantalla de recurrencia abrió en la instancia de pruebas",
    await existe(ui, "#rec-add-rule"),
  );

  // Abrir el formulario con un click REAL.
  const rectAdd = await ui.centerOf("#rec-add-rule");
  await ui.clickAt(rectAdd.x, rectAdd.y);
  await ui.waitFor(`!!document.querySelector("#rec-form")`, {
    timeout: 8000,
    label: "el formulario",
  });
  checkTrue("A0 · el formulario se abrió", await existe(ui, "#rec-form"));

  const tipoInicial = await tipoSeleccionado(ui);
  checkTrue("A0 · el tipo por defecto se puede leer", tipoInicial !== "NINGUNO", tipoInicial);

  // La categoría del OTRO tipo: la que dispara el aviso.
  const nombreUsado = tipoInicial === "INCOME" ? NOMBRE_GASTO : NOMBRE_INGRESO;
  const otroTipo = tipoInicial === "INCOME" ? "Gasto" : "Ingreso";

  // Escribirla en el campo (foco real + insertText).
  await ui.evalJs(
    `document.querySelector("#rec-category").scrollIntoView({ block: "center" })`,
  );
  await sleep(300);
  const rectCat = await ui.centerOf("#rec-category");
  await ui.clickAt(rectCat.x, rectCat.y);
  await sleep(200);
  const enfocado = await ui.evalJs(`document.activeElement && document.activeElement.id`);
  check("A1 · el campo de categoría recibió el foco", enfocado, "rec-category");
  await ui.insertText(nombreUsado);
  await sleep(800);

  const hayAviso = await existe(ui, "#rec-category-conflict");
  checkTrue("A2 · al escribir la categoría del otro tipo aparece el aviso", hayAviso);

  if (hayAviso) {
    const textoAviso = await textoDe(ui, "#rec-category-conflict");
    checkIncluye("A2 · el aviso nombra la categoría", textoAviso, nombreUsado);
    checkIncluye(
      "A2 · el aviso dice de qué tipo es la categoría",
      String(textoAviso),
      otroTipo,
    );

    const hayBoton = await existe(ui, "#rec-category-fix");
    checkTrue("A3 · hay un botón que deriva el tipo", hayBoton);
    const textoBoton = await textoDe(ui, "#rec-category-fix");
    checkIncluye("A3 · el botón ofrece usarla como el otro tipo", textoBoton, "Usarla como");
    checkIncluye(
      "A3 · y dice cuál (gasto o ingreso)",
      String(textoBoton).toLowerCase(),
      otroTipo.toLowerCase(),
    );

    /* ────────────────────────────────────────────────────────────────────
     * B · LA GEOMETRÍA (con el aviso ABIERTO)
     * ──────────────────────────────────────────────────────────────────── */
    section("B · La geometría a 320 px con el aviso abierto");

    // B1 · el botón de guardar tiene que ser TOCABLE: su punto de toque tiene
    //      que llegar a él, no al pie pegajoso ni a otro control.
    const geoSubmit = await geometria(ui, "#rec-form-submit");
    checkTrue("B1 · el botón de guardar existe", geoSubmit.existe);
    checkTrue(
      "B1 · el punto de toque del botón de guardar LLEGA al botón",
      geoSubmit.llega,
      `llega a "${geoSubmit.hit}"`,
    );

    // B2 · el pie pegajoso no puede tapar el aviso: un aviso que no se lee es
    //      un aviso que no existe.
    await ui.evalJs(
      `document.querySelector("#rec-category-conflict").scrollIntoView({ block: "center" })`,
    );
    await sleep(400);
    const geoAviso = await geometria(ui, "#rec-category-conflict");
    const geoPie = await geometria(ui, "#rec-form-submit");
    checkTrue(
      "B2 · el aviso está por ENCIMA del pie pegajoso (se puede leer)",
      geoAviso.bottom <= geoPie.top + 1,
      `aviso hasta ${Math.round(geoAviso.bottom)} · pie desde ${Math.round(geoPie.top)}`,
    );

    // B3 · el documento no se sale del ancho del device.
    const ancho = await ui.evalJs(
      `({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, screen: window.screen.width })`,
    );
    checkTrue(
      "B3 · el documento no desborda el ancho del device (320)",
      ancho.scroll <= VP.width + 1,
      `scrollWidth=${ancho.scroll} · innerWidth=${ancho.inner} · screen=${ancho.screen}`,
    );

    // B4 · el botón que deriva el tipo: al apretarlo, el tipo de la regla
    //      cambia y el aviso desaparece.
    const rectFix = await ui.centerOf("#rec-category-fix");
    await ui.clickAt(rectFix.x, rectFix.y);
    await sleep(800);
    const tipoDespues = await tipoSeleccionado(ui);
    checkTrue(
      "B4 · el botón derivó el tipo de la regla",
      tipoDespues !== "NINGUNO" && tipoDespues !== tipoInicial,
      `antes ${tipoInicial} · después ${tipoDespues}`,
    );
    const avisoDespues = await existe(ui, "#rec-category-conflict");
    checkTrue("B4 · y con el tipo derivado el aviso desaparece", !avisoDespues);

    // B5 · lo escrito NO se pierde: la categoría sigue en el campo.
    const valorCampo = await ui.evalJs(
      `document.querySelector("#rec-category")?.value ?? ""`,
    );
    check("B5 · lo escrito no se perdió al derivar el tipo", valorCampo, nombreUsado);

    // B6 · y con el tipo correcto, el botón de guardar sigue siendo tocable.
    const geoSubmit2 = await geometria(ui, "#rec-form-submit");
    checkTrue(
      "B6 · el botón de guardar sigue siendo tocable después de derivar",
      geoSubmit2.llega,
      `llega a "${geoSubmit2.hit}"`,
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * C · EL TEXTO NUEVO DEL PANEL EN EL RANGO 320→1024
   * ══════════════════════════════════════════════════════════════════════ */
  section("C · El panel con el texto nuevo, de 320 a 1024 px");

  for (const ancho of ANCHOS) {
    const vp = { width: ancho, height: 720 };
    await applyViewport(ui, vp);
    await ui.navigate(`${BASE}/`);
    await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
    await sleep(700);
    await ui.loginIfNeeded();
    await sleep(500);
    const probe = await verifyViewport(ui, vp);

    const { data } = await medir(ui, vp);

    checkTrue(
      `C · ${ancho}px · el viewport emulado es el pedido`,
      probe.screen === ancho,
      `screen=${probe.screen}`,
    );
    checkTrue(
      `C · ${ancho}px · el documento no desborda`,
      !desborde(data, vp),
      `scrollWidth=${data.scrollWidth} · innerWidth=${data.innerWidth}`,
    );
    checkTrue(
      `C · ${ancho}px · ningún texto queda partido dentro de su caja`,
      (data.overflowers ?? []).length === 0,
      JSON.stringify((data.overflowers ?? []).slice(0, 3)),
    );
    checkTrue(
      `C · ${ancho}px · no hay un scroller horizontal interno`,
      (data.innerScroll ?? []).length === 0,
      JSON.stringify((data.innerScroll ?? []).slice(0, 3)),
    );

    // El texto nuevo tiene que estar, y completo.
    const cuerpo = await ui.evalJs(`document.body.innerText`);
    checkIncluye(
      `C · ${ancho}px · el panel dice que el ahorro es de este mes`,
      cuerpo,
      "de lo que ganaste este mes",
    );
    checkIncluye(
      `C · ${ancho}px · el panel aclara que el saldo inicial no es ganancia`,
      cuerpo,
      "El saldo inicial no cuenta como ganancia",
    );
    checkIncluye(
      `C · ${ancho}px · el panel dice que la plata que entró y salió es de este mes`,
      cuerpo,
      "La plata que entró y salió de tus cuentas este mes",
    );
  }
} catch (error) {
  fallo = error;
  console.error(`\nLa batería falló: ${error.message ?? error}`);
  checkTrue("20 · la batería termina sin excepción", false, String(error.message ?? error));
} finally {
  await ui.close();
  // Las categorías propias se borran POR ID (están libres: no las usa nada).
  for (const id of categoriasCreadas) {
    await del(`/api/categories?id=${encodeURIComponent(id)}`);
  }
  console.log(
    categoriasCreadas.length
      ? `  categorías propias borradas (${categoriasCreadas.length})`
      : "  no había categorías propias que borrar",
  );
}

const bueno = resumen();
process.exit(bueno ? 0 : 1);
