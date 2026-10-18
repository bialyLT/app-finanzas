import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { CARD_PLAN_MAX_INSTALLMENTS, installmentAmounts } from "@/lib/cards";
import type { CardPlanPreviewDTO } from "@/lib/finance";
import { implicitFinancingRate, parseMoneyInput } from "@/lib/money";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/cards/plans/preview?total=120000&installments=12&cashPrice=108000
 *
 * Calcula, SIN ESCRIBIR NADA, cómo quedaría una compra en cuotas: el valor de
 * cada cuota, el total y —si se manda el precio de contado— la tasa de interés
 * implícita y el sobreprecio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES UN GET SIN EFECTOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Es la vista previa del formulario: la persona escribe "1.200.000 en 12 cuotas"
 * y quiere ver la cuota antes de confirmar. Un POST sería semánticamente
 * incorrecto (no crea nada) y además el formulario lo dispararía en cada tecla.
 *
 * Es la única parte de la fase que contesta la pregunta que el ROADMAP marca
 * como central: "12 cuotas sin interés" con descuento al contado NO es sin
 * interés, y la tasa implícita es el número que lo demuestra.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);

  const totalAmount = parseMoneyInput(searchParams.get("total") ?? "");
  if (totalAmount === null || totalAmount.lessThanOrEqualTo(0)) {
    return badRequest("El total de la compra tiene que ser un monto mayor a cero.");
  }

  const installments = Number(searchParams.get("installments"));
  if (
    !Number.isInteger(installments) ||
    installments < 1 ||
    installments > CARD_PLAN_MAX_INSTALLMENTS
  ) {
    return badRequest(
      `La cantidad de cuotas tiene que ser un número entero entre 1 y ${CARD_PLAN_MAX_INSTALLMENTS}.`,
    );
  }

  let cashPrice: string | null = null;
  const rawCashPrice = searchParams.get("cashPrice");
  if (rawCashPrice !== null && rawCashPrice !== "") {
    const parsed = parseMoneyInput(rawCashPrice);
    if (parsed === null || parsed.lessThanOrEqualTo(0)) {
      return badRequest(
        "El precio de contado tiene que ser un monto mayor a cero (o no mandarse).",
      );
    }
    cashPrice = parsed.toFixed(2);
  }

  let amounts;
  try {
    amounts = installmentAmounts(totalAmount, installments);
  } catch (error) {
    return badRequest(
      error instanceof Error
        ? error.message
        : "No se pudo repartir el total en cuotas.",
    );
  }

  const totalPaid = totalAmount;
  const rate =
    cashPrice === null ? null : implicitFinancingRate(amounts, cashPrice);

  const preview: CardPlanPreviewDTO = {
    totalAmount: totalAmount.toFixed(2),
    installments,
    installmentAmount: amounts[0].toFixed(2),
    lastInstallmentAmount: amounts[amounts.length - 1].toFixed(2),
    totalPaid: totalPaid.toFixed(2),
    cashPrice,
    surcharge: rate === null ? null : rate.surcharge.toFixed(2),
    implicitRate:
      rate === null
        ? null
        : {
            monthlyRatePercent: rate.monthlyRatePercent.toFixed(2),
            teaPercent: rate.teaPercent.toFixed(2),
            surcharge: rate.surcharge.toFixed(2),
          },
  };

  return NextResponse.json(preview);
}
