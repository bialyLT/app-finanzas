#!/usr/bin/env node
/**
 * ui-01 · AUTOCOMPLETADO DE DESCRIPCIÓN — contrato de UI (Fase 7 r2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque B)
 * ─────────────────────────────────────────────────────────────────────────────
 * La batería 01 atacó `/api/transactions/suggestions` por API. Ésta verifica el
 * COMPORTAMIENTO real en el formulario, con Chrome real y taps reales sobre el
 * viewport de los tests (1019×557):
 *
 *   1. DEBOUNCE + ABORT: tipear rápido dispara UN pedido (no uno por tecla) y
 *      los AbortController viejos quedan abortados. Con menos de 2 caracteres
 *      no se pide nada.
 *   2. EL DESPLEGABLE NO EMPUJA NADA: es absoluto; la fila de fecha y el pie
 *      fijo no se mueven un píxel al abrirlo (la trampa 15, cerrada con
 *      números). En gasto abre HACIA ARRIBA; en transferencia hacia abajo.
 *   3. TAP REAL sobre una sugerencia: el punto de toque llega al ítem (no al
 *      pie), y el clic precarga descripción, monto (sólo si está vacío),
 *      categoría y cuenta.
 *   4. TECLADO: ↓/↑ mueven el activo, Enter ELIGE (y no guarda el movimiento),
 *      Escape cierra SÓLO el desplegable (sin aviso de descarte).
 *   5. El monto ya escrito NUNCA se pisa. Elegir una sugerencia y después tocar
 *      "Ayer" sigue funcionando (geometría de reposo, cierre del aviso de r1).
 *   6. FILTRO POR TIPO: las sugerencias de INCOME no aparecen en EXPENSE.
 *   7. Cero diálogos nativos y cero excepciones de página en todo el recorrido.
 *
 * Datos propios (prefijo T_T7R2_UI1): cuentas propias, movimientos en 2027
 * (fuera de la ventana de los flows), descripciones limpias ("Super del
 * barrio"). La limpieza borra por cuenta (todas son del tag) — las
 * descripciones visibles no llevan prefijo para no cambiar el ranking.
 *
 * Requiere: server en :3000 (build final). Chrome propio en el puerto 9351.
 */

import {
  OUT_TMP,
  abrirModal,
  abrirPanel,
  addDaysCal,
  cerrarModal,
  check,
  checkTrue,
  dialogosNativos,
  get,
  imprimirTapInfo,
  instrumentar,
  localToday,
  openUi,
  pedidosA,
  post,
  runScript,
  section,
  sleep,
  tapInfo,
} from "./lib.mjs";

