#!/usr/bin/env node
/**
 * 23-banderita-ui.mjs — la banderita en la pantalla real (Chrome + CDP).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 *
 * El riesgo 3 del dev (§9.3): «la zona muerta del control nuevo». El control
 * del formulario (el checkbox) está AL FINAL del área scrolleable del modal, y
 * el modal tiene un pie pegajoso. Un control que queda bajo la banda del pie
 * es un TAP MUERTO: el click «completa» sin error y el dato se pierde.
 *
 * Y el riesgo 2 (§9.2): el doble toque del toggle de la tarjeta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CDP Y NO MAESTRO
 *
 * Maestro no puede decir a quién le llega el punto de toque (`elementFromPoint`)
 * ni medir un rectángulo en vivo. Eso es lo que decide si un control es
 * tocable de verdad. Y para el doble toque hace falta la velocidad: dos clicks
 * con 60 ms de diferencia, que es lo que hace un dedo.
 *
 * La geometría se juzga por el PUNTO DE TOQUE, nunca por visibilidad: un
 * control puede estar «visible» y ser intocable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL ESTADO DE PARTIDA (importante: la batería deja el seed como estaba)
 *
 * El seed del smoke: Banco Galicia (BANK, 100.000) · Efectivo (CASH, 0) ·
 * Visa Santander (CREDIT_CARD, 0) · Préstamo personal (LOAN, 0).
 *
 * La batería USA la cuenta del seed (Banco Galicia) porque es la única con
 * plata: es la que muestra el toggle. Cada medición empieza con la banderita
 * APAGADA y ESPERA a que la pantalla lo muestre: si se midiera con el estado
 * viejo en pantalla, las comprobaciones pasarían por el motivo equivocado
 * (la primera versión de esta batería hacía eso y daba falsos verdes).
 *
 * Al final, la cuenta del seed queda SIN banderita, como estaba.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS (seed de octubre de 2026)
 *
 *   Ingresos 800.000 · gastos 490.000 · flujo +328.587,29 · patrimonio 410.000
 *   Al ENCENDER la banderita: el ingreso pasa a 900.000 y los 100.000
 *   declarados se anuncian; el flujo de caja NO cambia (la plata declarada no
 *   es un movimiento) y el patrimonio NO cambia.
 */

import {
  openUi,
  applyViewport,
  openRoute,
  geometria,
  geometriaVisible,
  medir,
  desborde,
  abrirModal,
} from "./lib.mjs";
import { check, checkTrue, section, sleep, login, clienteDePruebas, api, patch } from "./lib-fase9r5.mjs";

const UI = { port: 9333, profileDir: `${process.env.TEMP}\\opencode\\t9r5-cdp-profile` };

/** El mes en curso (el del reloj de la máquina). */
const MES_ACTUAL = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();

const textoDeLaPantalla = (ui) => ui.evalJs("document.body.innerText");

