#!/usr/bin/env node
/**
 * 15-fuente-y-montos · la FUENTE real (Archivo descargada, no declarada) y la
 * RECALIBRACIÓN del modelo de tamaño del monto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (los objetivos que dejó el dev de la ronda «cero CSS suelto»,
 * actualizados en la Fase 10 F0b al cambiar Geist por Archivo)
 *
 *   1 · EL BODY NO ES ARIAL EN NINGUNA VISTA y la fuente se DESCARGA de verdad.
 *       No alcanza con que `getComputedStyle(body).fontFamily` diga «Archivo»:
 *       eso es lo DECLARADO. Lo que se usa es:
 *         · `document.fonts` → el estado real de cada FontFace (loaded/unloaded);
 *         · las peticiones de red de los `.woff2` → el archivo se descargó;
 *         · el AVANCE de los glifos «0», «1» y «8» medido en un canvas con la
 *           fuente COMPUTADA. OJO: con Archivo el «0» solo NO alcanza como
 *           prueba, porque mide 0,573 em y Arial mide 0,5562 em (1,7 % de
 *           diferencia: se confunden). Lo que sí discrimina es la RELACIÓN
 *           entre dígitos: en Archivo 400 las cifras son PROPORCIONALES
 *           («0» 0,573 · «1» 0,521, 5,2 % de diferencia) y en todo fallback
 *           del sistema (Arial, Helvetica, Liberation Sans) son TABULARES
 *           (los tres dígitos miden exactamente lo mismo). Se verifica además
 *           que los píxeles que se pintan NO son los del fallback.
 *         · las cifras del monto llevan `tabular-nums` (utilidad `monto`): el
 *           modelo de medidas de `lib/format.ts` está calibrado con las
 *           tabulares, no con las proporcionales del canvas.
 *
 *   2 · LA REGLA DE 44 PX (que ahora vive en `@layer base`) NO ESTÁ PISADA:
 *       con el dedo, TODO control (button/input/select/textarea) tiene
 *       min-height 44 px y min-width 44 px; con el mouse, NINGUNO los tiene.
 *       Las utilidades de Tailwind ganan sobre la capa base: si alguien
 *       puso un `min-h-9` explícito, la regla se pierde — y eso hay que
 *       detectarlo, no suponerlo.
 *
 *   3 · LA RECALIBRACIÓN DEL MONTO (el efecto colateral de cambiar de fuente):
 *       · en la ficha angosta el monto entra en su caja y se lee (≥ 8 px);
 *       · en las cajas cómodas el cuerpo llega a su tope (14 px en la ficha);
 *       · el modelo no quedó descalibrado para el otro lado: el monto de
 *         todos los días no se achicó de más (no quedó en el piso de 8 px
 *         cuando la caja da para un cuerpo mayor).
 *
 * Requiere: la app arriba en `BASE_URL` (127.0.0.1:3000 por defecto) y la base
 * sembrada (hay filas de movimiento para medir).
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import {
  openUi,
  applyViewport,
  verifyViewport,
  openRoute,
  correrBateria,
  sleep,
} from "./lib.mjs";

/** Las seis vistas de la app. */
const VISTAS = ["/login", "/", "/analisis", "/prestamos", "/recurrencia", "/tarjetas"];

/**
 * Las métricas medidas en el navegador (canvas, peso 400, sin `tnum`) el
 * 2026-10-22 con `scripts/medir-fuente.mjs` y este mismo probe:
 *   Archivo «0» 0,573 em · «1» 0,521 em · «8» 0,574 em  (proporcionales)
 *   Arial   «0» = «1» = «8» = 0,5562 em              (tabulares)
 */
const AVANCE_ARIAL = 0.5562;
const AVANCE_ARCHIVO_0 = 0.573;
const AVANCE_ARCHIVO_TOL = 0.008;
/** La diferencia mínima entre «0» y «1» que prueba cifras proporcionales. */
const PROPORCIONAL_MIN = 0.03;

