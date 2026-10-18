import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { describeCardError, runCardStatements } from "@/lib/card-service";
import { todayCalendar } from "@/lib/dates";
import { describeDatabaseError } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/cards/statements
 *
 * Body opcional: `{ cardId? }`
 *
 * Emite (y actualiza) los resúmenes de los períodos de tarjeta que YA cerraron.
 * Es el botón "correr el cierre de resúmenes".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES IDEMPOTENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * La corrida no tiene cursor ni "última corrida": se deriva del estado. Un
 * resumen ya emitido se reconoce por (tarjeta, año, mes de cierre) —clave única
 * en la base— y se ACTUALIZA si estaba impago, o se deja intacto si estaba pago.
 * Correr dos veces seguidas, o correr hoy y mañana, no duplica ni pierde nada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ DEVUELVE
 * ─────────────────────────────────────────────────────────────────────────────
 * Por tarjeta: cuántos resúmenes se crearon, actualizaron, quedaron iguales o
 * están congelados por estar pagos, y la lista de resúmenes resultante. Las
 * tarjetas con compras pero sin día de cierre configurado no rompen la corrida:
 * aparecen en `skipped` con el motivo.
 *
 * El período en curso NO se emite: todavía se está llenando. Un resumen de un
 * mes a mitad de camino tendría un total que no es el que va a cobrar el banco.
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  const raw = await req.text();

  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest("El cuerpo de la petición no es JSON válido.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
    }
  }

  let cardId: string | undefined;
  if (body.cardId !== undefined && body.cardId !== null && body.cardId !== "") {
    if (typeof body.cardId !== "string") {
      return badRequest("`cardId` tiene que ser el id de una tarjeta.");
    }
    cardId = body.cardId;
  }

  try {
    const run = await runCardStatements(prisma, {
      today: todayCalendar(),
      cardId,
    });
    return NextResponse.json(run);
  } catch (error) {
    console.error(error);

    const described =
      describeCardError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudieron correr los resúmenes." },
      { status: 500 },
    );
  }
}
