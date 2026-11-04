/**
 * La moneda como PARÁMETRO del borde HTTP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE MÓDULO
 * ─────────────────────────────────────────────────────────────────────────────
 * Desde la Fase 4 la moneda es parte del significado de cada número: sumar
 * `Movement.amount` de cuentas en pesos y en dólares da un número que no es
 * plata de nada. Las funciones de `lib/` exigen la moneda SIN default (el
 * compilador obliga a decidir), pero el borde HTTP conserva el comportamiento
 * histórico: sin `?currency=`, la app sigue mostrando pesos.
 *
 * El default vive acá y sólo acá. Repetir `?? "ARS"` en cinco rutas es la clase
 * de detalle que alguien olvida en la sexta.
 */

import type { Currency } from "@prisma/client";

/**
 * Las monedas que la app conoce hoy.
 *
 * Es una lista EXPLÍCITA y no `Object.values(Currency)`: el enum de Prisma es un
 * objeto generado y su orden no es parte del contrato. Además, cuando se sume
 * una moneda nueva (`ALTER TYPE ... ADD VALUE`), este es el único lugar donde
 * hay que decidir si el borde la acepta.
 */
export const CURRENCIES = ["ARS", "USD"] as const satisfies readonly Currency[];

/** La moneda que se usa cuando el cliente no manda `?currency=`. */
export const DEFAULT_CURRENCY: Currency = "ARS";

/** `true` sólo para un string que sea exactamente una moneda conocida. */
export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * El resultado de interpretar `?currency=` de una petición.
 *
 * Tres estados y no dos, igual que `parseIncomeMonth`: "no vino" (default ARS) y
 * "vino mal" (400) no son lo mismo. Devolver ARS ante un `?currency=EUR` sería
 * mentirle al cliente sobre la unidad de los números que recibe.
 */
export type ParsedCurrencyParam =
  | { ok: true; currency: Currency }
  | { ok: false; error: string };

/**
 * Interpreta el parámetro `currency` de la URL.
 *
 *   · ausente (`null`) → ARS, el comportamiento de siempre;
 *   · `"ARS"` / `"USD"` → esa moneda;
 *   · cualquier otra cosa (`"EUR"`, `"usd"`, `""`, basura) → error, que la ruta
 *     traduce a 400.
 *
 * La comparación es exacta a propósito: aceptar `"usd"` obligaría a decidir si
 * también se aceptan espacios, y ese tipo de tolerancia termina escondiendo un
 * cliente roto en vez de avisarle.
 */
export function parseCurrencyParam(value: string | null): ParsedCurrencyParam {
  if (value === null) return { ok: true, currency: DEFAULT_CURRENCY };

  if (!isCurrency(value)) {
    return {
      ok: false,
      error: "`currency` tiene que ser una moneda válida: ARS o USD.",
    };
  }

  return { ok: true, currency: value };
}
