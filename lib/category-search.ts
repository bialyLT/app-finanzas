/**
 * La búsqueda de categorías de la carga rápida (Fase 7).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO ES UN `filter` CON `.includes()` EN EL COMPONENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Tres cosas de esta pantalla son lógica, no dibujo:
 *
 *   1. QUÉ matchea. La comparación es por nombre NORMALIZADO —sin mayúsculas,
 *      sin acentos, con espacios colapsados—, la misma función que usa el
 *      servidor para deduplicar (`normalizeCategoryName`). Si acá se comparara
 *      distinto, la persona escribiría "cafe", vería el aviso de que se CREA
 *      una categoría nueva, y el servidor la reutilizaría: dos verdades para la
 *      misma acción.
 *   2. EL ORDEN de las sugerencias. Primero las que EMPIEZAN con lo escrito,
 *      después las que contienen una palabra que empieza así, y al final las
 *      que sólo lo contienen en el medio. Después desempata la RECENCIA: la
 *      categoría del próximo gasto suele ser una de las últimas que se usó
 *      (`lastUsedAt`).
 *   3. El ORDEN SIN BÚSQUEDA: las últimas usadas, primero.
 *
 * Adentro de un `useMemo` del formulario nada de esto se puede testear sin un
 * navegador. Acá se testea con Node.
 */

import { normalizeCategoryName, type CategoryDTO } from "./finance";

/** Cuántas sugerencias se muestran: las mismas que usa el formulario. */
export const CATEGORY_SUGGESTION_LIMIT = 6;

/**
 * Qué tan bien matchea una categoría, de mejor a peor, o `-1` si no matchea.
 *
 *   2 · prefijo:       "com" → "Comida"
 *   1 · palabra:       "sue" → "Pago sueldo"   (una palabra EMPIEZA con la query)
 *   0 · subcadena:     "ida" → "Comida"        (aparece en el medio de algo)
 *  -1 · no matchea.
 *
 * La escala existe para que lo que la persona escribió "desde el principio" de
 * la categoría gane: tipear "com" y ver "Transporte (consumo)" antes que
 * "Comida" sería ordenar por casualidad.
 */
function matchScore(normalizedName: string, normalizedQuery: string): number {
  if (normalizedQuery === "") return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 2;
  // Con los espacios ya colapsados (normalizeCategoryName), "una palabra que
  // empieza con la query" es exactamente "espacio + query".
  if (normalizedName.includes(` ${normalizedQuery}`)) return 1;
  return normalizedName.includes(normalizedQuery) ? 0 : -1;
}

/**
 * Comparator de recencia: la más nueva primero; `null` (sin uso registrado) al
 * final; y el nombre alfabético como último desempate para que el orden sea
 * SIEMPRE el mismo entre recargas.
 *
 * Las fechas viajan como `"YYYY-MM-DD"`, así que comparar strings es comparar
 * fechas — sin `new Date` de por medio y sin el corrimiento de un día que trae
 * parsear el formato ISO como instante.
 */
function byRecencyThenName(
  a: Pick<CategoryDTO, "name" | "lastUsedAt">,
  b: Pick<CategoryDTO, "name" | "lastUsedAt">,
): number {
  if (a.lastUsedAt !== b.lastUsedAt) {
    if (a.lastUsedAt === null) return 1;
    if (b.lastUsedAt === null) return -1;
    // `a < b` → `a` es más vieja → va después (positivo).
    return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
  }
  return a.name.localeCompare(b.name, "es");
}

/**
 * Las categorías sugeridas para lo que se está escribiendo, ya ordenadas y
 * cortadas a `limit`.
 *
 * Con la query vacía devuelve las últimas usadas (y a las nunca usadas al
 * final): abrir el formulario y tocar la primera sugerencia es el camino más
 * corto, así que la primera tiene que ser la más probable.
 *
 * La lista que entra ya viene filtrada por tipo (INCOME o EXPENSE) por quien
 * llama: acá no se mira `category.kind` porque el tipo activo es una decisión
 * del formulario, no de la búsqueda.
 */
export function searchCategories(
  categories: readonly CategoryDTO[],
  query: string,
  limit: number = CATEGORY_SUGGESTION_LIMIT,
): CategoryDTO[] {
  const normalizedQuery = normalizeCategoryName(query);

  const scored = categories
    .map((category) => ({
      category,
      score: matchScore(normalizeCategoryName(category.name), normalizedQuery),
    }))
    .filter((entry) => entry.score >= 0);

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : byRecencyThenName(a.category, b.category),
  );

  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.category);
}

/**
 * La categoría existente que corresponde a ese nombre escrito, o `null`.
 *
 * Es el chequeo que decide el aviso "se usa la existente" / "se crea una
 * nueva". Compara contra TODAS las categorías (no sólo las del tipo activo) y
 * a propósito: el servidor deduplica por `normalizedName`, que es único en toda
 * la tabla — si se comparara sólo contra las del tipo, el aviso podría decir
 * "se crea" y el servidor reutilizar una existente. El aviso tiene que decir lo
 * que va a pasar de verdad.
 */
export function findCategoryByName(
  categories: readonly CategoryDTO[],
  name: string,
): CategoryDTO | null {
  const normalized = normalizeCategoryName(name);
  if (normalized === "") return null;
  return (
    categories.find(
      (category) => normalizeCategoryName(category.name) === normalized,
    ) ?? null
  );
}
