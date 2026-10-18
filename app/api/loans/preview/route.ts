import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { isCalendarDate } from "@/lib/dates";
import { dueDateSeries, isAmortizationSystem, loanSummaryFor } from "@/lib/loans";
import { parseMoneyInput } from "@/lib/money";

/**
 * GET /api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12
 *
 * Devuelve el plan de pagos de un préstamo antes de crearlo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE ENDPOINT EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * El cálculo de la cuota vive en `lib/money.ts` y usa `Prisma.Decimal`, que es
 * del servidor. El formulario necesita mostrar la vista previa MIENTRAS el
 * usuario escribe la tasa y la cantidad de cuotas.
 *
 * La salida fácil sería reimplementar la fórmula del sistema francés en el
 * cliente con `Math.pow`. Son 5 líneas. Pero entonces habría DOS
 * implementaciones de la misma fórmula, y el día que difieran —porque una usa
 * redondeo bancario y la otra no, o porque una divide la TNA por 12 y la otra
 * usa la tasa efectiva— el usuario vería una cuota en el formulario y otra en la
 * lista de movimientos. Un bug así es prácticamente imposible de encontrar,
 * porque cada mitad parece correcta por separado.
 *
 * Con el cálculo en un solo lugar, la vista previa y el dato guardado NO PUEDEN
 * diferir: son el mismo código.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARÁMETROS (todos por query string — es un GET, no modifica nada)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `system`: opcional; por defecto FRENCH. El sistema importado NO tiene
 *     vista previa: su cronograma se carga tal como lo dio el banco, no se
 *     calcula.
 *   · `firstInstallmentDate`: opcional. Si viene, cada cuota del plan lleva su
 *     fecha de vencimiento; si no, `dueDate` va `null` — el plan es el mismo,
 *     sólo falta cuándo.
 *
 * Es GET y no POST porque no modifica nada. Se puede cachear con normalidad.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);

  const systemParam = searchParams.get("system");
  if (systemParam !== null && systemParam !== "" && !isAmortizationSystem(systemParam)) {
    return NextResponse.json(
      {
        error:
          "El sistema de amortización no es válido. Tiene que ser FRENCH, GERMAN, AMERICAN, INTEREST_ONLY o IMPORTED.",
      },
      { status: 400 },
    );
  }
  const system = isAmortizationSystem(systemParam) ? systemParam : "FRENCH";

  if (system === "IMPORTED") {
    return NextResponse.json(
      {
        error:
          "El sistema importado no tiene vista previa calculada: su cronograma se carga tal como lo dio el banco.",
      },
      { status: 400 },
    );
  }

  const principal = parseMoneyInput(searchParams.get("principal") ?? "");
  const tnaPercent = parseMoneyInput(searchParams.get("tnaPercent") ?? "");
  const installmentCount = Number(searchParams.get("installmentCount") ?? "");

  if (principal === null || principal.lessThanOrEqualTo(0)) {
    return NextResponse.json(
      { error: "El monto del préstamo tiene que ser mayor a cero." },
      { status: 400 },
    );
  }

  if (tnaPercent === null || tnaPercent.isNegative()) {
    return NextResponse.json(
      { error: "La tasa (TNA) no puede ser negativa." },
      { status: 400 },
    );
  }

  if (!Number.isInteger(installmentCount) || installmentCount <= 0 || installmentCount > 600) {
    return NextResponse.json(
      { error: "La cantidad de cuotas tiene que ser un entero entre 1 y 600." },
      { status: 400 },
    );
  }

  const firstInstallmentDate = searchParams.get("firstInstallmentDate");
  if (
    firstInstallmentDate !== null &&
    firstInstallmentDate !== "" &&
    !isCalendarDate(firstInstallmentDate)
  ) {
    return NextResponse.json(
      { error: "La fecha de la primera cuota no es una fecha válida." },
      { status: 400 },
    );
  }
  const dueDates =
    firstInstallmentDate && isCalendarDate(firstInstallmentDate)
      ? dueDateSeries(firstInstallmentDate, installmentCount)
      : null;

  // Las fórmulas puras tiran `Error` con mensajes para la persona (p. ej. el
  // americano con tasa 0 en más de una cuota): son datos del pedido, un 400.
  let summary: ReturnType<typeof loanSummaryFor>;
  try {
    summary = loanSummaryFor({ system, principal, tnaPercent, installmentCount });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "El plan de pagos no se pudo calcular con esos datos.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    system,
    payment: summary.payment.toFixed(2),
    totalPaid: summary.totalPaid.toFixed(2),
    totalInterest: summary.totalInterest.toFixed(2),
    totalPrincipal: summary.totalPrincipal.toFixed(2),
    interestSharePercent: summary.interestSharePercent.toFixed(2),
    schedule: summary.schedule.map((installment, index) => ({
      number: installment.number,
      dueDate: dueDates ? dueDates[index] : null,
      payment: installment.payment.toFixed(2),
      interest: installment.interest.toFixed(2),
      principal: installment.principal.toFixed(2),
      remainingBalance: installment.remainingBalance.toFixed(2),
    })),
  });
}
