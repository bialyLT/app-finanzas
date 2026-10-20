#!/usr/bin/env node
/**
 * 07-montos-largos · ¿un monto de 14+ caracteres entra en su tarjeta?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL LÍMITE QUE EL DEV DECLARÓ
 * El dev dice (§8.3): «Los montos con más de 13 caracteres (por ejemplo
 * `+$ 1.234.567.890,12`): el corte de 940 px está calculado para 13. Con 14+
 * caracteres el monto se sale de su tarjeta en el layout de cuatro columnas.»
 *
 * O sea: un límite DECLARADO, no medido por la auditoría (que barre anchos,
 * no montos). Esta batería lo mide — y además mide lo que el dev NO dijo: que
 * el desborde no era sólo de la tarjeta, sino del DOCUMENTO (scroll
 * horizontal, el invariante que la app no puede romper).
 *
 * Qué verifica:
 *   · el mes queda EXACTAMENTE en $ 1.234.567.890,12 (el delta se calcula
 *     contra el total real, no a ojo);
 *   · el texto del monto entra en su caja en los ocho anchos del rango;
 *   · el documento no se pasa del device en ningún ancho;
 *   · Y QUE EL CASO DE TODOS LOS DÍAS NO CAMBIE: el cuerpo de letra de los
 *     montos de siempre tiene que ser el de siempre (18 px en el panel por
 *     debajo de 640, 24 px de ahí en adelante; 20 px en el análisis). Un
 *     arreglo que arruina el caso común no es un arreglo.
 *
 * El movimiento de prueba se borra POR ID al final: la base vuelve al seed.
 *
 * Requisito: la app arriba en :3000.
 */

import { check, checkTrue, section, post, get, del, localToday } from "../tester-fase7/helpers.mjs";
import { openUi, applyViewport, verifyViewport, openRoute, correrBateria } from "./lib.mjs";

const MONTO_OBJETIVO = "1234567890.12"; // $ 1.234.567.890,12
const ANCHOS = [320, 375, 480, 768, 939, 940, 941, 1024];

/** El cuerpo de letra que el monto tiene que tener en cada ancho (el de siempre). */
const CUERPO_ESPERADO = [
  [320, "18px"],
  [375, "18px"],
  [768, "24px"],
  [1024, "24px"],
];

/** Los montos del panel: los cuatro de arriba. */
const montosDelPanel = () =>
  `[...document.querySelectorAll("p.monto-tarjeta")].map((p) => ({
    texto: (p.textContent || "").trim(),
    fuente: getComputedStyle(p).fontSize
  }))`;

/** La medición del desborde, con los NOMBRES de los cajas. */
const medicion = () =>
  `(() => {
    const out = { documento: document.documentElement.scrollWidth, montos: [] };
    for (const p of document.querySelectorAll("p")) {
      const t = (p.textContent || "").trim();
      if (!/1\\.234\\.567\\.890,12/.test(t)) continue;
      const r = p.getBoundingClientRect();
      const card = p.parentElement;
      const cr = card.getBoundingClientRect();
      out.montos.push({
        texto: t,
        fuente: getComputedStyle(p).fontSize,
        caja: p.clientWidth,
        contenido: p.scrollWidth,
        sobra: p.scrollWidth - p.clientWidth,
        textoDerecha: Math.round(r.right),
        tarjetaDerecha: Math.round(cr.right)
      });
    }
    return out;
  })()`;

