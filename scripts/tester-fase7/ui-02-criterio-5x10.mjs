#!/usr/bin/env node
/**
 * ui-02 · EL CRITERIO DE LA RONDA — una compra de 4.500 en ≤5 interacciones y
 * ≤10 segundos (brief, ataque A; medido por el tester, no por el dev).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MÉTODO DE MEDICIÓN — esto es lo que hace válido el número
 * ─────────────────────────────────────────────────────────────────────────────
 * Escenario: la compra típica. Un gasto de 4.500, SIN categoría, con la cuenta
 * por defecto y la fecha Hoy — los tres valores que el formulario ya trae.
 *
 *   · INTERACCIONES (definición explícita del brief: tipear un campo = 1;
 *     cada toque/clic/selección = 1):
 *       1. tap en "－ Gasto" (abre Nuevo gasto)           ← toque
 *       2. tipear "4500" (el autofocus ya está en el monto) ← tipeo
 *       3. tap en "Guardar"                               ← toque
 *     Total 3. NO se toca cuenta, ni fecha, ni categoría: vienen por defecto.
 *     El scroll previo hasta el botón no es un toque y no cuenta (el flow del
 *     dev tampoco lo cuenta). Contabilidad alternativa y más conservadora: si
 *     se contara el tap de foco del monto + el tipeo como DOS interacciones,
 *     serían 4 — igual ≤5.
 *
 *   · TIEMPO (cronómetro in-page con performance.now(), resolución del frame
 *     ~16 ms, sin latencia del driver):
 *       t0 = el PRIMER pointerdown real después de armar la sonda: el tap en
 *            "－ Gasto". Lo registra un listener capture en window.
 *       t1 = el guardado confirmado EN PANTALLA, tomado como el máximo de dos
 *            señales medidas en el mismo loop rAF:
 *              a) el toast "movimiento guardado" (#undo-toast) aparece, y
 *              b) la tarjeta "Gastos" ya muestra el total actualizado
 *                 (el número esperado, calculado como el valor visible antes +
 *                 4.500 — la confirmación de que el número se movió).
 *     Se reportan los dos crudos (toast y totales) y el número de cabecera es
 *     el mayor de los dos (el criterio es "cuando el guardado está confirmado
 *     en pantalla", y el total es la evidencia más lenta). Como control,
 *     también se mide de punta a punta en Node (incluye roundtrips CDP y
 *     polling de 150 ms: es una cota superior, no el número).
 *
 *     El total de la tarjeta es CORROBORACIÓN, no criterio: la tarjeta
 *     "Gastos" es el total del MES y el generador de recurrencia materializa
 *     movimientos dentro de cualquier load() del panel (documentado en
 *     ui-03). Si eso pasa entre la línea de base y el guardado, el total
 *     esperado ya no es alcanzable y su señal no se enciende aunque el
 *     guardado sea real. Discriminante: si la tarjeta CAMBIÓ respecto a la
 *     línea de base, el entorno contamina la señal (se documenta y pasa); si
 *     quedó clavada en la línea de base, el total nuevo no se renderizó (eso
 *     sí es falla). La corroboración independiente del guardado es el diff
 *     por id contra la API, que corre siempre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ MÁS VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 *   · Que el guardado sea real: diff por id contra la lista de movimientos de
 *     hoy (API) antes/después → exactamente 1 movimiento nuevo, con monto
 *     4500.00, kind EXPENSE, category null, la cuenta que el select ya tenía
 *     elegida y fecha de hoy. Todo se limpia por su id (POST + DELETE reales).
 *   · Que no haya un duplicado pre-existente que desvíe la medición: antes de
 *     guardar se pregunta a /api/transactions/duplicates; si lo hubiera, se
 *     reporta y se reintenta con 4501,25 (documentado como desvío del guion).
 *   · Doble toque en Guardar: dos clicks REALES pegados (el segundo ~110 ms
 *     después del primero) → UN solo movimiento. La barrera que lo frene se
 *     registra: botón `disabled={saving}`, el guard del handler, o el modal
 *     ya cerrado (el click sobrante cae en el gráfico de patrimonio, inerte).
 *     Si la página queda sorda (artefacto CDP nunca visto en Maestro), el
 *     intento se reintenta con recarga, acotado a 2 veces — un falso rojo por
 *     ventana sorda sería un rojo mentiroso, y los reintentos quedan contados.
 *
 * Requiere: server en :3000 (build final, con el fix) y la base dev en
 * cualquier estado — la sonda crea y borra lo suyo. Chrome CDP en el puerto
 * 9341 (lo reusa si está vivo, patrón de ui-01).
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  check,
  checkTrue,
  del,
  duplicadosDe,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_CRITERIO";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** El texto de la tarjeta "Gastos" del panel (el `p` que sigue a la etiqueta). */
