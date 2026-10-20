#!/usr/bin/env node
/**
 * 13-gate-integridad · ¿el gate de responsive aguanta que lo ataquen?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS TRES ATAQUES
 *
 * A · EL CHECK A4 INVERTIDO (el que el dev de la r2 editó en MI batería).
 *     El ataque es el MISMO fixture: una tarjeta cuyo texto es más ancho que
 *     la tarjeta (el documento entra perfecto, el número queda PARTIDO). La
 *     r2 lo cerró: el runner ahora lo cuenta como falla.
 *     Lo que hay que verificar es que el check INVERTIDO no sea trivial:
 *       · con el corte → la auditoría tiene que FALLAR (exit 1, fail>0,
 *         nombrar al culpable);
 *       · SIN el corte (el MISMO fixture con el texto que entra) → la
 *         auditoría tiene que dar VERDE. Si las dos dan lo mismo, el check no
 *         está midiendo el corte: no dice nada.
 *
 * B · EL UMBRAL. El runner acepta `--max-overflow`. Un gate con umbral
 *     ajustable a 0 es un gate; con umbral ajustable a «infinito» no es nada.
 *     Hay que ver:
 *       · `--max-overflow 0` (el más estricto) → el corte sigue fallando;
 *       · `--max-overflow 99999` → el check se desactiva (y hay que poder
 *         verlo, no suponerlo);
 *       · `--max-overflow` SIN VALOR → ¿el runner se queja o se desactiva en
 *         silencio? Un gate que se desactiva con un typo es un gate que no
 *         es gate.
 *       · `--max-overflow=5` (con signo `=`) → ¿se respeta o se ignora?
 *
 * C · EL LANDSCAPE. La auditoría barre las dos orientaciones: un layout
 *     roto SÓLO en landscape tiene que detectarse (es el agujero donde
 *     estaba el BUG-1 de la paleta).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN SERVIDOR DE FIXTURES
 * La auditoría es un script que habla HTTP: lo que hay que probar es que
 * DETECTE, no de dónde viene la página. Un fixture de 20 líneas hace el
 * mismo trabajo que un build roto, sin tocar la app.
 */

import { check, checkTrue, checkIncluye, section } from "../tester-fase7/helpers.mjs";
import { servirFixture, correrAuditoria, resultadoDe, correrBateria } from "./lib.mjs";

const PUERTO = 3198;
const BASE = `http://127.0.0.1:${PUERTO}`;
const OUT = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\resp-fixtures-13`;

/** La página sana: nada más ancho que el device. */
const PAGINA_LIMPIA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>limpio</title></head>
<body style="margin:0;font-family:sans-serif">
  <main style="max-width:640px;margin:0 auto;padding:12px">
    <h1 style="font-size:18px">Panel</h1>
    <p style="font-size:14px">Un layout que se adapta.</p>
    <button style="min-height:44px">Guardar</button>
  </main>
</body></html>`;

/**
 * El MISMO fixture del A4: la tarjeta entra, el texto NO.
 * `textoCorto` decide si el número cabe o no — así el ataque y su control
 * son la misma página con un parámetro.
 */
const paginaConCorte = (textoCorto) => `<!doctype html>
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
      <p class="monto">${textoCorto ? "$ 100,00" : "$ 1.234.567.890,12"}</p>
    </div>
  </main>
</body></html>`;

