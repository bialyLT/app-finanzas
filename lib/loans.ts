/**
 * Reglas PURAS de los préstamos: sistemas de amortización, dirección, serie de
 * vencimientos, progreso y compromisos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO EXISTE (y por qué es puro)
 * ─────────────────────────────────────────────────────────────────────────────
 * Un préstamo se puede describir con cuatro números (capital, tasa, cantidad de
 * cuotas y primera fecha) y una decisión: el SISTEMA con el que se devuelve el
 * capital. Todo lo demás —qué paga cada cuota, cuándo vence, cuánto interés
 * queda— se deriva de ahí. Igual que `lib/cards.ts` con las tarjetas, esas
 * cuentas viven acá, sin Prisma, sin reloj y sin red: el "hoy" entra siempre
 * como parámetro y los tests pueden fijar cualquier fecha.
 *
 * El motor del SISTEMA FRANCÉS no se reimplementa: vive en `lib/money.ts`
 * (`amortizationSchedule`) desde la Fase 2 y está verificado contra los números
 * del §3.2. Este módulo lo orquesta junto con los otros sistemas para que la
 * vista previa, el alta, la vista de préstamos y el reporte de deudas usen
 * TODOS la misma función — y no puedan divergir en silencio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS CINCO SISTEMAS, EN UNA FRASE CADA UNO
 * ─────────────────────────────────────────────────────────────────────────────
 *   · FRENCH        → cuota constante: pagás lo mismo todos los meses y cambia
 *                     la composición (al principio interés, al final capital).
 *                     Es el que usan los bancos argentinos para personales e
 *                     hipotecarios. `Σ capital = principal`, cierra a 0.
 *   · GERMAN        → CAPITAL constante: cada cuota amortiza lo mismo y el pago
 *                     total baja mes a mes porque el interés se calcula sobre el
 *                     saldo que queda. `Σ capital = principal`, cierra a 0.
 *   · AMERICAN      → interés periódico y capital AL VENCIMIENTO: las primeras
 *                     n−1 cuotas son sólo interés y la última es interés +
 *                     todo el capital (el "bullet"). Cierra a 0.
 *   · INTEREST_ONLY → ROTATIVO: todas las cuotas son sólo interés y el capital
 *                     nunca se amortiza por contrato. NO cierra a 0: es la
 *                     única excepción documentada a la invariante "cada sistema
 *                     cierra a 0", y es una decisión, no un olvido — un
 *                     rotativo que "cerrara" estaría mintiendo sobre la deuda.
 *   · IMPORTED      → el cronograma lo dicta el banco externo: acá sólo se
 *                     VALIDA y se materializa tal cual. No se recalcula nada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA RELACIÓN CONTRACT vs PROYECCIÓN (la invariante que no puede divergir)
 * ─────────────────────────────────────────────────────────────────────────────
 * El saldo de la cuenta ES la deuda viva (decisión de la Fase 2, no negociable).
 * El cronograma materializado (`Installment`) es el CONTRATO: lo que se pactó
 * pagar, cuota por cuota. Los movimientos reales pueden ir más rápido (un pago
 * extra) o más lento (un mes sin pagar) que el contrato, pero el contrato NO se
 * reescribe: se mide el progreso CONTRA él (`installmentsCoveredBy` camina el
 * cronograma con el capital realmente amortizado). Recalcular las cuotas
 * futuras ante cada pago extra reescribiría el pasado (la cuota 3 que ya pagaste
 * "cambiaría"), y regenerarlas dejaría dos versiones del mismo contrato. La
 * decisión documentada: el cronograma es inmutable; el avance se deriva de la
 * plata y se muestra como "cubriste N de M cuotas".
 */

import { addMonths, isCalendarDate, type CalendarDate } from "./dates";
import { installmentAmounts } from "./cards";
import {
  amortizationSchedule,
  loanProgress,
  money,
  monthlyRateFromTna,
  round,
  sum,
  zero,
  type Installment,
  type Money,
} from "./money";