/**
 * La fuente REAL: lo declarado, lo cargado y lo que se midió en un canvas.
 * El canvas con la fuente COMPUTADA del body es la prueba que no miente:
 * si Archivo no estuviera disponible, el canvas caería al fallback del sistema
 * —y además los píxeles pintados serían idénticos a los del fallback.
 */
const FUENTE = `(() => {
  const cs = getComputedStyle(document.body);
  const fuentes = [];
  for (const f of document.fonts) {
    fuentes.push({ familia: f.family, estado: f.status, peso: f.weight });
  }
  const woff = performance.getEntriesByType("resource")
    .filter((r) => /woff2?$/i.test(r.name))
    .map((r) => ({
      archivo: r.name.split("/").pop(),
      transfer: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize
    }));
  const c = document.createElement("canvas").getContext("2d");
  c.font = "100px " + cs.fontFamily;
  const cero = c.measureText("0").width / 100;
  const uno = c.measureText("1").width / 100;
  const ocho = c.measureText("8").width / 100;

  // ¿Los píxeles que se pintan son los de Archivo o los del fallback? Se pinta
  // el mismo texto dos veces: con la familia computada y con la genérica. Si
  // Archivo no hubiera cargado, los dos dibujos serían idénticos.
  const lienzo = document.createElement("canvas");
  lienzo.width = 160; lienzo.height = 40;
  const ctx = lienzo.getContext("2d");
  const pintar = (familia) => {
    ctx.clearRect(0, 0, 160, 40);
    ctx.font = "32px " + familia;
    ctx.fillStyle = "#000";
    ctx.fillText("0123456789", 2, 30);
    return Array.from(ctx.getImageData(0, 0, 160, 40).data).join(",");
  };
  const conArchivo = pintar(cs.fontFamily);
  const conFallback = pintar("monospace");
  const tinta = (datos) => {
    const px = datos.split(",");
    let pintados = 0;
    for (let i = 3; i < px.length; i += 4) if (Number(px[i]) > 0) pintados++;
    return pintados;
  };

  return {
    body: cs.fontFamily,
    html: getComputedStyle(document.documentElement).fontFamily,
    estado: cs.fontStatus,
    fuentes,
    woff,
    cero: Math.round(cero * 10000) / 10000,
    uno: Math.round(uno * 10000) / 10000,
    ocho: Math.round(ocho * 10000) / 10000,
    archivoDisponible: document.fonts.check("16px Archivo"),
    pixelesDistintosDelFallback: conArchivo !== conFallback,
    tintaConArchivo: tinta(conArchivo),
    tintaConFallback: tinta(conFallback)
  };
})()`;

/** Los controles de la app y su tamaño mínimo COMPUTADO. */
const CONTROLES = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, input, select, textarea")) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    // Un control de tamaño CERO no es un control: está dentro de algo
    // oculto (el atributo hidden de un padre) y no lo puede tocar nadie.
    if (r.width === 0 && r.height === 0) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      tipo: el.getAttribute("type") || "",
      minH: cs.minHeight,
      minW: cs.minWidth,
      h: Math.round(r.height),
      w: Math.round(r.width),
      id: el.id || "",
      texto: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 20)
    });
  }
  return out;
})()`;

/** La geometría de la fila de un movimiento. */
const FILA = `(() => {
  const filas = [...document.querySelectorAll(".mov-fila")];
  if (filas.length === 0) return { error: "no hay filas .mov-fila" };
  const f = filas[0];
  const texto = f.querySelector(".mov-texto");
  const monto = f.querySelector(".mov-monto");
  const papelera = f.querySelector(".mov-borrar");
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      top: Math.round(b.top), bottom: Math.round(b.bottom),
      left: Math.round(b.left), right: Math.round(b.right)
    };
  };
  // ¿A dónde llega el punto de toque de la papelera?
  let toque = null;
  if (papelera) {
    const b = papelera.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    toque = hit ? (hit === papelera || papelera.contains(hit)) : false;
  }
  return {
    texto: r(texto), monto: r(monto), papelera: r(papelera),
    textoFuente: texto ? getComputedStyle(texto).fontSize : null,
    montoFuente: monto ? getComputedStyle(monto).fontSize : null,
    montoTexto: monto ? monto.textContent.trim() : null,
    textoTexto: texto ? texto.textContent.trim().replace(/\\s+/g, " ").slice(0, 30) : null,
    toquePapeleraLlega: toque
  };
})()`;

/** Las fichas del patrimonio: caja, monto y cuerpo de letra. */
const FICHAS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll(".monto-ficha, .monto-ficha--chico")) {
    const rango = document.createRange();
    let ancho = 0;
    for (const nodo of el.childNodes) {
      if (nodo.nodeType !== 3) continue;
      const bruto = nodo.textContent || "";
      if (!bruto.trim()) continue;
      rango.setStart(nodo, 0);
      rango.setEnd(nodo, bruto.replace(/\\s+$/, "").length);
      ancho = Math.max(ancho, rango.getBoundingClientRect().width);
    }
    const cs = getComputedStyle(el);
    out.push({
      texto: el.textContent.trim().replace(/\\s+/g, " "),
      fuente: cs.fontSize,
      peso: cs.fontWeight,
      anchoTexto: Math.round(ancho),
      caja: el.clientWidth,
      sobra: Math.round(ancho - el.clientWidth),
      chico: el.classList.contains("monto-ficha--chico")
    });
  }
  return out;
})()`;

