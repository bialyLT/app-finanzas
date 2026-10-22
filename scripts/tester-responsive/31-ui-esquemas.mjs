#!/usr/bin/env node
/**
 * 31-ui-esquemas · lo que se VE en los dos esquemas (navegador real)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * Los tokens y las clases se pueden leer en el código; lo que NO se puede leer
 * en el código es lo que se PINTA. Esta batería abre la app en Chromium
 * (CDP), emula los dos esquemas (`prefers-color-scheme`) y mide:
 *
 *   1 · el FONDO REALMENTE PINTADO del header en cada esquema (componiendo
 *       los fondos con un canvas, no leyendo el `background-color` suelto):
 *       en «Noche» el header tenía `dark:bg-black/90` y quedaba NEGRO sobre
 *       una página `#07111F`;
 *   2 · la CASILLA DE LA BANDERITA: no puede ser un recuadro VACÍO (el
 *       `✓` era `text-transparent`: un cuadrado de 44×44 sin nada dentro);
 *   3 · el GROSOR de los iconos tal como los renderiza el navegador (el
 *       atributo `stroke-width` del SVG) y sus tamaños;
 *   4 · el CONTRASTE REAL de lo que se ve: el texto de los avisos con tinte
 *       (`bg-success/10` + `text-success`), el de los botones de acción y el
 *       de los textos de estado, con el fondo COMPUESTO (no el teórico).
 *
 * Y una AUTO-PRUEBA de la medición: si el fondo compuesto del cuerpo no
 * coincide con el token de la superficie, la medida no vale nada (y la
 * batería falla, en vez de dar verde por casualidad).
 *
 * La batería es de SOLO LECTURA: no toca la base (no hace clic en la
 * banderita ni en ningún control que escriba). La sonda de tintes INSERTA un
 * contenedor propio en la página y lo saca al terminar.
 */

import { check, checkTrue, section } from "../tester-fase7/helpers.mjs";
import { correrBateria } from "./lib.mjs";
import { openUi } from "../tester-fase7/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3101";

/* ────────────────────────────────────────────────────────────────────────────
 * LA MEDICIÓN (dentro de la página)
 * ──────────────────────────────────────────────────────────────────────────── */
