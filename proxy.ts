/**
 * Proxy (ex-middleware) de Next 16.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES ESTO Y QUÉ NO ES
 * ─────────────────────────────────────────────────────────────────────────────
 * En Next 16 el archivo `middleware.ts` fue renombrado a `proxy.ts` y la función
 * exportada se llama `proxy`. Corre en el runtime de Node.js por defecto.
 *
 * Esta es la PRIMERA capa de autenticación: una cortina optimista que corre
 * antes de que la ruta se renderice. NO es la capa que protege los datos — esa
 * está en `lib/auth/dal.ts`, al lado de la base, porque el propio Next avisa que
 * el proxy "should not be your only line of defense".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL BUG DE SEGURIDAD QUE ESTO ARREGLA
 * ─────────────────────────────────────────────────────────────────────────────
 * Antes de este archivo, la app estaba desplegada en Vercel SIN autenticación:
 * cualquiera con la URL podía listar, crear y borrar movimientos financieros.
 * El matcher de abajo cubre `/((?!...))`, es decir TODAS las rutas excepto
 * estáticos — incluidas las 3 rutas de API. Si el matcher excluyera `/api`,
 * el proxy no las vería y quedarían abiertas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ 401 Y NO REDIRECT EN LAS RUTAS DE API
 * ─────────────────────────────────────────────────────────────────────────────
 * Un `redirect()` en una ruta de API devuelve un 307. Un `fetch()` del navegador
 * SIGUE el redirect y termina recibiendo el HTML de la página de login con
 * status 200. El cliente cree que la llamada salió bien y trata de parsear HTML
 * como JSON: el error aparece lejos de la causa.
 *
 * Para una API, la respuesta correcta a "no autenticado" es un 401 con JSON.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, getSessionSecret, verifySessionToken } from "./lib/auth/session";

/**
 * Rutas accesibles sin sesión.
 * Es una allow-list: todo lo que no esté acá exige autenticación.
 * (Al revés — block-list — es un error clásico: cada ruta nueva nace abierta.)
 */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

function readSession(request: NextRequest) {
  const secret = getSessionSecret();
  if (!secret) {
    // Falla cerrado: sin secreto no se acepta ninguna sesión.
    console.error("[proxy] FALLA CERRADO: SESSION_SECRET ausente o demasiado corto.");
    return null;
  }
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret);
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const session = readSession(request);

  // Usuario ya autenticado que entra a /login → mandarlo al inicio.
  if (pathname === "/login" && session) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (session) return NextResponse.next();
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // API: 401 en JSON. Nunca un redirect.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "No autenticado" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Páginas: redirect a /login recordando a dónde quería ir.
  // El `next` se valida al usarlo (ver app/login/page.tsx) para no permitir
  // redirecciones a un origen externo.
  const loginUrl = new URL("/login", request.url);
  const target = `${pathname}${search}`;
  if (target !== "/") loginUrl.searchParams.set("next", target);

  const response = NextResponse.redirect(loginUrl);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  /**
   * Corre en TODAS las rutas excepto los estáticos.
   *
   * Sin matcher, el proxy corre hasta sobre `_next/static` y las imágenes: eso
   * rompería el CSS y el JS del login, porque el navegador los pide sin sesión
   * y recibiría HTML de login en lugar del asset.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest)$).*)",
  ],
};