/* ────────────────────────────────────────────────────────────────────────────
 * Tipos del contrato
 * ──────────────────────────────────────────────────────────────────────────── */

/** El sistema con el que se devuelve el capital. Ver la cabecera. */
export type AmortizationSystem =
  | "FRENCH"
  | "GERMAN"
  | "AMERICAN"
  | "INTEREST_ONLY"
  | "IMPORTED";

/** Todos los sistemas, en el orden en que se muestran. */
export const AMORTIZATION_SYSTEMS: readonly AmortizationSystem[] = [
  "FRENCH",
  "GERMAN",
  "AMERICAN",
  "INTEREST_ONLY",
  "IMPORTED",
] as const;

/** `true` si el string es un sistema válido. Para validar cuerpos de la API. */
export function isAmortizationSystem(value: unknown): value is AmortizationSystem {
  return (
    typeof value === "string" &&
    (AMORTIZATION_SYSTEMS as readonly string[]).includes(value)
  );
}

/** ¿El sistema amortiza capital hasta cero por contrato? */
export function closesToZero(system: AmortizationSystem): boolean {
  return system !== "INTEREST_ONLY";
}

/**
 * El sistema de una cuenta, con el fallback de los datos legados.
 *
 * `NULL` = la cuenta se creó antes de que existiera el campo (Fase 4): su
 * contrato es el francés, que era el único que había. No se escribe nada en la
 * base al leer: la conversión vive acá y en un solo lugar.
 */
export function systemOf(
  value: AmortizationSystem | null | undefined,
): AmortizationSystem {
  return value ?? "FRENCH";
}

/**
 * La dirección de un préstamo: quién le debe a quién.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES DERIVADA Y NO UNA COLUMNA
 * ─────────────────────────────────────────────────────────────────────────────
 * El `kind` de la cuenta YA dice la dirección: `LOAN` es un pasivo (yo debo) y
 * `RECEIVABLE` es un activo (me deben). Guardar además un campo `direction`
 * crearía dos fuentes de verdad que pueden contradecirse ("kind LOAN con
 * direction OWED_TO_ME": ¿cuál manda?). La dirección se DERIVA del kind, y esta
 * función pura es el único lugar donde se hace la traducción.
 */
export type LoanDirection = "I_OWE" | "OWED_TO_ME";

export function loanDirectionOf(kind: "LOAN" | "RECEIVABLE"): LoanDirection {
  return kind === "LOAN" ? "I_OWE" : "OWED_TO_ME";
}

/** Una cuota del cronograma, ya con su fecha. Lo que persiste `Installment`. */
export interface MaterializedInstallment extends Installment {
  dueDate: CalendarDate;
}

