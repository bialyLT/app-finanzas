/**
 * POST /api/auth/logout
 *
 * Borra la cookie de sesión.
 *
 * Es una ruta pública a propósito: si la sesión ya venció, el usuario igual tiene
 * que poder limpiar la cookie. Un logout que exige sesión válida deja cookies
 * huérfanas en el navegador.
 *
 * Se borra con `maxAge: 0` y los MISMOS atributos con los que se creó
 * (`path`, `sameSite`, `secure`). Una cookie sólo se puede sobrescribir si
 * coinciden el nombre, el dominio y el path.
 */

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST() {
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );

  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
