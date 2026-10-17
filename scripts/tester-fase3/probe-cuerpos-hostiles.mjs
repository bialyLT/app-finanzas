#!/usr/bin/env node
/**
 * Probe — cuerpos JSON hostiles contra las rutas nuevas de recurrencia.
 *
 * Diagnóstico: imprime status y body crudo para `null`, `"texto"`, `42`, `[]` y
 * un objeto vacío. Sirve para ver si el borde rechaza con 400 o si algo explota
 * con 500 (y si ese 500 filtra stack o texto de Prisma).
 */

process.loadEnvFile();

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = login.headers
  .getSetCookie()
  .find((c) => c.startsWith("finanzas_session="))
  .split(";")[0];

const H = { "Content-Type": "application/json", Origin: BASE, Cookie: cookie };

const casos = [
  ["null", "null"],
  ["string", '"hola"'],
  ["number", "42"],
  ["array", "[1,2]"],
  ["objeto vacío", "{}"],
];

for (const [nombre, raw] of casos) {
  for (const [ruta, metodo] of [
    ["/api/recurrence/rules", "POST"],
    ["/api/recurrence/rules", "PATCH"],
    ["/api/recurrence/occurrences", "POST"],
  ]) {
    const res = await fetch(`${BASE}${ruta}`, { method: metodo, headers: H, body: raw });
    const texto = (await res.text()).slice(0, 220);
    console.log(`${metodo} ${ruta} · body ${nombre} → ${res.status} ${texto.replace(/\s+/g, " ")}`);
  }
}