/** Una cuota externa del sistema IMPORTED, tal como la declara el banco. */
export interface ImportedInstallmentInput {
  dueDate: CalendarDate;
  payment: Money | string;
  interest: Money | string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Series de vencimientos
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La serie de vencimientos de un cronograma mensual: primera fecha + N meses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CLAMP ES CONTRA EL ANCLA, NO CONTRA LA FECHA ANTERIOR
 * ─────────────────────────────────────────────────────────────────────────────
 * `addMonths` se aplica SIEMPRE sobre la primera fecha (el ancla), no sobre el
 * resultado anterior: una primera cuota el 31 de enero da 28 de febrero y
 * DESPUÉS 31 de marzo. Clampear el resultado anterior dejaría la serie pegada al
 * 28 para siempre — el mismo criterio que `RecurrenceRule.dayOfMonth` y que los
 * resúmenes de tarjeta.
 */
export function dueDateSeries(
  first: CalendarDate,
  count: number,
): CalendarDate[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("La cantidad de cuotas tiene que ser un entero mayor a cero.");
  }
  return Array.from({ length: count }, (_, index) => addMonths(first, index));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Los sistemas de amortización
 * ──────────────────────────────────────────────────────────────────────────── */

function toMoney(value: Money | string): Money {
  return typeof value === "string" ? money(value) : value;
}

/**
 * Sistema ALEMÁN: capital constante por cuota.
 *
 *     capital_k   = floor(P ÷ n)  (en centavos; la última absorbe el resto)
 *     interés_k   = saldo_{k−1} × i
 *     pago_k      = capital_k + interés_k
 *
 * El pago BAJA mes a mes porque el interés se calcula sobre el saldo que queda,
 * y el saldo baja siempre en el mismo capital. Es el espejo del francés: acá lo
 * constante es el capital, allá el pago.
 *
 * El reparto del capital usa `installmentAmounts` (el mismo de los planes de
 * tarjeta): base truncada al centavo y última cuota que absorbe el resto. Eso
 * garantiza `Σ capital = P` exacto — la invariante de que cierra a 0.
 */
export function germanSchedule(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
): Installment[] {
  const p = toMoney(principal);
  const i = monthlyRateFromTna(tnaPercent);

  if (!Number.isInteger(installmentCount) || installmentCount < 1) {
    throw new Error("La cantidad de cuotas tiene que ser un entero mayor a cero.");
  }
  if (p.lessThanOrEqualTo(0)) {
    throw new Error("El monto del préstamo tiene que ser mayor a cero.");
  }

  const capitals = installmentAmounts(p, installmentCount);
  const installments: Installment[] = [];
  let balance = round(p);

  for (let number = 1; number <= installmentCount; number += 1) {
    const interest = round(balance.times(i));
    const principalPart = capitals[number - 1];

    balance = round(balance.minus(principalPart));

    installments.push({
      number,
      payment: round(principalPart.plus(interest)),
      interest,
      principal: principalPart,
      remainingBalance: balance,
    });
  }

  return installments;
}

/**
 * Sistema AMERICANO: interés periódico y todo el capital en la última cuota.
 *
 *     cuotas 1..n−1 → interés = P × i, capital = 0
 *     cuota n       → interés = P × i, capital = P
 *
 * Exige `i > 0` cuando hay más de una cuota: con tasa 0 las primeras cuotas
 * serían de CERO pesos, y una cuota de cero no es una cuota (la base la rechaza
 * con el CHECK `installment_payment_positive`; acá se rechaza antes y con
 * palabras). Con n = 1 la única cuota es P + interés y el caso no aplica.
 */
export function americanSchedule(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
): Installment[] {
  const p = toMoney(principal);
  const i = monthlyRateFromTna(tnaPercent);

  if (!Number.isInteger(installmentCount) || installmentCount < 1) {
    throw new Error("La cantidad de cuotas tiene que ser un entero mayor a cero.");
  }
  if (p.lessThanOrEqualTo(0)) {
    throw new Error("El monto del préstamo tiene que ser mayor a cero.");
  }
  if (installmentCount > 1 && i.isZero()) {
    throw new Error(
      "El sistema americano con tasa 0 dejaría cuotas de interés de $0,00: cargá una tasa mayor a cero o usá el sistema francés.",
    );
  }

  const interest = round(p.times(i));
  const installments: Installment[] = [];

  for (let number = 1; number <= installmentCount; number += 1) {
    const isLast = number === installmentCount;
    const principalPart = isLast ? round(p) : zero();

    installments.push({
      number,
      payment: round(principalPart.plus(interest)),
      interest,
      principal: principalPart,
      remainingBalance: isLast ? zero() : round(p),
    });
  }

  return installments;
}

/**
 * Sistema SOLO INTERÉS (rotativo): todas las cuotas son interés, el capital
 * nunca se amortiza por contrato.
 *
 * Es la única excepción a "cada sistema cierra a 0", y es deliberada: un
 * rotativo cuyo cronograma "cerrara" estaría declarando una amortización que
 * nadie pactó. El `remainingBalance` de cada cuota queda en el capital original
 * — constante, sin mentir.
 *
 * Exige `i > 0`: sin interés, un rotativo es un préstamo gratis para siempre, y
 * todas las cuotas serían de $0,00 (imposible en la base).
 */
export function interestOnlySchedule(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
): Installment[] {
  const p = toMoney(principal);
  const i = monthlyRateFromTna(tnaPercent);

  if (!Number.isInteger(installmentCount) || installmentCount < 1) {
    throw new Error("La cantidad de cuotas tiene que ser un entero mayor a cero.");
  }
  if (p.lessThanOrEqualTo(0)) {
    throw new Error("El monto del préstamo tiene que ser mayor a cero.");
  }
  if (i.isZero()) {
    throw new Error(
      "El sistema de solo interés con tasa 0 dejaría cuotas de $0,00: cargá una tasa mayor a cero.",
    );
  }

  const interest = round(p.times(i));

  return Array.from({ length: installmentCount }, (_, index) => ({
    number: index + 1,
    payment: interest,
    interest,
    principal: zero(),
    remainingBalance: round(p),
  }));
}

/**
 * Sistema IMPORTADO: el cronograma lo dicta el banco, acá sólo se valida.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE VALIDA (y qué NO se recalcula)
 * ─────────────────────────────────────────────────────────────────────────────
 * No se recalcula NADA: ni la tasa, ni la cuota, ni la composición. El banco
 * externo ya lo decidió. Lo que sí se exige es que el cronograma sea COHERENTE
 * consigo mismo y con el contrato:
 *
 *   1. Fechas ESTRICTAMENTE crecientes (dos cuotas el mismo día no existen).
 *   2. `interest ≥ 0` y `payment ≥ interest` → el capital de cada cuota
 *      (`payment − interest`) nunca es negativo: un pago que no cubre ni su
 *      propio interés sería una quita disfrazada.
 *   3. `payment > 0`: mismo criterio que la base.
 *   4. El saldo CAMINA sin caer bajo cero: `Σ capital` hasta cualquier punto
 *      ≤ principal. Un cronograma donde la cuota 3 ya devolvió más capital que
 *      el préstamo entero describe algo imposible.
 *   5. `Σ capital = principal` EXACTO al centavo: es la misma invariante que
 *      cumplen los sistemas calculados, y sin ella el "progreso del 100%" se
 *      mediría contra una vara que el cronograma no alcanza (o pasa).
 *
 * Las cuotas ya vencidas (fechas pasadas) se aceptan: el estado "pagada" no
 * vive en el cronograma —es el contrato— sino que se deriva de las
 * transferencias reales. Un cronograma importado de un préstamo a medio pagar
 * es un caso legítimo y esperado.
 *
 * @throws Error con mensaje en castellano (lo traduce a 400 el servicio) si el
 *         cronograma viola cualquiera de los cinco puntos.
 */
export function importedSchedule(
  items: readonly ImportedInstallmentInput[],
  principal: Money | string,
): Installment[] {
  const p = toMoney(principal);

  if (p.lessThanOrEqualTo(0)) {
    throw new Error("El monto del préstamo tiene que ser mayor a cero.");
  }
  if (items.length === 0) {
    throw new Error(
      "El cronograma importado necesita al menos una cuota: sin cuotas no hay contrato.",
    );
  }
  if (items.length > 600) {
    throw new Error("El cronograma importado no puede tener más de 600 cuotas.");
  }

  const installments: Installment[] = [];
  let balance = round(p);
  let previousDate: CalendarDate | null = null;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const number = index + 1;
    const label = `cuota ${number}`;

    if (!isCalendarDate(item.dueDate)) {
      throw new Error(`La fecha de la ${label} no es una fecha válida.`);
    }
    if (previousDate !== null && item.dueDate <= previousDate) {
      throw new Error(
        `Las fechas del cronograma importado tienen que ser estrictamente crecientes: la ${label} (${item.dueDate}) no es posterior a la anterior (${previousDate}).`,
      );
    }

    const payment = toMoney(item.payment);
    const interest = toMoney(item.interest);

    if (interest.isNegative()) {
      throw new Error(`El interés de la ${label} no puede ser negativo.`);
    }
    if (payment.lessThanOrEqualTo(0)) {
      throw new Error(`El pago de la ${label} tiene que ser mayor a cero.`);
    }
    if (payment.lessThan(interest)) {
      throw new Error(
        `El pago de la ${label} (${payment.toFixed(2)}) no cubre ni su propio interés (${interest.toFixed(2)}).`,
      );
    }

    const principalPart = payment.minus(interest);
    if (principalPart.greaterThan(balance)) {
      throw new Error(
        `El capital de la ${label} (${principalPart.toFixed(2)}) supera el saldo que queda (${balance.toFixed(2)}): el cronograma devuelve más que el préstamo.`,
      );
    }

    balance = round(balance.minus(principalPart));

    installments.push({
      number,
      payment: round(payment),
      interest: round(interest),
      principal: round(principalPart),
      remainingBalance: balance,
    });

    previousDate = item.dueDate;
  }

