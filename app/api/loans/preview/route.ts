import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { loanSummary, parseMoneyInput } from "@/lib/money";

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
 * Es GET y no POST porque no modifica nada. Se puede cachear con normalidad.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);

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

  const summary = loanSummary(principal, tnaPercent, installmentCount);

  return NextResponse.json({
    payment: summary.payment.toFixed(2),
    totalPaid: summary.totalPaid.toFixed(2),
    totalInterest: summary.totalInterest.toFixed(2),
    interestSharePercent: summary.interestSharePercent.toFixed(2),
    schedule: summary.schedule.map((installment) => ({
      number: installment.number,
      payment: installment.payment.toFixed(2),
      interest: installment.interest.toFixed(2),
      principal: installment.principal.toFixed(2),
      remainingBalance: installment.remainingBalance.toFixed(2),
    })),
  });
}
