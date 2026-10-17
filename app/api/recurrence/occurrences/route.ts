import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { describeDatabaseError } from "@/lib/queries";
import {
  acceptOccurrence,
  describeRecurrenceError,
  skipOccurrence,
} from "@/lib/recurring";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/recurrence/occurrences
 *
 * Body: `{ id, action: "accept" | "skip" }`
 *
 * Resuelve una ocurrencia de la bandeja:
 *
 *   · `accept` → crea el movimiento que la cumple. Responsabilidad del
 *     servidor: el movimiento se arma con los datos VIGENTES de la regla
 *     (monto, cuentas, categoría, título) y la fecha de la ocurrencia, no la
 *     de hoy. ES IDEMPOTENTE: si ya estaba posteada, devuelve el movimiento
 *     existente con `created: false` en vez de duplicarlo o de dar un error —
 *     un doble clic, dos pestañas o un reintento llegan con la misma
 *     ocurrencia, y los tres merecen la misma respuesta.
 *
 *   · `skip`  → la marca como saltada. La fila NO se borra: si saltar fuera un
 *     borrado, la próxima corrida recrearía la fecha y el pasado se reescribiría
 *     solo. También es idempotente.
 *
 * Respuesta: `{ occurrence, created }`. `occurrence` trae el estado final y, si
 * se posteó, el movimiento completo (`OccurrenceDTO`).
 *
 * Status: 201 en el accept que creó el movimiento; 200 en el resto (accept
 * idempotente y skip): el recurso ya estaba en el estado pedido.
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.id`
  // explotaba con un TypeError y la respuesta era un 500 sin explicación.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return badRequest("Falta el id de la ocurrencia.");

  const action = body.action;
  if (action !== "accept" && action !== "skip") {
    return badRequest("Acción inválida. Tiene que ser \"accept\" o \"skip\".");
  }

  try {
    if (action === "accept") {
      const result = await acceptOccurrence(prisma, id);
      return NextResponse.json(result, { status: result.created ? 201 : 200 });
    }

    const occurrence = await skipOccurrence(prisma, id);
    return NextResponse.json({ occurrence, created: false });
  } catch (error) {
    console.error(error);

    const described =
      describeRecurrenceError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo resolver la ocurrencia." },
      { status: 500 },
    );
  }
}