const GASTOS_CARD = `(() => {
  const label = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === "Gastos");
  return label?.parentElement?.querySelector("p.font-extrabold")?.textContent?.trim() ?? null;
})()`;

/** "490.000,00" → 490000. */
function parseMoneyEsAr(texto) {
  return Number(String(texto).replace(/[^\d,-]/g, "").replace(",", "."));
}

/**
 * La sonda in-page: arma el cronómetro y el loop rAF que registra las señales.
 * Todo adentro de la página, para no medir la latencia de CDP.
 */
const armarSonda = (esperadoCents) => `(() => {
  window.__f7 = {
    arm: performance.now(), t0: 0, tToast: 0, tTotals: 0, tClosed: 0,
    sawModal: false, esperadoCents: ${esperadoCents},
  };
  window.addEventListener("pointerdown", () => {
    if (!window.__f7.t0) window.__f7.t0 = performance.now();
  }, { capture: true, once: false });
  const tick = () => {
    const f = window.__f7;
    if (!f.tToast && document.getElementById("undo-toast")) f.tToast = performance.now();
    const submit = document.getElementById("tx-submit");
    if (!f.sawModal && submit) f.sawModal = true;
    if (f.sawModal && !f.tClosed && !submit) f.tClosed = performance.now();
    if (!f.tTotals) {
      const label = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === "Gastos");
      const value = label?.parentElement?.querySelector("p.font-extrabold")?.textContent?.trim() ?? "";
      // Comparación NUMÉRICA por centavos: un includes("4.500,00") daría
      // falso positivo dentro de un total más grande (p. ej. "504.500,00").
      const num = Number(String(value).replace(/[^\\d,-]/g, "").replace(",", "."));
      if (Number.isFinite(num) && Math.round(num * 100) === f.esperadoCents) f.tTotals = performance.now();
    }
    if (performance.now() - f.arm < 15000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

runScript({
  tag: TAG,
  main: async (prisma) => {
    const ui = await openUi({ port: 9341 });
    /** Ids creados por esta corrida: red de seguridad para el finally. */
    const creados = new Set();
    const borrarCreado = async (id) => {
      await del(`/api/transactions?id=${id}`);
      creados.delete(id);
    };

    try {
      const hoy = localToday();

      section("Preparación — panel y línea de base");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "el panel",
      });
      checkTrue("el panel cargó", true);

      const antes = await movimientosDe(hoy, hoy);
      check("la lista de movimientos de hoy responde 200", antes.status, 200);
      const idsAntes = new Set((antes.body?.movements ?? []).map((m) => m.id));
      console.log(`  · movimientos de hoy antes de medir: ${idsAntes.size}`);

      // La tarjeta arranca en "—" y puede pasar por un "0,00" formateado antes
      // de que el load async traiga los números del mes: se exige ESTABILIDAD
      // (3 lecturas iguales seguidas, separadas 400 ms, ya sin guion) para no
      // tomar el cero transitorio como línea de base (visto en una corrida:
      // $ 0,00 → $ 10.934.500,00).
      await ui.waitFor(`${GASTOS_CARD}?.includes(",")`, {
        timeout: 10000,
        label: "la tarjeta 'Gastos' con su número",
      });
      let gastosTexto = null;
      let estables = 0;
      for (let lectura = 0; lectura < 20 && estables < 2; lectura += 1) {
        const v = await ui.evalJs(GASTOS_CARD);
        if (v !== null && !String(v).includes("—")) {
          estables = v === gastosTexto ? estables + 1 : 0;
          gastosTexto = v;
        }
        await sleep(400);
      }
      checkTrue("la tarjeta 'Gastos' está en pantalla", gastosTexto !== null, `${gastosTexto}`);
      const gastosNum = parseMoneyEsAr(gastosTexto);

      /* ───────────────────────────────────────────────────────────────────────
       * 1. LA MEDICIÓN — 4.500 en el camino corto
       * ─────────────────────────────────────────────────────────────────────── */
      section("Medición A — la compra típica, 3 interacciones");

      /**
       * Abre "Nuevo gasto" con reintentos: el HTML llega server-rendered y en
       * el entorno CDP se observó de forma intermitente una ventana post-load
       * en la que TODOS los eventos se pierden sin error (nunca vista en
       * Maestro). `antesDelPrimerClick` engancha la sonda de tiempo justo
       * antes del primer toque real. Cada reintento queda contado — y cuenta
       * como un retap del usuario: 1 interacción más en el criterio.
       */
      let reintentosDeApertura = 0;
      const abrirModal = async (antesDelPrimerClick) => {
        // La hidratación PRIMERO: un click sintético antes de que React tome
        // el árbol se pierde sin error (lección de ui-01). El marcador
        // `__reactProps` en el nodo es la señal de hidratación. Aun así, en
        // el entorno CDP apareció también una ventana "sorda" post-load con
        // el árbol ya hidratado (documentada en el informe): por eso el
        // reintento existe y se cuenta.
        await ui.waitFor(
          `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
          { timeout: 30000, label: "la hidratación del panel" },
        );
        let armado = false;
        for (let intento = 0; intento < 4; intento += 1) {
          if (intento > 0) reintentosDeApertura += 1;
          await ui.evalJs(`document.getElementById("btn-expense").scrollIntoView({ block: "center" })`);
          await sleep(intento === 0 ? 250 : 300);
          if (!armado && antesDelPrimerClick) {
            await antesDelPrimerClick();
            armado = true;
          }
          await ui.clickEl("#btn-expense");
          try {
            await ui.waitFor(`!!document.getElementById("tx-submit")`, {
              timeout: 2500,
              label: "modal (reintento de apertura)",
            });
            return;
          } catch {
            // Se reintenta: el click llegó antes de que React hidrate.
          }
        }
        await ui.waitFor(`!!document.getElementById("tx-submit")`, {
          timeout: 2000,
          label: "el modal tras los reintentos",
        });
      };

      const medir = async (monto, esperadoCents) => {
        const interacciones = [];
        const reintentosAntes = reintentosDeApertura;
        const tNodo0 = Date.now();

        // Interacción 1 — abrir "Nuevo gasto" (toque real; la sonda arranca
        // con el primer pointerdown).
        interacciones.push('tap en "－ Gasto"');
        await abrirModal(async () => {
          await ui.evalJs(armarSonda(esperadoCents));
          await sleep(150);
        });

        // Lo que NO se toca: los valores por defecto, verificados.
        const defaults = await ui.evalJs(`({
          active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
          amount: document.getElementById("tx-amount")?.value ?? null,
          category: document.getElementById("tx-category")?.value ?? null,
          date: document.getElementById("tx-date")?.value ?? null,
          accountId: document.getElementById("tx-account")?.value ?? null,
          accountText: document.getElementById("tx-account")?.selectedOptions?.[0]?.textContent?.trim() ?? null,
        })`);
        check("autofocus: el foco ya está en el monto (sin toque extra)", defaults.active, "tx-amount");
        check("la fecha por defecto ya es Hoy", defaults.date, hoy);
        check("la categoría viene vacía (carga rápida, sin clasificar)", defaults.category, "");
        checkTrue(
          "la cuenta por defecto ya está elegida",
          Boolean(defaults.accountId),
          JSON.stringify({ accountId: defaults.accountId, accountText: defaults.accountText }),
        );

        // Pre-chequeo de duplicado (misma cuenta+monto+día+tipo) para que el
        // aviso no desvíe la medición. Si hay, se informa y se reintenta con
        // otro monto (desvío documentado del guion de 4.500).
        const dup = await duplicadosDe({
          kind: "EXPENSE",
          accountId: defaults.accountId,
          amount: monto,
          date: hoy,
        });
        if ((dup.body?.duplicates ?? []).length > 0) {
          return { duplicado: true, defaults, interacciones };
        }

        // Interacción 2 — tipear el monto (el autofocus ya puso el cursor).
        interacciones.push(`tipear "${monto}" en el monto (autofocus)`);
        await ui.insertText(monto);

        // Interacción 3 — guardar (toque real).
        interacciones.push('tap en "Guardar"');
        await ui.clickEl("#tx-submit");

        const salida = await ui.waitFor(
          `(() => {
            if (document.getElementById("undo-toast")) return "guardado";
            if (document.getElementById("tx-duplicate-warning")) return "duplicado";
            return false;
          })()`,
          { timeout: 20000, label: "el resultado del guardado (toast o aviso)" },
        );
        const tNodo1 = Date.now();

        if (salida === "duplicado") {
          return { duplicado: true, defaults, interacciones };
        }

        // El modal se cierra y el total se mueve: ambos dentro de la ventana
        // de la sonda (15 s). Se esperan acá para leer las marcas con todo
        // estabilizado (la sonda ya venía registrando).
        await ui.waitFor(`!document.getElementById("tx-submit")`, {
          timeout: 10000,
          label: "el cierre del modal",
        });
        // Espera a que la tarjeta llegue al total esperado — comparación
        // numérica por centavos, igual que en la sonda.
        await ui.waitFor(
          `(() => {
            const v = ${GASTOS_CARD};
            if (v === null) return false;
            const num = Number(String(v).replace(/[^\\d,-]/g, "").replace(",", "."));
            return Number.isFinite(num) && Math.round(num * 100) === ${esperadoCents};
          })()`,
          { timeout: 10000, label: `los totales en pantalla con ${esperadoCents} centavos` },
        ).catch(() => {}); // si no llegó, las marcas lo delatan y falla el check

        const marcas = await ui.evalJs(`window.__f7`);
        // Contexto del entorno + el POST real según Resource Timing: permite
        // decir DÓNDE se fue el tiempo cuando una corrida sale lenta (el
        // duration del POST es la parte atribuible al server, no a la sonda).
        const entorno = await ui.evalJs(
          `document.visibilityState + " · hasFocus: " + document.hasFocus()`,
        );
        const post = await ui.evalJs(`(() => {
          const es = performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/api/transactions"));
          if (!es.length) return null;
          const last = es[es.length - 1];
          return { dur: Math.round(last.duration), start: Math.round(last.startTime) };
        })()`);
        return {
          duplicado: false,
          defaults,
          interacciones,
          marcas,
          tNodo0,
          tNodo1,
          entorno,
          post,
          salida,
          reintentos: reintentosDeApertura - reintentosAntes,
        };
      };

      let monto = "4500";
      let resultado = await medir(monto, Math.round((gastosNum + 4500) * 100));
      if (resultado.duplicado) {
        console.log("  AVISO ya existía un duplicado de 4.500 hoy en la cuenta por defecto;");
        console.log("        se cierra el modal y se mide con 4.501,25 (desvío documentado).");
        await ui.evalJs(`document.getElementById("tx-duplicate-back")?.click()`);
        await sleep(150);
        await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
        await sleep(150);
        monto = "4501.25";
        resultado = await medir(monto, Math.round((gastosNum + 4501.25) * 100));
      }
      if (resultado.duplicado) {
        // Dos veces seguidas no es unlucky: es un ambiente sucio. Mejor abortar
        // con el detalle que medir con el aviso de duplicado en el medio.
        throw new Error(
          "La cuenta por defecto ya tiene un gasto de 4500,00 Y de 4501,25 hoy: ambiente sucio para medir. " +
            JSON.stringify(resultado.defaults),
        );
      }

      checkTrue("la medición no se desvió por un duplicado pre-existente", !resultado.duplicado);
      const { marcas } = resultado;
      const cantidad = resultado.interacciones.length;
      // Un reintento del probe equivale a un retap del usuario: si el primer
      // tap no abrió el modal (artefacto del entorno CDP ya documentado, nunca
      // visto en Maestro), la persona vuelve a tocar — 1 interacción más.
      const cantidadEfectiva = cantidad + resultado.reintentos;

      check("interacciones del camino corto (tap abrir + tipear + tap guardar)", cantidad, 3);
      checkTrue(
        "criterio A · interacciones ≤ 5",
        cantidadEfectiva <= 5,
        `${cantidadEfectiva} interacciones (3 del guion + ${resultado.reintentos} retap(s) de entorno): ${resultado.interacciones.join(" → ")}`,
      );

      checkTrue("el cronómetro in-page arrancó con el primer toque (t0)", marcas.t0 > 0, JSON.stringify(marcas));
      checkTrue("la señal 'toast visible' quedó registrada", marcas.tToast > 0, JSON.stringify(marcas));

      // El total de la tarjeta es CORROBORACIÓN, no criterio (ver cabecera):
      // si el generador de recurrencia materializó movimientos, el total del
      // mes cambió y la señal esperada ya no es alcanzable. Discriminante:
      // tarjeta final ≠ línea de base → el entorno explica la señal ausente;
      // tarjeta clavada en la línea de base → el total nuevo no se renderizó.
      const gastosPost = await ui.evalJs(GASTOS_CARD);
      const totalesVistoEnSonda = marcas.tTotals > 0;
      checkTrue(
        "la señal 'totales actualizados en pantalla' quedó registrada (o el generador contaminó la tarjeta y se documenta)",
        totalesVistoEnSonda ||
          (marcas.tToast > 0 && resultado.salida === "guardado" && gastosPost !== gastosTexto),
        JSON.stringify({
          t0: marcas.t0,
          tToast: marcas.tToast,
          tTotals: marcas.tTotals,
          tarjetaAntes: gastosTexto,
          tarjetaDespues: gastosPost,
        }),
      );
      if (!totalesVistoEnSonda) {
        console.log(`  NOTA la sonda no registró la señal de totales (esperaba +${monto} sobre la línea de base).`);
        console.log(`       Tarjeta: ${gastosTexto} → ${gastosPost}. Lectura: el generador de recurrencia pudo`);
        console.log("       materializar movimientos y mover el total del mes (precedente ui-03).");
      }

      const msToast = marcas.tToast - marcas.t0;
      const msTotales = totalesVistoEnSonda ? marcas.tTotals - marcas.t0 : null;
      const msFin = Math.max(msToast, msTotales ?? 0);
      const msNodo = resultado.tNodo1 - resultado.tNodo0;

      console.log(`  · t0→toast:    ${Math.round(msToast)} ms`);
      console.log(`  · t0→totales:  ${msTotales === null ? "señal no registrada (ver NOTA)" : `${Math.round(msTotales)} ms`}`);
      console.log(`  · t0→fin (el mayor): ${Math.round(msFin)} ms`);
      console.log(`  · control Node punta a punta (cota superior, con roundtrips CDP): ${msNodo} ms`);

      checkTrue(
        "criterio A · tiempo: guardado confirmado en pantalla ≤ 10 s",
        msFin > 0 && msFin <= 10000,
        `${Math.round(msFin)} ms (toast ${Math.round(msToast)} ms · totales ${msTotales === null ? "sin señal" : `${Math.round(msTotales)} ms`})`,
      );

      /* ── El guardado es REAL: diff por id contra la API ──────────────────── */
      const despues = await movimientosDe(hoy, hoy);
      check("la lista de hoy responde 200 después del guardado", despues.status, 200);
      const nuevos = (despues.body?.movements ?? []).filter((m) => !idsAntes.has(m.id));
      check("se creó exactamente 1 movimiento nuevo", nuevos.length, 1);
      const mov = nuevos[0];
      if (mov) creados.add(mov.id);
      check("monto guardado: 4500,00", mov?.amount, monto === "4500" ? "4500.00" : "4501.25");
      check("tipo EXPENSE (se entró por '－ Gasto')", mov?.kind, "EXPENSE");
      check("sin categoría: el guardado rápido no clasifica", mov?.category, null);
      check("cuenta = la elegida por defecto en el select", mov?.account?.id, resultado.defaults.accountId);
      check("fecha = hoy", mov?.date, hoy);
      check("sin nota (no se tocó)", mov?.description, "");

      /* ── Limpieza de la medición (DELETE real) ───────────────────────────── */
      if (mov) {
        await borrarCreado(mov.id);
        const trasBorrar = await movimientosDe(hoy, hoy);
        checkTrue(
          "el movimiento de la medición se borró (y no queda fantasma)",
          !(trasBorrar.body?.movements ?? []).some((m) => m.id === mov.id),
          JSON.stringify((trasBorrar.body?.movements ?? []).map((m) => m.id)),
        );
      }
      await ui.navigate(`${BASE_URL}/`);
      await ui.waitFor(`!!document.getElementById("btn-expense")`, { timeout: 30000, label: "el panel recargado" });
      checkTrue("el panel recargó tras la limpieza (toast viejo descartado)", true);

      /* ───────────────────────────────────────────────────────────────────────
       * 2. DOBLE TOQUE EN GUARDAR — un solo movimiento
       * ─────────────────────────────────────────────────────────────────────── */
      section("Doble toque en Guardar → UN solo movimiento");

      /**
       * Un intento completo del doble toque. Devuelve lo medido y limpia lo
       * que haya creado. En este entorno se observó de forma intermitente un
       * estado de página "sorda" (ni clicks reales ni los sintéticos llegan a
       * React, sin errores en consola y sólo en sondas CDP — nunca en
       * Maestro): por eso el llamador reintenta UNA vez tras recargar, en vez
       * de convertir un artefacto de entorno en un falso rojo.
       */
      const intentoDobleToque = async () => {
        await abrirModal();
        // Foco determinista antes de tipear: si la apertura necesitó reintentos
        // por hidratación, el mouseReleased del reintento puede haberle robado
        // el foco al monto (el autofocus ya quedó verificado en la medición A).
        await ui.evalJs(`document.getElementById("tx-amount").focus()`);
        await sleep(80);
        await ui.insertText("4600");
        let tipeado = await ui.evalJs(`document.getElementById("tx-amount")?.value ?? null`);
        if (tipeado !== "4600") {
          await ui.evalJs(`document.getElementById("tx-amount").focus()`);
          await ui.insertText("4600");
          tipeado = await ui.evalJs(`document.getElementById("tx-amount")?.value ?? null`);
        }
        if (tipeado !== "4600") return { tipeado, guardado: false, nuevos: [], barrera: "no se pudo tipear" };

        const antesDoble = await movimientosDe(hoy, hoy);
        const idsAntesDoble = new Set((antesDoble.body?.movements ?? []).map((m) => m.id));

        // DOS CLICKS REALES pegados (CDP): el segundo arranca ~110 ms después
        // del primero — más rápido que cualquier doble toque humano. Barreras
        // en orden: si el guardado ya arrancó, el botón está `disabled={saving}`
        // y el navegador no emite el click; si todavía no arrancó, `if
        // (saving) return` en el handler lo frena; y si el guardado terminó
        // ANTES del segundo click, el click cae en el gráfico de patrimonio
        // (elemento inerte, verificado con `elementFromPoint`).
        const centroGuardar = await ui.centerOf("#tx-submit");
        await ui.clickAt(centroGuardar.x, centroGuardar.y); // click 1
        await ui.clickAt(centroGuardar.x, centroGuardar.y); // click 2
        const barrera = await ui.evalJs(`(() => {
          const b = document.getElementById("tx-submit");
          if (!b) return "el modal ya se había cerrado antes del segundo click";
          return b.disabled ? "el botón ya estaba disabled (saving=true)" : "el botón seguía habilitado";
        })()`);

        let guardado = true;
        try {
          await ui.waitFor(`!!document.getElementById("undo-toast")`, {
            timeout: 8000,
            label: "el toast del guardado con doble toque",
          });
        } catch {
          guardado = false;
        }
        await sleep(300); // que termine de asentarse el refresh del panel
        const despuesDoble = await movimientosDe(hoy, hoy);
        const nuevos = (despuesDoble.body?.movements ?? []).filter((m) => !idsAntesDoble.has(m.id));
        for (const m of nuevos) await borrarCreado(m.id); // limpieza del intento
        return { tipeado, guardado, nuevos, barrera, centro: centroGuardar };
      };

      let doble = await intentoDobleToque();
      // La página sorda (arriba) puede caer justo en este intento: se
      // reintenta con recarga, acotado a 2 veces. Nunca en Maestro; acá los
      // reintentos quedan contados y el check final lo declara.
      let reintentosDoble = 0;
      while (!doble.guardado && reintentosDoble < 2) {
        reintentosDoble += 1;
        console.log("  AVISO el guardado no reaccionó en 8 s (posible página sorda del entorno):");
        console.log(`        se recarga y se reintenta (${reintentosDoble}/2).`);
        await ui.navigate(`${BASE_URL}/`);
        await ui.waitFor(`!!document.getElementById("btn-expense")`, {
          timeout: 30000,
          label: `el panel (reintento ${reintentosDoble}/2)`,
        });
        doble = await intentoDobleToque();
      }

      check("el monto 4600 quedó tipeado en el campo", doble.tipeado, "4600");
      console.log(`  · segundo click: ${doble.barrera} · guardado: ${doble.guardado}`);
      checkTrue(
        `el doble toque terminó en UN guardado (reintentos de entorno usados: ${reintentosDoble}/2)`,
        doble.guardado,
        JSON.stringify({ barrera: doble.barrera, tipeado: doble.tipeado, reintentos: reintentosDoble }),
      );
      check("el doble toque creó UN solo movimiento", doble.nuevos.length, 1);
      check("por 4600,00", doble.nuevos[0]?.amount, "4600.00");
      const movDoble = doble.nuevos[0];
      if (movDoble) {
        const trasDoble = await movimientosDe(hoy, hoy);
        checkTrue(
          "limpieza del doble toque verificada",
          !(trasDoble.body?.movements ?? []).some((m) => m.id === movDoble.id),
          JSON.stringify((trasDoble.body?.movements ?? []).map((m) => m.id)),
        );
      }

      section("Números crudos (para el informe)");
      console.log(`  · medición A: ${cantidadEfectiva} interacciones efectivas (${cantidad} del guion + ${resultado.reintentos} retap de entorno) · ${Math.round(msFin)} ms (toast ${Math.round(msToast)} ms · totales ${msTotales === null ? "n/d" : `${Math.round(msTotales)} ms`})`);
      console.log(`  · entorno medido: ${resultado.entorno}`);
      console.log(`  · POST /api/transactions real (Resource Timing): ${resultado.post ? `${resultado.post.dur} ms` : "sin entrada"}`);
      console.log(`  · monto medido: ${monto}${monto === "4500" ? "" : " (desviado por duplicado pre-existente)"}`);
      if (resultado.reintentos > 0) {
        console.log(`  AVISO el entorno exigió ${resultado.reintentos} reintento(s) de apertura (artefacto de sonda CDP`);
        console.log(`        documentado, nunca visto en Maestro): el tiempo medido YA incluye esos ~2,8 s.`);
      }
      checkTrue(
        "criterio A se sostiene aunque el entorno haya forzado un retap (el tiempo incluye el reintento)",
        resultado.reintentos === 0 || msFin <= 10000,
        `reintentos: ${resultado.reintentos} · tiempo: ${Math.round(msFin)} ms`,
      );
    } finally {
      for (const id of creados) {
        try {
          await del(`/api/transactions?id=${id}`);
        } catch {
          // La red de seguridad no puede tapar un error real de la corrida.
        }
      }
      await ui.close();
    }
  },
});
