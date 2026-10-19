/**
 * Sugerencias de descripción para la carga rápida (Fase 7 ronda 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO NO VIVE EN EL ENDPOINT
 * ─────────────────────────────────────────────────────────────────────────────
 * La parte difícil no es consultar la base: es decidir QUÉ es la misma
 * descripción ("Café" y "cafe" son la misma), cuál es el monto típico (mediana,
 * no promedio) y cómo se ordenan dos candidatos que matchean igual. Todo eso se
 * puede probar sin PostgreSQL ni navegador, así que vive acá.
 *
 * El endpoint sólo acota la consulta (tipo, ventana de filas, límite) y le pasa
 * las filas a `buildDescriptionSuggestions`.
 */

import type { MovementKindDTO } from "./finance";

/** Cuántas sugerencias devuelve el endpoint por defecto. */
export const DESCRIPTION_SUGGESTION_LIMIT = 6;

/**
 * Cuántos movimientos recientes se miran para armar las sugerencias.
 *
 * No se trae "todo el histórico": la carga rápida sugiere lo que la persona
 * viene usando, y una ventana acotada mantiene el endpoint barato. El tope es
 * visible en la documentación y en el informe; no es un número escondido.
 */
export const DESCRIPTION_SUGGESTION_SCAN = 400;

/** Lo mínimo que este módulo necesita de una fila de movimiento. */
export interface SuggestionMovementLike {
  kind: MovementKindDTO;
  /** Monto decimal como string (el DTO de Prisma ya lo serializa así). */
  amount: string;
  /** Fecha de calendario `YYYY-MM-DD`. */
  date: string;
  description: string;
  account: { id: string; name: string; archived: boolean };
  toAccount: { id: string; name: string; archived: boolean } | null;
  category: { id: string; name: string; kind: "INCOME" | "EXPENSE" } | null;
}

/** Una sugerencia lista para precargar el formulario. */
export interface DescriptionSuggestionDTO {
  /** Texto para mostrar y poner en el campo. */
  description: string;
  kind: MovementKindDTO;
  /** Monto típico (mediana) como string decimal exacto. */
  amount: string;
  /** Cuántos movimientos de la ventana comparten esta descripción. */
  frequency: number;
  /** La fecha más reciente del grupo, `YYYY-MM-DD`. */
  lastDate: string;
  /** Categoría más frecuente del grupo, o `null`. */
  category: { id: string; name: string } | null;
  /** Cuenta de origen más frecuente. */
  account: { id: string; name: string };
  /** Sólo TRANSFER: destino más frecuente. */
  toAccount: { id: string; name: string } | null;
}

/**
 * Normaliza una descripción para agrupar y buscar.
 *
 * Es la misma idea que `normalizeCategoryName`: minúsculas, sin acentos y con
 * los espacios colapsados. "  Café  con leche " y "cafe con leche" son la misma
 * cosa para quien escribe rápido en el celular.
 */
