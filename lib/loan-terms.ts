/**
 * Los términos de un préstamo cuando la persona NO sabe la tasa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL PEDIDO
 * ─────────────────────────────────────────────────────────────────────────────
 * "Para cargar un préstamo no tengas que poner el porcentaje, sino otra cosa
 * como lo que hay que pagar y la cantidad de cuotas: las personas no van a
 * ponerse a calcular el porcentaje".
 *
 * Nadie sabe calcular una TNA. Lo que la persona SÍ sabe es:
 *
 *   · cuánto va a pagar por mes (la cuota), o
 *   · cuánto va a devolver en total.
 *
 * Este módulo DERIVA la tasa de esos dos números, con la misma aritmética en
 * Decimal que usa el resto de la app (`lib/money.ts`) y los mismos sistemas de
 * amortización (`lib/loans.ts`). La tasa derivada se guarda en la columna que
 * YA existe (`Account.tnaPercent`): no hay migración.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA TASA SE CUANTIZA A LA GRILLA DE LA COLUMNA
 * ─────────────────────────────────────────────────────────────────────────────
 * `tnaPercent` es `Decimal(7,4)`: la tasa que se guarda tiene 4 decimales. La
 * tasa CONTINUA que sale de la bisección no se puede guardar (se perderían
 * decimales) y el cronograma se recalcula DESPUÉS con la tasa guardada. Si se
 * guardara la tasa continua, la cuota que la persona pidió y la que la app
 * cobraían diferirían en centavos.
 *
 * Por eso la tasa se cuantiza a la grilla (pasos de 0,0001 %) y después se
 * busca, EN ESA GRILLA, el punto que produce la cuota pedida. Es el mismo
 * patrón que usa `implicitFinancingRate` en `lib/money.ts`: bisecar sobre la
 * función continua y quedarse con un valor representable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL NÚMERO QUE SE DERIVA, POR SISTEMA
 * ─────────────────────────────────────────────────────────────────────────────
 * | Sistema         | Qué es "la cuota"                        | Cómo se deriva   |
 * |-----------------|------------------------------------------|------------------|
 * | FRENCH          | la cuota constante                        | bisección        |
 * | GERMAN          | la PRIMERA cuota (la más cara: la capital es fija) | bisección |
 * | AMERICAN        | el interés periódico (la última cuota suma el capital) | directo + grilla |
 * | INTEREST_ONLY   | el interés del mes                        | directo + grilla |
 * | IMPORTED        | no hay tasa: el cronograma lo da el banco | no aplica        |
 *
 * "Directo" quiere decir que la cuota ES el interés: `i = cuota / capital`, y
 * de ahí la TNA (`i × 1200`). No hace falta bisecionar: la ecuación es lineal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS BORDES (todos con mensaje, ninguno con excepción)
 * ─────────────────────────────────────────────────────────────────────────────
 * · **Cuota insuficiente**: con tasa 0 la cuota mínima es `capital / n`. Si la
 *   cuota pedida es menor, NO HAY SOLUCIÓN (ninguna tasa la produce): el error
 *   lo dice y muestra la cuota mínima.
 * · **Tasa 0**: es un préstamo sin interés y es un caso real, no un error.
 * · **Cuota o total <= 0**: 4xx con mensaje.
 * · **Total < capital**: no se puede devolver menos de lo que te prestaron.
 */

import { Prisma } from "@prisma/client";
import { installmentAmounts } from "./cards";
import {
  type AmortizationSystem,
  loanScheduleFor,
} from "./loans";
import {
  installmentPayment,
  installmentPaymentExact,
  money,
  parseMoneyInput,
  round,
  sum,
  zero,
  type Installment,
  type Money,
} from "./money";

/** La tasa más alta que se busca: 1000 % mensual. Nadie tiene una más alta. */
const MAX_MONTHLY_RATE = new Prisma.Decimal(10);