  const totalPrincipal = sum(installments.map((installment) => installment.principal));
  if (!totalPrincipal.equals(p)) {
    throw new Error(
      `El capital del cronograma importado (${totalPrincipal.toFixed(2)}) no coincide con el monto del préstamo (${p.toFixed(2)}): la diferencia es ${p.minus(totalPrincipal).toFixed(2)}.`,
    );
  }

  return installments;
}

/** El cronograma de un préstamo, sin fechas: sólo la aritmética del sistema. */
export interface LoanScheduleInput {
  system: AmortizationSystem;
  principal: Money | string;
  /** Obligatoria salvo en IMPORTED, donde la tasa la implica el cronograma. */
  tnaPercent: Money | string | null;
  installmentCount: number;
  /** Sólo para IMPORTED: el cronograma externo. */
  imported?: readonly ImportedInstallmentInput[];
}

/**
 * El cronograma de un préstamo según su sistema, con las invariantes
 * verificadas de una vez para todos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS VERIFICACIONES QUE NO SE PUEDEN DELEGAR A CADA FÓRMULA
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. **Todas las cuotas > 0.** Con capitales diminutos y tasas chicas la
 *      fórmula redondea a $0,00 (p. ej. $0,01 en 600 cuotas), y una cuota de
 *      cero no es una cuota: la base la rechazaría con un error de integridad
 *      que no explica nada. Acá se corta antes, con un mensaje que se entiende.
 *   2. **`Σ capital = principal` en los sistemas que cierran a 0.** Es la
 *      invariante que hace que el préstamo "termine de pagarse". En los
 *      calculados se cumple por construcción, pero verificarla acá —una vez,
 *      para todos— es lo que garantiza que un cambio futuro en una fórmula no
 *      rompa el contrato en silencio.
 *
 * INTEREST_ONLY queda afuera de la segunda a propósito (no amortiza: ver la
 * cabecera del sistema).
 *
 * @throws Error con mensaje en castellano cuando los números no describen un
 *         contrato posible.
 */
