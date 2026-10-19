#!/usr/bin/env node
/**
 * ui-03 · ATAQUE E — el "Deshacer" del guardado rápido
 *
 * El contrato que ataca (app/page.tsx, `undoLastSave` + el aviso):
 *   · El aviso "Movimiento guardado." es PERSISTENTE: no se auto-oculta (la
 *     decisión está comentada en el código: un aviso que desaparece solo es
 *     intestable y puede irse justo cuando la persona reacciona).
 *   · "Deshacer" → DELETE /api/transactions?id=… · Éxito (200) y "ya no está"
 *     (404) son los dos finales felices. Otro error NO se traga: el aviso se
 *     queda con el mensaje del servidor y el botón vuelve a estar disponible.
 *   · El próximo guardado REEMPLAZA el aviso (uno solo a la vez).
 *   · La × lo descarta SIN tocar el movimiento.
 *   · `if (busy) return` + `disabled={busy}`: el doble toque no puede disparar
 *     dos DELETEs.
 *   · Recarga: el aviso no sobrevive (estado en memoria); el movimiento sí.
 *   · Geometría: píldora fija abajo (z-40) con la capa exterior
 *     `pointer-events-none`; no puede tapar el pie del modal donde vive
 *     "Guardar" (centro medido ≈ (594, 474) en el viewport de tests).
 *
 * Método: se guarda por la UI (clicks REALES por CDP, monto por
 * `Input.insertText` sobre el autofocus) y cada final se verifica contra la
 * API real (diff de ids de hoy) y la base. Los montos son distintos por paso
 * (4700…5400) y hay un pre-chequeo de duplicado contra
 * /api/transactions/duplicates: si uno existiera, se corre un centavo (queda
 * dicho en el log).
 *
 * Todos los movimientos creados se borran SIEMPRE: por el paso que los usó,
 * por el aviso cuando el DELETE es el que borra, y por una red de seguridad
 * por id y por monto en el `finally` — los movimientos hechos por la UI no
 * llevan nota (`description: ""`), así que `cleanupTag` no puede encontrarlos
 * por prefijo.
 *
 * Requiere: server en :3000 y Chrome CDP 9341 (acá se lanza y se mata solo;
 * ver cdp.mjs).
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  check,
  checkDeep,
  checkIncluye,
  checkTrue,
  del,
  duplicadosDe,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_UNDO";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** El texto de la tarjeta "Gastos" del panel (el `p` que sigue a la etiqueta). */
const GASTOS_CARD = `(() => {
  const label = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === "Gastos");
  return label?.parentElement?.querySelector("p.font-extrabold")?.textContent?.trim() ?? null;
})()`;