async function main() {
  const hoy = localToday();
  const mes = hoy.slice(0, 7);

  /* ── 1 · línea base: el mes como está ─────────────────────────────────── */
  section("1 · línea base del mes");
  const base = await get(`/api/transactions?from=${mes}-01&to=${mes}-31`);
  const ingresoBase = base.body?.totals?.income ?? "0";
  const delta = (Number(MONTO_OBJETIVO) - Number(ingresoBase)).toFixed(2);
  console.log(`  · ingreso del mes: ${ingresoBase} · delta a crear: ${delta}`);

  const cuentas = (await get("/api/accounts")).body?.accounts ?? [];
  const cuenta = cuentas.find((c) => c.kind === "BANK" || c.kind === "CASH");
  checkTrue("hay una cuenta donde cargar el ingreso", Boolean(cuenta));
  const categorias = (await get("/api/categories?kind=INCOME")).body?.categories ?? [];
  const categoria = categorias[0];
  checkTrue("hay una categoría de ingreso", Boolean(categoria));

  /* ── 2 · el caso de TODOS LOS DÍAS: el cuerpo de letra no cambia ─────── */
  section("2 · el caso de todos los días: el monto mantiene su cuerpo de letra");
  {
    const uiBase = await openUi({
      port: 9355,
      profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9355`,
    });
    try {
      for (const [width, esperado] of CUERPO_ESPERADO) {
        const vp = { name: `${width}px`, width, height: 800 };
        await applyViewport(uiBase, vp, { touch: true });
        await openRoute(uiBase, "/");
        const montos = await uiBase.evalJs(montosDelPanel());
        const fuentes = [...new Set(montos.map((m) => m.fuente))];
        console.log(
          `  · ${width}px · ${montos.length} montos · cuerpos: ${fuentes.join(",")} ` +
            `· "${montos[0]?.texto ?? ""}"`,
        );
        check(
          `${width}px · el monto del panel mantiene su cuerpo de siempre`,
          fuentes.join(","),
          esperado,
        );
      }
      {
        const vp = { name: "1024px", width: 1024, height: 800 };
        await applyViewport(uiBase, vp, { touch: true });
        await openRoute(uiBase, "/analisis");
        const analisis = await uiBase.evalJs(montosDelPanel());
        const fuentes = [...new Set(analisis.map((m) => m.fuente))];
        check("1024px · el monto del análisis mantiene su cuerpo de siempre", fuentes.join(","), "20px");
      }
    } finally {
      await uiBase.close();
    }
  }

  const creado = await post("/api/transactions", {
    kind: "INCOME",
    amount: delta.replace(".", ","),
    date: hoy,
    accountId: cuenta.id,
    categoryId: categoria.id,
    description: "T_RESPONDE_LARGO · monto largo",
  });
  check("el ingreso de prueba se creó", creado.status, 201);
  const id = creado.body?.movement?.id ?? creado.body?.id;
  checkTrue("el movimiento tiene id", Boolean(id));

  try {
    const nuevo = await get(`/api/transactions?from=${mes}-01&to=${mes}-31`);
    check("el ingreso del mes quedó exactamente en 1234567890.12", nuevo.body?.totals?.income, MONTO_OBJETIVO);

    const ui = await openUi({
      port: 9353,
      profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9353`,
    });
    try {
      /* ── 3 · con el monto enorme: entra y no rompe el documento ──────── */
      section("2 · con el mes en $ 1.234.567.890,12: el texto entra y el documento no se pasa");
      for (const width of ANCHOS) {
        const vp = { name: `${width}px`, width, height: 800 };
        await applyViewport(ui, vp, { touch: true });
        await openRoute(ui, "/");
        await verifyViewport(ui, vp, { touch: true });
        const m = await ui.evalJs(medicion());
        const peor = m.montos.reduce((a, b) => (b.sobra > (a?.sobra ?? -1) ? b : a), null);
        console.log(
          `  · ${String(width).padStart(4)}px documento=${m.documento} ` +
            `montos=${m.montos.length} peor overflow=${peor ? peor.sobra : "—"}px ` +
            `fuera-de-la-tarjeta=${peor ? peor.textoDerecha - peor.tarjetaDerecha : "—"}px ` +
            `fuente=${peor ? peor.fuente : "—"} texto="${peor ? peor.texto : ""}"`,
        );
        for (const monto of m.montos) {
          console.log(
            `      · ${monto.texto.padEnd(24)} caja=${monto.caja} contenido=${monto.contenido} ` +
              `sobra=${monto.sobra} fuera-de-la-tarjeta=${monto.textoDerecha - monto.tarjetaDerecha}px`,
          );
        }
        check(
          `${width}px · el texto del monto entra en su caja`,
          m.montos.filter((x) => x.sobra > 0).length,
          0,
        );
        checkTrue(
          `${width}px · el documento no se pasa del device (${m.documento} ≤ ${width})`,
          m.documento <= width + 1,
          `documento=${m.documento}`,
        );
        if (width === 940 || width === 1024) {
          await ui.screenshot(`${process.env.TEMP}\\opencode\\logs-f9\\montos-${width}.png`);
        }
      }
    } finally {
      await ui.close();
    }
  } finally {
    section("Limpieza (movimiento de prueba)");
    const borrado = await del(`/api/transactions?id=${encodeURIComponent(id)}`);
    // La API contesta 204 (sin contenido) cuando borra: el recurso ya no está.
    check("el movimiento de prueba se borró", borrado.status, 204);
    const final = await get(`/api/transactions?from=${mes}-01&to=${mes}-31`);
    check("el ingreso del mes volvió al valor de partida", final.body?.totals?.income, ingresoBase);
  }
}

await correrBateria({ main, etiqueta: "07-montos-largos", conSesion: true });
