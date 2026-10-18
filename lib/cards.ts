/**
 * Reglas PURAS de las tarjetas de crédito: períodos de resumen, asignación de
 * cuotas, pago mínimo, utilización y cuotas comprometidas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO ES PURO (sin Prisma, sin reloj, sin red)
 * ─────────────────────────────────────────────────────────────────────────────
 * Todas las decisiones de fechas y de plata de una tarjeta se pueden contestar
 * mirando dos cosas: el día de cierre y los montos. Nada más. Aislar esas
 * cuentas acá —igual que `lib/recurrence.ts` con el motor de fechas— hace que
 * el "¿en qué resumen cae esta compra?" y el "¿cuánto es el mínimo?" tengan UNA
 * respuesta verificable, y que el servicio de base de datos (lib/card-service.ts)
 * sólo se ocupe de leer y escribir.
 *
 * El "hoy" NUNCA se lee acá: entra como parámetro. Es la misma disciplina que
 * `runDueOccurrences`: los tests pueden probar cualquier día del mes, incluido
 * el 31, sin depender del día en que se corran.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CONCEPTO QUE ORDENA TODO: EL PERÍODO SE IDENTIFICA POR SU CIERRE
 * ─────────────────────────────────────────────────────────────────────────────
 * Un resumen "de diciembre" es el que CIERRA en diciembre. Una compra del 28 de
 * diciembre con cierre el 25 no está en el resumen que cerró el 25 de
 * diciembre: está en el que cierra el 25 de enero. Por eso el período se
 * identifica con el par (año, mes) DEL CIERRE, y no con el mes de las compras.
 * Esa única decisión es la que hace que el cruce diciembre/enero no descuadre
 * nada: el resumen de diciembre cierra en diciembre y vence en enero, y ninguna
 * cuenta mezcla los dos meses.
 */

import { calendarToLocalDate, clampDayOfMonth, type CalendarDate } from "./dates";
import { money, round, zero, type Money } from "./money";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Un período de resumen, identificado por el MES EN QUE CIERRA (1..12).
 *
 * No guarda la fecha de cierre: la cierre la determina el `closingDay` de la
 * tarjeta (con su clamp a fin de mes). Guardar las dos cosas sería un segundo
 * origen de verdad que puede contradecir al primero.
 */
export interface StatementPeriod {
  year: number;
  month: number;
}

/** Clave estable de un período, para Sets, Map y comparaciones: "2026-12". */
export function periodKey(period: StatementPeriod): string {
  return `${period.year}-${pad2(period.month)}`;
}

