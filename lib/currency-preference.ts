/**
 * La moneda de TRABAJO elegida por la persona (no la de una cuenta).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTAS REGLAS VIVEN ACÁ Y NO EN EL COMPONENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * El selector es UI, pero las decisiones que toma son de dominio:
 *
 *   · sólo se puede elegir una moneda HABILITADA;
 *   · si la moneda guardada ya no está habilitada (la persona deshabilitó
 *     dólares), la app no puede quedarse mostrando una pantalla vacía: cae a
 *     la primera habilitada;
 *   · con una sola moneda habilitada no hay nada que elegir y el control no se
 *     muestra.
 *
 * Probar eso contra un DOM no agrega nada; son funciones puras y así se pueden
 * verificar de verdad, incluidos los casos hostiles (`null`, basura, una
 * moneda apagada).
 */

import type { Currency } from "@prisma/client";
import { DEFAULT_CURRENCY, isCurrency } from "./currency";

/**
 * La clave de `localStorage`.
 *
 * Vive acá, y no escrita en el componente, para que la lectura y la escritura
 * usen EXACTAMENTE la misma clave. Un espacio de diferencia y la preferencia
 * se pierde en silencio — que es indistinguible de "no funciona".
 */
export const CURRENCY_STORAGE_KEY = "finanzas.moneda";

/**
 * El evento con el que el modal de configuración avisa que cambió la lista.
 *
 * Los dos componentes viven en árboles distintos (el modal cuelga del header y
 * cada selector de su pantalla), así que no comparten estado de React. Un
 * evento del `window` es la comunicación mínima: el selector vuelve a pedir la
 * lista y, si su moneda quedó apagada, cae a una habilitada.
 */
export const CURRENCIES_CHANGED_EVENT = "finanzas:monedas-cambiadas";

/** `true` sólo si la moneda está en la lista de habilitadas. */
export function isCurrencyEnabled(
  currency: unknown,
  enabled: readonly Currency[],
): currency is Currency {
  return isCurrency(currency) && enabled.includes(currency);
}

/**
 * La moneda que la pantalla tiene que usar.
 *
 * Preferencia guardada si sigue habilitada; si no, la primera habilitada (el
 * orden del enum, que es el que devuelve la API). Nunca una moneda apagada:
 * pedir reportes en dólares con dólares apagados mostraría una pantalla vacía
 * que parece un bug.
 *
 * `stored` es `unknown` a propósito: `localStorage` es texto que cualquiera
 * pudo editar, y un valor raro no puede romper el render.
 */
export function resolveSelectedCurrency(
  enabled: readonly Currency[],
  stored: unknown,
): Currency {
  if (isCurrencyEnabled(stored, enabled)) return stored;
  return enabled[0] ?? DEFAULT_CURRENCY;
}

/**
 * ¿Hay algo que elegir?
 *
 * Con una sola moneda habilitada, el selector sería un control con una única
 * opción: ocupa lugar, invita a un tap que no hace nada y comunica que hay una
 * decisión donde no la hay. Se oculta.
 */
export function shouldShowCurrencySelector(
  enabled: readonly Currency[],
): boolean {
  return enabled.length > 1;
}