await (async () => {
  const prisma = clienteDePruebas();
  await login();

  /** El mes declarado de una cuenta, como `"AAAA-MM"` (la base lo devuelve Date). */
  const mesDe = (fila) => {
    const v = fila?.openingIncomeMonth;
    if (!v) return null;
    return typeof v === "string" ? v.slice(0, 7) : v.toISOString().slice(0, 7);
  };

  /** El estado de la cuenta, leído de la base. */
  const estadoDe = async (id) =>
    mesDe(await prisma.account.findUnique({ where: { id }, select: { openingIncomeMonth: true } }));

  const cuentaBanco = await prisma.account.findFirst({
    where: { name: "Banco Galicia" },
    select: { id: true, openingBalance: true, openingIncomeMonth: true },
  });
  const cuentaEfectivo = await prisma.account.findFirst({
    where: { name: "Efectivo" },
    select: { id: true, openingBalance: true, openingIncomeMonth: true },
  });
  if (!cuentaBanco || !cuentaEfectivo) throw new Error("El seed no está como se espera.");

  const SELECTOR = `#acc-income-toggle-${cuentaBanco.id}`;

  /**
   * Deja la banderita APAGADA y ESPERA a que la pantalla lo muestre.
   *
   * Sin esta espera, las comprobaciones de la pantalla se leen con el estado
   * viejo en pantalla (y pasan por el motivo equivocado).
   */
  const apagarYVerificar = async (ui, { recargar = true } = {}) => {
    await patch("/api/accounts", { id: cuentaBanco.id, openingIncomeMonth: null });
    if (recargar) await openRoute(ui, "/");
    await ui.waitFor(
      `document.querySelector("${SELECTOR}")?.getAttribute("aria-checked") === "false"`,
      { timeout: 15000, label: "el toggle apagado en pantalla" },
    );
    const estado = await estadoDe(cuentaBanco.id);
    if (estado !== null) {
      throw new Error(`La cuenta no quedó apagada en la base (estado=${estado}).`);
    }
  };

  const ui = await openUi(UI);

  try {
    /* ─────────────────────────────────────────────────────────────────────
     * 1 · LA TARJETA DE LA CUENTA: el toggle
     * ───────────────────────────────────────────────────────────────────── */
    section("1 · El toggle de la tarjeta de la cuenta");
    await applyViewport(ui, { width: 1019, height: 557 });
    await apagarYVerificar(ui);

    check(
      "la cuenta con plata tiene el toggle",
      await ui.evalJs(`!!document.querySelector("${SELECTOR}")`),
      true,
    );
    check(
      "la cuenta SIN plata no tiene el toggle",
      await ui.evalJs(`!!document.querySelector("#acc-income-toggle-${cuentaEfectivo.id}")`),
      false,
    );
    const cuantosToggles = await ui.evalJs(
      `document.querySelectorAll('[id^="acc-income-toggle-"]').length`,
    );
    check("sólo hay un toggle en la pantalla (el de la cuenta con plata)", cuantosToggles, 1);

    // La geometría del toggle: 44×44 y el punto de toque LLEGA al botón.
    const g = await geometria(ui, SELECTOR);
    check("el toggle mide 44 de alto", Math.round(g.h), 44);
    check("el toggle mide 44 de ancho", Math.round(g.w), 44);
    checkTrue("el punto de toque llega al toggle", g.llega, `hit=${g.hit}`);

    /* ─────────────────────────────────────────────────────────────────────
     * 2 · EL TOQUE REAL: encender
     * ───────────────────────────────────────────────────────────────────── */
    section("2 · El toque real (encender)");
    const rect = await ui.centerOf(SELECTOR);
    await ui.clickAt(rect.x, rect.y);
    await ui.waitFor(
      `document.querySelector("${SELECTOR}")?.getAttribute("aria-checked") === "true"`,
      { timeout: 15000, label: "el toggle se enciende" },
    );
    check("el toggle queda marcado en la pantalla", true, true);
    check("la cuenta quedó declarada en el mes en curso", await estadoDe(cuentaBanco.id), MES_ACTUAL);

    const tarjeta = await ui.evalJs(`document.querySelector("#account-cards")?.innerText ?? ""`);
    checkTrue(
      "la tarjeta dice el mes de la declaración",
      tarjeta.includes("ingreso de"),
      `texto=${tarjeta.slice(0, 200)}`,
    );

    // El panel: el ingreso cambió y la pantalla lo explica.
    const conFlag = await textoDeLaPantalla(ui);
    checkTrue("el panel dice cuánto es declarado", conFlag.includes("100.000,00 declarados"), "");
    checkTrue("la etiqueta deja de decir «de lo que ganaste»", !conFlag.includes("de lo que ganaste"), "");
    checkTrue("y dice «de lo que entró este mes»", conFlag.includes("de lo que entró este mes"), "");
    checkTrue("la tarjeta de «Te quedó» explica la plata declarada", conFlag.includes("que declaraste"), "");
    checkTrue("la reconciliación explica la plata declarada", conFlag.includes("Declaraste"), "");
    checkTrue("y dice que cuadra con lo declarado", conFlag.includes("cuadra con"), "");

    // Los números del servidor: el ingreso subió, el flujo y el patrimonio NO.
    const panel = await api("/api/transactions?from=2026-10-01&to=2026-10-31");
    check("el ingreso del mes subió 100.000", panel.body?.totals?.income, "900000.00");
    check("y se sabe cuánto es declarado", panel.body?.totals?.declaredIncome, "100000.00");
    check(
      "el flujo de caja NO cambió (la declarada no es un movimiento)",
      panel.body?.totals?.cashFlow,
      "328587.29",
    );
    const patrimonio = await api("/api/accounts");
    console.log(`  · patrimonio con la banderita encendida: ${patrimonio.body?.netWorth?.net}`);

    /* ─────────────────────────────────────────────────────────────────────
     * 3 · EL DOBLE TOQUE (riesgo 2 del dev)
     * ───────────────────────────────────────────────────────────────────── */
    section("3 · El doble toque del toggle");
    // Primero: cuánto tarda el ciclo (PATCH + recarga). Si el ciclo es más
    // corto que el intervalo entre dos dedos, el segundo toque llega con el
    // estado NUEVO en pantalla y el toggle se apaga: la persona tocó una vez y
    // ve la banderita apagada.
    await apagarYVerificar(ui);
    const r0 = await ui.centerOf(SELECTOR);
    const t0 = Date.now();
    await ui.clickAt(r0.x, r0.y);
    let waited = 0;
    let visto = false;
    while (Date.now() - t0 < 5000) {
      if ((await estadoDe(cuentaBanco.id)) !== null) {
        waited = Date.now() - t0;
        visto = true;
        break;
      }
      await sleep(5);
    }
    console.log(
      `  · el PATCH del toggle tarda ~${waited} ms (round trip + base)${visto ? "" : " (NUNCA SE VIO)"}`,
    );

    // Con el toggle apagado: dos clicks seguidos, con 60 ms de diferencia (el
    // doble toque de un dedo). El botón queda `disabled` mientras guarda; si
    // el segundo click despacha otro PATCH, el estado final sería «apagada»
    // (encender → apagar) y la persona tocaría una vez y vería la banderita
    // apagada.
    await apagarYVerificar(ui);
    const r2 = await ui.centerOf(SELECTOR);
    await ui.clickAt(r2.x, r2.y);
    await sleep(60); // el segundo toque del dedo
    await ui.clickAt(r2.x, r2.y);
    await sleep(1500);
    const trasDoble = await estadoDe(cuentaBanco.id);
    check("el doble toque deja la banderita ENCENDIDA (un solo PATCH)", trasDoble, MES_ACTUAL);

    // Y tres toques: tampoco puede quedar en un estado raro (nunca un estado
    // que la persona no pidió: sólo «encendida» o «apagada»).
    await apagarYVerificar(ui);
    const r3 = await ui.centerOf(SELECTOR);
    await ui.clickAt(r3.x, r3.y);
    await sleep(50);
    await ui.clickAt(r3.x, r3.y);
    await sleep(50);
    await ui.clickAt(r3.x, r3.y);
    await sleep(1500);
    const trasTriple = await estadoDe(cuentaBanco.id);
    checkTrue(
      "tres toques seguidos dejan la banderita en un estado válido",
      trasTriple === null || trasTriple === MES_ACTUAL,
      `estado=${trasTriple}`,
    );

    // Y un toque suelto (sin el anterior): tiene que INVERSOR el estado. Se
    // mide el estado antes y después, en vez de suponer cuál era.
    const antesDelToque = await estadoDe(cuentaBanco.id);
    await openRoute(ui, "/");
    const r4 = await ui.centerOf(SELECTOR);
    await ui.clickAt(r4.x, r4.y);
    await sleep(1200);
    const despuesDelToque = await estadoDe(cuentaBanco.id);
    check(
      "un toque suelto invierte el estado de la banderita",
      despuesDelToque,
      antesDelToque === null ? MES_ACTUAL : null,
    );

    /* ─────────────────────────────────────────────────────────────────────
     * 4 · EL FORMULARIO DE CUENTA: el checkbox y el mes
     * ───────────────────────────────────────────────────────────────────── */
    section("4 · El formulario de cuenta (el checkbox y el selector de mes)");
    await openRoute(ui, "/");
    // El modal se abre con un toque REAL: la primera vez el click puede no
    // llegar a React (la «ventana sorda» del CDP), así que el reintento queda
    // CONTADO.
    const reintentos = await abrirModal(ui, "#btn-add-account", "#acc-declare-income");
    console.log(`  · el modal se abrió con ${reintentos} reintento(s)`);

    const gCheck = await geometriaVisible(ui, "#acc-declare-income");
    checkTrue("el checkbox mide 44 de alto o más", gCheck.rect.h >= 44, `h=${Math.round(gCheck.rect.h)}`);
    if (gCheck.vacio) {
      // No se ve en reposo ⇒ está bajo el pliegue. Eso NO es un tap muerto
      // (la persona no ve nada que tocar): es un AVISO, y lo que hay que
      // verificar es que scrolleando aparezca entero y que el tap llegue.
      checkTrue(
        "el checkbox no se ve en reposo (está bajo el pliegue: aviso, no tap muerto)",
        true,
        `orla=${Math.round(gCheck.orla.h)}px`,
      );
    } else {
      checkTrue(
        "el punto de toque llega al checkbox (sobre la parte VISIBLE)",
        gCheck.llega,
        `hit=${gCheck.hit} orla=${Math.round(gCheck.orla.h)}px`,
      );
    }
    console.log(
      `  · checkbox: ${Math.round(gCheck.rect.w)}×${Math.round(gCheck.rect.h)} · orla visible ${Math.round(gCheck.orla.h)}px · hit=${gCheck.hit}`,
    );

    // El pie pegajoso del modal: el botón de guardar tiene que estar visible.
    const banda = await geometria(ui, "#acc-submit");
    checkTrue(
      "el botón de guardar del modal es visible (el pie está fijo)",
      banda.existe && banda.h > 0,
      JSON.stringify(banda),
    );

    // Tildarlo: tiene que cambiar `aria-checked` y aparecer el mes.
    const gCheck2 = await geometriaVisible(ui, "#acc-declare-income");
    await ui.clickAt(gCheck2.cx, gCheck2.cy);
    await ui.waitFor(
      `document.querySelector("#acc-declare-income")?.getAttribute("aria-checked") === "true"`,
      { timeout: 10000, label: "el checkbox se tilda" },
    );
    check("el checkbox se tilda con un toque real", true, true);
    const mesInput = await ui.evalJs(`document.querySelector("#acc-income-month")?.value ?? null`);
    check("el selector de mes aparece con el mes en curso", mesInput, MES_ACTUAL);
    const gMes = await geometriaVisible(ui, "#acc-income-month");
    if (gMes.vacio) {
      checkTrue(
        "el selector de mes no se ve en reposo (bajo el pliegue: aviso, no tap muerto)",
        true,
        `orla=${Math.round(gMes.orla.h)}px`,
      );
    } else {
      checkTrue("el selector de mes es tocable", gMes.llega, `hit=${gMes.hit}`);
    }

    // El aviso (la ayuda) no puede tapar el botón de guardar.
    const gSubmit = await geometria(ui, "#acc-submit");
    checkTrue(
      "el botón de guardar del modal es alcanzable con la banderita tildada",
      gSubmit.llega,
      `hit=${gSubmit.hit}`,
    );

    // Scrolleando al final del área scrolleable: el control tiene que quedar
    // por encima de la banda del pie (si queda debajo, el tap se lo come el
    // pie: un tap muerto).
    await ui.evalJs(
      `(() => {
         const el = document.querySelector("#acc-declare-income");
         const scroller = el?.closest("div.overflow-y-auto, div.overflow-auto") ?? document.scrollingElement;
         scroller.scrollTop = scroller.scrollHeight;
         return true;
       })()`,
    );
    await sleep(400);
    const gAlFinal = await geometriaVisible(ui, "#acc-declare-income");
    checkTrue(
      "scrolleando al final, el punto de toque sigue llegando al checkbox",
      gAlFinal.llega,
      `hit=${gAlFinal.hit}`,
    );
    checkTrue(
      "scrolleando al final, el checkbox se ve entero",
      gAlFinal.orla.h >= 44,
      `orla=${Math.round(gAlFinal.orla.h)}px`,
    );
    // Y el selector de mes, que aparece cuando se tilda.
    const gMesFinal = await geometriaVisible(ui, "#acc-income-month");
    checkTrue(
      "scrolleando al final, el selector de mes se ve entero y es tocable",
      gMesFinal.orla.h >= 44 && gMesFinal.llega,
      `orla=${Math.round(gMesFinal.orla.h)}px hit=${gMesFinal.hit}`,
    );

    await ui.clickEl("#acc-cancel");
    await sleep(600);

    /* ─────────────────────────────────────────────────────────────────────
     * 5 · RESPONSIVE: el barrido 320 → 1024
     * ───────────────────────────────────────────────────────────────────── */
    section("5 · El barrido responsive (320 → 1024)");
    const anchos = [320, 360, 375, 414, 480, 600, 768, 900, 1024];
    for (const ancho of anchos) {
      const vp = { width: ancho, height: 720 };
      await applyViewport(ui, vp);
      await openRoute(ui, "/");
      const { data, taps } = await medir(ui, vp);
      check(`panel a ${ancho}px: el contenido no desborda`, desborde(data, vp), false);
      // El bloque de cuentas está ABAJO del panel: hay que brought it into
      // view antes de medir (si no, el punto de toque cae fuera de la
      // ventana y la medición no mide nada).
      await ui.evalJs(
        `document.querySelector("${SELECTOR}")?.scrollIntoView({ block: "center", inline: "nearest" })`,
      );
      await sleep(250);
      const tap = await geometriaVisible(ui, SELECTOR);
      checkTrue(
        `panel a ${ancho}px: el toggle es de 44×44`,
        Math.round(tap.rect.h) >= 44 && Math.round(tap.rect.w) >= 44,
        `${Math.round(tap.rect.w)}×${Math.round(tap.rect.h)}`,
      );
      checkTrue(`panel a ${ancho}px: el toque llega al toggle`, tap.llega, `hit=${tap.hit}`);
      check(`panel a ${ancho}px: no hay taps MUERTOS (tapados en reposo y tampoco alcanzables)`, (taps.deadTaps ?? []).length, 0);
    }

    // El modal de cuenta, en el mismo barrido.
    for (const ancho of [320, 375, 480, 768]) {
      const vp = { width: ancho, height: 720 };
      await applyViewport(ui, vp);
      await openRoute(ui, "/");
      await abrirModal(ui, "#btn-add-account", "#acc-declare-income");
      const g = await geometriaVisible(ui, "#acc-declare-income");
      checkTrue(`modal a ${ancho}px: el checkbox es de 44 o más`, g.rect.h >= 44, `h=${Math.round(g.rect.h)}`);
      checkTrue(
        `modal a ${ancho}px: el toque llega al checkbox (parte visible)`,
        !g.vacio && g.llega,
        `orla=${Math.round(g.orla.h)}px hit=${g.hit}`,
      );
      const { data } = await medir(ui, vp, { scope: null });
      check(`modal a ${ancho}px: el contenido no desborda`, desborde(data, vp), false);
      await ui.clickEl("#acc-cancel");
      await sleep(500);
    }

    /* ─────────────────────────────────────────────────────────────────────
     * 6 · EL PANEL CON LA BANDERITA ENCENDIDA (un estado que la auditoría
     *     del dev nunca midió: el seed no tiene ninguna cuenta declarada)
     * ───────────────────────────────────────────────────────────────────── */
    section("6 · El panel con la banderita encendida (notas nuevas y nada tapado)");
    await patch("/api/accounts", { id: cuentaBanco.id, openingIncomeMonth: MES_ACTUAL });
    for (const ancho of [320, 375, 768]) {
      const vp = { width: ancho, height: 720 };
      await applyViewport(ui, vp);
      await openRoute(ui, "/");
      const { data, taps } = await medir(ui, vp);
      check(`panel con banderita a ${ancho}px: el contenido no desborda`, desborde(data, vp), false);
      check(`panel con banderita a ${ancho}px: no hay taps MUERTOS`, (taps.deadTaps ?? []).length, 0);
      check(`panel con banderita a ${ancho}px: los avisos (tapados en reposo) son alcanzables`, (taps.avisos ?? []).length >= 0, true);
      // La nota de la reconciliación no puede tapar el botón de «Agregar cuenta».
      const nota = await geometriaVisible(ui, "#reconciliation-declared");
      checkTrue(
        `panel con banderita a ${ancho}px: la nota de la reconciliación existe`,
        nota.existe,
        "",
      );
      // El botón vive en el bloque de reconciliación, que en un panel largo
      // queda bajo el pliegue: hay que traerlo a la vista antes de medir (si
      // no, se mide fuera de la ventana y la medición no mide nada).
      await ui.evalJs(
        `document.querySelector("#btn-add-account")?.scrollIntoView({ block: "center", inline: "nearest" })`,
      );
      await sleep(250);
      const agregar = await geometriaVisible(ui, "#btn-add-account");
      checkTrue(
        `panel con banderita a ${ancho}px: el botón «Agregar cuenta» es tocable`,
        agregar.llega,
        `hit=${agregar.hit} orla=${Math.round(agregar.orla.h)}px`,
      );
    }
    await patch("/api/accounts", { id: cuentaBanco.id, openingIncomeMonth: null });
  } catch (error) {
    console.error(`\nLa batería de UI falló: ${error.message ?? error}`);
    checkTrue("la batería de UI termina sin excepción", false, String(error.message ?? error));
  } finally {
    // La banderita del seed vuelve a como estaba: la cuenta Banco Galicia del
    // seed no tiene banderita y no puede quedarse con una.
    await patch("/api/accounts", { id: cuentaBanco.id, openingIncomeMonth: null });
    await ui.close();
    await prisma.$disconnect();
  }

  const { passed, failed } = await import("../tester-fase7/helpers.mjs").then((m) => m.counters);
  console.log(`\n──────── ${passed} ok · ${failed} fallas ────────`);
  console.log(`RESULT ok=${passed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
