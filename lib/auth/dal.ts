/**
 * Data Access Layer (DAL) de autenticación.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO EXISTE SI YA HAY `proxy.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * Lo dice la documentación oficial de Next 16 (guía `authentication`, sección
 * "Optimistic checks with Proxy"):
 *
 *   "While Proxy can be useful for initial checks, it should not be your only
 *    line of defense in protecting your data. The majority of security checks
 *    should be performed as close as possible to your data source."
 *
 * Traducción: el proxy es una CORTINA, no una cerradura. Es una optimización
 * para no renderizar trabajo de usuarios anónimos, y puede haber rutas que no
 * matcheé. La verificación que realmente protege los datos ocurre acá, al lado
 * de la base.
 *
 * Diseño de dos capas:
 *   proxy.ts        → capa optimista. Frena antes de renderizar. Barata.
 *   lib/auth/dal.ts → capa autoritativa. Se ejecuta en cada server component y
 *                     en cada route handler, siempre.
 *
 * Si alguien mañana agrega una ruta y se olvida del matcher, la DAL sigue
 * cerrando la puerta.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, getSessionSecret, verifySessionToken } from "./session";

/**
 * Devuelve la sesión actual, o `null` si no hay sesión válida.
 * Falla cerrado: si falta `SESSION_SECRET`, devuelve `null`.
 */
export async function getSession() {
  const secret = getSessionSecret();
  if (!secret) {
    console.error("[dal] FALLA CERRADO: SESSION_SECRET ausente o demasiado corto.");
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, secret);
}

/** `true` si hay una sesión válida. Azúcar sintáctico para las páginas. */
export async function isAuthenticated(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Exige sesión en un server component. Si no hay, redirige a `/login`.
 * Devuelve la sesión para quien la necesite.
 */
export async function requireSession(nextPath?: string) {
  const session = await getSession();
  if (session) return session;

  const target = nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login";
  redirect(target);
}

/**
 * Exige sesión en un route handler.
 * NO redirige (un `redirect()` en un handler devuelve un 307 que un cliente
 * `fetch` sigue sin entender): devuelve `null` para que el handler responda 401.
 *
 * Patrón de uso:
 *
 *   const session = await requireApiSession()
 *   if (!session) return unauthorized()
 */
export async function requireApiSession() {
  return getSession();
}

/** Respuesta 401 estándar, para no repetirla en cada handler. */
export function unauthorized(): Response {
  return Response.json(
    { error: "No autenticado" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
