import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import { getMonthReconciliation } from "@/lib/queries";

/**
 * GET /api/reconciliation?month=YYYY-MM[&asOf=YYYY-MM-DD]
 *
 * Devuelve la reconciliación de UN mes: `ΔPatrimonio = Ahorro`, con la
 * diferencia ya calculada por el servidor. La definición completa vive en
 * `getMonthReconciliation` (lib/queries.ts); acá sólo se valida la entrada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA RUTA EXISTE (y no va dentro de /api/accounts)
 * ─────────────────────────────────────────────────────────────────────────────
 * Podría parecer que la reconciliación pertenece a `/api/accounts`, que ya
 * calcula el patrimonio. Y no: responden a preguntas distintas.
 *
 *   · `/api/accounts` contesta "¿cuánto tengo HOY?" — sin `asOf`, su foto y su
 *     serie terminan en el mes del reloj, y así lo usa el panel.
 *   · La reconciliación contesta "¿el mes que estoy MIRANDO cierra?" — y el mes
 *     que se mira es el del selector del panel, que cambia sin tocar "hoy".
 *
 * Colgarla de `/api/accounts` obligaría a mover también el patrimonio y la
 * serie cuando el usuario navega meses, que es exactamente lo que el panel NO
 * quiere (el encabezado de patrimonio es de hoy). Una ruta propia mantiene las
 * dos preguntas separadas, y de paso le da al control su propia superficie de
 * verificación: un número que existe para vigilar a los demás merece su propio
 * endpoint, su propia sección del smoke y sus propios tests.
 *
 * `asOf` ancla la fecha del corte (como en `/api/accounts`): existe para que
 * el smoke y los tests verifiquen meses cerrados con números fijos sin
 * depender del día en que se corran. La interfaz no lo manda.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month");
  const asOf = searchParams.get("asOf");

  // `month` es "YYYY-MM" y tiene que ser un mes real: el "13" no pasa el regex,
  // y el día 1 siempre existe en un mes existente — `isCalendarDate` cierra la
  // validación reusando el parser del módulo de fechas.
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isCalendarDate(`${month}-01`)) {
    return NextResponse.json(
      { error: "`month` tiene que ser un mes válido en formato AAAA-MM." },
      { status: 400 },
    );
  }

  if (asOf && !isCalendarDate(asOf)) {
    return NextResponse.json(
      { error: "`asOf` tiene que ser una fecha AAAA-MM-DD válida." },
      { status: 400 },
    );
  }

  const reconciliation = await getMonthReconciliation(prisma, {
    month,
    anchor: asOf ?? todayCalendar(),
  });

  return NextResponse.json({ reconciliation });
}
