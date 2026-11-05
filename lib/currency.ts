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

/**
 * Cómo se nombra una moneda en un mensaje para la persona.
 *
 * Existe para que "ya tenés una cuenta con ese nombre **en esa moneda**" diga
 * cuál, en vez de repetir el código del enum. Un `Record<Currency, string>` y no
 * un `switch` con `default`: cuando se sume una moneda nueva, el compilador
 * obliga a nombrarla acá en vez de dejarla hablando en siglas.
 */
const CURRENCY_NOUNS: Record<Currency, string> = {
  ARS: "pesos",
  USD: "dólares",
};

/** El nombre de la moneda para un mensaje: "pesos" / "dólares". */
export function currencyNoun(currency: Currency): string {
  return CURRENCY_NOUNS[currency];
}

/** `true` sólo para un string que sea exactamente una moneda conocida. */
export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * ¿Una transferencia cruza monedas?
 *
 * Es la condición que decide si el formulario tiene que pedir el segundo monto
 * ("¿cuánto llega?"). Vive acá, pura y testeada, porque es una REGLA del
 * dominio: la misma comparación la usa la API para exigir/prohibir `toAmount`
 * y la base para hacer cumplir la bicondicional. El `null` significa "todavía
 * no se eligieron las dos cuentas": no hay transferencia que comparar.
 *
 * Ojo: `null !== null` es `false` en JS, pero acá se compara con `== null`
 * explícito para que "sin origen" y "sin destino" NO se lean como "distintas
 * monedas" y el formulario no pida un monto que después no puede mandar.
 */
export function isCrossCurrencyTransfer(
  from: Currency | null | undefined,
  to: Currency | null | undefined,
): boolean {
  if (from == null || to == null) return false;
  return from !== to;
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

/**
 * Interpreta el campo `currency` de un cuerpo JSON (alta o edición de cuenta).
 *
 * Tres estados, igual que `parseDayOfMonth` en las cuentas: "no vino" (`null`)
 * y "vino mal" (`"invalid"`) no son lo mismo. El primero se resuelve con el
 * default (alta) o se ignora (edición); el segundo es un 400 con mensaje,
 * porque adivinar la moneda sería guardar el número en la unidad equivocada.
 *
 * Un `null` o `""` explícitos cuentan como "no vino": los formularios mandan
 * todos los campos y un campo vacío no es una moneda.
 */
export function parseCurrencyBody(value: unknown): Currency | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return isCurrency(value) ? value : "invalid";
}
