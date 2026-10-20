#!/usr/bin/env node
/**
 * 05-nav-telefono · el menú del teléfono: se abre, se navega, se cierra, y el
 * teclado no queda atrapado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE DECLARA EL DEV
 * «En el teléfono: un botón “☰ Menú” que abre un panel de dos columnas con
 * los seis destinos» y «Un solo conjunto de destinos en el DOM (LINKS), dos
 * presentaciones. Si fueran dos markups distintos, el id de un destino
 * existiría dos veces y el querySelector del primer match apuntaría al que
 * está oculto».
 *
 * Eso se verifica:
 *   · NO hay ids duplicados en el DOM (el id es lo que usan los flows);
 *   · el panel se abre de verdad con un toque real (no está en el DOM y ya);
 *   · los destinos son alcanzables con el DEDO (targets ≥ 44 px y el tap
 *     llega al enlace);
 *   · navegar con el menú abierto lo cierra (si no, el panel tapa la vista
 *     nueva);
 *   · se puede abrir con TECLADO y el foco no queda atrapado;
 *   · en pantalla ancha sigue estando la fila de siempre, con los ids que
 *     usan los flows (`nav-cards`, `nav-loans`, `nav-recurrence`).
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { openUi, applyViewport, verifyViewport, openRoute, correrBateria } from "./lib.mjs";

const MOVIL = { name: "375 iphone-se", width: 375, height: 667 };
const ESCRITORIO = { name: "1019 ventana de tests", width: 1019, height: 557 };

/** Los ids que los flows usan (la fila de escritorio). */
const IDS_DE_FLOWS = ["nav-cards", "nav-loans", "nav-recurrence"];

/** Los destinos del menú, por texto exacto (los flows matchean por texto). */
const DESTINOS = ["Inicio", "🔁 Recurrencia", "💳 Tarjetas", "🤝 Préstamos", "📊 Análisis"];

const idsDuplicados = (ui) =>
  ui.evalJs(`(() => {
    const vistos = new Map();
    for (const el of document.querySelectorAll("[id]")) {
      vistos.set(el.id, (vistos.get(el.id) ?? 0) + 1);
    }
    return [...vistos.entries()].filter(([, n]) => n > 1).map(([id, n]) => id + "×" + n);
  })()`);

