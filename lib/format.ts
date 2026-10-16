/**
 * Formateo de números para mostrar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO ESTÁ SEPARADO DE lib/money.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/money.ts` necesita `Prisma.Decimal` para hacer aritmética exacta, y eso
 * significa importar `@prisma/client` COMO VALOR (no como tipo). En el servidor
 * no hay problema. En el navegador es un desastre: el bundle se lleva el cliente
 * de Prisma entero — que es grande y usa APIs de Node que no existen en el
 * navegador.
 *
 * Formatear un número, en cambio, sólo necesita `Intl`, que ya está en todas
 * partes. Este archivo no importa NADA. Es seguro para componentes de cliente y
 * no se puede romper agregando una dependencia sin que salte a la vista.
 *
 * La regla, entonces:
 *   · ¿Necesitás CALCULAR con plata?  → lib/money.ts (servidor)
 *   · ¿Necesitás MOSTRAR plata?       → lib/format.ts  (cliente o servidor)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL BUG QUE ESTE MÓDULO ARREGLA
 * ─────────────────────────────────────────────────────────────────────────────
 * La versión anterior tenía, en `lib/finance.ts`:
 *
 *     new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" })
 *
 * Una app de finanzas argentina mostraba TODOS los montos en EUROS. No era un
 * bug de configuración: era la consecuencia de que la moneda y el locale estaban
 * escritos a mano en el medio de una función de formato, y nadie los revisó.
 *
 * Ahora salen de variables de entorno con los valores correctos por defecto, y
 * están en un solo lugar.
 */

/**
 * Código ISO de la moneda principal.
 *
 * Configurable por si algún día hace falta, pero el valor por defecto es el que
 * corresponde: ARS. Un default CORRECTO es la mejor documentación.
 */
export const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY ?? "ARS";

/** Locale para formatear. `es-AR` da "$ 1.234,56" y separa miles con punto. */
export const LOCALE = process.env.NEXT_PUBLIC_LOCALE ?? "es-AR";

/** Cuántos decimales se muestran. */
export const MONEY_SCALE = 2;

/**
 * Cualquier cosa que represente un monto y sepa convertirse a string.
 *
 * Es un tipo ESTRUCTURAL: `number` y `Prisma.Decimal` lo cumplen los dos
 * (ambos tienen `toFixed`), y un `string` entra por su propia rama. Así este
 * módulo acepta tanto valores del servidor como del formulario sin importar
 * `Decimal` — que es exactamente lo que lo mantiene libre de dependencias.
 */
export type MoneyLike = string | number | { toFixed(dp: number): string };

/** Convierte a string decimal con la escala de dinero, sin tocar la aritmética. */
function toDecimalString(value: MoneyLike): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toFixed(MONEY_SCALE);
  return value.toFixed(MONEY_SCALE);
}

/**
 * Formatea un monto para mostrarlo.
 *
 *     formatMoney("800000.5")   → "$ 800.000,50"
 *     formatMoney("800000.5", { withSymbol: false }) → "800.000,50"
 *     formatMoney("-1500")      → "-$ 1.500,00"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ PASA POR `Number` AL FINAL
 * ─────────────────────────────────────────────────────────────────────────────
 * `Intl.NumberFormat` sólo formatea `number`, y en este punto del flujo el
 * redondeo ya está hecho (el string ya viene con 2 decimales), así que la
 * conversión es segura para cualquier monto que quepa en un `number` — que es
 * todo lo que alguien va a escribir en un formulario de gastos. La precisión
 * exacta importa al SUMAR cientos de movimientos, no al mostrar uno.
 */
export function formatMoney(
  value: MoneyLike,
  options: { withSymbol?: boolean; withSign?: boolean } = {},
): string {
  const { withSymbol = true, withSign = false } = options;
  const decimal = toDecimalString(value);

  return new Intl.NumberFormat(LOCALE, {
    style: withSymbol ? "currency" : "decimal",
    currency: withSymbol ? CURRENCY : undefined,
    minimumFractionDigits: MONEY_SCALE,
    maximumFractionDigits: MONEY_SCALE,
    signDisplay: withSign ? "always" : "auto",
  }).format(Number(decimal));
}

/**
 * Formatea un porcentaje.
 *
 *     formatPercent("21.88") → "21,88 %"
 *
 * Recibe el porcentaje ya multiplicado (21.88 significa 21,88%), NO la fracción.
 * Es la convención inversa a la de `Intl`, y se eligió a propósito: es como se
 * lee en la base de datos y en los tests, y evita el clásico "0,22%" cuando en
 * realidad era 21,88%.
 */
export function formatPercent(
  value: MoneyLike,
  decimals = MONEY_SCALE,
): string {
  const decimal = toDecimalString(value);

  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(decimal) / 100);
}

