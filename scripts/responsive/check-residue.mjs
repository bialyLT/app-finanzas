#!/usr/bin/env node
/**
 * check-residue.mjs — ¿la auditoría dejó algo en la base?
 *
 * La auditoría de responsive (`audit-mobile.mjs`) crea una tarjeta
 * descartable (`__AUDIT_TARJETA__`) para poder abrir el modal de «compra en
 * cuotas» — sin día de cierre no hay botón — y la borra al terminar. Si la
 * corrida se corta (el proceso muere, el server se cae), la tarjeta queda y
 * la base deja de ser el seed canónico: los flows y el smoke asertan contra
 * ese seed.
 *
 * Este script CUENTA lo que quedó y sale con código 1 si hay algo. La
 * pregunta «¿quedó algo?» se responde con un número, no de palabra.
 *
 * Uso:
 *   node scripts/responsive/check-residue.mjs
 *   node scripts/responsive/check-residue.mjs --base http://127.0.0.1:3000
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const optText = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const BASE_URL = optText("base", process.env.BASE_URL ?? "http://127.0.0.1:3000");

function readPassword() {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    const m = raw.match(/^APP_PASSWORD=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "finanzas-dev";
  } catch {
    return "finanzas-dev";
  }
}

const PREFIJO = "__AUDIT_";

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE_URL },
  body: JSON.stringify({ password: readPassword() }),
});
const raw = login.headers.getSetCookie?.().find((c) => c.startsWith("finanzas_session="));
if (!raw) {
  console.error(`No se pudo iniciar sesión en ${BASE_URL} (status ${login.status}).`);
  console.log("\nRESULT ok=0 fail=1");
  process.exit(1);
}
const cookie = raw.split(";")[0];

const response = await fetch(`${BASE_URL}/api/accounts`, { headers: { Cookie: cookie } });
const body = await response.json().catch(() => ({}));
const cuentas = Array.isArray(body?.accounts) ? body.accounts : [];
const residuo = cuentas.filter((c) => String(c?.name ?? "").startsWith(PREFIJO));

console.log(`Cuentas con el prefijo ${PREFIJO}: ${residuo.length}`);
for (const c of residuo) console.log(`  · ${c.name} (${c.id})`);

const ok = residuo.length === 0;
console.log(`RESULT ok=${ok ? 1 : 0} fail=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
