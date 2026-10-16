/**
 * Aritmética de dinero y cálculo de préstamos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE USA `number` PARA PLATA
 * ─────────────────────────────────────────────────────────────────────────────
 * Los números de JavaScript son IEEE-754 de doble precisión: fracciones
 * binarias. No pueden representar 0,10 de forma exacta — el valor real es
 * 0,1000000000000000055511151231257827.
 *
 * Eso no molesta hasta que acumulás:
 *
 *     0.1 + 0.2 === 0.3        // false, da 0.30000000000000004
 *     0.1 * 3   === 0.3        // false, da 0.30000000000000004
 *
 * En un registro de gastos con cientos de movimientos, esos errores se suman y
 * el saldo deja de cerrar con la realidad. Y no hay nada peor para la confianza
 * en una app de finanzas que los números no cierren.
 *
 * `Decimal` es aritmética decimal de precisión arbitraria — la misma que usa
 * cualquier sistema contable. `new Decimal("0.1").plus("0.2").equals("0.3")`
 * es `true`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SE CONSTRUYE DESDE STRING Y NO DESDE `number`
 * ─────────────────────────────────────────────────────────────────────────────
 * `new Decimal(0.1)` NO da 0,1: copia el error binario que ya tenía el number.
 * `new Decimal("0.1")` da 0,1 exacto. Todo lo que entra desde la interfaz o
 * desde un número de `number` pasa primero por un string.
 *
 * Regla: jamás construir un Decimal desde un `number` que representa plata. Por
 * eso `money()` sólo acepta `string | Decimal` — si necesitás pasar un number,
 * el tipo te obliga a pensarlo dos veces.
 */

import { Prisma } from "@prisma/client";

/** El tipo de dinero de la aplicación. Alias corto para no escribir Prisma. dos veces. */
export type Money = Prisma.Decimal;

/** Cuántos decimales se muestran y se guardan. */
import { MONEY_SCALE } from "./format";

// El formateo vive en lib/format.ts — que no importa NADA — para que los
// componentes de cliente puedan mostrarlo sin arrastrar `@prisma/client` al
// bundle del navegador. Se re-exporta acá para que el código de servidor tenga
// un solo punto de entrada y no tenga que saber de esa división.
export {
  CURRENCY,
  LOCALE,
  MONEY_SCALE,
  formatMoney,
  formatPercent,
} from "./format";

/**
 * Convierte a Money de forma segura.
 *
 * Acepta `string` (preferido, exacto) o `Decimal` (idempotente).
 * NO acepta `number`: ver la nota de arriba.
 */
export function money(value: string | Money): Money {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** `0` con la escala de dinero. */
export function zero(): Money {
  return new Prisma.Decimal(0);
}

/** Suma exacta. */
export function add(a: Money, b: Money): Money {
  return a.plus(b);
}

/** Resta exacta. */
export function subtract(a: Money, b: Money): Money {
  return a.minus(b);
}

/** Suma una lista. Con lista vacía devuelve 0 (no `null`). */
export function sum(values: readonly Money[]): Money {
  return values.reduce<Money>((acc, value) => acc.plus(value), zero());
}

/** `true` si la lista suma exactamente cero. */
export function sumIsZero(values: readonly Money[]): boolean {
  return sum(values).isZero();
}

/**
 * Redondea a 2 decimales con redondeo bancario (half-even).
 *
 * Redondeo bancario y no "half-up": cuando redondeás hacia arriba siempre, los
 * errores se acumulan en una dirección. En muchos movimientos eso produce un
 * sesgo medible. Half-even reparte el error.
 */
export function round(value: Money): Money {
  return value.toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_EVEN);
}

/** `true` si el valor es exactamente cero. */
export function isZero(value: Money): boolean {
  return value.isZero();
}

/** `true` si el valor es estrictamente negativo. */
export function isNegative(value: Money): boolean {
  return value.isNegative() && !value.isZero();
}

/** Valor absoluto. */
export function abs(value: Money): Money {
  return value.abs();
}

/** El mayor entre dos valores. */
export function max(a: Money, b: Money): Money {
  return a.greaterThan(b) ? a : b;
}

