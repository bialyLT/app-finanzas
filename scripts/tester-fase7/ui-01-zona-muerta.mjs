#!/usr/bin/env node
/**
 * ui-01 · LA ZONA MUERTA DEL PIE FIJO — todas las variantes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, ataque B)
 * ─────────────────────────────────────────────────────────────────────────────
 * En la ventana de los tests (1019×557) el modal del formulario es
 * `max-h-[92vh] overflow-y-auto` y su pie es `sticky bottom-0` con fondo
 * OPACO. La geometría medida en el árbol REAL del flow 04:
 *
 *   · contenedor del modal: y 22..535 (viewport 557, 92vh = 512)
 *   · BANDA MUERTA del pie:  y 441..511 — todo tap acá lo come el pie
 *     (opaco: lo de abajo está visualmente tapado, y el tap NO llega al campo)
 *   · debajo 535: fuera del contenedor → recortado (invisible sin scroll).
 *
 * El flow 04 perdió así la nota de una transferencia (`description: ""`, sin
 * error). El dev reordenó «Nota» por tipo. Esta sonda mide, para las TRES
 * variantes y con datos cargados:
 *
 *   1. El punto de toque de cada campo (el CENTRO DEL LABEL, que es lo que
 *      resuelve Maestro — lo probó el log del flow 04).
 *   2. Si ese punto cae en la banda del pie (tap tragado) o fuera del
 *      contenedor (recortado): en cualquiera de los dos casos el campo NO es
 *      alcanzable sin scrollear.
 *   3. La pérdida silenciosa REAL: tap en el punto de toque + tipeo. ¿Foco?
 *      ¿Llegó el texto? ¿El tap cerró el modal?
 *   4. El cambio de tipo con datos cargados: nada se pierde y la variante
 *      nueva no deja campos muertos NUEVOS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE EXIGE Y QUÉ SE AdVIRTIERTE (lo medido manda)
 * ─────────────────────────────────────────────────────────────────────────────
 * El formulario NO entra completo en 512px (gasto: 637px de contenido;
 * transferencia: 670px). Algo tiene que scrollear. Lo que esta sonda EXIGE:
 *
 *   · Todo campo que un flujo toca (monto, categoría, nota, chips en reposo,
 *     pestañas de tipo, guardar) es alcanzable en el estado que el flujo
 *     ejercita.
 *   · Ningún tap en un punto de toque resuelto pierde texto EN SILENCIO en los
 *     caminos vivos (elegir sugerencia → fecha; nota de transferencia; etc.).
 *   · Cambiar de tipo no pierde datos.
 *
 * Lo que ADVIERTE (residuo documentado de la ventana baja, reportado al
 * orquestador y sin flujo afectado): en TRANSFERENCIA la fila de fecha/chips
 * queda debajo del contenedor (hay que scrollear el modal para fechar ≠ hoy),
 * y en GASTO/INGRESO con el campo de categoría enfocado (fila de sugerencias
 * abierta) la fila de fecha baja a la banda del pie.
 *
 * El viewport es el del árbol REAL del flow 04 (`b=[0,0][1019,557]`), y los
 * taps son CDP reales sobre Chrome real — el mismo sustrato que Maestro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE CORRE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/tester-fase7/ui-01-zona-muerta.mjs
 *
 * Requiere: server en :3000 (build final) y la base dev en cualquier estado
 * (la sonda NO escribe nada: sólo abre el modal y toca/tipea en memoria).
 * Deja capturas en %TEMP%\opencode\f7-zona-muerta-*.png.
 */

import { openUi } from "./cdp.mjs";
import {
  BASE_URL,
  addDaysCal,
  check,
  checkTrue,
  localToday,
  section,
  summary,
} from "./helpers.mjs";

