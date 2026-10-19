#!/usr/bin/env node
/**
 * ui-04 · ATAQUE F — la cuenta recordada (localStorage) de la carga rápida
 *
 * El contrato que ataca (lib/quick-entry.ts + TransactionForm):
 *   · Clave por TIPO: "finanzas:ultima-cuenta:<KIND>". Se guarda el id CRUDO
 *     como string —no JSON—: leer no puede fallar por parseo ("broken JSON"
 *     es, en este formato, una basura más que no matchea ninguna cuenta).
 *   · Al ABRIR el formulario, la cuenta de origen = la última usada de ese
 *     tipo si sigue existiendo y es válida para el tipo; si no, la primera
 *     válida (para INCOME, la primera que no sea liability).
 *   · Se ESCRIBE sólo cuando un guardado sale bien (best-effort: un storage
 *     bloqueado no puede tumbar el guardado — se pierde la comodidad, no el
 *     movimiento).
 *   · Cambiar de tipo conserva la cuenta si sigue siendo válida; si no, se
 *     re-resuelve como al abrir.
 *
 * Los casos hostiles que corre:
 *   F1 sin clave · F2 clave válida · F3 id inexistente · F4 sólo espacios ·
 *   F5 basura con forma de JSON · F6 clave inválida para el tipo (Visa es
 *   liability: un INCOME no puede entrar ahí) · F7 aislamiento entre tipos
 *   (gasto/ingreso/transferencia) y destino de transferencia intacto ·
 *   F8 guardar una transferencia escribe SU clave (y sólo esa) · F9 round
 *   trip de gasto: cambiar la cuenta y guardar → la próxima apertura la
 *   recuerda · F10 cambiar la cuenta SIN guardar no escribe · F11 storage
 *   que LANZA (Object.defineProperty): todo cae a la primera válida y el
 *   guardado sigue funcionando.
 *
 * Método: modales abiertos con clicks REALES en los botones del panel; los
 * selects se cambian con el setter nativo + evento `change` (lo que ve React);
 * el valor persistido se verifica en la API real (y en una transferencia,
 * también el destino). Los movimientos creados se limpian por id + red de
 * seguridad por monto en el finally.
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
  duplicadosDe,
  localToday,
  movimientosDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F7_LS";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const claveDe = (kind) => `finanzas:ultima-cuenta:${kind}`;

runScript({
  tag: TAG,
  main: async (prisma) => {
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

    const setClave = (kind, valor) =>
      ui.evalJs(`localStorage.setItem(${JSON.stringify(claveDe(kind))}, ${JSON.stringify(valor)}); true`);
    const quitarClave = (kind) =>
      ui.evalJs(`localStorage.removeItem(${JSON.stringify(claveDe(kind))}); true`);
    const leerClave = (kind) =>
      ui.evalJs(`localStorage.getItem(${JSON.stringify(claveDe(kind))})`);

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

    /** Cierra el modal abierto con Escape (sólo modales sin datos escritos). */
    const cerrarConEscape = async () => {
      for (let intento = 0; intento < 3; intento += 1) {
        await ui.press("Escape");
        try {
          await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 3000, label: "el cierre (Escape)" });
          return;
        } catch {
          console.log(`  AVISO Escape no cerró (intento ${intento + 1}/3); se reintenta.`);
        }
      }
      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 2000, label: "el cierre tras los reintentos" });
    };

    /** Estado del modal: tipo activo + cuentas seleccionadas (id y texto). */
    const estadoDelModal = () =>
      ui.evalJs(`(() => {
        const activo = ["tx-kind-gasto", "tx-kind-ingreso", "tx-kind-transferencia"].find(
          (id) => document.getElementById(id)?.getAttribute("aria-pressed") === "true",
        ) ?? null;
        const sel = document.getElementById("tx-account");
        const to = document.getElementById("tx-to-account");
        return {
          activo,
          cuenta: sel ? sel.value : null,
          cuentaTexto: sel ? sel.selectedOptions?.[0]?.textContent?.trim() : null,
          destino: to ? to.value : null,
        };
      })()`);

    /** Cambia un select controlado por React con el setter nativo + `change`. */
    const setSelect = (selector, valor) =>
      ui.evalJs(`(() => {
        const sel = document.querySelector(${JSON.stringify(selector)});
        if (!sel) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(sel, ${JSON.stringify(valor)});
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return sel.value;
      })()`);

    /**
     * Tipea el monto en el modal abierto y toca Guardar (con reintento por la
     * ventana sorda). Devuelve el movimiento nuevo; lo registra en `creados`.
     */
    const guardarEsperandoAviso = async (monto) => {
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
      montosUsados.add(Number(monto).toFixed(2));

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
        throw new Error(`El guardado no terminó bien (salida=${salida}); en pantalla: ${detalle}`);
      }

      await ui.waitFor(`!document.getElementById("tx-submit")`, { timeout: 10000, label: "el cierre del modal" });
      await sleep(200);
      const despues = await movimientosDe(hoy, hoy);
      const nuevos = (despues.body?.movements ?? []).filter((m) => !idsAntes.has(m.id));
      check("el guardado creó exactamente 1 movimiento nuevo", nuevos.length, 1);
      const mov = nuevos[0];
      if (mov) creados.add(mov.id);
      return mov ?? null;
    };

    try {
      /* ── Preparación ─────────────────────────────────────────────────── */
      section("Preparación — panel, cuentas reales y línea base");
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
      const lista = cuentasRes.body?.accounts ?? [];
      const validasPara = (kind) => lista.filter((a) => (kind === "INCOME" ? !a.isLiability : true));
      const primeraValida = (kind) => validasPara(kind)[0]?.id ?? null;
      // Las dos cuentas no-liability del dev DB (Banco Galicia, Efectivo) y una
      // liability (Visa) para el caso "clave inválida para INCOME".
      const noLiab = lista.filter((a) => !a.isLiability);
      const liab = lista.find((a) => a.isLiability);
      checkTrue("hay al menos 2 cuentas no-liability (hacen falta para los casos)", noLiab.length >= 2, `${noLiab.length}`);
      checkTrue("hay al menos 1 cuenta liability (caso INCOME inválido)", Boolean(liab), JSON.stringify(lista.map((a) => `${a.name}${a.isLiability ? " LIAB" : ""}`)));
      const [cuentaA, cuentaB] = noLiab; // orden de la API = orden del select
      console.log(`  · cuentas: ${noLiab.map((a) => a.name).join(", ")}${liab ? ` · liability: ${liab.name}` : ""}`);

      /* ── F1 · sin clave → primera válida ─────────────────────────────── */
      section("F1 — sin clave: la cuenta por defecto es la primera válida");
      await quitarClave("EXPENSE");
      await abrirCon("#btn-expense");
      let estado = await estadoDelModal();
      check("abre Gasto", estado.activo, "tx-kind-gasto");
      check("sin clave, la cuenta de origen es la primera válida", estado.cuenta, cuentaA.id);
      await cerrarConEscape();

      /* ── F2 · clave válida → esa cuenta ──────────────────────────────── */
      section("F2 — clave válida: la última usada manda");
      await setClave("EXPENSE", cuentaB.id);
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("la cuenta de origen es la recordada (Efectivo)", estado.cuenta, cuentaB.id);
      await cerrarConEscape();

      /* ── F3–F5 · claves hostiles → primera válida ────────────────────── */
      section("F3/F4/F5 — id inexistente, espacios y basura con forma de JSON caen a la primera válida");
      await setClave("EXPENSE", "cm_tester_f7_inexistente_000");
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("F3 · id inexistente → primera válida", estado.cuenta, cuentaA.id);
      await cerrarConEscape();

      await setClave("EXPENSE", "   ");
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("F4 · sólo espacios → primera válida", estado.cuenta, cuentaA.id);
      await cerrarConEscape();

      await setClave("EXPENSE", '{"id":"cm_tester_f7_basura"}');
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("F5 · basura con forma de JSON → primera válida", estado.cuenta, cuentaA.id);
      await cerrarConEscape();
      // Abrir no ESCRIBE: las claves hostiles quedan como estaban (la lectura
      // las ignora; escribir es cosa del guardado).
      check("las aperturas no limpiaron la clave hostil (leer no escribe)", await leerClave("EXPENSE"), '{"id":"cm_tester_f7_basura"}');

      /* ── F6 · clave inválida para el tipo (liability → INCOME) ───────── */
      section("F6 — clave inválida para el tipo: Visa (liability) no puede ser origen de un ingreso");
      await setClave("INCOME", liab.id);
      await abrirCon("#btn-income");
      estado = await estadoDelModal();
      check("abre Ingreso", estado.activo, "tx-kind-ingreso");
      check("la liability se ignora y cae a la primera válida", estado.cuenta, primeraValida("INCOME"));
      checkTrue("la cuenta elegida no es la liability", estado.cuenta !== liab.id, `${estado.cuentaTexto}`);
      await cerrarConEscape();

      /* ── F7 · aislamiento entre tipos + destino de transferencia ─────── */
      section("F7 — una clave por tipo: gasto, ingreso y transferencia no se pisan");
      await setClave("EXPENSE", cuentaA.id);
      await setClave("TRANSFER", cuentaB.id);
      await abrirCon("#btn-transfer");
      estado = await estadoDelModal();
      check("abre Transferencia", estado.activo, "tx-kind-transferencia");
      check("el origen es la clave de TRANSFER (Efectivo)", estado.cuenta, cuentaB.id);
      check("el destino es la primera cuenta que no es el origen (Galicia)", estado.destino, cuentaA.id);
      await cerrarConEscape();

      // Cambiar el origen SIN guardar y cerrar: no escribe nada.
      await abrirCon("#btn-transfer");
      await setSelect("#tx-account", cuentaA.id);
      await cerrarConEscape();
      check("cambiar la cuenta sin guardar NO toca la clave", await leerClave("TRANSFER"), cuentaB.id);
      await abrirCon("#btn-transfer");
      estado = await estadoDelModal();
      check("reabrir: el origen sigue siendo el recordado (Efectivo)", estado.cuenta, cuentaB.id);
      await cerrarConEscape();

      /* ── F8 · guardar una transferencia escribe SU clave ─────────────── */
      section("F8 — guardar una transferencia escribe la clave de TRANSFER (y sólo esa)");
      await abrirCon("#btn-transfer");
      await setSelect("#tx-account", cuentaA.id); // Galicia → el destino se re-elige (Efectivo)
      estado = await estadoDelModal();
      checkTrue("al cambiar el origen, el destino ya no es el origen", estado.destino !== cuentaA.id, JSON.stringify(estado));
      const movF8 = await guardarEsperandoAviso("5500");
      check("la transferencia salió con origen Galicia", movF8?.account?.id, cuentaA.id);
      check("y destino Efectivo", movF8?.toAccount?.id ?? null, estado.destino);
      check("la clave de TRANSFER quedó escrita con el origen usado", await leerClave("TRANSFER"), cuentaA.id);
      check("la clave de EXPENSE no se tocó", await leerClave("EXPENSE"), cuentaA.id);
      if (movF8) {
        await borrar(movF8.id);
        await ui.clickEl("#undo-dismiss");
        await ui.waitFor(`!document.getElementById("undo-toast")`, { timeout: 8000, label: "el cierre del aviso (×)" });
        const tras = await idsDeHoy();
        checkTrue("la transferencia de F8 se limpió (sin fantasma)", !tras.has(movF8.id));
      }

      /* ── F9 · round trip de gasto ────────────────────────────────────── */
      section("F9 — gasto: cambiar la cuenta y guardar → la próxima apertura la recuerda");
      await setClave("EXPENSE", cuentaA.id);
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("abre con la clave previa (Galicia)", estado.cuenta, cuentaA.id);
      await setSelect("#tx-account", cuentaB.id);
      const movF9 = await guardarEsperandoAviso("5600");
      check("el gasto salió con la cuenta elegida (Efectivo)", movF9?.account?.id, cuentaB.id);
      check("la clave de EXPENSE quedó escrita con esa cuenta", await leerClave("EXPENSE"), cuentaB.id);
      if (movF9) {
        await borrar(movF9.id);
        await ui.clickEl("#undo-dismiss");
        await ui.waitFor(`!document.getElementById("undo-toast")`, { timeout: 8000, label: "el cierre del aviso (×)" });
      }
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("round trip: reabrir Gasto ya viene con Efectivo", estado.cuenta, cuentaB.id);
      await cerrarConEscape();

      /* ── F10 · cambiar sin guardar no escribe ────────────────────────── */
      section("F10 — cambiar la cuenta sin guardar no escribe");
      await abrirCon("#btn-expense");
      await setSelect("#tx-account", cuentaA.id);
      await cerrarConEscape();
      check("la clave sigue siendo Efectivo", await leerClave("EXPENSE"), cuentaB.id);
      await abrirCon("#btn-expense");
      estado = await estadoDelModal();
      check("reabrir: sigue Efectivo", estado.cuenta, cuentaB.id);
      await cerrarConEscape();

      /* ── F11 · storage que lanza ─────────────────────────────────────── */
      section("F11 — localStorage bloqueado (tira al accederse): comodidad perdida, guardado intacto");
      // `localStorage` es un accessor PROPIO de window: para restaurarlo hay
      // que guardar su descriptor ANTES de pisarlo. Borrar la propiedad no
      // restaura nada: deja el global inexistente y el próximo `localStorage`
      // tira ReferenceError (bug del primer intento de esta batería).
      const descriptorGuardado = await ui.evalJs(`(() => {
        try {
          const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
          if (!desc || typeof desc.get !== "function") return false;
          Object.defineProperty(window, "__f7_ls_desc", { value: desc, configurable: true });
          return true;
        } catch {
          return false;
        }
      })()`);
      const override = descriptorGuardado === true && (await ui.evalJs(`(() => {
        try {
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() { throw new Error("T_TESTER_F7_LS: storage bloqueado"); },
          });
          return true;
        } catch {
          return false;
        }
      })()`));
      checkTrue("se pudo simular el storage que lanza (descriptor original guardado)", override === true, `${override} · descriptor=${descriptorGuardado}`);
      if (override === true) {
        await abrirCon("#btn-expense");
        estado = await estadoDelModal();
        check("con storage roto, el modal igual abre y cae a la primera válida", estado.cuenta, cuentaA.id);
        const movF11 = await guardarEsperandoAviso("5700");
        checkTrue("el guardado NO se rompió por el storage", movF11 !== null, "sin movimiento");
        const lecturaConStorageRoto = await ui.evalJs(`(() => { try { window.localStorage.getItem("x"); return "no-lanza"; } catch { return "lanza"; } })()`);
        check("el storage sigue bloqueado (la lectura de la clave falla, no devuelve basura)", lecturaConStorageRoto, "lanza");
        if (movF11) {
          await borrar(movF11.id);
          await ui.clickEl("#undo-dismiss");
          await ui.waitFor(`!document.getElementById("undo-toast")`, { timeout: 8000, label: "el cierre del aviso (×)" });
        }
        const restaurado = await ui.evalJs(`(() => {
          try {
            Object.defineProperty(window, "localStorage", window.__f7_ls_desc);
            delete window.__f7_ls_desc;
            const s = localStorage; // bare: si el global no existe, acá tira
            s.getItem("__f7_probe__");
            return typeof s;
          } catch (e) {
            return "falla: " + e.message;
          }
        })()`);
        check("el storage real quedó restaurado (accesible y usable)", restaurado, "object");
        check("la clave de EXPENSE quedó como antes del bloqueo (Efectivo)", await leerClave("EXPENSE"), cuentaB.id);
      }

      /* ── Cierre ──────────────────────────────────────────────────────── */
      section("Cierre — claves finales y día como estaba");
      console.log(`  · claves finales: EXPENSE=${await leerClave("EXPENSE")} · INCOME=${await leerClave("INCOME")} · TRANSFER=${await leerClave("TRANSFER")}`);
      check("la clave inválida de INCOME (Visa) sigue guardada como estaba — abrir no limpia", await leerClave("INCOME"), liab.id);
      const idsFinal = await idsDeHoy();
      checkDeep("ids de hoy idénticos a la línea base (sin fantasmas)", [...idsFinal].sort(), [...baselineIds].sort());
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
