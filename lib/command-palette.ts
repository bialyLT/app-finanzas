/**
 * Paleta de comandos (`Ctrl+K`) · Fase 7 ronda 2.
 *
 * La parte que se puede probar sin navegador vive acá: qué matchea, cómo se
 * ordena, cómo se mueve el índice activo y cuándo el atajo debe dispararse.
 * El componente sólo dibuja y ejecuta.
 */

/** Una acción o un favorito dentro de la paleta. */
export interface PaletteItem {
  /** Id estable (el de la acción o el de la plantilla). */
  id: string;
  /** Texto principal visible y buscable. */
  label: string;
  /** Texto secundario (tipo de movimiento, cuenta, etc.). */
  hint?: string;
  /** Grupo visible: "Acciones", "Pantallas", "Plantillas". */
  group: string;
  /** Palabras extra para buscar (alias, categoría, cuenta). */
  keywords?: string;
  /** Una plantilla con cuenta archivada se muestra, pero no se puede usar. */
  disabled?: boolean;
}

/**
 * Normaliza para comparar: minúsculas, sin acentos y con espacios colapsados.
 * Misma idea que `normalizeCategoryName`, pero acá no se importa nada de la
 * capa de finanzas para que el módulo siga siendo puro y chico.
 */
export function normalizePaletteText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Puntaje de coincidencia, de mejor a peor, o `-1` si no coincide.
 *
 *   4 · el label empieza con la búsqueda
 *   3 · alguna palabra del label empieza con la búsqueda
 *   2 · el label la contiene
 *   1 · sólo aparece en `keywords` o `hint`
 *  -1 · no coincide
 *
 * El orden importa: escribir "gas" tiene que poner "Nuevo gasto" arriba de
 * "Ir a Análisis" aunque las dos contengan las letras en otro lado.
 */
function matchScore(item: PaletteItem, normalizedQuery: string): number {
  if (normalizedQuery === "") return 0;

  const label = normalizePaletteText(item.label);
  if (label.startsWith(normalizedQuery)) return 4;
  if (label.split(" ").some((word) => word.startsWith(normalizedQuery))) return 3;
  if (label.includes(normalizedQuery)) return 2;

  const extra = normalizePaletteText(`${item.keywords ?? ""} ${item.hint ?? ""}`);
  return extra.includes(normalizedQuery) ? 1 : -1;
}

/**
 * Filtra y ordena, conservando el orden original para los empates.
 *
 * `limit` no es decorativo: la paleta es una ayuda para llegar rápido, no un
 * listado exhaustivo. Una lista de 60 favoritos con scroll no se navega con
 * flechas.
 */
export function filterPaletteItems<T extends PaletteItem>(
  items: readonly T[],
  query: string,
  limit = 12,
): T[] {
  const normalizedQuery = normalizePaletteText(query);

  return items
    .map((item, index) => ({ item, index, score: matchScore(item, normalizedQuery) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

/**
 * Mueve el índice activo con wrap-around. Con lista vacía devuelve `-1`.
 *
 * El wrap es deliberado: en una lista corta, bajar desde el último elemento y
 * volver al primero es más rápido que subir por toda la lista.
 */
export function movePaletteIndex(
  current: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

/** Las teclas que el atajo acepta como "K" (con o sin mayúscula). */
export function isPaletteShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  // `Ctrl+K` en Windows/Linux y `Cmd+K` en macOS. Alt o Shift cambiarían el
  // significado (Ctrl+Shift+K suele ser "borrar línea" en editores), así que
  // no se roban.
  if (event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === "k";
}