runScript({
  tag: TAG,
  main: async (prisma) => {
    const ui = await openUi({ port: 9341 });
    const hoy = localToday();
    /** Ids creados por esta corrida (red de seguridad del finally). */
    const creados = new Set();
    /** Montos usados ("4700.00"), para reconocer huérfanos en la limpieza. */
    const montosUsados = new Set();
    /** Línea base: el invariante final es volver exactamente a esto. */
    let baselineIds = new Set();
    let gastosBase = null;

    /** Borra por API y devuelve la respuesta (los pasos que lo usan la asertan). */
    const borrar = async (id) => {
      const borrado = await del(`/api/transactions?id=${id}`);
      creados.delete(id);
      return borrado;
    };

    const idsDeHoy = async () => {
      const res = await movimientosDe(hoy, hoy);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return new Set((res.body?.movements ?? []).map((m) => m.id));
    };

    try {
      /* ── Preparación ─────────────────────────────────────────────────── */
      section("Preparación — panel, línea base y una forma confiable de abrir el modal");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "el panel",
      });
      await ui.waitFor(
        `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
        { timeout: 30000, label: "la hidratación del panel" },
      );

      baselineIds = await idsDeHoy();
      console.log(`  · movimientos de hoy en la línea base: ${baselineIds.size}`);
      gastosBase = await ui.evalJs(GASTOS_CARD);
      checkTrue("la tarjeta 'Gastos' está en pantalla", gastosBase !== null, `${gastosBase}`);

      // Microscopio del camino del submit (se instala UNA vez): cuenta clicks
      // NATIVOS (documento y botón), submits del form y fetchs (duplicados y
      // POST). `guardarRapido` lo resetea por guardado. Cuando algo "no
      // reacciona", la autopsia dice DÓNDE se perdió — es la evidencia del
      // artefacto de entorno, no una corazonada.
      // (Tras la recarga de E6 el microscopio no se reinstala: la autopsia de
      // esos pasos queda más pobre, y está bien.)
      await ui.evalJs(`(() => {
        window.__f7EvOrigFetch = window.fetch;
        window.fetch = (...args) => {
          const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          if (window.__f7ev) {
            if (u.includes("/api/transactions/duplicates")) window.__f7ev.dups += 1;
            else if (u.includes("/api/transactions") && !u.includes("?id=")) window.__f7ev.posts += 1;
          }
          return window.__f7EvOrigFetch(...args);
        };
        document.addEventListener("click", (e) => {
          if (!window.__f7ev) return;
          window.__f7ev.docClicks.push({
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
            t: e.target && (e.target.id || e.target.tagName),
          });
          if (e.target && e.target.closest && e.target.closest("#tx-submit")) window.__f7ev.clicks += 1;
        }, { capture: true });
        document.addEventListener("submit", (e) => {
          if (window.__f7ev && e.target && e.target.tagName === "FORM") window.__f7ev.submits += 1;
        }, { capture: true });
        return true;
      })()`);

      /**
       * Abre "Nuevo gasto" con reintentos: en el entorno CDP se observó una
       * ventana "sorda" post-load en la que el primer click se pierde sin
       * error (nunca vista en Maestro). El reintento es del probe, no del
       * guion: acá no se cuenta como interacción.
       */
      const abrirGasto = async () => {
        for (let intento = 0; intento < 4; intento += 1) {
          await ui.evalJs(`document.getElementById("btn-expense").scrollIntoView({ block: "center" })`);
          await sleep(intento === 0 ? 250 : 300);
          await ui.clickEl("#btn-expense");
          try {
            await ui.waitFor(`!!document.getElementById("tx-submit")`, {
              timeout: 2500,
              label: "el modal",
            });
            return;
          } catch {
            // Se reintenta: el click cayó en la ventana sorda.
          }
        }
        await ui.waitFor(`!!document.getElementById("tx-submit")`, {
          timeout: 2000,
          label: "el modal tras los reintentos",
        });
      };

      /**
       * Guarda por el camino corto (Gasto + monto + Guardar) y devuelve el
       * movimiento recién creado, ya registrado en `creados`. Verifica que el
       * aviso haya aparecido (y no el aviso de duplicado).
       */
      const guardarRapido = async (montoPreferido) => {
        await abrirGasto();
        const accountId = await ui.evalJs(`document.getElementById("tx-account")?.value ?? null`);
        checkTrue(
          "hay cuenta elegida en el select (se guarda con la de siempre)",
          Boolean(accountId),
          `${accountId}`,
        );

        // Pre-chequeo de duplicado (tipo+cuenta+monto+día). Si existiera, se
        // corre un centavo — desvío mínimo, documentado en el log.
        let monto = montoPreferido;
        for (let i = 0; i < 5; i += 1) {
          const dup = await duplicadosDe({ kind: "EXPENSE", accountId, amount: monto, date: hoy });
          if ((dup.body?.duplicates ?? []).length === 0) break;
          monto = (Number(monto) + 0.01).toFixed(2);
          console.log(`  AVISO había un duplicado de ${montoPreferido}; este paso usa ${monto}.`);
        }

        // El autofocus ya está en el monto; se tipea directo, con un reintento
        // por si el foco se perdió al reabrir.
        await ui.evalJs(`document.getElementById("tx-amount").focus()`);
        await sleep(80);
        await ui.insertText(monto);
        let valor = await ui.evalJs(`document.getElementById("tx-amount")?.value ?? null`);
        if (valor !== monto) {
          await ui.evalJs(`document.getElementById("tx-amount").focus()`);
          await ui.insertText(monto);
          valor = await ui.evalJs(`document.getElementById("tx-amount")?.value ?? null`);
        }
        check(`el monto ${monto} quedó tipeado`, valor, monto);
        // El monto INTENCIONADO se registra ANTES de guardar: si la corrida
        // aborta entre el click y el diff, la red de seguridad del finally
        // igual reconoce al huérfano por monto.
        montosUsados.add(Number(monto).toFixed(2));

        // Microscopio por guardado + submit con reintento: en el entorno CDP
        // hubo ventanas en las que el click se pierde sin error (documentado;
        // nunca en Maestro). Si el primer click no llega, el reintento lo
        // salva; y si ningún intento llega, la autopsia queda impresa.
        await ui.evalJs(`window.__f7ev = { clicks: 0, submits: 0, dups: 0, posts: 0, docClicks: [] }`);
        const idsAntes = await idsDeHoy();
        const centroGuardar = await ui.centerOf("#tx-submit");
        let salida = null;
        let autopsia = null;
        for (let intento = 0; intento < 3 && !salida; intento += 1) {
          await ui.clickAt(centroGuardar.x, centroGuardar.y);
          try {
            salida = await ui.waitFor(
              `(() => {
                if (document.getElementById("undo-toast")) return "guardado";
                if (document.getElementById("tx-duplicate-warning")) return "duplicado";
                if ([...document.querySelectorAll("[role=alert]")].some((e) => e.closest("form"))) return "error";
                return false;
              })()`,
              { timeout: 10000, label: "el resultado del guardado" },
            );
          } catch {
            autopsia = await ui.evalJs(`(() => {
              const boton = document.getElementById("tx-submit");
              const enCoords = document.elementFromPoint(${centroGuardar.x}, ${centroGuardar.y});
              return {
                hayModal: !!boton,
                boton: boton ? { texto: boton.textContent.trim(), disabled: boton.disabled } : null,
                errorInline: [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.trim()),
                enCoords: enCoords ? (enCoords.id || enCoords.tagName) : null,
                evt: window.__f7ev ?? null,
                activo: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
              };
            })()`);
            console.log(`  AVISO el guardado no reaccionó (intento ${intento + 1}/3) — autopsia: ${JSON.stringify(autopsia)}`);
          }
        }
        checkTrue("el guardado terminó en el aviso (no en duplicado ni error)", salida === "guardado", JSON.stringify({ salida, autopsia }));
        if (salida !== "guardado") {
          const detalle = await ui.evalJs(`[...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.trim()).join(" || ")`);
          throw new Error(`El guardado no terminó bien (salida=${salida}); en pantalla: ${detalle}; autopsia: ${JSON.stringify(autopsia)}`);
        }

        await ui.waitFor(`!document.getElementById("tx-submit")`, {
          timeout: 10000,
          label: "el cierre del modal",
        });
        await sleep(200);

        const despues = await movimientosDe(hoy, hoy);
        const nuevos = (despues.body?.movements ?? []).filter((m) => !idsAntes.has(m.id));
        check("el guardado creó exactamente 1 movimiento nuevo", nuevos.length, 1);
        const mov = nuevos[0];
        if (mov) {
          creados.add(mov.id);
          montosUsados.add(mov.amount);
          check(`el movimiento es de ${monto}`, mov.amount, Number(monto).toFixed(2));
        }
        return { monto, mov };
      };

      /** Toca "Deshacer" (click real) y espera el cierre del aviso. */
      const deshacer = async (etiqueta) => {
        await ui.clickEl("#undo-button");
        await ui.waitFor(`!document.getElementById("undo-toast")`, {
          timeout: 15000,
          label: `el cierre del aviso (${etiqueta})`,
        });
      };

      const sinMovimiento = async (id, etiqueta) => {
        const res = await movimientosDe(hoy, hoy);
        checkTrue(
          `el movimiento ya no está (${etiqueta})`,
          !(res.body?.movements ?? []).some((m) => m.id === id),
        );
      };

      /* ── E1 · deshacer real ──────────────────────────────────────────── */
      section("E1 — deshacer real: el aviso aparece, borra el movimiento y se va");
      const e1 = await guardarRapido("4700");
      const avisoE1 = await ui.evalJs(`(() => {
        const t = document.getElementById("undo-toast");
        if (!t) return null;
        return {
          texto: t.textContent,
          boton: document.getElementById("undo-button")?.textContent?.trim() ?? null,
          hayX: !!document.getElementById("undo-dismiss"),
        };
      })()`);
      checkTrue("el aviso está en pantalla", avisoE1 !== null, JSON.stringify(avisoE1));
      checkIncluye("el aviso dice qué pasó", avisoE1?.texto, "Movimiento guardado.");
      check("el botón del aviso dice 'Deshacer'", avisoE1?.boton, "Deshacer");
      checkTrue("el aviso trae la × para descartarlo", avisoE1?.hayX);

      await deshacer("E1");
      await sinMovimiento(e1.mov.id, "tras deshacer");
      // El aviso sólo se cierra con 200/404: si el DELETE hubiera fallado,
      // seguiría en pantalla con el error. Cerrarse = final feliz.
      checkTrue(
        "el aviso se cerró limpio (sin callejón de error)",
        !(await ui.evalJs(`!!document.getElementById("undo-toast")`)),
      );
      // La tarjeta "Gastos" es del MES, no del movimiento, y el generador de
      // recurrencia materializa vencimientos en cualquier load(): en la
      // corrida de desarrollo aparecieron movimientos con fechas anteriores
      // apenas el panel recargó. Asertar igualdad contra la línea base acá
      // sería medir al generador, no al deshacer: la evidencia del deshacer es
      // el diff por id (ya hecho) y el aviso. Se deja constancia de los dos
      // valores de la tarjeta:
      await sleep(600); // que asiente el refresh posterior al DELETE
      const gastosE1 = await ui.evalJs(GASTOS_CARD);
      console.log(`  · tarjeta Gastos: base "${gastosBase}" → tras deshacer "${gastosE1}" (informativo: es del mes)`);

      /* ── E2 · 404: el movimiento ya no está ──────────────────────────── */
      section("E2 — 404 feliz: deshacer cuando el movimiento ya no existe");
      const e2 = await guardarRapido("4800");
      // Alguien (otra pestaña, la API) lo borra ANTES del toque: el DELETE del
      // aviso va a recibir 404 — y para "Deshacer" eso también es un final
      // feliz (el objetivo era que no estuviera).
      const borradoDirecto = await borrar(e2.mov.id);
      // El DELETE de la API responde 204 (No Content), no 200. Se afirma 2xx
      // explícito para no acoplar la batería al código exacto de la respuesta.
      checkTrue(
        "el borrado directo por API responde 2xx",
        borradoDirecto.status >= 200 && borradoDirecto.status < 300,
        `status=${borradoDirecto.status}`,
      );
      await deshacer("E2 (404)");
      checkTrue(
        "con 404 el aviso se cierra igual (y no queda error)",
        !(await ui.evalJs(`!!document.getElementById("undo-toast")`)),
      );
      checkTrue(
        "no quedó ningún 'No se pudo deshacer.' en pantalla",
        !(await ui.evalJs(`document.body.textContent.includes("No se pudo deshacer.")`)),
      );
      const idsE2 = await idsDeHoy();
      checkDeep(
        "el día quedó exactamente como la línea base (el 404 no resucitó nada)",
        [...idsE2].sort(),
        [...baselineIds].sort(),
      );

      /* ── E3 · el próximo guardado reemplaza el aviso ─────────────────── */
      section("E3 — el próximo guardado reemplaza el aviso (y el aviso es persistente)");
      const e3a = await guardarRapido("4900");
      const cuantosE3a = await ui.evalJs(`document.querySelectorAll("#undo-toast").length`);
      check("con un guardado hay UN aviso (no se apilan)", cuantosE3a, 1);
      const e3b = await guardarRapido("4950"); // sin tocar el aviso anterior
      const cuantosE3b = await ui.evalJs(`document.querySelectorAll("#undo-toast").length`);
      check("tras el segundo guardado sigue habiendo UN aviso", cuantosE3b, 1);
      // Persistente de verdad: 3,5 s después (de sobra para un auto-hide
      // típico), el aviso sigue ahí.
      await sleep(3500);
      const avisoSigue = await ui.evalJs(`!!document.getElementById("undo-toast")`);
      checkTrue("el aviso NO se auto-oculta (sigue a los 3,5 s)", avisoSigue);
      // Y el aviso es el del ÚLTIMO guardado: deshacer borra 4950, no 4900.
      await deshacer("E3");
      const idsE3 = await idsDeHoy();
      checkTrue("el DELETE del aviso fue al ÚLTIMO movimiento (4950)", !idsE3.has(e3b.mov.id));
      checkTrue("el movimiento anterior (4900) quedó intacto", idsE3.has(e3a.mov.id));
      await borrar(e3a.mov.id);
      await sinMovimiento(e3a.mov.id, "limpieza de E3");

      /* ── E4 · la × descarta sin borrar ───────────────────────────────── */
      section("E4 — la × descarta el aviso y NO toca el movimiento");
      const e4 = await guardarRapido("5000");
      await ui.clickEl("#undo-dismiss");
      await ui.waitFor(`!document.getElementById("undo-toast")`, {
        timeout: 8000,
        label: "el cierre del aviso (×)",
      });
      checkTrue(
        "la × cerró el aviso",
        !(await ui.evalJs(`!!document.getElementById("undo-toast")`)),
      );
      const idsE4 = await idsDeHoy();
      checkTrue("descartar NO borró el movimiento (5000 sigue)", idsE4.has(e4.mov.id));
      await borrar(e4.mov.id);
      await sinMovimiento(e4.mov.id, "limpieza de E4");

      /* ── E5 · error del servidor: se ve, no se traga ─────────────────── */
      section("E5 — error del servidor en el DELETE: el aviso lo muestra y se puede reintentar");
      const e5 = await guardarRapido("5100");
      // Stub de fetch: SOLO el DELETE de movimientos devuelve 500 con mensaje.
      // Es un corte controlado — la rama de error de la UI, de otra forma,
      // pediría un movimiento protegido real (hoy no hay fixture de plan).
      await ui.evalJs(`(() => {
        window.__f7UndoOrigFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init && init.method) || (input && input.method) || "GET";
          if (method === "DELETE" && url.includes("/api/transactions")) {
            return Promise.resolve(new Response(
              JSON.stringify({ error: "T_TESTER_F7_UNDO: fallo simulado" }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            ));
          }
          return window.__f7UndoOrigFetch(input, init);
        };
        return true;
      })()`);
      await ui.clickEl("#undo-button");
      await ui.waitFor(`!!document.getElementById("undo-error")`, {
        timeout: 10000,
        label: "el mensaje de error del aviso",
      });
      const errE5 = await ui.evalJs(`document.getElementById("undo-error")?.textContent?.trim() ?? null`);
      checkIncluye("el aviso muestra el mensaje del servidor", errE5, "fallo simulado");
      checkTrue(
        "el aviso NO se cierra con el error (no falla en silencio)",
        !!(await ui.evalJs(`!!document.getElementById("undo-toast")`)),
      );
      const idsE5 = await idsDeHoy();
      checkTrue("el movimiento sigue vivo (el DELETE falló de verdad)", idsE5.has(e5.mov.id));
      await ui.waitFor(
        `(() => { const b = document.getElementById("undo-button"); return !!b && !b.disabled && b.textContent.trim() === "Deshacer"; })()`,
        { timeout: 8000, label: "el botón habilitado de nuevo (busy=false)" },
      );
      checkTrue("el botón quedó disponible para reintentar", true);

      // Se saca el stub y el reintento REAL ahora sí borra.
      await ui.evalJs(`(() => { window.fetch = window.__f7UndoOrigFetch; delete window.__f7UndoOrigFetch; return true; })()`);
      await deshacer("E5 (reintento real)");
      await sinMovimiento(e5.mov.id, "tras el reintento");

      /* ── E6 · recarga: el aviso no sobrevive ─────────────────────────── */
      section("E6 — recargar la página se lleva el aviso (el movimiento queda)");
      const e6 = await guardarRapido("5200");
      await ui.navigate(`${BASE_URL}/`);
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "el panel recargado",
      });
      checkTrue(
        "tras recargar no hay aviso (el estado era en memoria)",
        !(await ui.evalJs(`!!document.getElementById("undo-toast")`)),
      );
      const idsE6 = await idsDeHoy();
      checkTrue("el movimiento sin aviso sigue en la base", idsE6.has(e6.mov.id));
      await borrar(e6.mov.id);
      await sinMovimiento(e6.mov.id, "limpieza de E6");

      /* ── E7 · doble toque en Deshacer ────────────────────────────────── */
      section("E7 — doble toque en Deshacer: un solo DELETE");
      const e7 = await guardarRapido("5300");
      const centroDeshacer = await ui.centerOf("#undo-button");
      await ui.clickAt(centroDeshacer.x, centroDeshacer.y); // toque 1 (real)
      // ¿Queda algo que tocar para el toque 2? El DELETE local resuelve en
      // decenas de ms: muchas veces el aviso ya se cerró. Si sigue, se toca
      // de nuevo (ahí se ejerce la barrera: `disabled={busy}` o el guard
      // `if (busy) return`). Si no sigue, el toque 2 NO se dispara a ciegas:
      // detrás del aviso hay contenido de la lista y un click suelto ahí no
      // es parte del ataque.
      const enPunto = await ui.evalJs(`(() => {
        const el = document.elementFromPoint(${centroDeshacer.x}, ${centroDeshacer.y});
        if (!el) return null;
        const boton = document.getElementById("undo-button");
        return {
          dentroDelAviso: !!el.closest("#undo-toast"),
          hayBoton: !!boton,
          disabled: boton ? boton.disabled : null,
        };
      })()`);
      let barreraE7;
      if (enPunto && enPunto.dentroDelAviso) {
        await ui.clickAt(centroDeshacer.x, centroDeshacer.y); // toque 2 (real)
        barreraE7 = enPunto.disabled
          ? "toque 2 sobre el botón disabled (saving/busy en DOM)"
          : "toque 2 con el botón aún habilitado (frenó el guard `if (busy) return`)";
      } else {
        barreraE7 = "el aviso ya se había cerrado antes del toque 2 (la capa pointer-events-none deja pasar lo de atrás)";
      }
      await ui.waitFor(`!document.getElementById("undo-toast")`, {
        timeout: 15000,
        label: "el cierre del aviso (E7)",
      });
      console.log(`  · barrera del doble toque en Deshacer: ${barreraE7}`);
      const idsE7 = await idsDeHoy();
      checkTrue("el movimiento del doble toque se borró (el DELETE llegó a destino)", !idsE7.has(e7.mov.id));
      checkTrue(
        "sin 'No se pudo deshacer.' tras el doble toque",
        !(await ui.evalJs(`document.body.textContent.includes("No se pudo deshacer.")`)),
      );
      checkDeep(
        "el día quedó como la línea base (el toque 2 no creó ni borró nada)",
        [...idsE7].sort(),
        [...baselineIds].sort(),
      );

      /* ── E8 · geometría: el aviso no tapa el pie del modal ───────────── */
      section("E8 — geometría: el aviso flota abajo y no bloquea el pie del modal");
      const e8 = await guardarRapido("5400");
      await abrirGasto(); // el aviso de 5400 sigue vivo mientras se abre el modal
      const geo = await ui.evalJs(`(() => {
        const t = document.getElementById("undo-toast");
        const b = document.getElementById("tx-submit");
        if (!t || !b) return { falta: { t: !!t, b: !!b } };
        const rt = t.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const cx = rb.x + rb.width / 2;
        const cy = rb.y + rb.height / 2;
        const enCentro = document.elementFromPoint(cx, cy);
        const alMargen = document.elementFromPoint(100, rt.y + rt.height / 2);
        // Solape = intersección de rectángulos. En la corrida real fue de 2px
        // (borde inferior de Guardar contra el borde superior de la píldora):
        // eso es "beso de bordes", no un bloqueo. Lo que se exige es que no
        // supere la tolerancia y que el centro del botón siga clickeable.
        const solapeAlto = Math.max(0, Math.min(rt.bottom, rb.bottom) - Math.max(rt.top, rb.top));
        const solapeAncho = Math.max(0, Math.min(rt.right, rb.right) - Math.max(rt.left, rb.left));
        const seSolapan = solapeAlto > 0 && solapeAncho > 0;
        const banda = seSolapan
          ? document.elementFromPoint(Math.max(rt.left, rb.left) + solapeAncho / 2, Math.max(rt.top, rb.top) + solapeAlto / 2)
          : null;
        return {
          toast: { top: Math.round(rt.top), bottom: Math.round(rt.bottom), left: Math.round(rt.left), right: Math.round(rt.right) },
          submit: { top: Math.round(rb.top), bottom: Math.round(rb.bottom), left: Math.round(rb.left), right: Math.round(rb.right) },
          seSolapan,
          solapeAlto,
          solapeAncho,
          // Informativo: quién recibe el clic en la banda de solape (si existe).
          enBanda: banda ? (banda.closest("#undo-toast") ? "aviso" : (banda.id || banda.tagName)) : null,
          enCentroEsGuardar: enCentro ? (enCentro.id === "tx-submit" || !!enCentro.closest("#tx-submit")) : false,
          alMargenEsAviso: alMargen ? !!alMargen.closest("#undo-toast") : false,
          capaPointerEvents: getComputedStyle(t.parentElement).pointerEvents,
        };
      })()`);
      console.log(`  · geometría medida: ${JSON.stringify(geo)}`);
      check("la capa del aviso deja pasar los clics fuera de la píldora (pointer-events)", geo?.capaPointerEvents, "none");
      checkTrue(
        "el solape aviso/Guardar es solo de borde (≤4px)",
        geo && typeof geo.solapeAlto === "number" && geo.solapeAlto <= 4,
        JSON.stringify({ solapeAlto: geo?.solapeAlto, solapeAncho: geo?.solapeAncho, falta: geo?.falta }),
      );
      checkTrue("el centro de 'Guardar' le llega al botón, no al aviso", geo?.enCentroEsGuardar, JSON.stringify(geo));
      checkTrue("a la altura del aviso, al margen, no hay aviso (no bloquea la lista)", geo && geo.alMargenEsAviso === false, JSON.stringify(geo));
      await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
      await ui.waitFor(`!document.getElementById("tx-submit")`, {
        timeout: 8000,
        label: "el cierre del modal (cancelar)",
      });
      await deshacer("E8");
      await sinMovimiento(e8.mov.id, "tras deshacer E8");

      /* ── Invariante final: todo volvió a la línea base ───────────────── */
      section("Cierre — el día quedó como estaba");
      await ui.navigate(`${BASE_URL}/`);
      await ui.waitFor(`!!document.getElementById("btn-expense")`, {
        timeout: 30000,
        label: "el panel final",
      });
      const idsFinal = await idsDeHoy();
      checkDeep("ids de hoy idénticos a la línea base (sin fantasmas)", [...idsFinal].sort(), [...baselineIds].sort());
      // (Igual que en E1: la tarjeta del mes no se aserta — el generador de
      // recurrencia puede materializar en cualquier load(). Se imprime.)
      await sleep(600);
      const gastosFinal = await ui.evalJs(GASTOS_CARD);
      console.log(`  · tarjeta Gastos: base "${gastosBase}" → final "${gastosFinal}" (informativo)`);
    } finally {
      // Red de seguridad: lo creado por la UI no lleva nota (description ""),
      // así que `cleanupTag` no puede encontrarlo — se borra por id y, si algo
      // quedó huérfano, por monto usado fuera de la línea base.
      try {
        const res = await movimientosDe(hoy, hoy);
        for (const m of res.body?.movements ?? []) {
          const huerfano = !baselineIds.has(m.id) && (creados.has(m.id) || montosUsados.has(m.amount));
          if (huerfano) await del(`/api/transactions?id=${m.id}`);
        }
      } catch {
        // La limpieza no puede tapar un error real de la corrida.
      }
      for (const id of [...creados]) {
        try {
          await del(`/api/transactions?id=${id}`);
        } catch {
          // Ya no está: es lo que buscábamos.
        }
      }
      await ui.close();
    }
  },
});
