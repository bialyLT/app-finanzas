import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { todayCalendar } from "@/lib/dates";
import { describeDatabaseError } from "@/lib/queries";
import {
  describeRecurrenceError,
  runDueOccurrences,
} from "@/lib/recurring";

/**
 * POST /api/recurrence/run
 *
 * Materializa las ocurrencias vencidas de todas las reglas ACTIVAS ("desde la
 * última vez"). No hay cron: la pantalla lo llama al cargar y el resultado es
 * el mismo se corra cuando se corra, porque el avance se deriva del último
 * `dueDate` materializado y no de un cursor.
 *
 * Es una escritura, así que exige sesión Y mismo origen (CSRF).
 *
 * Respuesta (`RecurrenceRunDTO`):
 *   {
 *     today, materialized, posted, pending, capped,
 *     rules: [{ ruleId, title, materialized, posted, pending }],
 *     blocked: [{ ruleId, title, reason }]
 *   }
 *
 * `materialized: 0` es la respuesta normal cuando no había nada vencido. La
 * corrida entera es una sola transacción: si algo falla, no queda nada a
 * medias y reintentar es seguro.
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  try {
    const run = await runDueOccurrences(prisma, { today: todayCalendar() });
    return NextResponse.json(run);
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
      { error: "No se pudo correr la recurrencia." },
      { status: 500 },
    );
  }
}