export function loanScheduleFor(input: LoanScheduleInput): Installment[] {
  const { system, installmentCount } = input;

  const schedule = ((): Installment[] => {
    switch (system) {
      case "FRENCH": {
        if (input.tnaPercent === null) {
          throw new Error("El sistema francés necesita la tasa (TNA).");
        }
        return amortizationSchedule(
          input.principal,
          input.tnaPercent,
          installmentCount,
        );
      }
      case "GERMAN": {
        if (input.tnaPercent === null) {
          throw new Error("El sistema alemán necesita la tasa (TNA).");
        }
        return germanSchedule(input.principal, input.tnaPercent, installmentCount);
      }
      case "AMERICAN": {
        if (input.tnaPercent === null) {
          throw new Error("El sistema americano necesita la tasa (TNA).");
        }
        return americanSchedule(input.principal, input.tnaPercent, installmentCount);
      }
      case "INTEREST_ONLY": {
        if (input.tnaPercent === null) {
          throw new Error("El sistema de solo interés necesita la tasa (TNA).");
        }
        return interestOnlySchedule(
          input.principal,
          input.tnaPercent,
          installmentCount,
        );
      }
      case "IMPORTED": {
        if (!input.imported || input.imported.length === 0) {
          throw new Error(
            "El sistema importado necesita el cronograma externo: cargá las cuotas tal como te las dio el banco.",
          );
        }
        return importedSchedule(input.imported, input.principal);
      }
    }
  })();

  for (const installment of schedule) {
    if (installment.payment.lessThanOrEqualTo(0)) {
      throw new Error(
        "El préstamo es demasiado chico para esa cantidad de cuotas: cada cuota tiene que ser de al menos un centavo. Subí el monto o bajá la cantidad de cuotas.",
      );
    }
  }

  if (closesToZero(system)) {
    const p = toMoney(input.principal);
    const totalPrincipal = sum(schedule.map((installment) => installment.principal));
    if (!totalPrincipal.equals(p)) {
      // Si esto se dispara, es un bug de una fórmula (los sistemas calculados
      // lo cumplen por construcción): un error interno, no una petición inválida.
      throw new Error(
        `Invariante rota del sistema ${system}: el cronograma amortiza ${totalPrincipal.toFixed(2)} sobre un principal de ${p.toFixed(2)}.`,
      );
    }
  }

  return schedule;
}