/** Compara dos períodos cronológicamente (negativo: `a` es anterior). */
export function comparePeriods(a: StatementPeriod, b: StatementPeriod): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/** Suma (o resta, con `months` negativo) meses a un período. */
export function addMonthsToPeriod(
  period: StatementPeriod,
  months: number,
): StatementPeriod {
  const index = period.year * 12 + (period.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** El período siguiente. */
export function nextPeriod(period: StatementPeriod): StatementPeriod {
  return addMonthsToPeriod(period, 1);
}

/**
 * La fecha de cierre de un período: el `closingDay` clampeado al mes.
 *
 * Cierre 31 en abril es el 30; en febrero, el 28 (o 29). Igual que el ancla de
 * `RecurrenceRule.dayOfMonth`, el clamp se aplica al ANCLA y no se arrastra:
 * mayo vuelve a cerrar el 31.
 */
export function closingDateOf(
  period: StatementPeriod,
  closingDay: number,
): CalendarDate {
  return `${period.year}-${pad2(period.month)}-${pad2(
    clampDayOfMonth(period.year, period.month, closingDay),
  )}`;
}

/**
 * El período de resumen al que corresponde una fecha.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA DEL DÍA DE CIERRE (criterio 4: "una compra EN el día de cierre")
 * ─────────────────────────────────────────────────────────────────────────────
 * Si la fecha es EN O ANTES del día de cierre del mes, va al resumen que cierra
 * ese mes. Si es después, al siguiente. La comparación es `<=` a propósito:
 * una compra hecha el mismo día del cierre entra en ESE resumen — el banco
 * cierra al terminar el día, no al empezarlo.
 *
 * La comparación se hace contra el cierre CLAMPEADO del mes de la fecha, que es
 * el mismo número con el que después se calcula la fecha de cierre: si fueran
 * dos cuentas distintas, un cierre "31" en abril podría mandar una compra del 30
 * a dos períodos diferentes según por dónde se pregunte.
 */
export function statementPeriodOf(
  date: CalendarDate,
  closingDay: number,
): StatementPeriod {
  const parsed = calendarToLocalDate(date);
  const year = parsed.getFullYear();
  const month = parsed.getMonth() + 1;
  const day = parsed.getDate();

  if (day <= clampDayOfMonth(year, month, closingDay)) {
    return { year, month };
  }
  return addMonthsToPeriod({ year, month }, 1);
}

/**
 * La fecha de vencimiento de un período.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `dueDay` ES UN DÍA FIJO DEL MES (decisión, con su porqué)
 * ─────────────────────────────────────────────────────────────────────────────
 * El vencimiento es el primer `dueDay` (clampeado) ESTRICTAMENTE posterior al
 * cierre. Con un cierre 25 y un vencimiento 5, el resumen de octubre vence el 5
 * de noviembre; con cierre 5 y vencimiento 20, vence el 20 del mismo mes.
 *
 * La alternativa —"vence N días después del cierre"— se descartó por dos
 * motivos: (1) es como lo dice el banco ("cierra el 25 y vence el 5") y así se
 * carga sin traducir; (2) un vencimiento en días es una fecha MÓVIL: 10 días
 * después de un cierre 25 daría el 4 de marzo en un año y el 6 en otro, y el
 * "día de pago" que la persona tiene en la cabeza no es una cuenta, es un día
 * del mes.
 *
 * El caso `dueDay == closingDay` cae al mes siguiente: el cierre ocurre primero
 * (el mismo día no se puede cerrar y vencer a la vez).
 */
export function dueDateOf(
  period: StatementPeriod,
  closingDay: number,
  dueDay: number,
): CalendarDate {
  const closing = closingDateOf(period, closingDay);
  const sameMonth = closingDateOf(period, dueDay);
  // Las fechas son "YYYY-MM-DD" cero-rellenadas: comparar como string es
  // comparar cronológicamente, sin construir un solo Date.
  return sameMonth > closing ? sameMonth : closingDateOf(nextPeriod(period), dueDay);
}

/**
 * La ventana de fechas que un período factura: (cierre anterior, cierre].
 *
 * Es semiabierta a propósito: la fecha de cierre anterior queda EXCLUIDA (esa
 * compra fue del resumen anterior) y la de este cierre queda INCLUIDA. Sin la
 * distinción, una compra justo en un cierre aparecería en dos resúmenes — o en
 * ninguno.
 */
export interface PeriodWindow {
  /** Exclusivo: estrictamente después de esta fecha. */
  after: CalendarDate;
  /** Inclusive: hasta esta fecha. */
  through: CalendarDate;
}

export function periodWindow(
  period: StatementPeriod,
  closingDay: number,
): PeriodWindow {
  return {
    after: closingDateOf(addMonthsToPeriod(period, -1), closingDay),
    through: closingDateOf(period, closingDay),
  };
}

/** ¿La fecha cae en la ventana del período? */
export function isInPeriodWindow(
  date: CalendarDate,
  period: StatementPeriod,
  closingDay: number,
): boolean {
  const window = periodWindow(period, closingDay);
  return date > window.after && date <= window.through;
}

/** El último período que YA cerró: cierra hoy cuenta como cerrado. */
export function lastClosedPeriod(
  today: CalendarDate,
  closingDay: number,
): StatementPeriod {
  const current = statementPeriodOf(today, closingDay);
  return closingDateOf(current, closingDay) <= today
    ? current
    : addMonthsToPeriod(current, -1);
}

/** ¿El período ya cerró a la fecha `today`? */
export function isPeriodClosed(
  period: StatementPeriod,
  today: CalendarDate,
  closingDay: number,
): boolean {
  return closingDateOf(period, closingDay) <= today;
}

/** Hasta cuántas cuotas puede pedirse una compra (la API lo valida con esto). */
export const CARD_PLAN_MAX_INSTALLMENTS = 120;

/**
 * Reparte un total en N cuotas: iguales, truncadas al centavo, y la última
 * absorbe el resto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ TRUNCAR HACIA ABAJO (y no redondear)
 * ─────────────────────────────────────────────────────────────────────────────
 * Con las cuotas redondeadas "normalmente", la última puede quedar en CERO
 * (o negativa) cuando el total es chico: $0,06 en 4 cuotas daría 0,02/0,02/0,02/0,00.
 * Truncando la base, la última es SIEMPRE mayor o igual que las demás:
 *
 *     base = floor(total ÷ N)        (en centavos)
 *     última = total − base × (N−1)
 *
 * Con `total ≥ N centavos` (lo valida el llamador), todas las cuotas son ≥ $0,01
 * y la suma da EL TOTAL EXACTO, al centavo. Esa igualdad es una invariante del
 * modelo: `Σ CardPlanItem.amount == CardPlan.totalAmount`.
 *
 * @throws Error si `installments` no es un entero ≥ 1, si el total no es
 *         positivo, o si no alcanza para cuotas de al menos un centavo.
 */
export function installmentAmounts(
  totalInput: Money | string,
  installments: number,
): Money[] {
  const total = typeof totalInput === "string" ? money(totalInput) : totalInput;

  if (!Number.isInteger(installments) || installments < 1) {
    throw new Error("La cantidad de cuotas tiene que ser un entero mayor a cero.");
  }
  if (total.lessThanOrEqualTo(0)) {
    throw new Error("El total del plan tiene que ser mayor a cero.");
  }
  if (total.lessThan(money("0.01").times(installments))) {
    throw new Error(
      "El total no alcanza para esa cantidad de cuotas: cada cuota tiene que ser de al menos un centavo.",
    );
  }

  // Base = floor(total ÷ N) en centavos. Se divide ANTES de truncar: truncar el
  // total×100 daría el total mismo y la última cuota quedaría negativa.
  const base = total
    .times(100)
    .dividedBy(installments)
    .floor()
    .dividedBy(100);
  const last = total.minus(base.times(installments - 1));

  return Array.from({ length: installments }, (_, index) =>
    index === installments - 1 ? last : base,
  );
}

/**
 * Porcentaje del total que es el pago mínimo de un resumen.
 *
 * 5% es la convención más difundida de los resúmenes argentinos: el banco
 * publica el mínimo como un porcentaje del saldo del resumen, y 5 es el número
 * que la persona ve impreso. Se guarda como constante para que la fórmula no
 * tenga un número mágico escondido en el medio del cálculo.
 */
export const STATEMENT_MINIMUM_PERCENT = 5;

/**
 * El pago mínimo de un resumen: 5% del total, redondeado HACIA ARRIBA al
 * centavo, y nunca más que el total.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES DECISIONES DE LA FÓRMULA (y sus alternativas)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **5% del total.** La alternativa (mínimo = total ÷ 12, "una cuota más")
 *    no es lo que el banco publica: el mínimo es un porcentaje, y el porcentaje
 *    es lo que la persona puede cotejar contra su resumen en papel.
 *    LIMITACIÓN DECLARADA: un resumen real también incluye en el mínimo las
 *    sumas no financiadas (impuestos y cargos, p. ej. el impuesto de sellos).
 *    Este modelo no tiene esos rubros como datos separados, así que el mínimo
 *    se calcula sobre el TOTAL del período — que los incluye (cuando existan
 *    como movimientos) pero sin tratarlos aparte.
 * 2. **Redondeo hacia arriba.** Un 5% de $0,10 es medio centavo: redondeado
 *    "normal" daría $0,00, y un mínimo de cero con deuda no significa nada. Se
 *    redondea a favor del único redondeo defendible: nunca menos del 5%, y
 *    nunca cero mientras haya deuda.
 * 3. **Tope en el total.** El mínimo no puede superar lo que debés: un resumen
 *    de $0,03 tiene un 5% de $0,01 (redondeo hacia arriba), no más.
 *
 * Es una función PURA: los tests fijan el borde del centavo sin tocar la base.
 */
export function minimumPayment(totalDueInput: Money | string): Money {
  const total =
    typeof totalDueInput === "string" ? money(totalDueInput) : totalDueInput;

  if (total.lessThanOrEqualTo(0)) return zero();

  const raw = total.times(STATEMENT_MINIMUM_PERCENT).dividedBy(100);
  const roundedUp = raw.times(100).ceil().dividedBy(100);

  return roundedUp.greaterThan(total) ? total : roundedUp;
}

/**
 * Utilización del límite: `deuda / límite × 100`, o `null` si no hay límite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS DOS CASOS QUE NO SON UN PORCENTAJE
 * ─────────────────────────────────────────────────────────────────────────────
 * · Sin `creditLimit` no se puede calcular. Devuelve `null` — "no se sabe" —
 *   y jamás un 0% inventado: un 0% se lee "no usás la tarjeta", que es lo
 *   contrario de "no cargaste el límite".
 * · Una tarjeta a favor (pagaste de más, saldo positivo) usa 0% del límite. Un
 *   porcentaje negativo ("−12% del límite") no existe en ningún resumen.
 */
export function utilizationPercent(
  debtInput: Money | string,
  limitInput: Money | string | null,
): Money | null {
  if (limitInput === null) return null;

  const limit = typeof limitInput === "string" ? money(limitInput) : limitInput;
  if (limit.lessThanOrEqualTo(0)) return null;

  const debt = typeof debtInput === "string" ? money(debtInput) : debtInput;
  if (debt.lessThanOrEqualTo(0)) return zero();

  return round(debt.dividedBy(limit).times(100));
}

/** Una cuota con su período, lo mínimo que necesita el agregador de abajo. */
export interface CommitmentItemLike {
  periodYear: number;
  periodMonth: number;
  amount: Money | string;
}

/** La ventana de compromisos: un monto por mes, más el total. */
export interface Commitments {
  /** Mes por mes, empezando en el período `from` (inclusive). */
  months: { year: number; month: number; amount: Money }[];
  /** Σ de todos los meses de la ventana. */
  total: Money;
}

/**
 * Cuotas comprometidas de los próximos `months` períodos, desde `from`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DEFINICIÓN EXACTA DE "PRÓXIMOS 6/12 MESES" (y qué queda afuera)
 * ─────────────────────────────────────────────────────────────────────────────
 * La ventana arranca en el período QUE CONTIENE HOY (el de las compras de hoy,
 * cierre mediante) y avanza N meses. Las cuotas de períodos ya cerrados quedan
 * afuera: ya no son un compromiso FUTURO, son un resumen emitido — y los
 * resúmenes emitidos se ven en la lista de resúmenes, con su total y su
 * vencimiento. Separarlos es lo que permite que este número conteste la
 * pregunta que promete contestar ("¿qué me va a llegar?") sin mezclarla con
 * "¿qué me quedó sin pagar?".
 *
 * Las cuotas de resúmenes YA PAGADOS tampoco cuentan: ya no las vas a pagar.
 * `paidPeriods` trae las claves `"AAAA-MM"` de los resúmenes pagados, y las
 * cuotas cuyo período cae en una de esas claves se saltean. Es el único ajuste
 * que depende del estado de la base, y por eso entra como parámetro: la función
 * sigue siendo pura.
 */
export function commitmentsFromItems(
  items: readonly CommitmentItemLike[],
  from: StatementPeriod,
  months: number,
  paidPeriods: ReadonlySet<string> = new Set(),
): Commitments {
  const buckets = Array.from({ length: months }, (_, index) => {
    const period = addMonthsToPeriod(from, index);
    return { year: period.year, month: period.month, amount: zero() };
  });

  const indexByKey = new Map(
    buckets.map((bucket, index) => [periodKey(bucket), index]),
  );

  for (const item of items) {
    const key = periodKey({ year: item.periodYear, month: item.periodMonth });
    if (paidPeriods.has(key)) continue;

    const index = indexByKey.get(key);
    if (index === undefined) continue; // fuera de la ventana: no es "próximo"

    const bucket = buckets[index];
    bucket.amount = bucket.amount.plus(
      typeof item.amount === "string" ? money(item.amount) : item.amount,
    );
  }

  return {
    months: buckets,
    total: buckets.reduce((total, bucket) => total.plus(bucket.amount), zero()),
  };
}

/** Etiqueta del período para mostrar: "octubre de 2026". */
export function cardPeriodLabel(period: StatementPeriod, locale = "es-AR"): string {
  // El día 1 existe en todos los meses: es la forma segura de armar la fecha
  // local sin caer en el parseo UTC de "YYYY-MM-DD".
  return new Date(period.year, period.month - 1, 1).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}