/** El paso de la grilla de la columna `tnaPercent` (4 decimales). */
const GRID_STEP = new Prisma.Decimal("0.0001");

/** Cuántos puntos de la grilla se revisan a cada lado del centro. */
const GRID_SCAN = 30;

/** Un error de dominio: son datos del pedido, no una falla del servidor. */
export class LoanTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanTermsError";
  }
}

/** Los tres modos de carga: el discriminante EXPLÍCITO del contrato. */
export type LoanInputMode = "RATE" | "PAYMENT" | "TOTAL";

/** `true` si el string es un modo válido. Para validar cuerpos de la API. */
export function isLoanInputMode(value: unknown): value is LoanInputMode {
  return (
    typeof value === "string" &&
    (["RATE", "PAYMENT", "TOTAL"] as readonly string[]).includes(value)
  );
}

/**
 * La FORMA que puede tener un monto en el pedido: un string o un número.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY QUE MIRAR LA FORMA Y NO SOLO EL VALOR
 * ─────────────────────────────────────────────────────────────────────────────
 * `String(["56412.71"])` es `"56412.71"`: un array con UN número adentro pasa
 * el parseo como si fuera el número escrito. Lo mismo con un objeto que tenga
 * un `toString` útil. Un cuerpo con la forma equivocada tiene que ser un 400
 * —«no te creo nada»— y no un «sí, te creo»: un dato con la forma rara es
 * siempre un cliente roto (o alguien tratando de romperlo), nunca una
 * persona que escribe un número.
 *
 * Y los caracteres de CONTROL (NUL, salto de línea, tabulador) no son de un
 * número escrito por una persona: si vienen, el cuerpo está corrupto y hay
 * que decirlo, no descartarlos en silencio y leer el resto.
 */
