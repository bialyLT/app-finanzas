#!/usr/bin/env node
/**
 * ui-07 · ATAQUE I — el monto por la UI: vista previa vs. lo persistido
 *
 * El contrato que ataca (components/TransactionForm.tsx + lib/format.ts +
 * lib/money.ts):
 *   · Mientras se escribe, el `<p>` bajo `tx-amount` muestra "Se guarda como
 *     <b>$ X</b>" — o el ámbar "No se entiende el monto" — o el hint gris
 *     ("Podés escribir 1500, 1.500,50 o 1,500.50"). Nunca queda mudo.
 *   · La interpretación de separadores es la del servidor: "1.500" = mil
 *     quinientos (acá el punto separa miles), "1,500.50" = mil quinientos con
 *     cincuenta (manda el último separador), "1234.567" = decimal (no respeta
 *     el patrón de miles completo).
 *   · Lo que la preview dice es LO QUE SE GUARDA: se escribe cada formato y se
 *     verifica el monto REAL en la API (centavos exactos).
 *   · Basura no guarda: "abc"/vacío los bloquea el cliente ("Escribí un monto
 *     mayor a cero."); "0"/"-4500" pasan la preview pero los rechaza el
 *     servidor ("El monto tiene que ser mayor a cero."). En ningún caso nace
 *     un movimiento.
 *
 * Método:
 *   · La preview se lee del DOM real (el `<b>` y el `<span class="text-amber-600">`).
 *   · Tipear es insertText con select-all previo (reemplaza, no apila).
 *   · Guardar usa el mismo camino que un usuario: clic real en `tx-submit`
 *     con reintento acotado (ventana sorda del CDP) y espera del desenlace
 *     (toast / duplicado / error).
 *   · Cada guardado exitoso se limpia por id (API) + se descarta el toast.
 *     Invariante final: el día idéntico a la línea base, sin restos.
 *
 * Requiere: server en :3000 y Chrome CDP 9341 (se lanza y se mata solo).
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  check,
  checkDeep,
  checkTrue,
  cuentas,
  del,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_MONTO";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normaliza NBSP (Intl mete "$<NBSP>4.500,00") y espacios repetidos. */
const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

