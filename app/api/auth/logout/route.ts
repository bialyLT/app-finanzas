/**
 * POST /api/auth/logout
 *
 * Borra la cookie de sesión.
 *
 * Es una ruta pública a propósito: si la sesión ya venció, el usuario igual tiene
 * que poder limpiar la cookie. Un logout que exige sesión válida deja cookies
 * huérfanas en el navegador. Pero ser pública (sin sesión) NO es lo mismo que ser
 * abierta a cualquier origen: sin el chequeo de abajo, cualquier sitio podía
 * desloguear al usuario con un POST (logout CSRF).
 *
 * Se borra con `maxAge: 0` y los MISMOS atributos con los que se creó, tomados
 * de `sessionCookieOptions`. Una cookie sólo se puede sobrescribir si coinciden
 * el nombre, el dominio, el path... y `Secure`. Antes acá estaba hardcodeado
 * `secure: process.env.NODE_ENV === "production"`, que es `true` sirviendo por
 * http con `npm start` (el escenario que documenta `session.ts` para los tests de
 * interfaz): el login NO marcaba `Secure` pero el logout SÍ, y el navegador
 * descartaba el borrado, dejando la sesión viva tras "cerrar sesión".
 */

import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  // Segunda capa anti-CSRF, igual que en el resto de las mutaciones. No exige
  // sesión válida: sólo que el pedido venga del propio origen.
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );

  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });

  return response;
}