export function esFormaDeMonto(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * El cuerpo tiene que traer SÓLO el dato de su modo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ
 * ─────────────────────────────────────────────────────────────────────────────
 * El modo es explícito porque la API NO puede adivinar si un número es la
 * cuota o el total. Si el cuerpo trae los DOS, la API elegiría uno y
 * descartaría el otro en silencio: la persona vería un número que nadie usó
 * y el otro se perdería sin avisar. Lo mismo pasa con la tasa y la cuota.
 *
 * La respuesta honesta es un 400 que dice qué está mal: el cuerpo dice dos
 * cosas y una de las dos se va a perder.
 */
export function assertUnSoloDatoDelModo(
  mode: LoanInputMode,
  data: {
    tnaPercent?: unknown;
    payment?: unknown;
    total?: unknown;
  },
): void {
  const presentes: string[] = [];
  const tiene = (value: unknown) =>
    value !== undefined && value !== null && value !== "";

  if (tiene(data.tnaPercent)) presentes.push("la tasa (TNA)");
  if (tiene(data.payment)) presentes.push("la cuota");
  if (tiene(data.total)) presentes.push("el total a devolver");

  if (presentes.length > 1) {
    throw new LoanTermsError(
      `El cuerpo trae más de un dato (${presentes.join(" y ")}): con el modo ${mode} se manda sólo uno. ` +
        "Mandá el que corresponda y el otro se pierde.",
    );
  }
}

export interface LoanTermsInput {
  system: AmortizationSystem;
  principal: Money | string;
  installmentCount: number;
  mode: LoanInputMode;
  /** Sólo en modo RATE: la tasa que ya se conoce. */
  tnaPercent?: Money | string | null;
  /** Sólo en modo PAYMENT: la cuota mensual que se va a pagar. */
  payment?: Money | string | null;
  /** Sólo en modo TOTAL: lo que se va a devolver en total. */
  total?: Money | string | null;
}

export interface LoanTerms {
  mode: LoanInputMode;
  system: AmortizationSystem;
  /** La tasa (TNA %) que se guarda: la derivada o la que vino. */
  tnaPercent: Money;
  /** La cuota: el pago de la primera cuota, como en el resumen. */
  payment: Money;
  /** Lo que se paga en total, cuotas de por medio. */
  totalPaid: Money;
  /** La parte que es COSTO REAL (la se queda el banco). */
  totalInterest: Money;
  /** El capital devuelto (vuelve a vos: no es costo). */
  totalPrincipal: Money;
  /** De cada 100 pesos pagados, cuántos son del banco. */
  interestSharePercent: Money;
  /** El cronograma completo. */
  schedule: Installment[];
  /** La cuota mínima: el capital repartido en n cuotas (tasa 0). */
  minimumPayment: Money;
  /**
   * `true` si la cuota (o el total) pedido se reproduce EXACTAMENTE con la
   * tasa derivada. Si es `false`, la grilla de 4 decimales no alcanza para
   * clavar el número pedido y el cronograma usa el valor más cercano.
   */
  exact: boolean;
}

function toMoney(value: Money | string): Money {
  return typeof value === "string" ? money(value) : value;
}

/* ────────────────────────────────────────────────────────────────────────────
 * La lectura del pedido (el discriminante explícito)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lo que viaja en el pedido, sin validar. */
export interface LoanTermsRawRequest {
  mode?: unknown;
  principal?: unknown;
  installmentCount?: unknown;
  tnaPercent?: unknown;
  payment?: unknown;
  total?: unknown;
}

/** Lo que viaja en el pedido, ya validado. */
export interface LoanTermsRequest {
  mode: LoanInputMode;
  principal: Money;
  installmentCount: number;
  tnaPercent: Money | null;
  payment: Money | null;
  total: Money | null;
}

/**
 * Lee el discriminante del pedido.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL MODO ES EXPLÍCITO Y NO SE ADIVINA
 * ─────────────────────────────────────────────────────────────────────────────
 * "Un número puede ser cuota o total": con el mismo 50.000, uno es lo que
 * pagás por mes y el otro es lo que devolvés en total. La API NO puede
 * deducirlo (probar las dos y quedarse con una sería inventar datos), así que
 * el modo viaja explícito: `RATE` | `PAYMENT` | `TOTAL`.
 *
 * Si no viene modo, es `RATE`: es el modo de siempre y el que usan los flows
 * que ya existen.
 */
export function parseLoanTermsRequest(
  raw: LoanTermsRawRequest,
): LoanTermsRequest {
  const modoCrudo = raw.mode;
  const mode: LoanInputMode =
    modoCrudo === undefined || modoCrudo === null || modoCrudo === ""
      ? "RATE"
      : isLoanInputMode(modoCrudo)
        ? modoCrudo
        : (() => {
            throw new LoanTermsError(
              "El modo de carga tiene que ser RATE (la tasa), PAYMENT (la cuota) o TOTAL (lo que devolvés en total).",
            );
          })();

  if (!esFormaDeMonto(raw.principal)) {
    throw new LoanTermsError("El monto del préstamo no se entiende como un número.");
  }
  const principalRaw = parseMoneyInput(
    typeof raw.principal === "string" ? raw.principal : String(raw.principal ?? ""),
  );
  if (principalRaw === null) {
    throw new LoanTermsError("El monto del préstamo no se entiende como un número.");
  }
  if (principalRaw.lessThanOrEqualTo(0)) {
    throw new LoanTermsError("El monto del préstamo tiene que ser mayor a cero.");
  }

  // Un cuerpo con los dos datos (la cuota Y el total) es ambiguo: la API
  // elegiría uno y descartaría el otro en silencio.
  assertUnSoloDatoDelModo(mode, raw);

  const countRaw = raw.installmentCount;
  const countNumber =
    typeof countRaw === "number"
      ? countRaw
      : typeof countRaw === "string" && /^\d+$/.test(countRaw.trim())
        ? Number(countRaw.trim())
        : Number.NaN;
  if (!Number.isInteger(countNumber) || countNumber < 1 || countNumber > 600) {
    throw new LoanTermsError(
      "La cantidad de cuotas tiene que ser un entero entre 1 y 600.",
    );
  }

  const monto = (value: unknown): Money | null => {
    if (value === undefined || value === null || value === "") return null;
    if (!esFormaDeMonto(value)) {
      throw new LoanTermsError(
        "Uno de los montos del préstamo no se entiende como un número.",
      );
    }
    const parsed = parseMoneyInput(
      typeof value === "string" ? value : String(value),
    );
    if (parsed === null) {
      throw new LoanTermsError("Uno de los montos del préstamo no se entiende como un número.");
    }
    return parsed;
  };

  const tnaPercent = monto(raw.tnaPercent);
  const payment = monto(raw.payment);
  const total = monto(raw.total);

  if (mode === "RATE") {
    if (tnaPercent === null) {
      throw new LoanTermsError("Falta la tasa (TNA).");
    }
    if (tnaPercent.isNegative()) {
      throw new LoanTermsError("La tasa (TNA) no puede ser negativa.");
    }
  } else if (mode === "PAYMENT") {
    if (payment === null) {
      throw new LoanTermsError("Falta la cuota que vas a pagar.");
    }
    if (payment.lessThanOrEqualTo(0)) {
      throw new LoanTermsError("La cuota tiene que ser un monto mayor a cero.");
    }
  } else {
    if (total === null) {
      throw new LoanTermsError("Falta el total que vas a devolver.");
    }
    if (total.lessThanOrEqualTo(0)) {
      throw new LoanTermsError("El total a devolver tiene que ser un monto mayor a cero.");
    }
  }

  return {
    mode,
    principal: principalRaw,
    installmentCount: countNumber,
    tnaPercent,
    payment,
    total,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * El pago según el sistema
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * El pago CONTINUO (sin redondear) que produce una tasa mensual.
 *
 * Es la función que se biseca: tiene que ser suave y monótona, así que no
 * puede ser la que redondea a centavos (esa es una función escalonada y la
 * bisección sobre un escalón no converge a nada útil).
 */
function exactPaymentAtRate(
  system: AmortizationSystem,
  principal: Money,
  monthlyRate: Money,
  installmentCount: number,
): Money {
  switch (system) {
    case "FRENCH":
      // La cuota constante del francés, sin redondear.
      return installmentPaymentExact(principal, monthlyRate.times(1200), installmentCount);
    case "GERMAN": {
      // Capital constante: la primera cuota es el capital que se amortiza más
      // el interés del saldo inicial.
      const capital = installmentAmounts(principal, installmentCount)[0];
      return capital.plus(principal.times(monthlyRate));
    }
    case "AMERICAN":
      // Con una sola cuota se paga el capital entero: la cuota es P + interés.
      return installmentCount === 1
        ? principal.times(monthlyRate.plus(1))
        : principal.times(monthlyRate);
    case "INTEREST_ONLY":
      return principal.times(monthlyRate);
    case "IMPORTED":
      throw new LoanTermsError(
        "El sistema importado no tiene tasa: su cronograma lo da el banco.",
      );
  }
}

/**
 * El pago REAL (con el redondeo a centavos del cronograma) que produce una
 * tasa. Es el número que la persona va a ver y a pagar.
 */
function paymentAtRate(
  system: AmortizationSystem,
  principal: Money,
  tnaPercent: Money,
  installmentCount: number,
): Money {
  switch (system) {
    case "FRENCH":
      return installmentPayment(principal, tnaPercent, installmentCount);
    case "GERMAN": {
      const capital = installmentAmounts(principal, installmentCount)[0];
      return capital.plus(round(principal.times(tnaPercent.dividedBy(1200))));
    }
    case "AMERICAN":
      return round(principal.times(tnaPercent.dividedBy(1200)));
    case "INTEREST_ONLY":
      return round(principal.times(tnaPercent.dividedBy(1200)));
    case "IMPORTED":
      throw new LoanTermsError(
        "El sistema importado no tiene tasa: su cronograma lo da el banco.",
      );
  }
}

/**
 * La cuota MÍNIMA de un préstamo: el capital repartido en `n` cuotas (tasa 0).
 *
 * Es el número que se le muestra a la persona cuando su cuota no alcanza:
 * "esa cuota no alcanza para cubrir el capital; la mínima es $X".
 */
export function minimumLoanPayment(
  principal: Money | string,
  installmentCount: number,
): Money {
  const p = toMoney(principal);
  if (!Number.isInteger(installmentCount) || installmentCount < 1) {
    throw new LoanTermsError(
      "La cantidad de cuotas tiene que ser un entero entre 1 y 600.",
    );
  }
  return round(p.dividedBy(installmentCount));
}

/* ────────────────────────────────────────────────────────────────────────────
 * La bisección
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La tasa mensual continua que produce una cuota.
 *
 * La cuota es monótona CRECIENTE en la tasa (más tasa, más cuota): eso es lo
 * que hace posible invertirla con bisección. Es el mismo patrón que usa
 * `implicitFinancingRate` de `lib/money.ts` (el de la TEA implícita de las
 * cuotas de tarjeta), con la función invertida.
 */
function bisectMonthlyRate(
  system: AmortizationSystem,
  principal: Money,
  installmentCount: number,
  target: Money,
): Money {
  let low = zero();
  let high = new Prisma.Decimal(1);

  while (
    exactPaymentAtRate(system, principal, high, installmentCount).lessThan(target)
  ) {
    high = high.times(2);
    if (high.greaterThan(MAX_MONTHLY_RATE)) {
      throw new LoanTermsError(
        "Esa cuota es tan alta que ninguna tasa la produce: revisá el monto o la cantidad de cuotas.",
      );
    }
  }

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const mid = low.plus(high).dividedBy(2);
    if (
      exactPaymentAtRate(system, principal, mid, installmentCount).lessThan(target)
    ) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low.plus(high).dividedBy(2);
}

/**
 * El mejor punto de la GRILLA alrededor de una tasa continua.
 *
 * La grilla es la de la columna (`0,0001 %`). Se revisan los puntos de a lado
 * y se elige el que produce el pago pedido; si ninguno lo clava, el más
 * cercano (y `exact` queda en `false`, para que la interfaz lo diga).
 */
function bestGridRate(
  system: AmortizationSystem,
  principal: Money,
  installmentCount: number,
  centerTna: Money,
  target: Money,
  measure: (tna: Money) => Money,
): { tna: Money; value: Money; exact: boolean } {
  const base = centerTna.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_EVEN);
  let best: { tna: Money; value: Money; diff: Money } | null = null;
  let firstError: Error | null = null;

  for (let step = -GRID_SCAN; step <= GRID_SCAN; step += 1) {
    const candidate = base.plus(GRID_STEP.times(step));
    if (candidate.isNegative()) continue;

    let value: Money;
    try {
      value = measure(candidate);
    } catch (error) {
      // Una tasa que no produce un cronograma válido (el americano con tasa 0,
      // por ejemplo) no es candidata: se sigue buscando.
      if (!firstError && error instanceof Error) firstError = error;
      continue;
    }

    const diff = value.minus(target).abs();
    if (diff.isZero()) {
      return { tna: candidate, value, exact: true };
    }
    if (best === null || diff.lessThan(best.diff)) {
      best = { tna: candidate, value, diff };
    }
  }

  if (best === null) {
    throw new LoanTermsError(
      firstError?.message ??
        "No hay ninguna tasa que sirva para esos datos: revisá el monto y la cantidad de cuotas.",
    );
  }

  return { tna: best.tna, value: best.value, exact: false };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Los tres modos
 * ──────────────────────────────────────────────────────────────────────────── */

/** La tasa que ya se conoce (modo RATE). */
function rateFromGivenTna(tnaPercent: Money | string | null | undefined): Money {
  if (tnaPercent === null || tnaPercent === undefined) {
    throw new LoanTermsError("Falta la tasa (TNA).");
  }
  const tna = toMoney(tnaPercent);
  if (tna.isNegative()) {
    throw new LoanTermsError("La tasa (TNA) no puede ser negativa.");
  }
  // A 4 decimales: es lo que se guarda (`tnaPercent` es `Decimal(7,4)`) y lo
  // que usa el cronograma del alta. Cuantizar ACÁ (y no sólo en el llamador)
  // es lo que hace que la vista previa y el alta no puedan divergir.
  return tna.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_EVEN);
}

/**
 * La tasa que produce una cuota (modo PAYMENT).
 *
 * · Si la cuota es menor que `capital / n` NO HAY SOLUCIÓN: ninguna tasa (ni
 *   siquiera negativa) produce una cuota menor que la del capital repartido.
 *   El error lo dice y muestra la cuota mínima.
 * · Si la cuota es EXACTAMENTE la mínima, la tasa es 0 (préstamo sin interés:
 *     un caso real, no un error).
 */
function rateFromPayment(
  system: AmortizationSystem,
  principal: Money,
  installmentCount: number,
  payment: Money,
): { tna: Money; exact: boolean } {
  if (payment.lessThanOrEqualTo(0)) {
    throw new LoanTermsError("La cuota tiene que ser un monto mayor a cero.");
  }

  const minimum = minimumLoanPayment(principal, installmentCount);

  // En el americano y el solo interés la cuota es el interés: no hay mínimo
  // estructural (cualquier cuota positiva sirve), así que el caso de la cuota
  // insuficiente no aplica.
  const tieneMinimo =
    system === "FRENCH" || system === "GERMAN";

  if (tieneMinimo && payment.lessThan(minimum)) {
    throw new LoanTermsError(
      `Esa cuota no alcanza para cubrir el capital: con ${installmentCount} cuotas la mínima es ${minimum.toFixed(2)} (el capital repartido, sin interés).`,
    );
  }

  if (tieneMinimo && payment.equals(minimum)) {
    // Préstamo sin interés: la cuota mínima ES la cuota.
    return { tna: zero(), exact: true };
  }

  // Los sistemas con interés directo: la cuota ES el interés.
  if (system === "AMERICAN" || system === "INTEREST_ONLY") {
    const monthlyRate = payment.dividedBy(principal);
    const centerTna = monthlyRate.times(1200);
    const found = bestGridRate(
      system,
      principal,
      installmentCount,
      centerTna,
      payment,
      (tna) => paymentAtRate(system, principal, tna, installmentCount),
    );
    return { tna: found.tna, exact: found.exact };
  }

  const monthlyRate = bisectMonthlyRate(
    system,
    principal,
    installmentCount,
    payment,
  );
  const found = bestGridRate(
    system,
    principal,
    installmentCount,
    monthlyRate.times(1200),
    payment,
    (tna) => paymentAtRate(system, principal, tna, installmentCount),
  );
  return { tna: found.tna, exact: found.exact };
}

/**
 * La tasa que produce un total (modo TOTAL).
 *
 * El total manda: de él sale la cuota equivalente (`total / n`) y de la cuota
 * la tasa. Después se busca, en la grilla, el punto cuyo TOTAL REAL sea el
 * pedido (el redondeo de las cuotas puede corrimiento el total en centavos).
 */
function rateFromTotal(
  system: AmortizationSystem,
  principal: Money,
  installmentCount: number,
  total: Money,
): { tna: Money; exact: boolean } {
  if (total.lessThanOrEqualTo(0)) {
    throw new LoanTermsError("El total a devolver tiene que ser un monto mayor a cero.");
  }
  if (total.lessThan(principal)) {
    throw new LoanTermsError(
      `El total a devolver (${total.toFixed(2)}) no puede ser menor que el capital (${principal.toFixed(2)}): no se puede devolver menos de lo que te prestaron.`,
    );
  }

  // El americano y el solo interés suman el capital al final (o nunca): el
  // total incluye el capital, así que la cuota es (total − capital) / n.
  const cuotaDe =
    system === "AMERICAN"
      ? total.minus(principal).dividedBy(installmentCount)
      : total.dividedBy(installmentCount);

  const cuota = round(cuotaDe);
  if (cuota.lessThanOrEqualTo(0)) {
    throw new LoanTermsError(
      "El total a devolver no alcanza para una cuota de al menos un centavo.",
    );
  }

  const { tna: center } = rateFromPayment(
    system,
    principal,
    installmentCount,
    cuota,
  );

  // El total REAL del cronograma (con el redondeo de cada cuota) es lo que se
  // compara con el pedido: el total escrito puede caer entre dos puntos de la
  // grilla, y el que se elige es el que más se acerca.
  const found = bestGridRate(
    system,
    principal,
    installmentCount,
    center,
    total,
    (tna) => {
      const schedule = loanScheduleFor({
        system,
        principal,
        tnaPercent: tna,
        installmentCount,
      });
      return sum(schedule.map((installment) => installment.payment));
    },
  );

  return { tna: found.tna, exact: found.exact };
}

/* ────────────────────────────────────────────────────────────────────────────
 * El resumen
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resuelve los términos de un préstamo: de lo que la persona sabe (la cuota
 * o el total) a la tasa que se guarda, con su cronograma.
 *
 * @throws LoanTermsError con un mensaje para la persona si los datos no
 *         describen un préstamo posible (cuota insuficiente, total menor que
 *         el capital, números imposibles).
 */
export function resolveLoanTerms(input: LoanTermsInput): LoanTerms {
  const principal = toMoney(input.principal);
  const installmentCount = input.installmentCount;

  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 600) {
    throw new LoanTermsError(
      "La cantidad de cuotas tiene que ser un entero entre 1 y 600.",
    );
  }
  if (principal.lessThanOrEqualTo(0)) {
    throw new LoanTermsError("El monto del préstamo tiene que ser mayor a cero.");
  }
  if (input.system === "IMPORTED") {
    throw new LoanTermsError(
      "El sistema importado no tiene tasa: su cronograma lo da el banco.",
    );
  }

  let tna: Money;
  let exact = true;

  switch (input.mode) {
    case "RATE": {
      tna = rateFromGivenTna(input.tnaPercent);
      break;
    }
    case "PAYMENT": {
      if (input.payment === null || input.payment === undefined) {
        throw new LoanTermsError("Falta la cuota que vas a pagar.");
      }
      const derived = rateFromPayment(
        input.system,
        principal,
        installmentCount,
        toMoney(input.payment),
      );
      tna = derived.tna;
      exact = derived.exact;
      break;
    }
    case "TOTAL": {
      if (input.total === null || input.total === undefined) {
        throw new LoanTermsError("Falta el total que vas a devolver.");
      }
      const derived = rateFromTotal(
        input.system,
        principal,
        installmentCount,
        toMoney(input.total),
      );
      tna = derived.tna;
      exact = derived.exact;
      break;
    }
  }

  const schedule = loanScheduleFor({
    system: input.system,
    principal,
    tnaPercent: tna,
    installmentCount,
  });

  const totalPaid = sum(schedule.map((installment) => installment.payment));
  const totalInterest = sum(schedule.map((installment) => installment.interest));
  const totalPrincipal = sum(schedule.map((installment) => installment.principal));
  const interestSharePercent = totalPaid.isZero()
    ? zero()
    : round(totalInterest.dividedBy(totalPaid).times(100));

  return {
    mode: input.mode,
    system: input.system,
    tnaPercent: tna,
    payment: schedule[0]?.payment ?? zero(),
    totalPaid,
    totalInterest,
    totalPrincipal,
    interestSharePercent,
    schedule,
    minimumPayment: minimumLoanPayment(principal, installmentCount),
    exact,
  };
}
