#!/usr/bin/env node
/**
 * 01-auditoria-integridad · ¿la auditoría de responsive MIENTE?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA ES LA PRIMERA
 * Todo lo demás de la ronda depende de que la auditoría diga la verdad. Una
 * auditoría que dice «ok» con un layout roto es el peor bug posible: deja
 * pasar la etapa que tenía que atrapar y, además, da confianza falsa.
 *
 * Se ataca la auditoría por el lado que la hace creíble o la delata:
 *
 *   A1 · ¿DETECTA una fuga real?  Se le sirve un layout roto DE VERDAD
 *        (un `w-[999px]`) y se exige que la auditoría falle (exit 1,
 *        `RESULT ok=N fail=M` con fail>0) y que nombre al culpable.
 *        Y al revés: con un layout sano tiene que dar verde (exit 0). Una
 *        auditoría que siempre falla tampoco sirve: no mide, alarma.
 *
 *   A2 · ¿MIDE el viewport que dice medir?  Se rompe la emulación a propósito
 *        (`AUDIT_SKIP_TOUCH=1`: sin emulación de toque, `pointer: coarse` es
 *        falso) y se exige el ABORTE ruidoso: «LA EMULACIÓN NO APLICÓ» y exit 1.
 *        Medir sin emulación es peor que no medir, porque el reporte diría
 *        «ok».
 *
 *   A3 · ¿El rango es un RANGO?  Se sirve un layout que entra en 375 y se
 *        rompe en 480 (una media query con un elemento de 999 px). La
 *        auditoría tiene que decir «ok» en 375 y FALLAR en 480: un arreglo que
 *        funciona en 375 y se rompe en 480 es un arreglo para 375.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN SERVIDOR DE FIXTURES Y NO UN BUILD ROTO
 * La auditoría es un script que habla HTTP: lo que hay que probar es que
 * DETECTE el desborde, no de dónde viene la página. Un fixture HTTP de 30
 * líneas hace el mismo trabajo que un build roto, sin tocar la app, sin
 * rebuild y sin dejar el árbol roto si la corrida se corta. El runner que se
 * ejecuta es EL MISMO archivo (`scripts/responsive/audit-mobile.mjs`), con su
 * código de salida y su línea `RESULT` de verdad.
 *
 * Requiere: node ≥ 20 (fetch nativo). NO necesita la app arriba ni la base.
 */

import { check, checkTrue, checkIncluye, section } from "../tester-fase7/helpers.mjs";
import { servirFixture, correrAuditoria, resultadoDe, correrBateria } from "./lib.mjs";

const PUERTO = 3199;
const BASE = `http://127.0.0.1:${PUERTO}`;
const OUT = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\resp-fixtures`;

/* ── Las tres páginas de prueba ──────────────────────────────────────────── */

/** Sana: nada más ancho que el device. */
const PAGINA_LIMPIA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>limpio</title></head>
<body style="margin:0;font-family:sans-serif">
  <main style="max-width:640px;margin:0 auto;padding:12px">
    <h1 style="font-size:18px">Panel</h1>
    <p style="font-size:14px">Un layout que se adapta: el contenedor tiene
    max-width y el texto envuelve.</p>
    <button style="min-height:44px">Guardar</button>
  </main>
</body></html>`;

/** Con una fuga real: un bloque de 999 px que empuja el documento. */
const PAGINA_CON_FUGA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fuga</title></head>
<body style="margin:0;font-family:sans-serif">
  <main style="max-width:640px;margin:0 auto;padding:12px">
    <h1 style="font-size:18px">Panel con una fuga</h1>
    <div id="fuga" style="width:999px;height:20px;background:#c00"></div>
  </main>
</body></html>`;

/**
 * Sana en 375 y rota en 480: la fuga aparece recién con `min-width: 480px`.
 * Es el caso exacto de «responsive de juguete»: entra en el teléfono que se
 * probó y se rompe en el que no.
 */
const PAGINA_QUE_SE_ROMPE_A_480 = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>se rompe a 480</title>
<style>
  main { max-width:640px; margin:0 auto; padding:12px; }
  @media (min-width: 480px) { #fuga { width:999px; } }
</style></head>
<body style="margin:0;font-family:sans-serif">
  <main>
    <h1 style="font-size:18px">Entría en 375</h1>
    <div id="fuga" style="height:20px;background:#c00"></div>
  </main>
</body></html>`;

/**
 * El contenido que NO entra en su caja, pero sin romper el documento.
 *
 * Es la clase exacta del defecto que el dev arregló como #3 («$ 800.000,00
 * cortado dentro de la tarjeta»): el número es más ancho que la tarjeta y
 * queda CORTADO, pero el documento no se pasa de ancho (el device está bien).
 * La auditoría lo imprime («no entra en su caja») pero su contrato de salida
 * (exit code + `RESULT ok=N fail=M`) NO lo cuenta como falla.
 */
