#!/usr/bin/env node
/**
 * 19-gates-guardas · ¿LOS GATES DE VERDAD NO TOCAN LOS DATOS DE LA PERSONA?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * QUÉ VERIFICA
 *
 * La app está en USO PERSONAL: `finanzas_dev` tiene datos reales y el `:3000`
 * es la instancia de la persona. Los gates siembran, así que correrlos contra
 * el `:3000` es BORRAR los datos de la persona (ya pasó: la primera corrida
 * del dev corrió 24 flows contra la base personal).
 *
 * Este script NO se queda en "no pasó": PRUEBA que cada guarda ABORTA.
 *
 *   1 · LA MISMA BASE: si `DATABASE_URL` y `DATABASE_URL_TEST` fueran la
 *       misma, los gates la vaciarían. Tiene que abortar antes de nada.
 *   2 · EL BUILD VIEJO: si el build no está al día, los gates correrían
 *       contra el código anterior. Tiene que abortar y decir el comando.
 *   3 · EL PUERTO OCUPADO: si el puerto de la instancia de pruebas está
 *       tomado, tiene que abortar en vez de pegarle al proceso ajeno.
 *   4 · LA FUGA AL :3000: si un flow de la copia temporal sigue apuntando a la
 *       instancia de la persona, el gate tiene que ABORTAR. Es el error que
 *       hizo que la primera corrida corriera 24 flows contra la base de la
 *       persona: probarlo es la diferencia entre "no pasó" y "no puede pasar".
 *   5 · LA INSTANCIA DE LA PERSONA SIGUE VIVA: mismo PID en el `:3000` antes y
 *       después, y el `:3000` sigue respondiendo.
 *   6 · LA INSTANCIA DE PRUEBAS NO QUEDA COLGADA: el puerto queda libre.
 *   7 · `finanzas_dev` INTACTA: el estado antes y después es idéntico.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CUÁNDO CORRE
 *
 * DESPUÉS de la corrida de flows: las pruebas 3 y 4 levantan la instancia de
 * pruebas y (la 4) SIEMBRA el escenario de pruebas, así que no pueden correr
 * al mismo tiempo que la suite.
 *
 * La 1 y la 2 son seguras en cualquier momento (abartan antes de tocar nada).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, copyFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, checkIncluye, checkTrue, section, summary } from "./lib-fase9r3.mjs";

const REPO = process.cwd();
const TEMP = process.env.TEMP ?? tmpdir();

/** Corre un comando y devuelve `{ code, out }`. */
function correr(cmd, args, { cwd = REPO, timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: false,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ya terminó.
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** El PID que escucha en un puerto (o null). */
function pidEn(puerto) {
  const out = runSync(
    `(Get-NetTCPConnection -State Listen -LocalPort ${puerto} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
  );
  const pid = Number(out.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function runSync(cmd) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", cmd], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    return String(error?.stdout ?? "");
  }
}

/** ¿Responde la instancia? */
async function responde(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return null;
  }
}

/** El estado de una base, con el script de lectura del proyecto. */
function estadoDe(url) {
  try {
    return execFileSync("node", ["scripts/db-state.mjs", `--url=${url}`], {
      encoding: "utf8",
      cwd: REPO,
      windowsHide: true,
    });
  } catch (error) {
    return String(error?.stdout ?? "ERROR");
  }
}

const DEV_URL = "postgresql://postgres@localhost:5433/finanzas_dev?schema=public";

/* ────────────────────────────────────────────────────────────────────────────
 * LAS PRUEBAS
 * ──────────────────────────────────────────────────────────────────────────── */

const flowFuga = join(REPO, "flows", "zz-tester-fuga-3000-f9r3.yaml");
const contenidoFlowFuga = `# FLOW TEMPORAL DEL TESTER (se borra al final)
# El literal "https://127.0.0.1:3000" NO lo reescribe el script de gates
# (sólo reescribe "http://127.0.0.1:3000"), así que el guardián tiene que
# verlo. Si no lo ve, este flow correría contra la instancia de la persona.
url: https://127.0.0.1:3000
name: "ZZ · Fuga al 3000 (tester)"
env:
  BASE: "https://127.0.0.1:3000"
---
- assertVisible: "esta cadena no existe en ninguna pantalla"
`;

let ok = false;

try {
  section("Punto de partida");
  const pid3000Antes = pidEn(3000);
  const estadoAntes = estadoDe(DEV_URL);
  console.log(`  :3000 → PID ${pid3000Antes}`);
  console.log(`  finanzas_dev → ${estadoAntes.split("\n").filter((l) => l.includes(":")).join(" | ")}`);
  checkTrue("la instancia de la persona está viva", !!pid3000Antes);

  /* ── 1 · LA MISMA BASE ─────────────────────────────────────────────────── */
  section("1 · Las dos bases apuntando a la MISMA base");
  {
    const raiz = join(TEMP, "opencode", "gatestest-f9r3");
    rmSync(raiz, { recursive: true, force: true });
    mkdirSync(join(raiz, "scripts"), { recursive: true });
    copyFileSync(join(REPO, "scripts", "gates.ps1"), join(raiz, "scripts", "gates.ps1"));
    // Un `.env` propio, con las dos bases IGUALES: el script lo lee desde su
    // propio repo (la raíz es el padre del script), así que el `.env` de la
    // persona NO se toca.
    writeFileSync(
      join(raiz, ".env"),
      `DATABASE_URL="${DEV_URL}"\nDATABASE_URL_TEST="${DEV_URL}"\nAPP_PASSWORD="finanzas-dev"\n`,
      "utf8",
    );
    const res = await correr(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-File", join(raiz, "scripts", "gates.ps1")],
      { cwd: raiz },
    );
    checkTrue("1 · el script aborta (código distinto de 0)", res.code !== 0, `code=${res.code}`);
    checkIncluye(
      "1 · el aviso dice que las dos bases son la misma",
      res.out,
      "MISMA base",
    );
    checkTrue(
      "1 · y no llegó a levantar ninguna instancia",
      !res.out.includes("Instancia de pruebas"),
      res.out.slice(-200),
    );
  }

  /* ── 2 · EL BUILD VIEJO ───────────────────────────────────────────────── */
  section("2 · El build viejo");
  {
    const fuente = join(REPO, "lib", "category-kind.ts");
    const st = statSync(fuente);
    const original = st.mtime;
    try {
      // Se "cambia" el archivo (sólo la fecha: el contenido no se toca).
      const ahora = new Date();
      utimesSync(fuente, ahora, ahora);
      const res = await correr("powershell", [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/gates.ps1",
      ]);
      checkTrue("2 · el script aborta (código distinto de 0)", res.code !== 0, `code=${res.code}`);
      checkIncluye("2 · el aviso dice que el build está viejo", res.out, "VIEJO");
      checkIncluye("2 · dice qué archivo cambió", res.out, "category-kind.ts");
      checkTrue(
        "2 · y no corrió el smoke (aborta antes)",
        !res.out.includes("Smoke test contra"),
        res.out.slice(-200),
      );
    } finally {
      // La fecha original se restaura: el archivo queda como estaba.
      utimesSync(fuente, original, original);
    }
  }

  /* ── 3 · EL PUERTO OCUPADO ────────────────────────────────────────────── */
  section("3 · El puerto de la instancia de pruebas ya ocupado");
  {
    const PUERTO = 3199;
    const dummy = spawn(
      process.execPath,
      [
        "-e",
        `require("http").createServer((q,s)=>s.end("dummy")).listen(${PUERTO},"127.0.0.1")`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await correr("powershell", [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/gates.ps1",
        "-Port",
        String(PUERTO),
      ]);
      checkTrue("3 · el script aborta (código distinto de 0)", res.code !== 0, `code=${res.code}`);
      checkIncluye("3 · el aviso dice que el puerto está ocupado", res.out, "ya está ocupado");
      checkIncluye(
        "3 · y dice QUIÉN lo ocupa (el PID y el comando)",
        res.out,
        "PID",
      );
      checkTrue(
        "3 · y no le pegó al proceso ajeno (el dummy sigue vivo)",
        dummy.exitCode === null,
        `el dummy terminó con ${dummy.exitCode}`,
      );
    } finally {
      try {
        dummy.kill("SIGKILL");
      } catch {
        // Ya terminó.
      }
    }
  }

  /* ── 4 · LA FUGA AL :3000 ─────────────────────────────────────────────── */
  section("4 · Un flow que se escapa al :3000: el gate tiene que ABORTAR");
  {
    const PUERTO = 3199;
    writeFileSync(flowFuga, contenidoFlowFuga, "utf8");
    try {
      const res = await correr("powershell", [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/gates.ps1",
        "-Port",
        String(PUERTO),
      ]);
      checkTrue("4 · el script aborta (código distinto de 0)", res.code !== 0, `code=${res.code}`);
      checkIncluye(
        "4 · el aviso dice que hay flows apuntando al :3000",
        res.out,
        ":3000",
      );
      checkIncluye(
        "4 · y nombra el flow culpable",
        res.out,
        "zz-tester-fuga-3000-f9r3.yaml",
      );
      checkIncluye(
        "4 · y dice que ABORTA",
        res.out,
        "ABORTE",
      );
      checkIncluye(
        "4 · el gate queda en rojo (no dice GATES OK)",
        res.out,
        "GATES CON FALLAS",
      );
      checkTrue(
        "4 · NO corrió ningún flow de Maestro (el guardián frenó antes)",
        !res.out.includes("Flows OK"),
        res.out.slice(-300),
      );
      checkTrue(
        "4 · y la instancia de pruebas quedó baja",
        pidEn(PUERTO) === null,
        `puerto ${PUERTO} con PID ${pidEn(PUERTO)}`,
      );
    } finally {
      rmSync(flowFuga, { force: true });
    }
  }

  /* ── 5, 6, 7 · LO QUE NO SE TOCA ──────────────────────────────────────── */
  section("5 · La instancia de la persona y su base, después de todo");
  const pid3000Despues = pidEn(3000);
  const estadoDespues = estadoDe(DEV_URL);

  checkTrue(
    "5 · el :3000 es el MISMO proceso que antes (no lo mataron)",
    pid3000Despues === pid3000Antes,
    `antes ${pid3000Antes} · después ${pid3000Despues}`,
  );
  const status = await responde("http://127.0.0.1:3000/login");
  check("5 · el :3000 sigue respondiendo", status, 200);

  check(
    "7 · finanzas_dev quedó INTACTA (estado idéntico antes y después)",
    estadoDespues.trim(),
    estadoAntes.trim(),
  );
  checkTrue(
    "7 · y no hay ningún movimiento con la categoría del otro tipo",
    !estadoDespues.includes("MOVIMIENTOS CON CATEGORÍA DE OTRO TIPO: 1"),
    estadoDespues,
  );

  ok = true;
} catch (error) {
  console.error(`\nLa batería falló: ${error.message ?? error}`);
  checkTrue("19 · la batería termina sin excepción", false, String(error.message ?? error));
} finally {
  rmSync(flowFuga, { force: true });
}

const bueno = summary();
process.exit(bueno && ok ? 0 : 1);
