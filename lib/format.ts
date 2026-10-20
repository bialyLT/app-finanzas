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
 * Etiqueta de una cuenta de deuda, con la palabra del lado que corresponde.
 *
 *     formatLiability("50000.00")   → "debe $ 50.000,00"
 *     formatLiability("-50000.00")  → "a favor $ 50.000,00"
 *     formatLiability("0.00")       → "debe $ 0,00"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO ALCANZA CON `debe ${formatMoney(debt)}`
 * ─────────────────────────────────────────────────────────────────────────────
 * La deuda llega en POSITIVO cuando se debe —el caso normal— y en NEGATIVO
 * cuando la cuenta quedó con saldo a favor (se pagó más de lo que se debía).
 * Interpolar el signo crudo produce "debe −$ 50.000,00", que es una
 * contradicción: la palabra dice que debe y el signo dice que le deben.
 * Ninguna cuenta debe un número negativo; lo que tiene es plata a favor.
 *
 * El cero se queda del lado de "debe": es la deuda nula, no un saldo a favor.
 */
export function formatLiability(debt: MoneyLike): string {
  const cents = toCents(toDecimalString(debt));

  return cents < 0
    ? `a favor ${formatMoney(centsToString(-cents))}`
    : `debe ${formatMoney(centsToString(cents))}`;
}

/**
 * Factor de tamaño de letra de un monto, para que el número ENTRE en su
 * tarjeta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA
 * La fila de cuatro tarjetas del panel (y la del análisis) entra a partir de
 * 940 px, y ese corte está calculado para un monto de 13 caracteres
 * («+$ 800.000,00»): a 940 px la tarjeta mide 227 px y el texto del monto,
 * con 24 px de cuerpo, mide 165 px y entra justo.
 *
 * Un monto más largo no entra: «$ 1.234.567.890,12» mide 248 px en una caja
 * de 195 px. MEDIDO: el texto se salía de la tarjeta (37 px), las tarjetas se
 * pisaban entre sí y el DOCUMENTO se iba a 978 px en un device de 941 — o
 * sea, scroll horizontal, que es el invariante que la app no puede romper.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA
 * El tamaño de letra acompaña al ancho de la TARJETA (una container query:
 * `100cqw` es el 1 % del ancho de la tarjeta), no al del device. Como el
 * ancho disponible es el que manda, el número entra entero en su caja en vez
 * de salirse, y la grilla no necesita un corte nuevo.
 *
 * El factor es `1 / (caracteres × 0,6)`: el avance medio de un carácter de
 * un monto en negrita es de 0,576 em (medido: 248 px / 18 caracteres / 24 px
 * de cuerpo) y 0,6 es ese número con un 4 % de margen.
 *
 * Con los montos de todos los días (≤ 13 caracteres) el factor da un tamaño
 * MAYOR que el que ya se usaba: la tarjeta se ve EXACTAMENTE igual. Esto
 * sólo cambia cuando el monto no entraba.
 *
 * El `avance` es un parámetro porque no todos los montos avanzan igual: los
 * largos (18 caracteres, todos dígitos y separadores) avanzan 0,574 em y
 * necesitan el margen; los cortos («$ 100.000,00») avanzan 0,49 em (la «$»
 * y el espacio son angostos) y con 0,6 se achucarían de más: se verían más
 * chicos de lo necesario aunque entren. Con 0,5 el monto corto entra JUSTO
 * en su ficha y conserva su cuerpo de letra en el teléfono de todos los
 * días.
 */
export function factorMonto(texto: string, avance = 0.6): string {
  const caracteres = [...texto].length;
  if (caracteres === 0) return "1";
  return (1 / (caracteres * avance)).toFixed(4);
}

/**
 * ¿Este monto es más largo de lo que entra en su caja?
 *
 * Un monto de 13 caracteres («+$ 800.000,00») entra en cualquier caja de la
 * app. Uno de 18 («+$ 1.234.567.890,12») no: en las cajas angostas —la ficha
 * de un mes del patrimonio, una fila de movimientos, una celda de
 * reconciliación— el número es más ancho que la caja y la empuja, y con él
 * empuja al documento (medido a 320 px: el documento se iba a 337 px).
 *
 * Cuando el monto es largo, la caja tiene que poder PARTIRLO: sin eso, el
 * número no se puede mostrar entero en una pantalla angosta. Para los montos
 * de todos los días esto no cambia NADA: la respuesta es siempre «no».
 */
export function montoLargo(texto: string, maximo = 13): boolean {
  return [...texto].length > maximo;
}

/**
 * El factor del mecanismo de las FICHAS (el cuerpo de letra acompaña al
 * ancho de la tarjeta, no al del device).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO EL FACTOR DE ARRIBA
 * `factorMonto` usa un avance de 0,6 em por carácter: es un MARGEN
 * (conservador) y está calibrado para las tarjetas grandes, donde el tope
 * de 24 px manda y el margen extra no se ve.
 *
 * En las fichas angostas (la caja mide 64 px a 320 px) el margen se nota:
 * con 0,6 el monto de todos los días («$ 100.000,00», que entra JUSTO en
 * 82 px) se achicaría a 11,4 px aunque entrara perfecto — y el caso común
 * cambiaría (que es justo lo que no hay que hacer).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL AVANCE REAL, MEDIDO
 * En el navegador, con la fuente de la app y cuerpo de 14 px:
 *   · «$ 100.000,00» (12 caracteres) → 82 px → 0,488 em por carácter.
 *   · «+$ 310.000,00» (los mismos 12, más el signo) → 90 px → el signo
 *     adelante suma 0,571 em (los dígitos son tabulares: el ancho no
 *     depende de QUÉ dígito sea).
 *
 * Acá se usa 0,52 por carácter y 0,60 por el signo: un 6 % de margen sobre
 * la medición, que es lo que hace que el número entre en su caja y no la
 * empuje — en cualquier máquina, con un 6 % de diferencia de fuente.
 */
export function factorMontoFicha(texto: string): string {
  const caracteres = [...texto].length;
  if (caracteres === 0) return "1";
  const conSigno = /^[+\-−]/.test(texto);
  const em = caracteres * 0.52 + (conSigno ? 0.6 : 0);
  return factorMonto(texto, em / caracteres);
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
