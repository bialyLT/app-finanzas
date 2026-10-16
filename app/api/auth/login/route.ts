/**
 * POST /api/auth/login
 *
 * Verifica la contraseña y, si es correcta, emite la cookie de sesión firmada.
 *
 * Esta es una de las tres rutas públicas de la app (junto a `/login` y
 * `/api/auth/logout`). Todas las demás exigen sesión válida.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createSessionToken, getSessionSecret, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import {
  backoffDelay,
  clearFailures,
  clientIp,
  isRateLimited,
  registerFailure,
  verifyPassword,
} from "@/lib/auth/password";

export async function POST(request: NextRequest) {
  // Sin secreto no se puede firmar una sesión: no hay nada que hacer acá.
  // Es un error de configuración del servidor, no del usuario → 500.
  const secret = getSessionSecret();
  if (!secret) {
    console.error("[login] FALLA CERRADO: SESSION_SECRET ausente o con menos de 32 caracteres.");
    return NextResponse.json(
      { error: "El servidor no está configurado para autenticar. Revisá SESSION_SECRET." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = clientIp(request.headers);

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Demasiados intentos fallidos. Esperá unos minutos antes de reintentar." },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  // El cuerpo puede no ser JSON válido (o no traer `password`). Se normaliza a
  // string vacío para que la verificación falle por credencial y no por excepción.
  let password = "";
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "password" in body) {
      const candidate = (body as { password: unknown }).password;
      if (typeof candidate === "string") password = candidate;
    }
  } catch {
    password = "";
  }

  if (!verifyPassword(password)) {
    registerFailure(ip);
    // Retraso creciente: encarece el ataque automatizado sin bloquear al usuario
    // que se equivocó una sola vez.
    await backoffDelay(ip);

    // Mensaje genérico a propósito: no distinguimos "contraseña incorrecta" de
    // "no hay contraseña configurada". La causa real queda en los logs.
    return NextResponse.json(
      { error: "Contraseña incorrecta." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  clearFailures(ip);

  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(SESSION_COOKIE, createSessionToken(secret), sessionCookieOptions());
  return response;
}
