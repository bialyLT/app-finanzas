import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { isCalendarDate } from "@/lib/dates";
import { dueDateSeries, isAmortizationSystem } from "@/lib/loans";
import {
  LoanTermsError,
  parseLoanTermsRequest,
  resolveLoanTerms,
  type LoanTermsRawRequest,
} from "@/lib/loan-terms";
import { money } from "@/lib/money";

/**
 * GET /api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12
 * POST /api/loans/preview  { principal, installmentCount, mode, ... }
 *
 * Devuelve el plan de pagos de un préstamo antes de crearlo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE ENDPOINT EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * El cálculo de la cuota vive en `lib/money.ts` y usa `Prisma.Decimal`, que es
 * del servidor. El formulario necesita mostrar la vista previa MIENTRAS el
 * usuario escribe.
 *
 * La salida fácil sería reimplementar la fórmula del sistema francés en el
 * cliente con `Math.pow`. Son 5 líneas. Pero entonces habría DOS
 * implementaciones de la misma fórmula, y el día que difieran —porque una usa
 * redondeo bancario y la otra no, o porque una divide la TNA por 12 y la otra
 * usa la tasa efectiva— el usuario vería una cuota en el formulario y otra en
 * la lista de movimientos. Un bug así es prácticamente imposible de encontrar,
 * porque cada mitad parece correcta por separado.
 *
 * Con el cálculo en un solo lugar, la vista previa y el dato guardado NO PUEDEN
 * diferir: son el mismo código.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS TRES MODOS (el discriminante explícito)
 * ─────────────────────────────────────────────────────────────────────────────
 *   { principal, installmentCount, mode: "RATE",   tnaPercent }   // la tasa
 *   { principal, installmentCount, mode: "PAYMENT", payment }     // la cuota
 *   { principal, installmentCount, mode: "TOTAL",   total }       // el total
 *
 * El modo NO se deduce: un número puede ser la cuota o el total y la API no
 * puede saberlo (probar las dos y quedarse con una sería inventar datos). Si
 * no viene modo, es `RATE` (el de siempre: los flows que ya existen).
 *
 * El GET y el POST hacen EXACTAMENTE lo mismo: el GET es el que usa el
 * formulario (es una lectura, se puede cachear) y el POST el que acepta un
 * cuerpo con el mismo contrato. Un solo camino de cálculo para los dos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARÁMETROS DEL GET (todos por query string — es un GET, no modifica nada)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `system`: opcional; por defecto FRENCH. El sistema importado NO tiene
 *     vista previa: su cronograma se carga tal como lo dio el banco, no se
 *     calcula.
 *   · `firstInstallmentDate`: opcional. Si viene, cada cuota del plan lleva su
 *     fecha de vencimiento; si no, `dueDate` va `null` — el plan es el mismo,
 *     sólo falta cuándo.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);

  const raw: LoanTermsRawRequest = {
    mode: searchParams.get("mode"),
    principal: searchParams.get("principal") ?? "",
    installmentCount: searchParams.get("installmentCount") ?? "",
    tnaPercent: searchParams.get("tnaPercent"),
    payment: searchParams.get("payment"),
    total: searchParams.get("total"),
  };

  return preview(
    raw,
    searchParams.get("system"),
    searchParams.get("firstInstallmentDate"),
  );
}

/**
 * POST /api/loans/preview — el mismo contrato, en un cuerpo JSON.
 *
 * El cuerpo tiene que ser un objeto: sin ese chequeo, `body.principal` de un
 * `null` (que es JSON válido) revienta con un 500 sin explicación.
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "El cuerpo de la petición no es JSON válido." },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "El cuerpo de la petición tiene que ser un objeto JSON." },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;

  return preview(
    {
      mode: record.mode,
      principal: record.principal ?? "",
      installmentCount: record.installmentCount ?? "",
      tnaPercent: record.tnaPercent,
      payment: record.payment,
      total: record.total,
    },
    typeof record.system === "string" ? record.system : null,
    typeof record.firstInstallmentDate === "string"
      ? record.firstInstallmentDate
      : null,
  );
}

/** El núcleo: los dos verbos llaman a ESTA función (un solo camino). */
function preview(
  raw: LoanTermsRawRequest,
  systemParam: string | null,
  firstInstallmentDateParam: string | null,
) {
  if (
    systemParam !== null &&
    systemParam !== "" &&
    !isAmortizationSystem(systemParam)
  ) {
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

  if (
    firstInstallmentDateParam !== null &&
    firstInstallmentDateParam !== "" &&
    !isCalendarDate(firstInstallmentDateParam)
  ) {
    return NextResponse.json(
      { error: "La fecha de la primera cuota no es una fecha válida." },
      { status: 400 },
    );
  }

  let request;
  try {
    request = parseLoanTermsRequest(raw);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof LoanTermsError
            ? error.message
            : "No se pudo entender la petición de la vista previa.",
      },
      { status: 400 },
    );
  }

  // ── La normalización que hace honesta a la vista previa ────────────────────
  // El alta de préstamos redondea ANTES de guardar: el principal a centavos
  // (`toFixed(2)`) y la TNA a 4 decimales (`toFixed(4)`) — ver `/api/accounts`.
  // La vista previa tiene que calcular con ESOS mismos números o miente.
  const principal = money(request.principal.toFixed(2));
  // La tasa también se normaliza a 4 decimales: es lo que se guarda, y lo que
  // usa el cronograma del alta.
  const tnaPercent = request.tnaPercent
    ? money(request.tnaPercent.toFixed(4))
    : null;
  // La cuota y el total, a centavos: es lo que hace el ALTA
  // (`/api/accounts` -> `parsed.toFixed(2)`).
  //
  // ───────────────────────────────────────────────────────────────────────────
  // POR QUÉ IMPORTA (medido: 13 de cada 100 cuotas con 3 decimales)
  // ───────────────────────────────────────────────────────────────────────────
  // Si las dos rutas usan números distintos, la vista previa muestra una cuota
  // y el préstamo guarda otra. Con la cuota "56412.035": la vista previa
  // derivaba la tasa 59,9975 % (cuota 56.412,04) y el alta, que redondea a
  // 56.412,04, guardaba la tasa 59,9974 % (cuota 56.412,02): la app decía
  // una cosa y guardaba otra. Con la misma normalización, las dos rutas
  // calculan con el MISMO número y no pueden divergir.
  const payment = request.payment ? money(request.payment.toFixed(2)) : null;
  const total = request.total ? money(request.total.toFixed(2)) : null;

  const dueDates =
    firstInstallmentDateParam && isCalendarDate(firstInstallmentDateParam)
      ? dueDateSeries(firstInstallmentDateParam, request.installmentCount)
      : null;

  // Las fórmulas puras tiran `Error` con mensajes para la persona (p. ej. el
  // americano con tasa 0 en más de una cuota, o una cuota que no alcanza para
  // amortizar el capital): son datos del pedido, un 400.
  let terms;
  try {
    terms = resolveLoanTerms({
      system,
      principal,
      installmentCount: request.installmentCount,
      mode: request.mode,
      tnaPercent,
      payment,
      total,
    });
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
    mode: terms.mode,
    /** La tasa (TNA %) que corresponde a lo que se pidió: la derivada o la dada. */
    tnaPercent: terms.tnaPercent.toFixed(4),
    /** La cuota mínima: el capital repartido (tasa 0). Se usa en el mensaje
     *  de la cuota insuficiente. */
    minimumPayment: terms.minimumPayment.toFixed(2),
    /** `false` cuando la grilla de 4 decimales no alcanza para clavar el
     *  número pedido: la app muestra el valor real, no el tipeado. */
    exact: terms.exact,
    payment: terms.payment.toFixed(2),
    totalPaid: terms.totalPaid.toFixed(2),
    totalInterest: terms.totalInterest.toFixed(2),
    totalPrincipal: terms.totalPrincipal.toFixed(2),
    interestSharePercent: terms.interestSharePercent.toFixed(2),
    schedule: terms.schedule.map((installment, index) => ({
      number: installment.number,
      dueDate: dueDates ? dueDates[index] : null,
      payment: installment.payment.toFixed(2),
      interest: installment.interest.toFixed(2),
      principal: installment.principal.toFixed(2),
      remainingBalance: installment.remainingBalance.toFixed(2),
    })),
  });
}