/**
 * Pega las fechas al cronograma: el paso que convierte la aritmética en filas
 * de `Installment`.
 *
 * Las fechas llegan de afuera y no se calculan acá: en los sistemas calculados
 * son la serie de `dueDateSeries`; en IMPORTED son las que declaró el banco.
 * Así la función es una sola y no sabe de sistemas.
 */
export function materializeSchedule(
  schedule: readonly Installment[],
  dueDates: readonly CalendarDate[],
): MaterializedInstallment[] {
  if (schedule.length !== dueDates.length) {
    throw new Error(
      "El cronograma y sus fechas no coinciden: es un error interno, no de los datos.",
    );
  }
  return schedule.map((installment, index) => ({
    ...installment,
    dueDate: dueDates[index],
  }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resumen (para la vista previa)
 * ──────────────────────────────────────────────────────────────────────────── */

/** El resumen de un cronograma calculado, con la misma forma que `loanSummary`. */
export interface LoanScheduleSummary {
  /** El pago de la PRIMERA cuota (en el americano es sólo interés). */
  payment: Money;
  totalPaid: Money;
  totalInterest: Money;
  totalPrincipal: Money;
  interestSharePercent: Money;
  principal: Money;
  schedule: Installment[];
}

/**
 * El resumen de un préstamo según su sistema: lo que realmente cuesta.
 *
 * Para el francés la forma es idéntica a `loanSummary` de `lib/money.ts` (esa
 * función es la del §3.2 y no se toca); para el resto se calcula con las mismas
 * definiciones —"total pagado", "costo real = interés"— sobre el cronograma del
 * sistema.
 */
export function loanSummaryFor(input: LoanScheduleInput): LoanScheduleSummary {
  const schedule = loanScheduleFor(input);
  const totalPaid = sum(schedule.map((installment) => installment.payment));
  const totalInterest = sum(schedule.map((installment) => installment.interest));
  const totalPrincipal = sum(schedule.map((installment) => installment.principal));
  const p = toMoney(input.principal);

  const interestShare = totalPaid.isZero()
    ? zero()
    : totalInterest.dividedBy(totalPaid).times(100);

  return {
    payment: schedule[0]?.payment ?? zero(),
    totalPaid,
    totalInterest,
    totalPrincipal,
    interestSharePercent: round(interestShare),
    principal: p,
    schedule,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Progreso
 * ──────────────────────────────────────────────────────────────────────────── */

/** El progreso de un préstamo contra su cronograma (interés pagado nullable). */
export interface LoanProgressView {
  /** El capital del contrato. */
  principal: Money;
  /** Capital amortizado/recuperado, clampeado a `[0, principal]`. */
  capitalPaid: Money;
  /** Cuotas cubiertas por el capital que consta. */
  installmentsCovered: number;
  /**
   * Σ del interés de las cuotas cubiertas. `null` en un rotativo: su interés se
   * paga como gasto y NO se puede derivar del saldo — inventar un número sería
   * peor que decir "no se sabe".
   */
  interestPaid: Money | null;
  remainingCount: number;
  progressPercent: Money;
}

/**
 * El progreso de un préstamo, con los casos sin amortización derivable
 * resueltos explícitamente (rotativo y americano).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ INTEREST_ONLY Y AMERICAN NO PUEDEN USAR EL CAMINADOR DEL CAPITAL
 * ─────────────────────────────────────────────────────────────────────────────
 * `installmentsCoveredBy` camina el cronograma acumulando capital y cuenta las
 * cuotas que quedan por debajo de lo pagado. Ese caminador asume que TODA cuota
 * amortiza: en los sistemas donde hay cuotas con capital 0 el acumulado no se
 * mueve en ellas y la cuenta las daría "cubiertas" gratis — cubiertas desde el
 * día uno, con su interés sumado a `interestPaid` sin que nadie lo haya pagado.
 *
 *   · INTEREST_ONLY: TODAS las cuotas tienen capital 0. La única lectura
 *     honesta es 0 cubiertas mientras haya capital vivo; todas si el capital ya
 *     volvió entero (se canceló).
 *   · AMERICAN: las cuotas 1..n−1 son sólo interés; el capital entero vive en
 *     el CIERRE (la última). La cobertura es todo-o-nada del capital: 0 hasta
 *     que el cierre se paga (o se cancela), todas después.
 *
 * En los dos casos el interés pagado NO es derivable del saldo (no lo toca: se
 * registra como gasto) y por eso `interestPaid` viaja en `null` — inventar un
 * número sería peor que decir "no se sabe".
 *
 * Para los sistemas que cierran a 0 delega en `loanProgress` de `lib/money.ts`:
 * la misma función que usa el reporte de deudas desde la Fase 6, con sus
 * definiciones bloqueadas ("interés pagado = Σ interés de las cuotas cubiertas").
 */
export function loanProgressFor(
  input: LoanScheduleInput,
  schedule: readonly Installment[],
  capitalPaid: Money | string,
): LoanProgressView {
  const p = toMoney(input.principal);
  const paid = toMoney(capitalPaid);
  const clamped = paid.lessThan(0)
    ? zero()
    : paid.greaterThan(p)
      ? p
      : paid;

  if (input.system === "INTEREST_ONLY" || input.system === "AMERICAN") {
    const closed = clamped.greaterThanOrEqualTo(p);
    return {
      principal: p,
      capitalPaid: clamped,
      installmentsCovered: closed ? schedule.length : 0,
      // No derivable del saldo: el interés de estas cuotas se registra como
      // gasto (o va en el cierre) y no hay transferencia que lo delate.
      interestPaid: null,
      remainingCount: closed ? 0 : schedule.length,
      progressPercent: p.isZero()
        ? zero()
        : round(clamped.dividedBy(p).times(100)),
    };
  }

  const progress = loanProgress(schedule, clamped);
  return {
    principal: progress.principal,
    capitalPaid: progress.capitalPaid,
    installmentsCovered: progress.installmentsCovered,
    interestPaid: progress.interestPaid,
    remainingCount: progress.remainingCount,
    progressPercent: progress.progressPercent,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Compromisos próximos
 * ──────────────────────────────────────────────────────────────────────────── */

/** Un mes de compromiso: cuánto vence ese mes. */
export interface LoanCommitmentMonth {
  year: number;
  month: number;
  amount: Money;
}

/** Los compromisos de un préstamo: los próximos meses y lo ya vencido. */
export interface LoanCommitments {
  /** Un bucket por mes, empezando en el mes de `from` (inclusive). */
  months: LoanCommitmentMonth[];
  /** Σ de los meses de la ventana. NO incluye `overdue` (no se cuenta doble). */
  total: Money;
  /** Σ de las cuotas IMPAGAS con vencimiento anterior al mes de `from`. */
  overdue: Money;
  /** Cuántas cuotas impagas están vencidas. */
  overdueCount: number;
}

/** Lo mínimo que necesita el agregador: una cuota con fecha y estado. */
export interface LoanCommitmentItemLike {
  dueDate: CalendarDate;
  payment: Money | string;
  /** Las cuotas cubiertas no comprometen nada: ya se pagaron. */
  covered: boolean;
}

/**
 * Los compromisos de un préstamo: "¿qué cuotas tengo comprometidas en los
 * próximos N meses?" — la pregunta que justifica materializar el cronograma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES DECISIONES (y sus bordes)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **La ventana arranca en el mes de `from`** (el mes en curso, pasado como
 *    `startOfMonth(today)`) y avanza N meses. Las cuotas de meses anteriores NO
 *    son "próximas": van a `overdue`, un número SEPARADO que nunca suma al
 *    total de la ventana — contarlas dos veces inflaría el compromiso.
 * 2. **Las cuotas cubiertas se excluyen**: ya se pagaron, no se van a volver a
 *    pagar. La cobertura se deriva del capital real (ver `loanProgressFor`).
 * 3. **`countOverdue: false` para rotativos**: en un préstamo de solo interés el
 *    pago del interés del mes no se puede derivar del saldo (va como gasto), así
 *    que "vencido" no tiene fuente de verdad. El compromiso honesto es el de
 *    los meses que vienen, y `overdue` queda en 0 en vez de acumular cuotas
 *    que quizás ya se pagaron.
 */
export function loanCommitments(
  installments: readonly LoanCommitmentItemLike[],
  from: CalendarDate,
  months: number,
  options: { countOverdue?: boolean } = {},
): LoanCommitments {
  const { countOverdue = true } = options;

  if (!Number.isInteger(months) || months < 1) {
    throw new Error("La ventana de compromisos tiene que ser de al menos un mes.");
  }

  // El primer mes de la ventana: `from` es una fecha de calendario y se toma
  // su año/mes. La clave "AAAA-MM" de un vencimiento se compara directo contra
  // las claves de los buckets (las fechas ISO-8601 con cero a la izquierda
  // comparan cronológicamente como string).
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const keyOf = (year: number, month: number) =>
    `${year}-${String(month).padStart(2, "0")}`;

  const buckets = Array.from({ length: months }, (_, index) => {
    const totalIndex = fromYear * 12 + (fromMonth - 1) + index;
    return {
      year: Math.floor(totalIndex / 12),
      month: (totalIndex % 12) + 1,
      amount: zero(),
    };
  });
  const indexByKey = new Map(
    buckets.map((bucket, index) => [keyOf(bucket.year, bucket.month), index]),
  );
  const firstKey = keyOf(fromYear, fromMonth);

  let overdue = zero();
  let overdueCount = 0;

  for (const installment of installments) {
    if (installment.covered) continue;

    const key = installment.dueDate.slice(0, 7);
    const amount = toMoney(installment.payment);

    const index = indexByKey.get(key);
    if (index !== undefined) {
      buckets[index].amount = buckets[index].amount.plus(amount);
      continue;
    }

    if (countOverdue && key < firstKey) {
      overdue = overdue.plus(amount);
      overdueCount += 1;
    }
    // Un mes POSTERIOR a la ventana no es "próximo": se ignora en silencio,
    // como en `commitmentsFromItems` de las tarjetas.
  }

  return {
    months: buckets,
    total: buckets.reduce((total, bucket) => total.plus(bucket.amount), zero()),
    overdue,
    overdueCount,
  };
}