export function normalizeDescription(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Qué tan bien matchea una descripción, de mejor a peor, o `-1` si no matchea.
 *
 *   2 · prefijo:   "caf" → "Café con leche"
 *   1 · palabra:   "leche" → "Café con leche"
 *   0 · subcadena: "afe" → "Café con leche"
 *  -1 · no matchea.
 *
 * La escala es la misma que la de categorías: lo que la persona escribió desde
 * el principio de la descripción tiene que ganar.
 */
function matchScore(normalizedName: string, normalizedQuery: string): number {
  if (normalizedQuery === "") return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 2;
  if (normalizedName.includes(` ${normalizedQuery}`)) return 1;
  return normalizedName.includes(normalizedQuery) ? 0 : -1;
}

/**
 * Convierte un monto decimal exacto a centavos enteros.
 *
 * Se usa `bigint` y no `number` por el mismo motivo que todo el resto de la
 * app: la mediana de una lista de montos no puede arrastrar error binario. Los
 * montos de la base tienen dos decimales; si llegara más precisión se rechaza
 * en vez de redondear en silencio.
 */
export function amountToCents(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Monto inválido para la mediana: ${value}`);
  }

  const sign = match[1] === "-" ? BigInt(-1) : BigInt(1);
  const integer = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (integer * BigInt(100) + fraction);
}

/** El inverso exacto de `amountToCents`. */
export function centsToAmount(cents: bigint): string {
  const sign = cents < BigInt(0) ? "-" : "";
  const absolute = cents < BigInt(0) ? -cents : cents;
  const integer = absolute / BigInt(100);
  const fraction = absolute % BigInt(100);
  return `${sign}${integer}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Divide por dos con redondeo bancario (half-even) al centavo.
 *
 * La mediana de una cantidad PAR de montos es el promedio de los dos del
 * medio, y ese promedio puede caer en medio centavo. `BigInt` no tiene
 * decimales, así que la decisión se toma acá: half-even reparte el error en vez
 * de sesgarlo siempre hacia arriba, igual que `round` en lib/money.ts.
 */
function halfEvenDivideByTwo(value: bigint): bigint {
  const two = BigInt(2);
  const quotient = value / two;
  const remainder = value % two;
  if (remainder === BigInt(0)) return quotient;

  // remainder === 1n (los montos son positivos): el cociente exacto es
  // quotient + 0,5. Half-even redondea al entero par más cercano.
  return quotient % two === BigInt(0) ? quotient : quotient + BigInt(1);
}

/**
 * La mediana de una lista de montos, como string decimal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ MEDIANA Y NO PROMEDIO
 * ─────────────────────────────────────────────────────────────────────────────
 * El monto "típico" tiene que resistir un outlier. Si la persona cargó una vez
 * el súper de $ 150.000 y veinte veces el café de $ 1.500, el promedio diría
 * "$ 8.571" — un número que no es el café ni el súper. La mediana devuelve
 * $ 1.500: el valor que efectivamente se repite.
 *
 * Con cantidad impar es el valor del medio; con cantidad par, el promedio de
 * los dos del medio, redondeado half-even al centavo.
 */
export function medianAmount(amounts: readonly string[]): string {
  if (amounts.length === 0) return "0.00";

  const sorted = amounts.map(amountToCents).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return centsToAmount(sorted[middle]);

  return centsToAmount(halfEvenDivideByTwo(sorted[middle - 1] + sorted[middle]));
}

/** Candidato que se repite dentro de un grupo (cuenta, categoría, destino). */
interface Candidate {
  id: string;
  name: string;
  count: number;
  lastDate: string;
}

function pushCandidate(
  map: Map<string, Candidate>,
  value: { id: string; name: string },
  date: string,
): void {
  const current = map.get(value.id);
  if (!current) {
    map.set(value.id, { ...value, count: 1, lastDate: date });
    return;
  }
  current.count += 1;
  if (date > current.lastDate) current.lastDate = date;
}

/**
 * El candidato más frecuente; empate → el usado más recientemente; empate →
 * orden estable por nombre para que dos recargas den lo mismo.
 */
function pickCandidate(map: Map<string, Candidate>): Candidate | null {
  const candidates = [...map.values()];
  candidates.sort(
    (a, b) =>
      b.count - a.count ||
      (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
      a.name.localeCompare(b.name, "es"),
  );
  return candidates[0] ?? null;
}

interface Group {
  normalized: string;
  kind: MovementKindDTO;
  /** Cuántas veces aparece cada variante cruda, para elegir la que se muestra. */
  variants: Map<string, { count: number; lastDate: string }>;
  amounts: string[];
  categories: Map<string, Candidate>;
  accounts: Map<string, Candidate>;
  toAccounts: Map<string, Candidate>;
  frequency: number;
  lastDate: string;
}

/**
 * Arma las sugerencias a partir de movimientos YA filtrados por tipo.
 *
 * Reglas:
 *   · Se agrupa por `normalizeDescription`; se muestra la variante más repetida
 *     (empate: la más reciente).
 *   · La categoría y la cuenta son las más frecuentes del grupo (empate: la más
 *     reciente). La categoría de un grupo de INCOME/EXPENSE nunca se mezcla con
 *     la del tipo contrario: sólo se consideran filas del tipo pedido.
 *   · Se descartan cuentas archivadas y sugerencias sin cuenta de origen
 *     utilizable: precargar una cuenta que el formulario no ofrece dejaría el
 *     select en un estado inválido.
 *   · En TRANSFER, el destino elegido NUNCA es la cuenta de origen: con pares
 *     mezclados en la ventana (A→B, A→C, C→A) el origen más frecuente y el
 *     destino más reciente pueden coincidir y el formulario no puede precargar
 *     una transferencia de una cuenta a sí misma.
 *   · Orden: match con la query → frecuencia → recencia → nombre.
 */
export function buildDescriptionSuggestions(
  movements: readonly SuggestionMovementLike[],
  query: string,
  limit: number = DESCRIPTION_SUGGESTION_LIMIT,
): DescriptionSuggestionDTO[] {
  const groups = new Map<string, Group>();

  for (const movement of movements) {
    const normalized = normalizeDescription(movement.description);
    if (normalized === "") continue;
    if (movement.account.archived) continue;
    if (movement.kind === "TRANSFER" && (!movement.toAccount || movement.toAccount.archived)) {
      continue;
    }

    // El tipo forma parte de la clave A PROPÓSITO. El endpoint ya filtra por
    // tipo, pero esta función es pura y no debería producir un grupo mestizo si
    // alguien la llama con una lista mezclada: la categoría y la cuenta de un
    // ingreso no pueden precargar un gasto.
    const groupKey = `${movement.kind}|${normalized}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        normalized,
        kind: movement.kind,
        variants: new Map(),
        amounts: [],
        categories: new Map(),
        accounts: new Map(),
        toAccounts: new Map(),
        frequency: 0,
        lastDate: movement.date,
      };
      groups.set(groupKey, group);
    }

    group.frequency += 1;
    group.amounts.push(movement.amount);
    if (movement.date > group.lastDate) group.lastDate = movement.date;

    const variant = group.variants.get(movement.description);
    if (variant) {
      variant.count += 1;
      if (movement.date > variant.lastDate) variant.lastDate = movement.date;
    } else {
      group.variants.set(movement.description, {
        count: 1,
        lastDate: movement.date,
      });
    }

    pushCandidate(group.accounts, movement.account, movement.date);
    if (movement.kind === "TRANSFER" && movement.toAccount) {
      pushCandidate(group.toAccounts, movement.toAccount, movement.date);
    }
    if (movement.category && movement.category.kind === movement.kind) {
      pushCandidate(group.categories, movement.category, movement.date);
    }
  }

  const normalizedQuery = normalizeDescription(query);

  const scored = [...groups.values()]
    .map((group) => ({
      group,
      score: matchScore(group.normalized, normalizedQuery),
    }))
    .filter((entry) => entry.score >= 0);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.group.frequency - a.group.frequency ||
      (a.group.lastDate < b.group.lastDate
        ? 1
        : a.group.lastDate > b.group.lastDate
          ? -1
          : 0) ||
      a.group.normalized.localeCompare(b.group.normalized, "es"),
  );

  return scored.slice(0, Math.max(0, limit)).map(({ group }) => {
    const variant = [...group.variants.entries()].sort(
      ([nameA, a], [nameB, b]) =>
        b.count - a.count ||
        (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
        nameA.localeCompare(nameB, "es"),
    )[0][0];

    const account = pickCandidate(group.accounts);
    const category = pickCandidate(group.categories);
    // El destino no puede ser la MISMA cuenta que el origen: con pares
    // mezclados en la ventana (A→B vieja, A→C media, C→A nueva) el origen más
    // frecuente y el destino más reciente pueden coincidir, y el formulario no
    // tiene forma de precargar una transferencia de una cuenta a sí misma (el
    // cliente cae al destino por defecto y la precarga se pierde). Se descarta
    // ese candidato antes de elegir: gana el siguiente destino real del grupo.
    if (account) group.toAccounts.delete(account.id);
    const toAccount = pickCandidate(group.toAccounts);

    return {
      description: variant,
      kind: group.kind,
      amount: medianAmount(group.amounts),
      frequency: group.frequency,
      lastDate: group.lastDate,
      // `account` no puede ser null: toda fila tiene cuenta y las archivadas se
      // descartaron arriba. El fallback es defensa de tipos, no un caso real.
      account: account
        ? { id: account.id, name: account.name }
        : { id: "", name: "" },
      category: category ? { id: category.id, name: category.name } : null,
      toAccount: toAccount ? { id: toAccount.id, name: toAccount.name } : null,
    };
  });
}