const EXPRESION = `(() => {
  // El color de fondo REALMENTE pintado de un elemento: se compone hacia
  // arriba con un canvas (el navegador compone en sRGB).
  const canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const pintar = (capa, bajo) => {
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = bajo; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = capa; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  // La ALFA de un color computed: rgb()/rgba()/color(srgb)/oklab().
  const opaco = (color) => {
    if (!color) return 0;
    if (color === "transparent") return 0;
    const m = color.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const partes = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return partes.length > 3 ? partes[3] : 1;
    }
    const barra = color.match(/\\/\\s*([\\d.]+)\\s*\\)$/);
    if (barra) return Number(barra[1]);
    return 1;
  };
  const fondoEfectivo = (el) => {
    const capas = [];
    let p = el;
    while (p && p !== document.documentElement.parentNode) {
      const cs = getComputedStyle(p);
      const bg = cs.backgroundColor;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        capas.push(bg);
        if (opaco(bg) >= 0.999) break;
      }
      p = p.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = capas.length - 1; i >= 0; i -= 1) {
      base = pintar(capas[i], "rgb(" + base.join(",") + ")");
    }
    return base;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const colorDe = (cs) => {
    const m = cs.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2]];
  };
  const rgb = (c) => c ? "rgb(" + c.map(Math.round).join(",") + ")" : null;
  const hex = (c) => c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : null;

  const header = document.querySelector("header");
  const body = document.body;

  // El contraste REAL de un texto sobre su fondo pintado.
  const contrasteDe = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const fondo = fondoEfectivo(el.parentElement ?? el);
    const color = colorDe(cs.color);
    if (!fondo || !color) return null;
    return {
      texto: (el.textContent || "").trim().slice(0, 40),
      color: rgb(color),
      fondo: rgb(fondo),
      ratio: Number(ratio(color, fondo).toFixed(2)),
      clase: (el.className || "").toString().slice(0, 80),
    };
  };

  // ── La sonda de TINTES: el patrón bg-xxx/10 + text-xxx, con el CSS real.
  const sonda = document.createElement("div");
  sonda.id = "tester-f10-sonda";
  sonda.setAttribute("style", "position:fixed;left:0;top:0;z-index:9999;background:var(--surface-2);padding:8px");
  for (const e of ["success", "danger", "warning", "transfer"]) {
    const p = document.createElement("p");
    p.className = "bg-" + e + "/10 text-" + e;
    p.textContent = "Sonda " + e;
    sonda.appendChild(p);
  }
  document.body.appendChild(sonda);
  const tintes = [...sonda.querySelectorAll("p")].map(contrasteDe).filter(Boolean);
  sonda.remove();

  // Los avisos con tinte que ya están en la página (informativo).
  const tintesReales = [...document.querySelectorAll("p, span, div, a")].filter((e) => {
    const cls = (e.className || "").toString();
    return /\\/(10|15|20)\\b/.test(cls) && e.children.length === 0 &&
      (e.textContent || "").trim().length > 0 && (e.textContent || "").trim().length < 80;
  }).slice(0, 8).map(contrasteDe).filter(Boolean);

  // Los botones de acción.
  const botones = [...document.querySelectorAll("button")].filter((b) => {
    const cs = getComputedStyle(b);
    const fondo = cs.backgroundColor;
    const r = b.getBoundingClientRect();
    return fondo && fondo !== "rgba(0, 0, 0, 0)" && r.height > 40 && r.width > 60;
  }).slice(0, 8).map((b) => {
    const cs = getComputedStyle(b);
    const fondo = fondoEfectivo(b);
    const color = colorDe(cs.color);
    return {
      texto: (b.textContent || "").trim().slice(0, 30),
      fondo: rgb(fondo),
      color: cs.color,
      ratio: fondo && color ? Number(ratio(color, fondo).toFixed(2)) : null,
    };
  }).filter((x) => x.ratio !== null);

  // La casilla de la banderita: ¿hay algo DENTRO?
  const casillas = [...document.querySelectorAll('[id^="acc-income-toggle-"], [id="acc-declare-income"]')].map((b) => {
    const cs = getComputedStyle(b);
    const svg = b.querySelector("svg");
    const texto = (b.textContent || "").trim();
    const transparente = /rgba\\(0, 0, 0, 0\\)/.test(cs.color);
    return {
      id: b.id,
      ariaChecked: b.getAttribute("aria-checked"),
      ariaLabel: b.getAttribute("aria-label"),
      haySvg: !!svg,
      texto,
      color: cs.color,
      transparente,
      // Un icono invisible es un recuadro VACÍO: el SVG hereda el color del
      // texto (currentColor), así que si el control tiene el color
      // transparente, el check no se ve (era lo que pasaba con
      // text-transparent).
      vacio: transparente || (!svg && texto.length === 0),
      tam: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      radio: cs.borderRadius,
    };
  });

  // Los iconos: el grosor y el tamaño TAL COMO LOS PINTA EL NAVEGADOR
  // (los de tamaño 0 son los que están ocultos: no se miden).
  const iconos = [...document.querySelectorAll("svg.lucide")].map((s) => {
    const r = s.getBoundingClientRect();
    return {
      clase: (s.getAttribute("class") || "").split(" ").filter((c) => c.startsWith("size-")).join(" "),
      stroke: s.getAttribute("stroke-width"),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }).filter((i) => i.w > 0 && i.h > 0);

  return {
    scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    bodyPintado: hex(fondoEfectivo(body)),
    headerBg: header ? getComputedStyle(header).backgroundColor : null,
    headerPintado: hex(fondoEfectivo(header)),
    headerClase: header ? header.className : null,
    tokens: {
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      surface2: getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim(),
    },
    tintes, tintesReales, botones, casillas, iconos,
  };
})()`;