const PAGINA_CON_TEXTO_CORTADO = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>texto cortado</title>
<style>
  main { max-width:640px; margin:0 auto; padding:12px; }
  .tarjeta { width:140px; padding:12px; background:#eee; overflow:visible; }
  .monto { font: 800 24px/1.2 sans-serif; white-space:nowrap; }
</style></head>
<body style="margin:0;font-family:sans-serif">
  <main>
    <h1 style="font-size:18px">El documento entra</h1>
    <div class="tarjeta">
      <p class="monto">$ 1.234.567.890,12</p>
    </div>
  </main>
</body></html>`;

/* ── Corredora ───────────────────────────────────────────────────────────── */
async function correr(html, args, env = {}) {
  const fixture = await servirFixture(html, PUERTO);
  try {
    if (fixture.error) throw fixture.error;
    const r = await correrAuditoria(args, {
      BASE_URL: BASE,
      AUDIT_OUT_DIR: OUT,
      ...env,
    });
    return r;
  } finally {
    fixture.cerrar();
  }
}

async function main() {
  /* ── A1a · con un layout sano, la auditoría da verde ───────────────────── */
  section("A1a · layout sano → la auditoría tiene que dar VERDE");
  const verde = await correr(PAGINA_LIMPIA, ["--only=views", "--routes=inicio", "--widths=320"]);
  const resVerde = resultadoDe(verde.out);
  check("la auditoría sale con código 0 con un layout sano", verde.code, 0);
  checkTrue(
    "la auditoría imprime RESULT ok=N fail=M",
    resVerde !== null,
    `salida: ${verde.out.slice(-400)}`,
  );
  check("la auditoría no reporta fallas con un layout sano", resVerde?.fail, 0);
  checkTrue(
    "la auditoría comprobó algo (ok > 0): no es un ok vacío",
    (resVerde?.ok ?? 0) > 0,
    `ok=${resVerde?.ok}`,
  );

  /* ── A1b · con una fuga real, la auditoría tiene que FALLAR ───────────── */
  section("A1b · fuga real (w-[999px]) → la auditoría tiene que FALLAR y señalar al culpable");
  const rojo = await correr(PAGINA_CON_FUGA, ["--only=views", "--routes=inicio", "--widths=320"]);
  const resRojo = resultadoDe(rojo.out);
  check("la auditoría sale con código 1 con una fuga real", rojo.code, 1);
  checkTrue(
    "la auditoría imprime RESULT ok=N fail=M",
    resRojo !== null,
    `salida: ${rojo.out.slice(-400)}`,
  );
  checkTrue(
    "la auditoría reporta al menos una falla con la fuga",
    (resRojo?.fail ?? 0) > 0,
    `fail=${resRojo?.fail}`,
  );
  checkIncluye("la auditoría nombra al culpable de la fuga", rojo.out, "#fuga");
  checkIncluye("la auditoría dice DESBORDE", rojo.out, "DESBORDE");

  /* ── A2 · si la emulación no aplicó, ABORTA (no dice «ok») ───────────── */
  section("A2 · emulación rota → ABORTE ruidoso, nunca «ok»");
  const abortado = await correr(PAGINA_LIMPIA, ["--only=views", "--routes=inicio", "--widths=320"], {
    AUDIT_SKIP_TOUCH: "1",
  });
  check("sin emulación de toque la auditoría sale con código 1", abortado.code, 1);
  checkIncluye(
    "la auditoría aborta con el mensaje de emulación",
    abortado.out,
    "LA EMULACIÓN NO APLICÓ",
  );
  const resAbortado = resultadoDe(abortado.out);
  checkTrue(
    "el aborto se reporta como falla (fail>0)",
    (resAbortado?.fail ?? 0) > 0,
    `fail=${resAbortado?.fail}`,
  );

  /* ── A3 · el rango es un rango: 375 entra, 480 se rompe ───────────────── */
  section("A3 · un layout que entra en 375 y se rompe en 480 tiene que ser detectado");
  const rango = await correr(PAGINA_QUE_SE_ROMPE_A_480, [
    "--only=views",
    "--routes=inicio",
    "--width",
    "375",
    "--height",
    "667",
    "--widths=375,480",
  ]);
  const resRango = resultadoDe(rango.out);
  check("la corrida del rango sale con código 1", rango.code, 1);
  checkTrue(
    "la auditoría falló exactamente UNA vez (sólo el ancho que se rompe)",
    resRango?.fail === 1,
    `fail=${resRango?.fail} — ${rango.out.slice(-600)}`,
  );
  const linea375 = rango.out.split("\n").find((l) => l.includes("device=375"));
  const linea480 = rango.out.split("\n").find((l) => l.includes("device=480"));
  checkTrue("hubo una medición a 375 px", Boolean(linea375), `lineas: ${rango.out.slice(-400)}`);
  checkTrue("hubo una medición a 480 px", Boolean(linea480), `lineas: ${rango.out.slice(-400)}`);
  checkIncluye("a 375 px el veredicto es ok", linea375 ?? "", "ok");
  checkIncluye("a 480 px el veredicto es DESBORDE", linea480 ?? "", "DESBORDE");

  /* ── A4 · el HUECO del gate: el contenido que no entra en su caja ────── */
  section("A4 · el contenido que no entra en su caja ES una falla (el hueco está cerrado)");
  // Una tarjeta cuyo texto es más ancho que la tarjeta: el documento NO se
  // pasa de ancho (el DEVICE está bien), pero el número queda CORTADO dentro
  // de su caja. Es la clase exacta del defecto #3 que el dev arregló (el
  // «$ 800.000,00 cortado dentro de la tarjeta»).
  //
  // ANTES esta batería comprobaba que la auditoría NO lo contaba como
  // falla: era el hueco del gate («ok» con un número partido). La ronda
  // siguiente (Fase 9 r2) lo CERRÓ: el runner cuenta el corte como falla,
  // con un umbral explícito (`--max-overflow`, 1 px) y nombra al culpable.
  // El ataque es el MISMO; lo que cambia es el contrato esperado — que es
  // justo lo que el runner tenía que cambiar.
  const conCorte = await correr(PAGINA_CON_TEXTO_CORTADO, [
    "--only=views",
    "--routes=inicio",
    "--widths=320",
  ]);
  const resCorte = resultadoDe(conCorte.out);
  check(
    "con contenido cortado DENTRO de su caja, la auditoría sale con código 1",
    conCorte.code,
    1,
  );
  checkTrue(
    "y lo reporta como falla (el corte es parte del contrato de salida)",
    (resCorte?.fail ?? 0) > 0,
    `fail=${resCorte?.fail}`,
  );
  checkIncluye(
    "y lo imprime: «no entra en su caja»",
    conCorte.out,
    "no entra en su caja",
  );
  checkTrue(
    "y nombra al culpable del corte",
    /\.monto/.test(conCorte.out),
    conCorte.out.slice(-500),
  );

  /* ── A5 · EL CONTROL: el MISMO fixture SIN corte tiene que dar VERDE ──── */
  // Un check que dice «falla» puede estar mintiendo: lo que prueba que
  // mide el CORTE y no otra cosa es que la MISMA página, con el número que
  // entra, da verde. Si las dos dan lo mismo, el check no dice nada.
  //
  // (Lo agrega el tester en la r2: el A4 invertido del dev cumple su
  // contrato, pero el control es lo que lo demuestra.)
  section("A5 · el control: el mismo fixture con el número que ENTRA tiene que dar VERDE");
  const sinCorte = await correr(PAGINA_CON_TEXTO_CORTADO.replace(
    "$ 1.234.567.890,12",
    "$ 100,00",
  ), ["--only=views", "--routes=inicio", "--widths=320"]);
  const resSinCorte = resultadoDe(sinCorte.out);
  console.log(
    `  · con el número que entra → exit ${sinCorte.code} · ${JSON.stringify(resSinCorte)}`,
  );
  check("sin el corte, la auditoría sale con código 0", sinCorte.code, 0);
  check("sin el corte, la auditoría no reporta fallas", resSinCorte?.fail, 0);
  checkTrue(
    "sin el corte, la auditoría comprobó algo (ok > 0)",
    (resSinCorte?.ok ?? 0) > 0,
    `ok=${resSinCorte?.ok}`,
  );

  /* ── A6 · EL UMBRAL: el gate no se puede desactivar con un typo ──────── */
  section("A6 · el umbral «--max-overflow» no se puede dejar sin efecto con un typo");
  const sinValor = await correr(PAGINA_CON_TEXTO_CORTADO, [
    "--only=views",
    "--routes=inicio",
    "--widths=320",
    "--max-overflow",
  ]);
  console.log(`  · --max-overflow sin valor → exit ${sinValor.code}`);
  check(
    "un flag sin valor NO desactiva el check de corte (el runner avisa y usa el valor por defecto)",
    sinValor.code,
    1,
  );
}

/* ── Envoltorio ──────────────────────────────────────────────────────────── */

await correrBateria({ main, etiqueta: "01-auditoria-integridad" });