const OUT = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode`;

const FIELDS = [
  { id: "tx-amount", control: "#tx-amount", label: 'label[for="tx-amount"]' },
  { id: "tx-description", control: "#tx-description", label: 'label[for="tx-description"]' },
  { id: "tx-account", control: "#tx-account", label: 'label[for="tx-account"]' },
  { id: "tx-to-account", control: "#tx-to-account", label: 'label[for="tx-to-account"]' },
  { id: "tx-category", control: "#tx-category", label: 'label[for="tx-category"]' },
  { id: "tx-date", control: "#tx-date", label: 'label[for="tx-date"]' },
  { id: "tx-date-hoy", control: "#tx-date-hoy", label: null },
  { id: "tx-date-ayer", control: "#tx-date-ayer", label: null },
];

const measureExpr = `(() => {
  const submit = document.getElementById("tx-submit");
  if (!submit) return null;
  let container = submit.parentElement;
  while (container && getComputedStyle(container).overflowY !== "auto") {
    container = container.parentElement;
  }
  const footer = submit.closest(".sticky") ?? submit.parentElement;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
             x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const fields = ${JSON.stringify(FIELDS.map((f) => ({ id: f.id, control: f.control, label: f.label })))};
  const items = {};
  for (const field of fields) {
    const control = document.querySelector(field.control);
    const label = field.label ? document.querySelector(field.label) : null;
    const controlRect = rect(control);
    const labelRect = rect(label);
    items[field.id] = {
      exists: !!control,
      control: controlRect,
      label: labelRect,
      // El punto de toque de Maestro: el CENTRO DEL LABEL si existe.
      tap: labelRect ? { x: labelRect.x, y: labelRect.y } : controlRect ? { x: controlRect.x, y: controlRect.y } : null,
    };
  }
  const fr = footer.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  return {
    container: { top: cr.top, bottom: cr.bottom, clientHeight: container.clientHeight,
                 scrollHeight: container.scrollHeight, scrollTop: container.scrollTop },
    footer: { top: fr.top, bottom: fr.bottom },
    viewport: { width: innerWidth, height: innerHeight },
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    items,
  };
})()`;

/**
 * Clasificación de un punto de toque contra la geometría del modal.
 *   "ok"          → se puede tocar sin scrollear (dentro del contenedor y
 *                    fuera de la banda del pie).
 *   "banda-pie"   → y ∈ [footerTop, footerBottom]: el pie lo come (silencio).
 *   "recortado"   → fuera del contenedor: invisible sin scroll.
 */
function classify(point, measure) {
  if (!point) return "inexistente";
  if (point.y < measure.container.top || point.y > measure.container.bottom) return "recortado";
  if (point.y >= measure.footer.top && point.y <= measure.footer.bottom) return "banda-pie";
  return "ok";
}

function printTable(title, measure) {
  console.log(
    `\n  ${title} — contenedor ${measure.container.top.toFixed(0)}..${measure.container.bottom.toFixed(0)}` +
      ` (scroll ${measure.container.scrollHeight}/${measure.container.clientHeight}),` +
      ` banda del pie ${measure.footer.top.toFixed(0)}..${measure.footer.bottom.toFixed(0)}`,
  );
  for (const [id, item] of Object.entries(measure.items)) {
    if (!item.exists || !item.tap) {
      console.log(`    · ${id.padEnd(17)} — no está`);
      continue;
    }
    const how = classify(item.tap, measure);
    const flag =
      how === "ok" ? "" : how === "banda-pie" ? "  ← TAP EN LA BANDA DEL PIE" : "  ← RECORTADO (scroll)";
    console.log(
      `    · ${id.padEnd(17)} tap(y=${item.tap.y.toFixed(0)}) [${how}]` +
        ` control[${item.control.top.toFixed(0)}..${item.control.bottom.toFixed(0)}]${flag}`,
    );
  }
}

const warnings = [];
function warn(label, detail) {
  warnings.push(`${label}: ${detail}`);
  console.log(`  AVISO ${label}`);
  if (detail) console.log(`        ${detail}`);
}

/** Exige que TODOS los ids dados tengan tap point "ok". */
function requireReachable(label, measure, ids) {
  const bad = ids.filter((id) => classify(measure.items[id]?.tap, measure) !== "ok");
  checkTrue(
    label,
    bad.length === 0,
    bad.map((id) => `${id} → ${classify(measure.items[id]?.tap, measure)}`).join(", "),
  );
  return bad;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const ui = await openUi({ port: 9341 });
  try {
    const today = localToday();
    const yesterday = addDaysCal(today, -1);

    section("Preparación — app + login");
    await ui.navigate(`${BASE_URL}/`);
    await ui.loginIfNeeded();
    await ui.waitFor(`!!document.getElementById("btn-expense")`, {
      timeout: 30000,
      label: "el panel",
    });
    checkTrue("el panel cargó", true);

    const scrollTop = () =>
      ui.evalJs(`(() => {
        const submit = document.getElementById("tx-submit");
        let c = submit.parentElement;
        while (c && getComputedStyle(c).overflowY !== "auto") c = c.parentElement;
        c.scrollTop = 0;
        return c.scrollTop;
      })()`);

    const openModal = async (openSelector) => {
      await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
      await sleep(150);
      // El HTML llega server-rendered: el botón existe ANTES de que React
      // hidrate, así que un clic sintético temprano se pierde sin error. Se
      // reintenta hasta que el modal aparezca (el usuario real tarda segundos
      // en apuntar y tocar; CDP puede clickear milisegundos después del DOM).
      let opened = false;
      for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
        await ui.evalJs(
          `document.getElementById(${JSON.stringify(openSelector.slice(1))}).scrollIntoView({ block: "center" })`,
        );
        await sleep(250);
        await ui.clickEl(openSelector);
        try {
          await ui.waitFor(`!!document.getElementById("tx-submit")`, {
            timeout: 2500,
            label: "modal (reintento)",
          });
          opened = true;
        } catch {
          // Se reintenta.
        }
      }
      if (!opened) {
        await ui.waitFor(`!!document.getElementById("tx-submit")`, {
          timeout: 1000,
          label: `el modal tras ${openSelector}`,
        });
      }
      await scrollTop();
      await sleep(150);
      return ui.evalJs(measureExpr);
    };

    /* ── 1. GASTO, en reposo ─────────────────────────────────────────────── */
    section("Variante GASTO — en reposo");
    let m = await openModal("#btn-expense");
    check("al abrir, el foco cae en el monto (autofocus)", m.active, "tx-amount");
    printTable("GASTO reposo", m);
    requireReachable("GASTO reposo: monto, cuenta, categoría, nota y chips alcanzables", m, [
      "tx-amount", "tx-account", "tx-category", "tx-description", "tx-date-hoy", "tx-date-ayer",
    ]);
    await ui.screenshot(`${OUT}/f7-zona-muerta-gasto-reposo.png`);

    /* ── 2. GASTO con la categoría enfocada (sugerencias abiertas) ───────── */
    section("Variante GASTO — categoría enfocada (sugerencias visibles)");
    await ui.evalJs(`document.getElementById("tx-category").focus()`);
    await sleep(400);
    m = await ui.evalJs(measureExpr);
    printTable("GASTO con sugerencias", m);
    requireReachable("GASTO+sugerencias: la categoría sigue alcanzable", m, ["tx-category"]);
    const gastoSugerencias = { ...m };
    await ui.screenshot(`${OUT}/f7-zona-muerta-gasto-sugerencias.png`);

    // Y el camino real: elegir una sugerencia y DESPUÉS querer "Ayer".
    const sugValue = await ui.evalJs(`document.querySelector("div.mt-2.flex.flex-wrap.gap-2 button")?.textContent ?? null`);
    checkTrue("hay sugerencias visibles que se pueden elegir", Boolean(sugValue), `texto: ${sugValue}`);
    if (sugValue) {
      const sugCenter = await ui.evalJs(`(() => {
        const b = document.querySelector("div.mt-2.flex.flex-wrap.gap-2 button");
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await ui.clickAt(sugCenter.x, sugCenter.y);
      await sleep(250);
      const cat = await ui.evalJs(`document.getElementById("tx-category")?.value ?? null`);
      check("elegir una sugerencia carga su nombre en la categoría", cat, sugValue);

      // El chip "Ayer" DESPUÉS de elegir: ¿sigue respondiendo?
      const chip = await ui.centerOf("#tx-date-ayer");
      await ui.clickAt(chip.x, chip.y);
      await sleep(250);
      const value = await ui.evalJs(`document.getElementById("tx-date")?.value ?? null`);
      check(
        "GASTO: elegir sugerencia y después tocar 'Ayer' fecha en ayer (sin no-op silencioso)",
        value,
        yesterday,
      );
    }

    /* ── 3. INGRESO ──────────────────────────────────────────────────────── */
    section("Variante INGRESO — en reposo");
    m = await openModal("#btn-income");
    printTable("INGRESO reposo", m);
    requireReachable("INGRESO reposo: todos los campos y chips alcanzables", m, [
      "tx-amount", "tx-account", "tx-category", "tx-description", "tx-date-hoy", "tx-date-ayer",
    ]);
    await ui.screenshot(`${OUT}/f7-zona-muerta-ingreso-reposo.png`);

    /* ── 4. TRANSFERENCIA ────────────────────────────────────────────────── */
    section("Variante TRANSFERENCIA — en reposo");
    m = await openModal("#btn-transfer");
    printTable("TRANSFERENCIA reposo", m);
    requireReachable("TRANSFER reposo: monto, nota, origen y destino alcanzables (label)", m, [
      "tx-amount", "tx-description", "tx-account", "tx-to-account",
    ]);
    // Residuo documentado: fecha/chips de la transferencia.
    const transferDate = classify(m.items["tx-date-ayer"]?.tap, m);
    if (transferDate !== "ok") {
      warn(
        "TRANSFER: la fila de fecha y los chips 'Hoy/Ayer' quedan fuera de la vista sin scrollear",
        `chips → ${transferDate} (tap y=${m.items["tx-date-ayer"]?.tap?.y?.toFixed(0)}, contenedor hasta ${m.container.bottom.toFixed(0)}). ` +
          "No lo toca ningún flujo; fechar ≠ hoy exige scrollear el modal.",
      );
    }
    await ui.screenshot(`${OUT}/f7-zona-muerta-transfer-reposo.png`);

    // El destino: ¿la label lleva el foco al select aunque el control esté tapado?
    {
      const labelCenter = await ui.evalJs(`(() => {
        const l = document.querySelector('label[for="tx-to-account"]');
        const r = l.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await ui.clickAt(labelCenter.x, labelCenter.y);
      await sleep(200);
      const after = await ui.evalJs(`({
        modalOpen: !!document.getElementById("tx-submit"),
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
      })`);
      checkTrue("TRANSFER: el label de destino no cierra el modal", after.modalOpen, JSON.stringify(after));
      check("TRANSFER: tocar el label de destino enfoca el select de destino", after.active, "tx-to-account");
    }

    /* ── 5. Pérdida silenciosa REAL: tap en el punto de toque ────────────── */
    section("Pérdida silenciosa — tap en el punto de toque de la nota");

    const silentLossProbe = async ({ openSelector, field, typeText }) => {
      await openModal(openSelector);
      const info = await ui.evalJs(`(() => {
        const label = document.querySelector('label[for="${field}"]');
        const el = label ?? document.getElementById("${field}");
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await ui.clickAt(info.x, info.y);
      await sleep(200);
      const after = await ui.evalJs(`({
        modalOpen: !!document.getElementById("tx-submit"),
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
      })`);
      let typed = null;
      if (after.modalOpen) {
        await ui.insertText(typeText);
        await sleep(150);
        typed = await ui.evalJs(
          `document.getElementById(${JSON.stringify(field)})?.value ?? null`,
        );
      }
      return { after, typed };
    };

    {
      const probe = await silentLossProbe({
        openSelector: "#btn-expense",
        field: "tx-description",
        typeText: "nota-de-prueba",
      });
      checkTrue("GASTO: tocar la nota NO cierra el modal", probe.after.modalOpen, JSON.stringify(probe.after));
      check("GASTO: tocar la nota enfoca la nota", probe.after.active, "tx-description");
      check("GASTO: el texto tipeado llega a la nota", probe.typed, "nota-de-prueba");
    }
    {
      const probe = await silentLossProbe({
        openSelector: "#btn-transfer",
        field: "tx-description",
        typeText: "nota-de-prueba",
      });
      checkTrue("TRANSFER: tocar la nota NO cierra el modal", probe.after.modalOpen, JSON.stringify(probe.after));
      check("TRANSFER: tocar la nota enfoca la nota", probe.after.active, "tx-description");
      check("TRANSFER: el texto tipeado llega a la nota", probe.typed, "nota-de-prueba");
    }

    /* ── 6. Chip "Ayer" en gasto e ingreso (reposo) ──────────────────────── */
    section("Chip AYER — en reposo");
    for (const { kind, openSelector } of [
      { kind: "GASTO", openSelector: "#btn-expense" },
      { kind: "INGRESO", openSelector: "#btn-income" },
    ]) {
      await openModal(openSelector);
      const chip = await ui.centerOf("#tx-date-ayer");
      await ui.clickAt(chip.x, chip.y);
      await sleep(200);
      const value = await ui.evalJs(`document.getElementById("tx-date")?.value ?? null`);
      check(`${kind}: tocar "Ayer" fecha el movimiento en ayer`, value, yesterday);
    }

    /* ── 7. Cambio de tipo con datos cargados ────────────────────────────── */
    section("Cambio de tipo con datos cargados — nada se pierde, nada queda muerto");
    await openModal("#btn-expense");
    await ui.evalJs(`document.getElementById("tx-amount").focus()`);
    await ui.insertText("4500");
    await ui.evalJs(`document.getElementById("tx-category").focus()`);
    await ui.insertText("Kiosco");
    await ui.evalJs(`document.getElementById("tx-description").focus()`);
    await ui.insertText("la nota sobrevive");
    await scrollTop();
    await sleep(150);

    await ui.clickEl("#tx-kind-transferencia");
    await ui.waitFor(
      `!document.getElementById("tx-category") && !!document.getElementById("tx-to-account")`,
      { timeout: 5000, label: "el cambio a transferencia" },
    );
    let values = await ui.evalJs(`({
      amount: document.getElementById("tx-amount").value,
      description: document.getElementById("tx-description")?.value ?? null,
    })`);
    check("cambio a transferencia: el monto sobrevive", values.amount, "4500");
    check("cambio a transferencia: la nota sobrevive", values.description, "la nota sobrevive");
    await scrollTop();
    m = await ui.evalJs(measureExpr);
    printTable("TRANSFER (con datos, tras cambio de tipo)", m);
    requireReachable("TRANSFER con datos: monto, nota y origen alcanzables", m, [
      "tx-amount", "tx-description", "tx-account",
    ]);
    await ui.screenshot(`${OUT}/f7-zona-muerta-transfer-con-datos.png`);

    await ui.clickEl("#tx-kind-gasto");
    await ui.waitFor(`!!document.getElementById("tx-category")`, {
      timeout: 5000,
      label: "la vuelta a gasto",
    });
    values = await ui.evalJs(`({
      amount: document.getElementById("tx-amount").value,
      category: document.getElementById("tx-category")?.value ?? null,
      description: document.getElementById("tx-description")?.value ?? null,
    })`);
    check("vuelta a gasto: el monto sigue", values.amount, "4500");
    check("vuelta a gasto: la categoría sigue", values.category, "Kiosco");
    check("vuelta a gasto: la nota sigue", values.description, "la nota sobrevive");

    await ui.evalJs(`document.getElementById("tx-cancel")?.click()`);
    await sleep(150);
    const open = await ui.evalJs(`!!document.getElementById("tx-submit")`);
    check("el modal se cerró sin guardar nada", open, false);

    /* ── 8. El residuo de gasto+sugerencias, con números ─────────────────── */
    if (classify(gastoSugerencias.items["tx-date-ayer"]?.tap, gastoSugerencias) !== "ok") {
      warn(
        "GASTO/INGRESO con categoría abierta: la fila de fecha baja a la banda del pie",
        `chips → ${classify(gastoSugerencias.items["tx-date-ayer"]?.tap, gastoSugerencias)} ` +
          `(tap y=${gastoSugerencias.items["tx-date-ayer"]?.tap?.y?.toFixed(0)}, banda desde ${gastoSugerencias.footer.top.toFixed(0)}). ` +
          "Mientras haya sugerencias en pantalla, el chip 'Ayer' no responde.",
      );
    }

    section("Resumen de avisos");
    for (const w of warnings) console.log(`  · ${w}`);
  } finally {
    await ui.close();
  }
}

await main();
await sleep(200);
const ok = summary();
process.exit(ok ? 0 : 1);