async function main() {
  const ui = await openUi({
    port: Number(process.env.CDP_PORT ?? 9336),
    profileDir: `${process.env.TEMP}\\opencode\\f10-ui-cdp`,
  });
  try {
    for (const esquema of ["dark", "light"]) {
      section(`1 · el esquema ${esquema === "dark" ? "NOCHE" : "CLARO"}`);
      await ui.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: esquema }],
      });
      await ui.navigate(`${BASE}/`);
      await ui.waitFor("document.readyState === 'complete'", { label: "la carga" });
      await sleep(1200);
      await ui.loginIfNeeded();
      // Los datos del panel (las cuentas con plata) tardan: se espera a que
      // existan, con paciencia (la primera request del servidor es lenta).
      await ui.waitFor(
        `!!document.querySelector('[id^="acc-income-toggle-"]') || !!document.querySelector('#account-cards')`,
        { timeout: 45000, label: "los datos del panel" },
      );
      await sleep(800);
      const m = await ui.evalJs(EXPRESION);
      const superficie = m.tokens.surface.toLowerCase();

      check(`el esquema emulado es ${esquema}`, m.scheme, esquema);

      // 0 · AUTO-PRUEBA: si el fondo compuesto no es la superficie, la
      // medida no vale nada. El header es `bg-surface/90` (90 % opaco), así
      // que su color pintado difiere del token en un par de unidades por
      // canal: la tolerancia es de 2/255.
      const cerca = (a, b) => {
        if (!a || !b) return false;
        const pa = a.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
        const pb = b.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
        return pa.every((v, i) => Math.abs(v - pb[i]) <= 2);
      };
      check(
        "la medida funciona: el fondo pintado del cuerpo es la superficie",
        m.bodyPintado,
        superficie,
      );
      checkTrue(
        "la medida funciona: el fondo pintado del header es la superficie (tolerancia 2/255)",
        cerca(m.headerPintado, superficie),
        `pintado: ${m.headerPintado} · token: ${superficie}`,
      );
      checkTrue(
        "el header NO se pinta de negro en Noche (era `dark:bg-black/90`)",
        m.headerPintado !== "#000000",
        `header pintado: ${m.headerPintado}`,
      );
      checkTrue(
        "el header usa la superficie del esquema (no un color suelto)",
        m.headerClase ? m.headerClase.includes("bg-surface") : false,
        `clase: ${m.headerClase}`,
      );
      checkTrue(
        "el header NO tiene ningún `dark:` de color",
        m.headerClase ? !/dark:[a-z]+-/.test(m.headerClase) : false,
        `clase: ${m.headerClase}`,
      );

      // 2 · la casilla de la banderita: nunca vacía.
      checkTrue(
        "hay una casilla de banderita en pantalla",
        m.casillas.length > 0,
        `${m.casillas.length} casillas`,
      );
      for (const c of m.casillas) {
        checkTrue(
          `la casilla ${c.id} NO es un recuadro vacío`,
          !c.vacio,
          `svg=${c.haySvg} texto="${c.texto}" color=${c.color}`,
        );
        checkTrue(
          `la casilla ${c.id} tiene nombre accesible`,
          Boolean(c.ariaLabel),
          `aria-label=${c.ariaLabel}`,
        );
        checkTrue(
          `la casilla ${c.id} es un target de 44×44`,
          c.tam[0] >= 44 && c.tam[1] >= 44,
          `${c.tam.join("×")}`,
        );
      }

      // 3 · los iconos: un grosor y tamaños de la escala.
      const grosores = [...new Set(m.iconos.map((i) => i.stroke))];
      checkTrue(
        "todos los iconos tienen el mismo grosor (el default de lucide: 2)",
        grosores.length === 1 && grosores[0] === "2",
        `grosores: ${grosores.join(",")}`,
      );
      const tamanos = [...new Set(m.iconos.map((i) => i.w))].sort((a, b) => a - b);
      checkTrue(
        "los tamaños de los iconos están en la escala (16/20/24/32/40)",
        tamanos.every((t) => [16, 20, 24, 32, 40].includes(t)),
        `tamaños: ${tamanos.join(",")}`,
      );

      // 4 · el contraste REAL de lo que se ve.
      const peor = (lista) => (lista.length ? Math.min(...lista.map((x) => x.ratio)) : null);
      const peorTinte = peor(m.tintes);
      checkTrue(
        "el texto del estado sobre SU tinte ≥ 4,5:1 (los cuatro estados)",
        peorTinte !== null && peorTinte >= 4.5,
        `el peor: ${peorTinte}:1`,
      );
      for (const t of m.tintes) {
        checkTrue(
          `el tinte de «${t.clase.split(" ")[0]}» ≥ 4,5:1`,
          t.ratio >= 4.5,
          `${t.ratio}:1 (${t.color} sobre ${t.fondo})`,
        );
      }
      const peorBoton = peor(m.botones);
      checkTrue(
        "los botones de acción ≥ 4,5:1",
        peorBoton !== null && peorBoton >= 4.5,
        `el peor: ${peorBoton}:1`,
      );
      console.log(
        `      (el peor tinte: ${peorTinte}:1 · el peor botón: ${peorBoton}:1 · ${m.tintes.length} tintes medidos · ${m.botones.length} botones · ${m.tintesReales.length} tintes reales en pantalla)`,
      );
    }
  } finally {
    await ui.close();
  }
}

await correrBateria({ main, etiqueta: "31-ui-esquemas" });