runScript({
  tag: TAG,
  main: async (_prisma) => {
    const ui = await openUi({ port: 9341 });
    const hoy = localToday();
    const creados = new Set();
    const montosUsados = new Set();
    let baselineIds = new Set();

    const idsDeHoy = async () => {
      const res = await movimientosDe(hoy, hoy);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return new Set((res.body?.movements ?? []).map((m) => m.id));
    };

    const borrar = async (id) => {
      await del(`/api/transactions?id=${id}`);
      creados.delete(id);
    };

    /** Abre el modal de `btnSelector` con reintentos (ventana sorda del CDP). */
    const abrirCon = async (btnSelector) => {
      for (let intento = 0; intento < 4; intento += 1) {
        await ui.evalJs(`document.querySelector(${JSON.stringify(btnSelector)}).scrollIntoView({ block: "center" })`);
        await sleep(intento === 0 ? 250 : 300);
        await ui.clickEl(btnSelector);
        try {
          await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2500, label: "el modal" });
          return;
        } catch {
          // Reintento: el click cayó en la ventana sorda.
        }
      }
      await ui.waitFor(`!!document.getElementById("tx-submit")`, { timeout: 2000, label: "el modal tras los reintentos" });
    };

    /** Clic real con reintento acotado hasta que la condición se cumpla. */
    const clickHasta = async (selector, condicion, label) => {
      for (let intento = 0; intento < 3; intento += 1) {
        await ui.clickEl(selector);
        try {
          await ui.waitFor(condicion, { timeout: 2500, label });
          return intento;
        } catch {
          console.log(`  AVISO ${label}: el clic no reaccionó (intento ${intento + 1}/3); se reintenta.`);
        }
      }
      await ui.waitFor(condicion, { timeout: 2000, label: `${label} tras reintentos` });
      return 3;
    };

    /** Tipea en un campo (select-all previo: reemplaza, no apila). */
    const tipearEn = async (selector, texto) => {
      for (let intento = 0; intento < 2; intento += 1) {
        await ui.evalJs(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          el.focus();
          if (el.select) el.select();
          return true;
        })()`);
        await sleep(80);
        await ui.insertText(texto);
        const valor = await ui.evalJs(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
        if (valor === texto) return;
      }
      check(`el texto "${texto}" quedó tipeado en ${selector}`, await ui.evalJs(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`), texto);
    };

    /** Vacía un input controlado por React con el setter nativo + `input`. */
    const limpiarCampo = (selector) =>
      ui.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
      })()`);

    /** La vista previa del monto tal como está en el DOM. */
    const preview = () =>
      ui.evalJs(`(() => {
        const inp = document.getElementById("tx-amount");
        const p = inp?.parentElement?.querySelector("p");
        if (!p) return null;
        return {
          texto: p.textContent,
          negrita: p.querySelector("b")?.textContent ?? null,
          ambar: p.querySelector(".text-amber-600")?.textContent ?? null,
        };
      })()`);

    /**
     * Toca Guardar con el monto ya tipeado y espera el desenlace real
     * (toast / aviso de duplicado / error en el formulario). Devuelve el
     * movimiento nuevo y lo registra en `creados`.
     */
    const guardarConAviso = async (etiqueta) => {
      const idsAntes = await idsDeHoy();
      const centro = await ui.centerOf("#tx-submit");
      let salida = null;
      for (let intento = 0; intento < 3 && !salida; intento += 1) {
        await ui.clickAt(centro.x, centro.y);
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
          console.log(`  AVISO el guardado no reaccionó (intento ${intento + 1}/3); se reintenta el click.`);
        }
      }
      if (salida !== "guardado") {
        const detalle = await ui.evalJs(`[...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.trim()).join(" || ")`);
        throw new Error(`El guardado de ${etiqueta} no terminó bien (salida=${salida}); en pantalla: ${detalle}`);
      }
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 10000, label: "el cierre del modal" });
      await sleep(200);
      const despues = await movimientosDe(hoy, hoy);
      const nuevos = (despues.body?.movements ?? []).filter((m) => !idsAntes.has(m.id));
      check(`el guardado de ${etiqueta} creó exactamente 1 movimiento`, nuevos.length, 1);
      const mov = nuevos[0];
      if (mov) creados.add(mov.id);
      return mov ?? null;
    };

    /** Limpia un guardado: DELETE por API + descarte del toast (×). */
    const limpiarGuardado = async (id) => {
      await borrar(id);
      await clickHasta("#undo-dismiss", `!document.getElementById("undo-toast")`, "descartar el aviso");
    };

    /** El aviso de error del formulario contiene `texto`. */
    const esperarError = (texto) =>
      `[...document.querySelectorAll('p[role="alert"]')].some((e) => e.textContent.includes(${JSON.stringify(texto)}))`;

    try {
      /* ── Preparación ─────────────────────────────────────────────────── */
      section("Preparación — panel, cuenta disponible y línea base");
      await ui.navigate(`${BASE_URL}/`);
      await ui.loginIfNeeded();
      await ui.waitFor(`!!document.getElementById("btn-expense")`, { timeout: 30000, label: "el panel" });
      await ui.waitFor(
        `Object.keys(document.getElementById("btn-expense") ?? {}).some((k) => k.startsWith("__reactProps"))`,
        { timeout: 30000, label: "la hidratación del panel" },
      );
      baselineIds = await idsDeHoy();
      console.log(`  · movimientos de hoy en la línea base: ${baselineIds.size}`);
      const cuentasRes = await cuentas("?includeArchived=false");
      checkTrue("hay al menos una cuenta (si no, el modal no muestra el formulario)", (cuentasRes.body?.accounts ?? []).length >= 1, JSON.stringify(cuentasRes.status));

      /* ── I1 · vista previa en vivo ───────────────────────────────────── */
      section("I1 — la vista previa en vivo interpreta lo que se escribe");
      await abrirCon("#btn-expense");
      const previews = [
        ["4500", "$ 4.500,00"],
        ["4500,5", "$ 4.500,50"],
        ["1.500", "$ 1.500,00"], // el punto separa miles (convención local)
        ["1.500,50", "$ 1.500,50"],
        ["1,500.50", "$ 1.500,50"], // manda el último separador
        ["1234.567", "$ 1.234,57"], // no respeta el patrón de miles → decimal
        ["1a5b0c0", "$ 1.500,00"], // letras afuera, sin drama
        ["0,01", "$ 0,01"],
        ["999999999,99", "$ 999.999.999,99"],
        ["+4500", "$ 4.500,00"],
      ];
      for (const [entrada, esperado] of previews) {
        await tipearEn("#tx-amount", entrada);
        const pv = await preview();
        check(`preview "${entrada}" → "${esperado}"`, norm(pv?.negrita), esperado);
        checkTrue(`"${entrada}" no muestra el ámbar`, !pv?.ambar, JSON.stringify(pv));
      }
      await tipearEn("#tx-amount", "abc");
      const pvAbc = await preview();
      checkTrue('con "abc" no hay preview numérica', !pvAbc?.negrita, JSON.stringify(pvAbc));
      check('con "abc" aparece el ámbar que explica', norm(pvAbc?.ambar), "No se entiende el monto. Probá con 1500 o 1.500,50");
      await limpiarCampo("#tx-amount");
      const pvVacio = await preview();
      check("vacío → hint gris de formatos", norm(pvVacio?.texto), "Podés escribir 1500, 1.500,50 o 1,500.50");
      checkTrue("vacío → sin ámbar ni negrita", !pvVacio?.ambar && !pvVacio?.negrita, JSON.stringify(pvVacio));
      await clickHasta("#tx-cancel", `!document.getElementById("tx-submit")`, "cerrar el modal (cancelar)");

      /* ── I3 · basura no guarda ───────────────────────────────────────── */
      section("I3 — basura no guarda: lo bloquea el cliente o lo rechaza el servidor");
      const rechazos = [
        ["abc", "Escribí un monto mayor a cero."], // preview null → bloqueo del cliente
        [null, "Escribí un monto mayor a cero."], // vacío → bloqueo del cliente
        ["0", "El monto tiene que ser mayor a cero."], // pasa preview → 400 del servidor
        ["-4500", "El monto tiene que ser mayor a cero."], // pasa preview → 400 del servidor
      ];
      for (const [entrada, mensaje] of rechazos) {
        await abrirCon("#btn-expense");
        if (entrada !== null) await tipearEn("#tx-amount", entrada);
        await clickHasta("#tx-submit", esperarError(mensaje), `el rechazo de "${entrada ?? "vacío"}"`);
        const alerta = await ui.evalJs(`[...document.querySelectorAll('p[role="alert"]')].map((e) => e.textContent.trim()).join(" || ")`);
        check(`"${entrada ?? "vacío"}" → error en el formulario`, alerta.includes(mensaje) ? mensaje : alerta, mensaje);
        checkTrue(`"${entrada ?? "vacío"}" no cerró el modal`, await ui.evalJs(`!!document.getElementById("tx-submit")`), "se cerró");
        checkTrue(`"${entrada ?? "vacío"}" no guardó nada (sin toast)`, !(await ui.evalJs(`!!document.getElementById("undo-toast")`)), "apareció toast");
        await clickHasta("#tx-cancel", `!document.getElementById("tx-submit")`, "cerrar el modal (cancelar)");
      }
      const idsTrasRechazos = await idsDeHoy();
      checkDeep("los rechazos no crearon movimientos", [...idsTrasRechazos].sort(), [...baselineIds].sort());

      /* ── I2 · lo que dice la preview es lo que se guarda ─────────────── */
      section("I2 — la preview coincide con el monto persistido (centavos exactos)");
      const guardados = [
        ["4500", "4500.00", "$ 4.500,00"],
        ["4500,5", "4500.50", "$ 4.500,50"],
        ["1.500,50", "1500.50", "$ 1.500,50"],
        ["+4500", "4500.00", "$ 4.500,00"], // el signo tolerado también guarda
      ];
      for (const [entrada, apiEsperado, previewEsperada] of guardados) {
        await abrirCon("#btn-expense");
        await tipearEn("#tx-amount", entrada);
        const pv = await preview();
        check(`preview "${entrada}" antes de guardar`, norm(pv?.negrita), previewEsperada);
        montosUsados.add(apiEsperado);
        const mov = await guardarConAviso(`"${entrada}"`);
        check(`"${entrada}" persistió ${apiEsperado} (la preview no mintió)`, Number(mov?.amount).toFixed(2), apiEsperado);
        const formateadoAR = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(apiEsperado));
        checkTrue(
          `"${entrada}": la preview que vio el usuario es el número que se persistió`,
          norm(pv?.negrita) === `$ ${formateadoAR}`,
          `preview=${norm(pv?.negrita)} · api=${apiEsperado} (${formateadoAR})`,
        );
        if (mov) await limpiarGuardado(mov.id);
      }

      /* ── Cierre ──────────────────────────────────────────────────────── */
      section("Cierre — el día quedó como estaba");
      const idsFinal = await idsDeHoy();
      checkDeep("ids de hoy idénticos a la línea base (nada fantasma)", [...idsFinal].sort(), [...baselineIds].sort());
      checkTrue("sin toast colgado", !(await ui.evalJs(`!!document.getElementById("undo-toast")`)), "quedó toast");
      checkTrue("sin error colgado en pantalla", !(await ui.evalJs(`!!document.querySelector('p[role="alert"]')`)), "quedó error");
    } finally {
      // Red de seguridad por id y por monto (los movimientos de UI no llevan
      // nota: `cleanupTag` no puede encontrarlos por prefijo).
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
          // Ya no está.
        }
      }
      await ui.close();
    }
  },
});
