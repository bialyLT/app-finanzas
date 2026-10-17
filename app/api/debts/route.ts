import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import { getDebtReport } from "@/lib/queries";

/**
 * GET /api/debts?month=YYYY-MM[&asOf=YYYY-MM-DD]
 *
 * Devuelve el reporte de deudas de UN mes: deuda viva, progreso del capital,
 * interés pagado, cuotas restantes y DTI, con todas las definiciones resueltas
 * por el servidor (`getDebtReport`, lib/queries.ts). Acá sólo se valida la
 * entrada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES HERMANA DE /api/reconciliation Y NO PARTE DE /api/accounts
 * ─────────────────────────────────────────────────────────────────────────────
 * El reporte describe el mes que se está MIRANDO (el del selector del panel),
 * no el mes del reloj: navegar meses es viajar en el tiempo con las deudas, y
 * el corte de cada mes cambia con esa navegación. Colgarlo de `/api/accounts`
 * obligaría a mover también el patrimonio y la serie al cambiar de mes, que es
 * exactamente lo que el panel NO hace. Una ruta propia mantiene separadas las
 * dos preguntas —"¿cuánto debo hoy?" y "¿cómo estaban las deudas ese mes?"— y
 * le da al reporte su propia superficie de verificación: su sección del smoke
 * y sus tests de integración.
 *
 * `asOf` ancla el corte (como en `/api/reconciliation` y `/api/accounts`):
 * existe para que el smoke y los tests verifiquen meses cerrados con números
 * fijos sin depender del día en que se corran. La interfaz no lo manda.
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

  const debtReport = await getDebtReport(prisma, {
    month,
    anchor: asOf ?? todayCalendar(),
  });

  return NextResponse.json({ debtReport });
}