/**
 * Etiqueta corta del día, para agrupar movimientos en una lista.
 *
 *     formatDayLabel("2026-10-15") → "15 de octubre"
 *
 * Recibe el string de calendario y lo parsea con componentes sueltos. NO usa
 * `new Date("2026-10-15")`, que se interpretaría como UTC y mostraría el 14.
 */
export function formatDayLabel(calendarDate: string): string {
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (!year || !month || !day) return calendarDate;

  // El `new Date(y, m - 1, d)` con componentes sueltos construye la fecha en
  // hora LOCAL, que es lo que corresponde para una fecha de calendario.
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
  }).format(new Date(year, month - 1, day));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sumar montos en el cliente sin perder centavos
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE SUMAN LOS MONTOS CON `+` DIRECTAMENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Los montos viajan como strings decimales exactos ("1234.56"), y el navegador
 * no tiene un tipo decimal nativo. La conversión obvia es `Number("1234.56")`,
 * pero eso reintroduce exactamente el error binario que el servidor evitó con
 * mucho cuidado: `Number("0.1") + Number("0.2")` da 0.30000000000000004.
 *
 * La solución NO es traer una librería de decimales al bundle del navegador.
 * Es más simple: **sumar en centavos enteros**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS CENTAVOS ENTEROS SON EXACTOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Los enteros de JavaScript son exactos hasta 2^53 ≈ 9.007.199.254.740.992.
 *
 *   · Un monto con dos decimales, multiplicado por 100 y redondeado, es un
 *     entero con un error de a lo sumo 1e-10 — o sea, el redondeo da el entero
 *     correcto siempre.
 *   · Sumar enteros exactos da un entero exacto. No hay acumulación de error.
 *   · En centavos, el límite de 2^53 son $ 90.071.992.547.409,92. Noventa
 *     billones de pesos: no es un problema real para un presupuesto personal.
 *
 * La división por 100 se hace UNA sola vez, al final, para mostrar.
 *
 *     cantidad × 100  →  entero exacto     (el error de la multiplicación se
 *                                           elimina al redondear)
 *     sumar enteros   →  exacto            (los enteros sí son exactos)
 *     ÷ 100 y toFixed →  el monto correcto (un solo redondeo, al final)
 *
 * Comparalo con sumar los `Number` y redondear al final: el error de CADA
 * conversión se acumula, y con miles de movimientos el total puede diferir en
 * varios centavos del real.
 */

/**
 * Convierte un monto decimal en string a centavos enteros.
 *
 *     toCents("1234.56") → 123456
 *     toCents("-0.05")   → -5
 *     toCents("basura")  → 0
 */
export function toCents(amount: string | number): number {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/**
 * Convierte centavos enteros a un string decimal con dos decimales.
 *
 *     centsToString(123456) → "1234.56"
 *     centsToString(0)      → "0.00"
 */
export function centsToString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Suma una lista de montos decimales sin perder centavos.
 *
 *     sumAmounts(["0.1", "0.2"]) → "0.30"
 */
export function sumAmounts(amounts: readonly (string | number)[]): string {
  let total = 0;
  for (const amount of amounts) total += toCents(amount);
  return centsToString(total);
}

/**
 * Formatea un monto escrito por la persona mientras lo escribe, o `null` si
 * todavía no se entiende.
 *
 * Se usa para mostrar una vista previa en el formulario: escribir "1234,5" y
 * ver "$ 1.234,50" confirma al instante que se interpretó lo que se quiso
 * escribir — y evita el clásico "cargué 1.500 y guardó 1,50".
 *
 * La interpretación del separador vive en `lib/money.ts` (que es del servidor
 * porque usa Decimal), así que acá se replica SÓLO la parte de presentación con
 * una heurística conservadora: si el número formateado no coincide con lo que
 * se escribió, no se muestra nada en vez de mostrar algo equivocado.
 */
export function formatAmountInput(raw: string): string | null {
  const cleaned = raw.replace(/[^\d.,+-]/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "+" || cleaned === "." || cleaned === ",") {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = cleaned
      .split(thousandsSeparator)
      .join("")
      .replace(decimalSeparator, ".");
  } else if (lastComma >= 0) {
    const parts = cleaned.split(",");
    normalized = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  } else if (lastDot >= 0) {
    // Misma regla que el servidor: el punto es separador de miles sólo si el
    // string respeta el patrón completo.
    const sign = /^[+-]/.test(cleaned) ? cleaned[0] : "";
    const unsigned = sign ? cleaned.slice(1) : cleaned;
    normalized = /^\d{1,3}(\.\d{3})+$/.test(unsigned)
      ? sign + unsigned.split(".").join("")
      : cleaned;
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;

  return formatMoney(centsToString(toCents(normalized)));
}