/** Roto SÓLO en landscape: en portrait entra perfecto. */
const PAGINA_ROTA_EN_LANDSCAPE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>roto en landscape</title>
<style>
  main { max-width:640px; margin:0 auto; padding:12px; }
  @media (orientation: landscape) { #fuga { width:999px; } }
</style></head>
<body style="margin:0;font-family:sans-serif">
  <main>
    <h1 style="font-size:18px">Entra de pie</h1>
    <div id="fuga" style="height:20px;background:#c00"></div>
  </main>
</body></html>`;

async function correr(html, args, env = {}) {
  const fixture = await servirFixture(html, PUERTO);
  try {
    if (fixture.error) throw fixture.error;
    return await correrAuditoria(args, {
      BASE_URL: BASE,
      AUDIT_OUT_DIR: OUT,
      ...env,
    });
  } finally {
    fixture.cerrar();
  }
}

const SOLO_VISTA = ["--only=views", "--routes=inicio", "--widths=320"];

async function main() {
  /* ───────────────────────────────────────────────────────────────────────
   * A · EL CHECK A4 INVERTIDO: ¿mide de verdad?
   * ─────────────────────────────────────────────────────────────────────── */
  section("A · el A4 invertido: el ataque es el mismo y el contrato nuevo es el correcto");
  const conCorte = await correr(paginaConCorte(false), SOLO_VISTA);
  const resCorte = resultadoDe(conCorte.out);
  console.log(`  · con el corte → exit ${conCorte.code} · ${JSON.stringify(resCorte)}`);
  check("con el corte, la auditoría sale con código 1", conCorte.code, 1);
  checkTrue(
    "con el corte, la auditoría lo reporta como falla",
    (resCorte?.fail ?? 0) > 0,
    `fail=${resCorte?.fail}`,
  );
  checkIncluye("con el corte, la auditoría lo imprime", conCorte.out, "no entra en su caja");
  checkTrue(
    "con el corte, la auditoría NOMBRA al culpable",
    /\.monto/.test(conCorte.out),
    conCorte.out.slice(-500),
  );

  // EL CONTROL: la MISMA página, con el número que entra. Si el runner
  //Outer da verde, el check está midiendo el corte y no otra cosa.
  const sinCorte = await correr(paginaConCorte(true), SOLO_VISTA);
  const resSinCorte = resultadoDe(sinCorte.out);
  console.log(`  · sin el corte → exit ${sinCorte.code} · ${JSON.stringify(resSinCorte)}`);
  check("sin el corte, la auditoría sale con código 0", sinCorte.code, 0);
  check("sin el corte, la auditoría no reporta fallas", resSinCorte?.fail, 0);
  checkTrue(
    "sin el corte, la auditoría comprobó algo (ok > 0)",
    (resSinCorte?.ok ?? 0) > 0,
    `ok=${resSinCorte?.ok}`,
  );

  // Y una página sana por lo demás: el corte es lo único que puede fallar.
  const sana = await correr(PAGINA_LIMPIA, SOLO_VISTA);
  check("una página sana da verde", sana.code, 0);
  check("una página sana no reporta fallas", resultadoDe(sana.out)?.fail, 0);

  /* ───────────────────────────────────────────────────────────────────────
   * B · EL UMBRAL: ¿el gate se puede ablandar a voluntad?
   * ─────────────────────────────────────────────────────────────────────── */
  section("B · el umbral «--max-overflow»: explícito, y con límites");

  const estricto = await correr(paginaConCorte(false), [...SOLO_VISTA, "--max-overflow", "0"]);
  console.log(`  · --max-overflow 0 → exit ${estricto.code} · ${JSON.stringify(resultadoDe(estricto.out))}`);
  check("con el umbral más estricto (0 px), el corte sigue fallando", estricto.code, 1);
  checkIncluye("con el umbral 0, la auditoría nombra al culpable", estricto.out, ".monto");

  const laxo = await correr(paginaConCorte(false), [
    ...SOLO_VISTA,
    "--max-overflow",
    "99999",
  ]);
  console.log(`  · --max-overflow 99999 → exit ${laxo.code} · ${JSON.stringify(resultadoDe(laxo.out))}`);
  checkTrue(
    "con un umbral enorme, el corte deja de ser falla (el umbral manda): el gate es ajustable",
    laxo.code === 0,
    `exit=${laxo.code}`,
  );

  const sinValor = await correr(paginaConCorte(false), [...SOLO_VISTA, "--max-overflow"]);
  console.log(`  · --max-overflow (SIN VALOR) → exit ${sinValor.code} · ${JSON.stringify(resultadoDe(sinValor.out))}`);
  checkTrue(
    "un flag sin valor NO puede dejar el check de corte sin efecto (si el runner lo acepta, tiene que avisar)",
    sinValor.code === 1,
    `exit=${sinValor.code} — el runner acepta un umbral NaN y el corte deja de contar`,
  );

  const conEquals = await correr(paginaConCorte(false), [...SOLO_VISTA, "--max-overflow=5"]);
  console.log(`  · --max-overflow=5 → exit ${conEquals.code} · ${JSON.stringify(resultadoDe(conEquals.out))}`);
  check(
    "el flag con signo «=» se interpreta como el resto (falla cerrado: el corte cuenta)",
    conEquals.code,
    1,
  );

  /* ───────────────────────────────────────────────────────────────────────
   * C · EL LANDSCAPE: un layout roto sólo en landscape
   * ─────────────────────────────────────────────────────────────────────── */
  section("C · un layout roto SÓLO en landscape tiene que detectarse");
  const land = await correr(PAGINA_ROTA_EN_LANDSCAPE, [
    "--only=views",
    "--routes=inicio",
    "--widths=320,844",
  ]);
  const resLand = resultadoDe(land.out);
  console.log(`  · exit ${land.code} · ${JSON.stringify(resLand)}`);
  check("la corrida con landscape roto sale con código 1", land.code, 1);
  checkTrue(
    "la auditoría falló exactamente UNA vez (sólo el ancho roto)",
    resLand?.fail === 1,
    `fail=${resLand?.fail} — ${land.out.slice(-600)}`,
  );
  const linea320 = land.out.split("\n").find((l) => l.includes("device=320"));
  const linea844 = land.out.split("\n").find((l) => l.includes("device=844"));
  checkTrue("hubo una medición a 320 px (portrait)", Boolean(linea320), land.out.slice(-400));
  checkTrue("hubo una medición a 844 px (landscape)", Boolean(linea844), land.out.slice(-400));
  checkIncluye("a 320 px el veredicto es ok", linea320 ?? "", "ok");
  checkIncluye("a 844 px el veredicto es DESBORDE", linea844 ?? "", "DESBORDE");
  checkIncluye("la auditoría nombra al culpable del desborde en landscape", land.out, "#fuga");
}

await correrBateria({ main, etiqueta: "13-gate-integridad" });