async function main() {
  const ui = await openUi({
    port: 9357,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9357`,
  });
  try {
    /* ── 1 · el teléfono: el menú se abre con un toque real ─────────────── */
    section("1 · teléfono (375 px): el menú se abre de verdad");
    await applyViewport(ui, MOVIL, { touch: true });
    await openRoute(ui, "/");
    await verifyViewport(ui, MOVIL, { touch: true });

    const antes = await ui.evalJs(`(() => {
      const panel = document.getElementById("nav-destinos");
      const toggle = document.getElementById("nav-toggle");
      return {
        existePanel: !!panel,
        altoPanel: panel ? panel.getBoundingClientRect().height : 0,
        expandido: toggle ? toggle.getAttribute("aria-expanded") : null,
        textoToggle: toggle ? toggle.textContent.trim() : null
      };
    })()`);
    checkTrue("el botón del menú existe en el teléfono", antes.existePanel === true);
    check("el panel arranca cerrado (altura 0)", Math.round(antes.altoPanel), 0);
    check("el botón arranca con aria-expanded=false", antes.expandido, "false");
    check("el botón dice «☰ Menú»", antes.textoToggle, "☰ Menú");

    // Un toque REAL en el botón.
    const r = await ui.centerOf("#nav-toggle");
    await ui.clickAt(r.x, r.y);
    await new Promise((res) => setTimeout(res, 500));
    const despues = await ui.evalJs(`(() => {
      const panel = document.getElementById("nav-destinos");
      const toggle = document.getElementById("nav-toggle");
      const r = panel.getBoundingClientRect();
      return {
        altoPanel: r.height,
        expandido: toggle.getAttribute("aria-expanded"),
        textoToggle: toggle.textContent.trim(),
        anchoPanel: r.width
      };
    })()`);
    checkTrue(
      "el panel se abre con un toque real (alto > 0)",
      despues.altoPanel > 0,
      `alto=${despues.altoPanel}`,
    );
    check("el botón queda con aria-expanded=true", despues.expandido, "true");
    check("el botón cambia a «✕ Cerrar»", despues.textoToggle, "✕ Cerrar");
    checkTrue(
      "el panel no se pasa del ancho del device",
      despues.anchoPanel <= MOVIL.width + 1,
      `ancho=${despues.anchoPanel}`,
    );

    /* ── 2 · un solo conjunto de destinos (nada de ids duplicados) ──────── */
    section("2 · el DOM no tiene ids duplicados");
    const dup = await idsDuplicados(ui);
    check("no hay ningún id repetido en el documento", dup.length, 0);
    if (dup.length) console.log(`  · ids duplicados: ${dup.join(", ")}`);

    /* ── 3 · los destinos se tocan con el dedo ──────────────────────────── */
    section("3 · cada destino del menú se toca y navega");
    for (const texto of DESTINOS) {
      const info = await ui.evalJs(`(() => {
        const links = [...document.querySelectorAll("#nav-destinos a")];
        const el = links.find((a) => a.textContent.trim() === ${JSON.stringify(texto)});
        if (!el) return { existe: false };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          existe: true, w: r.width, h: r.height,
          llega: !!hit && (hit === el || el.contains(hit)),
          hit: hit ? (hit.id || hit.tagName.toLowerCase()) : null,
          href: el.getAttribute("href")
        };
      })()`);
      checkTrue(`el destino «${texto}» está en el menú`, info.existe === true);
      if (!info.existe) continue;
      checkTrue(
        `«${texto}» es un target táctil de 44 px o más (${Math.round(info.w)}×${Math.round(info.h)})`,
        info.h >= 44 && info.w >= 44,
        `${info.w}×${info.h}`,
      );
      checkTrue(`el tap llega a «${texto}»`, info.llega === true, `hit=${info.hit}`);
    }

    /* ── 4 · tocar un destino navega y cierra el menú ──────────────────── */
    section("4 · tocar «Tarjetas» navega y el menú se cierra");
    await ui.evalJs(`(() => {
      const links = [...document.querySelectorAll("#nav-destinos a")];
      const el = links.find((a) => a.textContent.trim() === "💳 Tarjetas");
      el.scrollIntoView({ block: "center" });
      return true;
    })()`);
    await new Promise((res) => setTimeout(res, 250));
    const rr = await ui.centerOf("#nav-destinos a[href='/tarjetas']");
    await ui.clickAt(rr.x, rr.y);
    await ui.waitFor("location.pathname === '/tarjetas'", { timeout: 15000, label: "la navegación" });
    await new Promise((res) => setTimeout(res, 700));
    const trasNavegar = await ui.evalJs(`(() => {
      const toggle = document.getElementById("nav-toggle");
      const panel = document.getElementById("nav-destinos");
      return {
        ruta: location.pathname,
        expandido: toggle ? toggle.getAttribute("aria-expanded") : null,
        altoPanel: panel ? panel.getBoundingClientRect().height : 0
      };
    })()`);
    check("se navegó a /tarjetas", trasNavegar.ruta, "/tarjetas");
    check("el menú se cierra al navegar", trasNavegar.expandido, "false");
    check("el panel vuelve a altura 0", Math.round(trasNavegar.altoPanel), 0);

    /* ── 5 · se puede volver a abrir ────────────────────────────────────── */
    section("5 · el menú se vuelve a abrir");
    await openRoute(ui, "/");
    const r2 = await ui.centerOf("#nav-toggle");
    await ui.clickAt(r2.x, r2.y);
    await new Promise((res) => setTimeout(res, 500));
    const reabierta = await ui.evalJs(`(() => {
      const panel = document.getElementById("nav-destinos");
      return {
        alto: panel.getBoundingClientRect().height,
        expandido: document.getElementById("nav-toggle").getAttribute("aria-expanded")
      };
    })()`);
    checkTrue("el menú se reabre", reabierta.alto > 0, `alto=${reabierta.alto}`);
    check("el botón vuelve a aria-expanded=true", reabierta.expandido, "true");

    /* ── 6 · teclado: se abre con Enter y el foco no queda atrapado ────── */
    section("6 · teclado: se abre con Enter y el foco no queda atrapado");
    const focoAntes = await ui.evalJs(`(() => {
      const t = document.getElementById("nav-toggle");
      t.focus();
      return { id: document.activeElement ? document.activeElement.id : null };
    })()`);
    check("el botón del menú recibe el foco", focoAntes.id, "nav-toggle");
    await ui.press("Enter");
    await new Promise((res) => setTimeout(res, 400));
    const conEnter = await ui.evalJs(`(() => ({
      expandido: document.getElementById("nav-toggle").getAttribute("aria-expanded"),
      foco: document.activeElement ? document.activeElement.id : null
    }))()`);
    check("Enter abre el menú", conEnter.expandido, "true");

    // El foco NO tiene que quedar atrapado: Tab tiene que poder llegar a los
    // destinos del menú (y salir de ahí).
    const cadena = [];
    let llegoAlMenu = false;
    let salioDelMenu = false;
    for (let i = 0; i < 10; i += 1) {
      // `pressKey` (no `press`): el mapa de teclas del cliente CDP no tiene
      // Tab, y acá hace falta una tecla REAL.
      await ui.pressKey("Tab", { code: "Tab", keyCode: 9 });
      const f = await ui.evalJs(
        `(() => {
          const a = document.activeElement;
          const enMenu = !!(a && a.closest && a.closest("#nav-destinos"));
          return {
            id: a ? a.id : null, tag: a ? a.tagName.toLowerCase() : null,
            texto: a ? (a.textContent || "").trim().slice(0, 18) : "", enMenu
          };
        })()`,
      );
      if (f.enMenu) llegoAlMenu = true;
      else if (llegoAlMenu) salioDelMenu = true;
      cadena.push(`${f.tag ?? "?"}${f.id ? "#" + f.id : ""}${f.texto ? "[" + f.texto + "]" : ""}`);
    }
    console.log(`  · cadena de foco con Tab: ${cadena.join(" → ")}`);
    checkTrue(
      "el foco puede llegar a los destinos del menú con el teclado",
      llegoAlMenu === true,
      cadena.join(" → "),
    );
    checkTrue(
      "el foco NO queda atrapado dentro del menú (sigue pudiendo salir)",
      salioDelMenu === true,
      `cadena: ${cadena.join(" → ")}`,
    );

    /* ── 7 · en pantalla ancha sigue la fila de siempre ─────────────────── */
    section("7 · pantalla ancha: la fila de escritorio con los ids de los flows");
    await applyViewport(ui, ESCRITORIO, { touch: true });
    await openRoute(ui, "/");
    await verifyViewport(ui, ESCRITORIO, { touch: true });
    const escritorio = await ui.evalJs(`(() => {
      const fila = document.getElementById("nav-destinos");
      const r = fila.getBoundingClientRect();
      const toggle = document.getElementById("nav-toggle");
      const tr = toggle.getBoundingClientRect();
      const links = [...fila.querySelectorAll("a")].map((a) => ({
        id: a.id, texto: a.textContent.trim(), w: a.getBoundingClientRect().width,
        h: a.getBoundingClientRect().height
      }));
      return {
        altoFila: r.height, anchoFila: r.width,
        toggleVisible: tr.width > 0 && tr.height > 0,
        links,
        ids: links.map((l) => l.id).filter(Boolean)
      };
    })()`);
    checkTrue(
      "la fila de destinos se ve en pantalla ancha",
      escritorio.altoFila > 0,
      `alto=${escritorio.altoFila}`,
    );
    checkTrue(
      "el botón «☰ Menú» está oculto en pantalla ancha",
      escritorio.toggleVisible === false,
    );
    for (const id of IDS_DE_FLOWS) {
      checkTrue(
        `el id ${id} (que usan los flows) existe`,
        escritorio.ids.includes(id),
        `ids=${escritorio.ids.join(",")}`,
      );
    }
    const dupEscritorio = await idsDuplicados(ui);
    check("no hay ids duplicados en pantalla ancha", dupEscritorio.length, 0);
    checkTrue(
      "la fila de destinos no se pasa del ancho de la ventana",
      escritorio.anchoFila <= ESCRITORIO.width,
      `ancho=${escritorio.anchoFila}`,
    );
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "05-nav-telefono", conSesion: true });