const TAG = "T_T7R2_UI1";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ── Fixtures ────────────────────────────────────────────────────────── */
    section("Preparación — cuentas y movimientos propios");
    const banco = await prisma.account.create({
      data: { name: `${TAG} Banco`, kind: "BANK" },
    });
    const efectivo = await prisma.account.create({
      data: { name: `${TAG} Efectivo`, kind: "CASH" },
    });

    const movs = [];
    const crear = async (body) => {
      const r = await post("/api/transactions", body);
      if (r.status === 201 && r.body?.id) movs.push(r.body.id);
      return r;
    };

    // Grupo EXPENSE "Super del barrio": 3 usos, montos 4500/4500/4800 →
    // mediana exacta 4500.00. Fechas 2027 (lejos de la ventana de los flows).
    for (const [i, monto] of ["4500", "4500", "4800"].entries()) {
      await crear({
        kind: "EXPENSE",
        amount: monto,
        date: `2027-05-0${i + 1}`,
        description: "Super del barrio",
        accountId: banco.id,
        categoryName: `${TAG} Comida`,
      });
    }
    await crear({
      kind: "EXPENSE",
      amount: "12000",
      date: "2027-05-04",
      description: "Supermercado mayorista",
      accountId: banco.id,
      categoryName: `${TAG} Comida`,
    });
    // El testigo del filtro por tipo: un INCOME con la misma familia de texto.
    await crear({
      kind: "INCOME",
      amount: "9000",
      date: "2027-05-05",
      description: "Super ingreso",
      accountId: banco.id,
    });
    await crear({
      kind: "TRANSFER",
      amount: "50000",
      date: "2027-05-06",
      description: "Traspaso mensual",
      accountId: banco.id,
      toAccountId: efectivo.id,
    });
    check("los 6 movimientos de fixture se crearon", movs.length, 6);

    const sug = await get(
      `/api/transactions/suggestions?kind=EXPENSE&q=su&limit=6`,
    );
    check("la API trae el grupo del súper primero", sug.body?.suggestions?.[0]?.description, "Super del barrio");
    check("y su monto típico es 4500.00", sug.body?.suggestions?.[0]?.amount, "4500.00");
    check(
      "el INCOME no se cuela en las sugerencias de gasto",
      (sug.body?.suggestions ?? []).some((s) => s.description === "Super ingreso"),
      false,
    );

    /* ── La UI ───────────────────────────────────────────────────────────── */
    const ui = await openUi({ port: 9351 });
    try {
      await abrirPanel(ui);
      await instrumentar(ui);

      const fetchesSugerencias = async () => {
        const lista = await pedidosA(ui, "/api/transactions/suggestions");
        if (!Array.isArray(lista)) throw new Error(`pedidosA no devolvió un array: ${typeof lista}`);
        return lista;
      };
      const fetchesAPost = async () => {
        const lista = await pedidosA(ui, "/api/transactions");
        if (!Array.isArray(lista)) throw new Error(`pedidosA no devolvió un array: ${typeof lista}`);
        return lista.filter((f) => f.method === "POST" && f.url.endsWith("/api/transactions"));
      };
      const controladores = () =>
        ui.evalJs(`(window.__t7r2 ? {
          total: window.__t7r2.controllers.length,
          abortados: window.__t7r2.controllers.filter((c) => c.signal.aborted).length,
        } : null)`);

      /** Tipea como una persona: prefijo a prefijo, con `input` real. */
      const escribir = (texto, pasoMs = 0) => {
        // Vaciar también es un paso: la primera versión no mandaba nada para ""
        // (el bucle no corría) y dejaba el campo con el texto anterior.
        const prefijos =
          texto.length === 0
            ? [""]
            : Array.from({ length: texto.length }, (_, i) => texto.slice(0, i + 1));
        return ui.evalJs(`(async () => {
          const el = document.getElementById("tx-description");
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          const prefijos = ${JSON.stringify(prefijos)};
          const paso = ${pasoMs};
          for (const valor of prefijos) {
            setter.call(el, valor);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            if (paso > 0) await new Promise((r) => setTimeout(r, paso));
          }
          return el.value;
        })()`);
      };

      /** Ítems visibles del desplegable (o null si no está). */
      const leerItems = () =>
        ui.evalJs(`(() => {
          const dd = document.getElementById("tx-description-suggestions");
          if (!dd) return null;
          return [...dd.querySelectorAll('[role="option"]')].map((el) => ({
            id: el.id,
            texto: el.querySelector("span span")?.textContent?.trim() ?? el.textContent.trim(),
            seleccionada: el.getAttribute("aria-selected") === "true",
          }));
        })()`);

      /** Rectángulos redondeados de los anclajes que no se pueden mover. */
      const rects = () =>
        ui.evalJs(`(() => {
          const r = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) };
          };
          return { desc: r("#tx-description"), cat: r("#tx-category"), date: r("#tx-date"), chip: r("#tx-date-ayer"), submit: r("#tx-submit"), dd: r("#tx-description-suggestions") };
        })()`);

      const subirScroll = () =>
        ui.evalJs(`(() => { const s = document.getElementById("tx-submit"); let c = s.parentElement; while (c && getComputedStyle(c).overflowY !== "auto") c = c.parentElement; if (c) c.scrollTop = 0; })()`);

      const abrirGasto = async () => {
        const reintentos = await abrirModal(ui, "#btn-expense");
        await subirScroll();
        return reintentos;
      };

      const esperarDropdown = (label) =>
        ui.waitFor(`!!document.getElementById("tx-description-suggestions")`, {
          timeout: 5000,
          label: label ?? "el desplegable",
        });

      /* ── 1. Debounce + abort + umbral de 2 caracteres ─────────────────── */
      section("1 · Debounce, abort y umbral de 2 caracteres");
      const reintentos = await abrirGasto();
      check("el modal de gasto abrió", await ui.evalJs(`!!document.getElementById("tx-submit")`), true);
      console.log(`  · reintentos de apertura: ${reintentos}`);

      const antes1 = { f: (await fetchesSugerencias()).length, c: await controladores() };

      // Un solo carácter: NO debe pedirse nada ni abrirse el desplegable.
      await escribir("s");
      await sleep(500);
      check("con 1 carácter no se pide ninguna sugerencia", (await fetchesSugerencias()).length, antes1.f);
      check("ni se abre el desplegable", await ui.evalJs(`!!document.getElementById("tx-description-suggestions")`), false);

      // Ráfaga rápida: 4 caracteres a 30ms = 120ms < debounce 180ms.
      await escribir("supe", 30);
      await esperarDropdown("el desplegable tras la ráfaga");
      const items = await leerItems();
      const tras1 = { f: await fetchesSugerencias(), c: await controladores() };
      const pedidos = tras1.f.length - antes1.f;
      check(`la ráfaga de 4 teclas disparó UN pedido (disparó ${pedidos})`, pedidos, 1);
      checkTrue(
        `se creó un AbortController por tecla (${tras1.c.total - antes1.c.total} en total)`,
        tras1.c.total - antes1.c.total >= 3,
      );
      checkTrue(
        `y los viejos quedaron abortados (${tras1.c.abortados - antes1.c.abortados} abortados)`,
        tras1.c.abortados - antes1.c.abortados >= 2,
      );
      const ultimoPedido = tras1.f[tras1.f.length - 1];
      checkTrue(
        "el pedido lleva kind, q y limit del formulario",
        ultimoPedido.url.includes("kind=EXPENSE") &&
          ultimoPedido.url.includes("q=supe") &&
          ultimoPedido.url.includes("limit=6"),
        ultimoPedido.url,
      );
      check("el pedido llegó a 200", ultimoPedido.status, 200);

      check("el desplegable muestra 2 sugerencias", items.length, 2);
      check("primero el grupo más frecuente", items[0]?.texto, "Super del barrio");
      check("segundo el otro grupo", items[1]?.texto, "Supermercado mayorista");
      check(
        "el INCOME no aparece en el formulario de gasto",
        items.some((i) => i.texto === "Super ingreso"),
        false,
      );

      /* ── 2. Geometría: absoluto, no empuja ────────────────────────────── */
      section("2 · El desplegable no empuja la fecha ni el pie fijo");
      const conDd = await rects();
      checkTrue("el desplegable existe para medir", Boolean(conDd.dd));
      checkTrue(
        "en GASTO abre hacia ARRIBA del campo",
        conDd.dd.bottom <= conDd.desc.top + 2,
        JSON.stringify({ dd: conDd.dd, desc: conDd.desc }),
      );
      await escribir("");
      await sleep(300);
      const enReposo = await rects();
      checkTrue(
        "sin desplegable, la fila de fecha queda donde estaba",
        JSON.stringify(enReposo.date) === JSON.stringify(conDd.date),
        JSON.stringify({ reposo: enReposo.date, abierto: conDd.date }),
      );
      checkTrue(
        "y el pie fijo también (ni un píxel)",
        JSON.stringify(enReposo.submit) === JSON.stringify(conDd.submit),
        JSON.stringify({ reposo: enReposo.submit, abierto: conDd.submit }),
      );
      check("el desplegable se cerró al vaciar el campo", await ui.evalJs(`!!document.getElementById("tx-description-suggestions")`), false);

      /* ── 3. Tap real sobre la sugerencia ──────────────────────────────── */
      section("3 · Tap real: el punto de toque llega al ítem y precarga");
      await escribir("supe");
      await esperarDropdown("el desplegable para medir taps");
      const infos = await tapInfo(ui, ["#tx-description-suggestion-0", "#tx-description-suggestion-1"]);
      imprimirTapInfo("Puntos de toque de las sugerencias", infos);
      checkTrue(
        "el ítem 0 recibe el tap (no cae en el pie)",
        infos[0]?.toqueLlega === true && infos[0]?.enBandaPie === false,
        JSON.stringify(infos[0]),
      );
      // El centro del ítem 1 cae DENTRO de la banda del pie (y≈451 con banda
      // desde ≈441), pero el desplegable (z-30) se pinta por ENCIMA del pie: el
      // hit-test llega al ítem y el clic real funciona (se verifica abajo). No
      // es un tap muerto: es un overlay. Se exige el contacto real y se deja la
      // superposición medida como observación.
      if (infos[1]?.enBandaPie) {
        console.log(
          `  · OBSERVACIÓN: el centro del ítem 1 (y=${infos[1]?.y?.toFixed(0)}) cae en la banda del pie ` +
            `(banda desde ≈441), pero el desplegable está por encima y el tap llega al ítem (hit=${infos[1]?.hit}).`,
        );
      }
      checkTrue(
        "el ítem 1 recibe el tap (el desplegable queda por encima del pie)",
        infos[1]?.toqueLlega === true,
        JSON.stringify(infos[1]),
      );

      await ui.clickEl("#tx-description-suggestion-1");
      await sleep(250);
      const trasClick = await ui.evalJs(`({
        desc: document.getElementById("tx-description").value,
        amount: document.getElementById("tx-amount").value,
        cat: document.getElementById("tx-category").value,
        cuenta: document.getElementById("tx-account").value,
        dd: !!document.getElementById("tx-description-suggestions"),
      })`);
      check("el clic carga la descripción elegida", trasClick.desc, "Supermercado mayorista");
      check("carga el monto típico con coma (12000,00)", trasClick.amount, "12000,00");
      check("carga la categoría", trasClick.cat, `${TAG} Comida`);
      check("carga la cuenta", trasClick.cuenta, banco.id);
      check("el desplegable se cierra al elegir", trasClick.dd, false);
      await sleep(700);
      check(
        "y NO se reabre solo (la sugerencia quedó aceptada)",
        await ui.evalJs(`!!document.getElementById("tx-description-suggestions")`),
        false,
      );

      /* ── 4. El monto escrito no se pisa ───────────────────────────────── */
      section("4 · El monto ya escrito nunca se pisa");
      await ui.evalJs(`(() => {
        const el = document.getElementById("tx-amount");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "999");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await escribir("supe");
      await esperarDropdown("el desplegable para el monto escrito");
      await ui.clickEl("#tx-description-suggestion-0");
      await sleep(250);
      const conMonto = await ui.evalJs(`({
        desc: document.getElementById("tx-description").value,
        amount: document.getElementById("tx-amount").value,
      })`);
      check("la descripción se carga igual", conMonto.desc, "Super del barrio");
      check("el monto escrito a mano sobrevive", conMonto.amount, "999");

      // Y elegir + "Ayer": la zona muerta de r1, cerrada con números.
      const chipOk = await tapInfo(ui, ["#tx-date-ayer"]);
      checkTrue(
        "el chip 'Ayer' recibe el tap tras aceptar la sugerencia",
        chipOk[0]?.toqueLlega === true && chipOk[0]?.enBandaPie === false,
        JSON.stringify(chipOk[0]),
      );
      const chip = await ui.centerOf("#tx-date-ayer");
      await ui.clickAt(chip.x, chip.y);
      await sleep(250);
      const fechaAyer = await ui.evalJs(`document.getElementById("tx-date").value`);
      check("tocar 'Ayer' fecha en ayer (no un no-op silencioso)", fechaAyer, addDaysCal(localToday(), -1));

      /* ── 5. Teclado: ↓/↑/Enter/Escape ─────────────────────────────────── */
      section("5 · Teclado: ↓/↑ mueven, Enter elige, Escape cierra sólo el desplegable");
      await ui.evalJs(`(() => {
        const el = document.getElementById("tx-amount");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await escribir("");
      await sleep(150);
      await ui.evalJs(`document.getElementById("tx-description").focus()`);
      await ui.insertText("su");
      await esperarDropdown("el desplegable tras tipear 'su'");

      const activo = () =>
        ui.evalJs(`(() => {
          const dd = document.getElementById("tx-description-suggestions");
          const sel = dd?.querySelector('[aria-selected="true"]');
          return {
            id: sel?.id ?? null,
            activedescendant: document.getElementById("tx-description").getAttribute("aria-activedescendant"),
          };
        })()`);

      await ui.pressKey("ArrowDown", { code: "ArrowDown", keyCode: 40 });
      await sleep(120);
      let act = await activo();
      check("↓ pone el activo en el segundo ítem", act.id, "tx-description-suggestion-1");
      check("aria-activedescendant acompaña", act.activedescendant, "tx-description-suggestion-1");
      await ui.pressKey("ArrowUp", { code: "ArrowUp", keyCode: 38 });
      await sleep(120);
      act = await activo();
      check("↑ vuelve al primero", act.id, "tx-description-suggestion-0");

      // Escape con el desplegable abierto: cierra SÓLO el desplegable.
      await ui.press("Escape");
      await sleep(250);
      const trasEscape = await ui.evalJs(`({
        dd: !!document.getElementById("tx-description-suggestions"),
        form: !!document.getElementById("tx-submit"),
        warning: !!document.getElementById("tx-discard-warning"),
      })`);
      check("Escape cierra el desplegable", trasEscape.dd, false);
      check("el formulario sigue abierto", trasEscape.form, true);
      check("y NO aparece el aviso de descarte", trasEscape.warning, false);

      // Tipear de nuevo lo reabre; ↓ + Enter ELIGE (y no guarda).
      await escribir("");
      await sleep(150);
      await ui.evalJs(`document.getElementById("tx-description").focus()`);
      await ui.insertText("su");
      await esperarDropdown("el desplegable reabierto");
      const postAntes = (await fetchesAPost()).length;
      await ui.pressKey("ArrowDown", { code: "ArrowDown", keyCode: 40 });
      await sleep(120);
      await ui.press("Enter");
      await sleep(300);
      const trasEnter = await ui.evalJs(`({
        desc: document.getElementById("tx-description").value,
        amount: document.getElementById("tx-amount").value,
        dd: !!document.getElementById("tx-description-suggestions"),
        form: !!document.getElementById("tx-submit"),
      })`);
      check("Enter elige la sugerencia activa (la segunda con ↓)", trasEnter.desc, "Supermercado mayorista");
      check("y completa el monto típico", trasEnter.amount, "12000,00");
      check("cierra el desplegable", trasEnter.dd, false);
      check("NO guarda el movimiento (el form sigue abierto)", trasEnter.form, true);
      check("no salió ningún POST /api/transactions extra", (await fetchesAPost()).length, postAntes);

      /* ── 6. TRANSFER: abre hacia abajo y precarga el destino ──────────── */
      section("6 · Transferencia: desplegable hacia abajo y destino precargado");
      await cerrarModal(ui);
      await abrirModal(ui, "#btn-transfer");
      await subirScroll();
      await escribir("tra");
      await esperarDropdown("el desplegable de transferencia");
      const rTrans = await rects();
      checkTrue(
        "en TRANSFER abre hacia ABAJO del campo",
        rTrans.dd.top >= rTrans.desc.bottom - 2,
        JSON.stringify({ dd: rTrans.dd, desc: rTrans.desc }),
      );
      const infosTrans = await tapInfo(ui, ["#tx-description-suggestion-0"]);
      checkTrue(
        "el ítem de transferencia recibe el tap",
        infosTrans[0]?.toqueLlega === true,
        JSON.stringify(infosTrans[0]),
      );
      await ui.clickEl("#tx-description-suggestion-0");
      await sleep(250);
      const trasTransfer = await ui.evalJs(`({
        desc: document.getElementById("tx-description").value,
        amount: document.getElementById("tx-amount").value,
        desde: document.getElementById("tx-account").value,
        hacia: document.getElementById("tx-to-account").value,
      })`);
      check("carga la descripción de la transferencia", trasTransfer.desc, "Traspaso mensual");
      check("carga el monto típico", trasTransfer.amount, "50000,00");
      check("carga el origen", trasTransfer.desde, banco.id);
      check("y el destino de la sugerencia", trasTransfer.hacia, efectivo.id);

      /* ── 7. INCOME tiene sus propias sugerencias ──────────────────────── */
      section("7 · Las sugerencias de INCOME viven en el formulario de ingreso");
      await cerrarModal(ui);
      await abrirModal(ui, "#btn-income");
      await escribir("su");
      await esperarDropdown("el desplegable de ingreso");
      const enIngreso = await ui.evalJs(
        `[...document.querySelectorAll('#tx-description-suggestions [role="option"]')].map((el) => el.querySelector("span span")?.textContent?.trim() ?? "")`,
      );
      checkTrue("el ingreso ve su propia sugerencia", enIngreso.includes("Super ingreso"), JSON.stringify(enIngreso));
      check("y no ve las de gasto", enIngreso.includes("Super del barrio"), false);
      await cerrarModal(ui);

      /* ── 8. Cierre: diálogos nativos, excepciones y captura ───────────── */
      section("8 · Cierre");
      const dialogos = await dialogosNativos(ui);
      check("ningún diálogo nativo en todo el recorrido", (dialogos ?? []).length, 0);
      const errores = await ui.evalJs(`(window.__t7r2 ? window.__t7r2.errores : null)`);
      check("ninguna excepción de página", (errores ?? []).length, 0);
      await ui.screenshot(`${OUT_TMP}/t7r2-ui01-sugerencias.png`);

      // La UI no escribió nada: hoy no puede haber ningún movimiento nuestro.
      const hoy = localToday();
      const deHoy = await get(`/api/transactions?from=${hoy}&to=${hoy}`);
      const nuestrosHoy = (deHoy.body?.movements ?? []).filter((m) =>
        /Super|Traspaso mensual/.test(m.description ?? ""),
      );
      check("la UI no guardó ningún movimiento hoy", nuestrosHoy.length, 0);
    } finally {
      await ui.close();
    }
  },
});