/** El menor entre dos valores. */
export function min(a: Money, b: Money): Money {
  return a.lessThan(b) ? a : b;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entrada de datos
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Interpreta un monto escrito por una persona.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA DE LOS SEPARADORES
 * ────────────────────────────────────────────────────────────────────────────
 * En Argentina el punto separa miles y la coma separa decimales: "1.234,56"
 * son mil doscientos treinta y cuatro con cincuenta y seis. En otros lugares es
 * al revés. Y "1.500" puede ser mil quinientos (acá) o uno con cinco (en otro
 * lado) — es genuinamente ambiguo.
 *
 * Reglas, en orden:
 *   1. Si aparecen LOS DOS separadores, manda el ÚLTIMO: "1.234,56" → decimal
 *      es la coma; "1,234.56" → decimal es el punto.
 *   2. Si sólo hay comas: la última es decimal. "1234,5" → 1234,5.
 *   3. Si sólo hay puntos:
 *      · un punto con EXACTAMENTE 3 dígitos detrás y más dígitos adelante
 *        ("1.500") → separador de miles.
 *      · cualquier otro caso ("1.5", "10.25") → separador decimal.
 *   4. Se ignoran espacios, símbolos de moneda y letras.
 *
 * Devuelve `null` si no se puede interpretar un número — nunca `NaN`, que se
 * propagaría silenciosamente por toda la aplicación.
 */
export function parseMoneyInput(raw: string): Money | null {
  if (typeof raw !== "string") return null;

  // Sacamos todo lo que no sea dígito, separador o signo.
  let cleaned = raw.replace(/[^\d.,+-]/g, "").trim();
  if (cleaned === "") return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    // Regla 1: el último separador que aparece es el decimal.
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    cleaned = cleaned.split(thousandsSeparator).join("");
    cleaned = cleaned.replace(decimalSeparator, ".");
  } else if (lastComma >= 0) {
    // Regla 2: sólo comas → la última es decimal.
    const parts = cleaned.split(",");
    // Si hay más de una coma, las anteriores eran separadores de miles.
    cleaned = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  } else if (lastDot >= 0) {
    // Regla 3.
    //
    // Sólo se interpreta el punto como separador de MILES si el string respeta
    // el formato de miles COMPLETO: de 1 a 3 dígitos, y después grupos exactos
    // de 3.
    //
    //   "1.500"      → coincide      → 1.500
    //   "1.234.567"  → coincide      → 1.234.567
    //   "1234.567"   → NO coincide   → decimal (1234,567)
    //   "1.5"        → NO coincide   → decimal
    //
    // ────────────────────────────────────────────────────────────────────────
    // POR QUÉ NO ALCANZA CON "3 DÍGITOS DESPUÉS DEL PUNTO"
    // ────────────────────────────────────────────────────────────────────────
    // La primera versión de esta función usaba esa regla, y "1234.567" se
    // interpretaba como 1.234.567. En el formato de miles real, el primer grupo
    // NUNCA tiene 4 dígitos: se escribe "1.234.567", no "1234.567". Exigir el
    // patrón completo es lo que desambigua.
    //
    // La ambigüedad de "1.500" es genuina y se resuelve por la convención
    // local, no por la del navegador.
    const thousandsPattern = /^\d{1,3}(\.\d{3})+$/;
    const sign = /^[+-]/.test(cleaned) ? cleaned[0] : "";
    const unsigned = sign ? cleaned.slice(1) : cleaned;

    if (thousandsPattern.test(unsigned)) {
      cleaned = sign + unsigned.split(".").join("");
    }
    // Si no coincide, queda como está: "1.5" ya es válido para Decimal.
  }

  // Después de normalizar sólo puede quedar un punto decimal.
  if (!/^[+-]?\d*\.?\d*$/.test(cleaned)) return null;
  if (cleaned === "" || cleaned === "." || cleaned === "-" || cleaned === "+") return null;

  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Formato
 * ──────────────────────────────────────────────────────────────────────────── */

// `formatMoney` y `formatPercent` se re-exportan desde lib/format.ts (ver
// arriba). Se mudaron ahí porque este archivo importa `Prisma.Decimal` como
// valor, y cualquier componente de cliente que lo importara se llevaría el
// cliente de Prisma entero al bundle del navegador.
//
// Si necesitás formatear plata en un componente de cliente, importá de
// "@/lib/format" directamente.

/* ────────────────────────────────────────────────────────────────────────────
 * Préstamos
 * ──────────────────────────────────────────────────────────────────────────── */

/** Una cuota, descompuesta en lo que realmente es. */
export interface Installment {
  /** Número de cuota, empezando en 1. */
  number: number;
  /** Lo que pagás: `interest + principal`. */
  payment: Money;
  /** La parte que es COSTO REAL: se la queda el banco. Es gasto. */
  interest: Money;
  /** La parte que AMORTIZA DEUDA: baja lo que debés. No es gasto. */
  principal: Money;
  /** Cuánto debés después de pagar esta cuota. */
  remainingBalance: Money;
}

/**
 * Tasa mensual a partir de la TNA (Tasa Nominal Anual) expresada en porcentaje.
 *
 * La TNA es una tasa NOMINAL: se divide por 12 para obtener la mensual. NO es
 * una tasa efectiva, y por eso no se usa la fórmula de conversión
 * `(1 + tna)^(1/12) - 1`: en Argentina los bancos liquidan dividiendo por 12, y
 * usar la otra fórmula daría cuotas que no coinciden con el resumen del banco.
 *
 * `monthlyRateFromTna("60")` → 0,05 (5% mensual)
 */
export function monthlyRateFromTna(tnaPercent: Money | string): Money {
  const tna = typeof tnaPercent === "string" ? money(tnaPercent) : tnaPercent;
  return tna.dividedBy(100).dividedBy(12);
}

/**
 * Calcula la cuota fija de un préstamo por el sistema francés (cuota constante).
 *
 *                        i · P
 *     cuota = ─────────────────────
 *              1 − (1 + i)^(−n)
 *
 * Es el sistema que usan prácticamente todos los bancos argentinos: pagás lo
 * mismo todos los meses, y lo que cambia es la COMPOSICIÓN — al principio casi
 * todo es interés, al final casi todo es capital.
 *
 * Entender esa composición es lo que separa "pagué 676.000 de préstamo" de
 * "el préstamo me costó 176.000". La app anterior no podía distinguirlo.
 */
export function installmentPayment(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
): Money {
  const p =
    typeof principal === "string" ? money(principal) : principal;
  const i = monthlyRateFromTna(tnaPercent);

  if (installmentCount <= 0) {
    throw new Error("La cantidad de cuotas debe ser mayor a cero.");
  }
  // Sin interés, la cuota es el capital repartido. Evita dividir por cero.
  if (i.isZero()) {
    return round(p.dividedBy(installmentCount));
  }

  const factor = new Prisma.Decimal(1).minus(
    new Prisma.Decimal(1).plus(i).pow(-installmentCount),
  );
  return round(p.times(i).dividedBy(factor));
}

/**
 * Arma el plan de pagos completo, cuota por cuota.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CÓMO SE MANEJA EL REDONDEO
 * ────────────────────────────────────────────────────────────────────────────
 * Con la cuota redondeada a 2 decimales, la suma de las amortizaciones de
 * capital casi nunca da EXACTAMENTE el principal: sobra o falta un centavo. Si
 * se ignora, la última cuota deja un saldo distinto de cero y el préstamo
 * "nunca termina de pagarse".
 *
 * Solución, igual a la de los bancos: la ÚLTIMA cuota absorbe la diferencia.
 * Se calcula su pago como "el saldo que queda más los intereses del período",
 * así el saldo final cierra en cero exacto.
 */
export function amortizationSchedule(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
): Installment[] {
  const p = typeof principal === "string" ? money(principal) : principal;
  const i = monthlyRateFromTna(tnaPercent);

  if (installmentCount <= 0) {
    throw new Error("La cantidad de cuotas debe ser mayor a cero.");
  }

  const payment = installmentPayment(p, tnaPercent, installmentCount);
  const installments: Installment[] = [];
  let balance = round(p);

  for (let number = 1; number <= installmentCount; number += 1) {
    const isLast = number === installmentCount;

    const interest = round(balance.times(i));

    // La última cuota paga exactamente lo que queda. Así el saldo cierra en 0
    // sin importar los centavos que se hayan acumulado por redondeo.
    const principalPart = isLast
      ? balance
      : round(payment.minus(interest));

    const actualPayment = isLast
      ? round(principalPart.plus(interest))
      : payment;

    balance = round(balance.minus(principalPart));
    if (balance.isNegative() && balance.abs().lessThan("0.005")) {
      balance = zero();
    }

    installments.push({
      number,
      payment: actualPayment,
      interest,
      principal: principalPart,
      remainingBalance: balance,
    });
  }

  return installments;
}

/**
 * Resumen de un préstamo: lo que realmente cuesta.
 *
 * Es la función que responde la pregunta que la app anterior no podía
 * contestar: de todo lo que vas a pagar, ¿cuánto es plata perdida y cuánto es
 * recuperar tu propia deuda?
 */
export function loanSummary(
  principal: Money | string,
  tnaPercent: Money | string,
  installmentCount: number,
) {
  const schedule = amortizationSchedule(principal, tnaPercent, installmentCount);
  const totalPaid = sum(schedule.map((c) => c.payment));
  const totalInterest = sum(schedule.map((c) => c.interest));
  const totalPrincipal = sum(schedule.map((c) => c.principal));
  const p = typeof principal === "string" ? money(principal) : principal;

  // Porcentaje del total pagado que es costo real. Se calcula sobre el TOTAL
  // PAGADO (no sobre el capital) porque así se lee mejor: "de cada $100 que
  // pagás, $26 son del banco".
  const interestShare = totalPaid.isZero()
    ? zero()
    : totalInterest.dividedBy(totalPaid).times(100);

  return {
    payment: schedule[0]?.payment ?? zero(),
    totalPaid,
    totalInterest,
    /** Costo real del préstamo: es lo único que debería contar como gasto. */
    totalCost: totalInterest,
    /** Capital devuelto: no es gasto, es bajar la deuda. */
    totalPrincipal,
    /** Porcentaje de cada peso pagado que se queda el banco. */
    interestSharePercent: round(interestShare),
    /** Cuánto más caro sale que pagarlo al contado. */
    extraOverPrincipal: totalInterest,
    principal: p,
    schedule,
  };
}
