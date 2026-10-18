import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { isCalendarDate } from "@/lib/dates";
import { getLoansView } from "@/lib/loan-service";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/loans
 *
 * Devuelve TODOS los préstamos —propios (`LOAN`, yo debo) y dados
 * (`RECEIVABLE`, me deben)— con su contrato, su progreso y sus compromisos de
 * los próximos meses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES "UN PRÉSTAMO" ACÁ (y qué no)
 * ─────────────────────────────────────────────────────────────────────────────
 * Los dos lados de una deuda son el mismo objeto con distinto signo: un `LOAN`
 * es un pasivo (la deuda contable es negativa) y un `RECEIVABLE` es un activo
 * (te deben, positivo). Los dos tienen contrato —monto, sistema, cronograma— y
 * los dos tienen progreso. La DIRECCIÓN no se guarda: se deriva del kind
 * (`loanDirectionOf`), así que no puede contradecirlo.
 *
 * Antes de responder, la vista CURA el cronograma: si a un préstamo con
 * parámetros completos le faltan filas materializadas (cuenta anterior a la
 * Fase 4), las crea de forma idempotente. Un préstamo no se puede "arreglar"
 * inventando cuotas: sólo se completan las que faltan de un contrato que ya
 * está implícito en los parámetros.
 *
 * `asOf` es opcional y ancla el progreso a una fecha (`?asOf=2026-09-30`): la
 * misma convención que `GET /api/accounts`.
 *
 * Una cuenta archivada sin saldo no se muestra (ya no dice nada); con saldo
 * pendiente, sí — archivarla no canceló la deuda.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  if (asOf && !isCalendarDate(asOf)) {
    return badRequest("`asOf` tiene que ser una fecha AAAA-MM-DD válida.");
  }

  const response = await getLoansView(prisma, {
    today: asOf ?? undefined,
    includeArchived: searchParams.get("includeArchived") !== "false",
  });

  return NextResponse.json(response);
}