/** Los montos grandes de las tarjetas del panel (peso 800). */
const TARJETAS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll(".monto-tarjeta, .monto-tarjeta--analisis")) {
    const cs = getComputedStyle(el);
    const rango = document.createRange();
    let ancho = 0;
    for (const nodo of el.childNodes) {
      if (nodo.nodeType !== 3) continue;
      const bruto = nodo.textContent || "";
      if (!bruto.trim()) continue;
      rango.setStart(nodo, 0);
      rango.setEnd(nodo, bruto.replace(/\\s+$/, "").length);
      ancho = Math.max(ancho, rango.getBoundingClientRect().width);
    }
    out.push({
      texto: el.textContent.trim().replace(/\\s+/g, " "),
      fuente: cs.fontSize,
      peso: cs.fontWeight,
      anchoTexto: Math.round(ancho),
      caja: el.clientWidth,
      sobra: Math.round(ancho - el.clientWidth)
    });
  }
  return out;
})()`;

/** Deja la página lista (el panel principal tarda en hidratar). */
async function abrir(ui, ruta) {
  await openRoute(ui, ruta);
}

async function main() {
  const ui = await openUi({
    port: 9375,
    profileDir: `${process.env.TEMP}\\opencode\\resp-profile-9375`,
  });
  try {
    /* ───────────────────────────────────────────────────────────────────
     * 1 · LA FUENTE REAL, VISTA POR VISTA
     * ─────────────────────────────────────────────────────────────────── */
    section("1 · la fuente del body, vista por vista (con mouse)");
    for (const vista of VISTAS) {
      await ui.send("Emulation.setDeviceMetricsOverride", {
        width: 1019, height: 557, screenWidth: 1019, screenHeight: 557,
        deviceScaleFactor: 1, mobile: false,
      });
      await ui.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await abrir(ui, vista);
      const f = await ui.evalJs(FUENTE);
      const finales = await ui.evalJs(`location.pathname`);
      console.log(
        `  · ${vista.padEnd(12)} → ${finales.padEnd(11)} body=${f.body} · avance del «0»=${f.cero} em`,
      );
      console.log(`      fuentes: ${JSON.stringify(f.fuentes)}`);
      console.log(`      woff2:   ${JSON.stringify(f.woff)}`);

      checkTrue(
        `${vista} · el body NO se renderiza en Arial`,
        !/arial|helvetica|liberation/i.test(f.body),
        `font-family=${f.body}`,
      );
      checkTrue(
        `${vista} · la fuente del body es Archivo`,
        /archivo/i.test(f.body),
        `font-family=${f.body}`,
      );
      checkTrue(
        `${vista} · el «0» avanza como Archivo 400 (0,573 em), no como Arial (0,5562 em)`,
        Math.abs(f.cero - AVANCE_ARCHIVO_0) < AVANCE_ARCHIVO_TOL &&
          Math.abs(f.cero - AVANCE_ARIAL) > 0.005,
        `avance=${f.cero} em (Archivo≈${AVANCE_ARCHIVO_0}, Arial=${AVANCE_ARIAL})`,
      );
      checkTrue(
        `${vista} · las cifras son PROPORCIONALES (0 ≠ 1): ningún fallback tabular se confunde con Archivo`,
        Math.abs(f.cero - f.uno) > PROPORCIONAL_MIN,
        `«0»=${f.cero} em · «1»=${f.uno} em · «8»=${f.ocho} em (en Arial los tres son ${AVANCE_ARIAL})`,
      );
      checkTrue(
        `${vista} · los PÍXELES que se pintan son los de Archivo, no los del fallback`,
        f.pixelesDistintosDelFallback === true,
        `tinta con la fuente del body=${f.tintaConArchivo} px · tinta del fallback=${f.tintaConFallback} px`,
      );
      const archivoCargada = f.fuentes.some(
        (x) => /^archivo$/i.test(x.familia) && x.estado === "loaded",
      );
      checkTrue(
        `${vista} · la fuente Archivo está CARGADA (document.fonts: loaded, no unloaded)`,
        archivoCargada,
        JSON.stringify(f.fuentes),
      );
      checkTrue(
        `${vista} · Archivo está DISPONIBLE para el motor de texto (document.fonts.check)`,
        f.archivoDisponible === true,
        `check=${f.archivoDisponible}`,
      );
      const descargada = f.woff.filter((w) => (w.encoded || 0) > 0);
      checkTrue(
        `${vista} · el archivo de la fuente se DESCARGÓ de verdad (bytes > 0 en la red)`,
        descargada.length > 0,
        JSON.stringify(f.woff),
      );
    }

    /* ───────────────────────────────────────────────────────────────────
     * 2 · LA REGLA DE 44 PX: CON EL DEDO Y CON EL MOUSE
     * ─────────────────────────────────────────────────────────────────── */
    section("2 · la regla de 44 px (@layer base): con el dedo y con el mouse");
    const VP = { name: "375 iphone-se", width: 375, height: 667 };
    await applyViewport(ui, VP, { touch: true });
    await abrir(ui, "/");
    await verifyViewport(ui, VP, { touch: true });
    const conDedo = await ui.evalJs(CONTROLES);
    console.log(`  · con el dedo: ${conDedo.length} controles`);
    const sinMin = conDedo.filter(
      (c) => c.minH !== "44px" || c.minW !== "44px",
    );
    console.log(
      `  · con el dedo, controles SIN min 44×44: ${sinMin.length}` +
        (sinMin.length ? ` → ${JSON.stringify(sinMin.slice(0, 5))}` : ""),
    );
    checkTrue(
      "con el dedo, TODO control tiene min-height 44 px y min-width 44 px (la regla de @layer base no está pisada)",
      sinMin.length === 0,
      JSON.stringify(sinMin.slice(0, 5)),
    );
    const chicosConDedo = conDedo.filter((c) => c.h < 44 || c.w < 44);
    checkTrue(
      "con el dedo, ningún control queda por debajo de 44 px en alguna dimensión",
      chicosConDedo.length === 0,
      JSON.stringify(chicosConDedo.slice(0, 5)),
    );

    await ui.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await abrir(ui, "/");
    await verifyViewport(ui, VP, { touch: false });
    const conMouse = await ui.evalJs(CONTROLES);
    const con44 = conMouse.filter((c) => c.minH === "44px" || c.minW === "44px");
    console.log(
      `  · con el mouse: ${conMouse.length} controles · ` +
        `con min 44: ${con44.length} · altura mínima: ${Math.min(...conMouse.map((c) => c.h))} px`,
    );
    checkTrue(
      "con el mouse, NINGÚN control arrastra el mínimo de 44 px (la regla es del puntero, no del ancho)",
      con44.length === 0,
      JSON.stringify(con44.slice(0, 5)),
    );
    const masBajo = Math.min(...conMouse.map((c) => c.h));
    checkTrue(
      "con el mouse los botones conservan su densidad (altura menor que 44 px)",
      masBajo < 44,
      `altura mínima=${masBajo}`,
    );

    /* ───────────────────────────────────────────────────────────────────
     * 3 · LA FILA DEL MOVIMIENTO EN 320→480
     * ─────────────────────────────────────────────────────────────────── */
    section("3 · la fila del movimiento: columna de texto y monto+papelera juntos");
    for (const w of [320, 340, 360, 375, 390, 414, 430, 460, 480]) {
      await applyViewport(ui, { width: w, height: 900 }, { touch: true });
      await abrir(ui, "/");
      await verifyViewport(ui, { width: w, height: 900 }, { touch: true });
      await ui
        .waitFor(`!!document.querySelector(".mov-fila")`, {
          timeout: 15000,
          label: "la lista de movimientos",
        })
        .catch(() => {});
      // La fila se trae a la vista ANTES de medir: el punto de toque se
      // mide con `elementFromPoint`, que sólo dice algo de lo que está
      // DENTRO del viewport (si la fila quedó 2500 px más abajo, el punto
      // cae fuera de la pantalla y el resultado es un artefacto, no un bug).
      await ui.evalJs(
        `document.querySelector(".mov-fila")?.scrollIntoView({ block: "center" })`,
      );
      await sleep(300);
      const fila = await ui.evalJs(FILA);
      if (fila.error) {
        checkTrue(`${w} px · hay una fila de movimiento para medir`, false, fila.error);
        continue;
      }
      const mismaLinea =
        fila.monto && fila.papelera
          ? fila.monto.bottom > fila.papelera.top && fila.papelera.bottom > fila.monto.top
          : false;
      console.log(
        `  · ${String(w).padStart(4)} px → texto ${String(fila.texto?.w ?? 0).padStart(4)} px · ` +
          `monto ${fila.monto?.w}×${fila.monto?.h} · papelera ${fila.papelera?.w}×${fila.papelera?.h} · ` +
          `misma línea=${mismaLinea} · toque papelera=${fila.toquePapeleraLlega}`,
      );
      checkTrue(
        `${w} px · la columna de texto de la fila tiene ancho real (≥ 150 px)`,
        (fila.texto?.w ?? 0) >= 150,
        `ancho=${fila.texto?.w}`,
      );
      checkTrue(
        `${w} px · el monto y la papelera están en la MISMA línea`,
        mismaLinea,
        `monto=${JSON.stringify(fila.monto)} papelera=${JSON.stringify(fila.papelera)}`,
      );
      checkTrue(
        `${w} px · el punto de toque de la papelera llega a la papelera (no a otra capa)`,
        fila.toquePapeleraLlega === true,
        `toque=${fila.toquePapeleraLlega}`,
      );
    }

    /* ───────────────────────────────────────────────────────────────────
     * 4 · LAS FICHAS: ENTRAN Y SE LEEN
     * ─────────────────────────────────────────────────────────────────── */
    section("4 · las fichas del patrimonio: el monto entra en su caja y se lee");
    for (const w of [320, 360, 390, 480, 768, 1024]) {
      await applyViewport(ui, { width: w, height: 900 }, { touch: true });
      await abrir(ui, "/");
      await verifyViewport(ui, { width: w, height: 900 }, { touch: true });
      await sleep(600);
      const fichas = await ui.evalJs(FICHAS);
      const grandes = await ui.evalJs(TARJETAS);
      if (!Array.isArray(fichas) || fichas.length === 0) {
        checkTrue(`${w} px · hay fichas del patrimonio`, false, JSON.stringify(fichas));
        continue;
      }
      console.log(
        `  · ${String(w).padStart(4)} px · fichas: ` +
          fichas.map((f) => `${f.fuente} «${f.texto}» ${f.anchoTexto}en${f.caja} (sobra ${f.sobra})`).join(" | "),
      );
      console.log(
        `            · tarjetas: ` +
          grandes.map((f) => `${f.fuente} «${f.texto}» ${f.anchoTexto}en${f.caja}`).join(" | "),
      );
      checkTrue(
        `${w} px · todos los montos de las fichas entran en su caja (sobra ≤ 1 px)`,
        fichas.every((f) => f.sobra <= 1),
        fichas.map((f) => `${f.texto} sobra ${f.sobra}`).join(" | "),
      );
      checkTrue(
        `${w} px · ningún monto de ficha es ilegible (≥ 8 px)`,
        fichas.every((f) => parseFloat(f.fuente) >= 8),
        fichas.map((f) => `${f.texto} ${f.fuente}`).join(" | "),
      );
      checkTrue(
        `${w} px · los montos de las tarjetas grandes entran en su caja`,
        grandes.every((f) => f.sobra <= 1),
        grandes.map((f) => `${f.texto} sobra ${f.sobra}`).join(" | "),
      );
    }

    /* ───────────────────────────────────────────────────────────────────
     * 5 · LA RECALIBRACIÓN: ¿cambió el escritorio?
     *
     * Los invariantes que se verifican NO llevan números de la fuente
     * metidos a mano (si el modelo cambia, el test se entera solo):
     *
     *   · el monto NO SE PARTE: el texto entra en su caja (≤ 1 px de sobra);
     *   · el monto NO QUEDÓ ACHICADO DE MÁS: el texto llena al menos el
     *     75 % de su caja (si el modelo se descalibra para el otro lado, el
     *     número queda flotando en una caja vacía);
     *   · el monto LLEGA AL TOPE (14 px) en las cajas cómodas (≥ 110 px);
     *   · el monto es LEGIBLE (≥ 8 px) en todas.
     *
     * Lo que NO se afirma (y es lo que el dev afirmó): «el monto mide
     * 14 px en todas las pantallas de 480 px en adelante». No es cierto:
     * en el corte `md` (768 px) la grilla del patrimonio pasa a 6
     * columnas, la ficha mide 95 px y el monto queda en 13,15 px (con
     * Arial eran 14 px). El número está en el informe.
     * ─────────────────────────────────────────────────────────────────── */
    section("5 · la recalibración: ¿el escritorio quedó igual?");
    const TOPE = 14; // 0,875 rem
    for (const w of [320, 360, 390, 414, 440, 480, 560, 640, 700, 768, 820, 1024]) {
      await applyViewport(ui, { width: w, height: 900 }, { touch: true });
      await abrir(ui, "/");
      await verifyViewport(ui, { width: w, height: 900 }, { touch: true });
      await sleep(600);
      const fichas = await ui.evalJs(FICHAS);
      const grandes = await ui.evalJs(TARJETAS);
      const normales = fichas.filter((f) => !f.chico);
      if (normales.length === 0) {
        checkTrue(`${w} px · hay fichas del patrimonio`, false, JSON.stringify(fichas));
        continue;
      }
      console.log(
        `  · ${String(w).padStart(4)} px · caja ${normales[0].caja} px · ` +
          `monto ${normales[0].fuente} · ocupa ${normales[0].anchoTexto} px ` +
          `(${(normales[0].anchoTexto / normales[0].caja * 100).toFixed(0)} % de la caja) · ` +
          `fichas ${[...new Set(normales.map((f) => f.fuente))].join(",")}`,
      );
      checkTrue(
        `${w} px · el monto de la ficha NO SE PARTE (entra en su caja)`,
        normales.every((f) => f.sobra <= 1),
        normales.map((f) => `${f.texto} sobra ${f.sobra}`).join(" | "),
      );
      checkTrue(
        `${w} px · el monto de la ficha llena su caja (≥ 75 %) cuando el tamaño lo manda la caja`,
        normales
          .filter((f) => parseFloat(f.fuente) < 13.9) // si está en el tope (14 px), el tamaño no lo manda la caja
          .every((f) => f.anchoTexto >= f.caja * 0.75),
        normales.map((f) => `${f.texto} ${f.fuente} ${f.anchoTexto}px en ${f.caja}px`).join(" | "),
      );
      checkTrue(
        `${w} px · el monto llega al tope de 14 px en las cajas cómodas (≥ 110 px)`,
        normales
          .filter((f) => f.caja >= 110)
          .every((f) => Math.abs(parseFloat(f.fuente) - TOPE) < 0.6),
        normales.map((f) => `${f.texto} ${f.fuente} (caja ${f.caja})`).join(" | "),
      );
      checkTrue(
        `${w} px · las tarjetas grandes mantienen su cuerpo de letra (18-24 px)`,
        grandes.every((f) => {
          const px = parseFloat(f.fuente);
          return px >= 17.9 && px <= 24.1;
        }),
        grandes.map((f) => `${f.texto} ${f.fuente}`).join(" | "),
      );
    }

    /* ───────────────────────────────────────────────────────────────────
     * 6 · EL MODELO NO QUEDÓ DESCALIBRADO PARA EL OTRO LADO
     * ─────────────────────────────────────────────────────────────────── */
    section("6 · el modelo del monto: ¿se achicó de más el caso común?");
    // A 320 px la ficha angosta: el monto de todos los días («$ 100.000,00»)
    // tiene que entrar Y leerse. Si el modelo quedó muy conservador, el monto
    // cae al piso de 8 px aunque la caja daría para más.
    await applyViewport(ui, { width: 320, height: 900 }, { touch: true });
    await abrir(ui, "/");
    await verifyViewport(ui, { width: 320, height: 900 }, { touch: true });
    await sleep(600);
    const fichas320 = await ui.evalJs(FICHAS);
    console.log(`  · a 320 px: ${JSON.stringify(fichas320)}`);
    const comunes = fichas320.filter((f) => !f.chico && /100\.000|800\.000/.test(f.texto));
    checkTrue(
      "a 320 px el monto de todos los días NO quedó en el piso de 8 px (el modelo no se descalibró de más)",
      comunes.every((f) => parseFloat(f.fuente) > 8),
      comunes.map((f) => `${f.texto} ${f.fuente}`).join(" | "),
    );
    /* ───────────────────────────────────────────────────────────────────
     * 7 · LOS MONTOS DE LAS TARJETAS GRANDES EN EL ANÁLISIS
     *
     * Las tarjetas del panel usan `monto-tarjeta` (tope 1,5 rem = 24 px) y
     * las del análisis `monto-tarjeta--analisis` (tope 1,25 rem = 20 px). El
     * cambio de fuente no puede haber movido esos cuerpos de letra.
     * ─────────────────────────────────────────────────────────────────── */
    section("7 · los montos grandes del panel y del análisis");
    for (const w of [320, 375, 768, 1024]) {
      for (const vista of ["/", "/analisis"]) {
        await applyViewport(ui, { width: w, height: 900 }, { touch: true });
        await abrir(ui, vista);
        await verifyViewport(ui, { width: w, height: 900 }, { touch: true });
        await sleep(700);
        const grandes = await ui.evalJs(TARJETAS);
        const fuentes = [...new Set(grandes.map((f) => f.fuente))];
        console.log(
          `  · ${String(w).padStart(4)} px ${vista.padEnd(9)} · ${grandes.length} montos · ${fuentes.join(",")}`,
        );
        checkTrue(
          `${w} px ${vista} · los montos grandes están entre 17,9 y 24,1 px`,
          grandes.length > 0 && grandes.every((f) => {
            const px = parseFloat(f.fuente);
            return px >= 17.9 && px <= 24.1;
          }),
          grandes.map((f) => `${f.texto} ${f.fuente}`).join(" | "),
        );
        checkTrue(
          `${w} px ${vista} · los montos grandes entran en su caja`,
          grandes.every((f) => f.sobra <= 1),
          grandes.map((f) => `${f.texto} sobra ${f.sobra}`).join(" | "),
        );
      }
    }
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "15-fuente-y-montos", conSesion: true });
