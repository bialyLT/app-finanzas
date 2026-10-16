/**
 * Chequeo de mismo origen para peticiones que mutan estado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SI YA HAY `SameSite=Lax`, ¿POR QUÉ ESTO?
 * ─────────────────────────────────────────────────────────────────────────────
 * `SameSite=Lax` ya impide que un POST cross-site lleve la cookie. Es la defensa
 * principal y alcanza. Pero es una defensa del NAVEGADOR: depende de que el
 * navegador del cliente implemente SameSite correctamente, y hay escenarios
 * (clientes viejos, proxies que reescriben cookies, subdominios) donde conviene
 * no depender de una sola capa.
 *
 * Este chequeo es la segunda capa: compara el header `Origin` (o `Referer`) con
 * el `Host` real de la petición. Si un sitio externo dispara el POST, el
 * navegador manda SU origen — que no coincide — y se corta en el servidor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA DEL "FALLA CERRADO"
 * ─────────────────────────────────────────────────────────────────────────────
 * Si no hay `Origin` ni `Referer`, se RECHAZA. Un `fetch` legítimo del navegador
 * en un método que muta estado siempre manda `Origin`; su ausencia es en sí
 * misma sospechosa.
 */

/**
 * Devuelve una respuesta 403 si el origen no coincide, o `null` si está bien.
 *
 *   const csrf = assertSameOrigin(request)
 *   if (csrf) return csrf
 */
export function assertSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");

  // `Origin` puede ser "null" (iframes sandboxeados, redirects cross-origin).
  // Ese caso también se rechaza.
  const candidate = origin && origin !== "null" ? origin : refererOrigin(request.headers.get("referer"));

  if (!candidate) {
    return forbidden("Falta el header Origin. Petición rechazada por seguridad.");
  }

  const host = request.headers.get("host");
  if (!host) {
    return forbidden("No se pudo determinar el host de la petición.");
  }

  let candidateHost: string;
  try {
    candidateHost = new URL(candidate).host;
  } catch {
    return forbidden("Origen inválido.");
  }

  // Comparación exacta host:puerto. Un subdominio distinto NO coincide.
  if (candidateHost !== host) {
    return forbidden("El origen de la petición no coincide con el de la aplicación.");
  }

  return null;
}

/** Extrae el origen de un `Referer` completo (fallback cuando no hay `Origin`). */
function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
