/**
 * Consultas compartidas y conversión de filas de Prisma a DTOs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE MÓDULO
 * ─────────────────────────────────────────────────────────────────────────────
 * Tres rutas de API distintas necesitan devolver movimientos, y las tres
 * necesitan el mismo `include`, el mismo orden y la misma conversión a DTO. Si
 * cada una arma su propia versión, tarde o temprano una se olvida de incluir
 * `toAccount` y el cliente recibe `undefined` donde esperaba `null` — un bug que
 * sólo aparece en la pantalla que usa esa ruta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA CONVERSIÓN ES EXPLÍCITA Y NO UN `JSON.stringify` DIRECTO
 * ─────────────────────────────────────────────────────────────────────────────
 * Devolver las filas de Prisma tal cual parece más corto y funciona... hasta que
 * mirás lo que viaja:
 *
 *   · `Decimal`  → serializa a string, pero el tipo declarado miente (dice
 *                  `number`), así que el cliente hace aritmética sobre un string
 *                  y obtiene `"1000" + "2000" = "10002000"`.
 *   · fechas     → `@db.Date` viaja como ISO en UTC: `"2026-10-15T00:00:00.000Z"`,
 *                  que en Buenos Aires es el 14 de octubre. Un día menos.
 *   · campos nulos → `toAccountId: null` Y `toAccount: null`: dos formas de decir
 *                  lo mismo, y el cliente tiene que saber cuál usar.
 *
 * Convirtiendo de forma explícita, el DTO es chico, tiene los tipos que dice
 * tener, y las fechas son strings de calendario que no se corrompen al viajar.
 */

import type { Prisma } from "@prisma/client";
import type { Db } from "./balance";
import { dbToCalendar } from "./dates";
import type {
  AccountDTO,
  CategoryDTO,
  MovementDTO,
  PeriodTotalsDTO,
} from "./finance";

/**
 * Relaciones que hay que traer siempre para armar un MovementDTO.
 *
 * Es una constante y no un objeto repetido en cada ruta para que agregar una
 * relación nueva sea un cambio en UN lugar.
 */
export const movementInclude = {
  account: true,
  toAccount: true,
  category: true,
} as const satisfies Prisma.MovementInclude;

/**
 * Totales de un conjunto de movimientos, agregados **en la base**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO NO ES UN `reduce` EN EL CLIENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque las listas de movimientos están topeadas (ver `MOVEMENTS_MAX_ROWS`) y
 * los totales no pueden estarlo. Un panel que suma la lista que recibió da
 * números subestimados en cuanto el período pasa el tope — y los da con la misma
 * cara de confianza que los correctos, que es lo peligroso.
 *
 * Ésta es la función que hace que el tope limite lo que se **muestra** y no lo
 * que se **calcula**: recibe el mismo `where` que la consulta de la lista, pero
 * ningún `take`.
 *
 * El `groupBy` por `kind` saca los tres totales y los tres contadores en **una**
 * sola consulta en vez de seis, y como agrupa por tipo, los grupos son mutuamente
 * excluyentes: un movimiento no puede contarse dos veces.
 *
 * @param db Cliente de Prisma inyectado, igual que en `lib/balance.ts`. Existe
 *           para que los tests de integración puedan apuntarlo a
 *           `finanzas_test` en vez de a la base de desarrollo.
 */
export async function movementTotals(
  db: Db,
  where: Prisma.MovementWhereInput,
): Promise<PeriodTotalsDTO> {
  const grouped = await db.movement.groupBy({
    by: ["kind"],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  // Se arranca en cero y no en vacío para que un período sin movimientos tenga la
  // misma forma que uno con movimientos: quien consume no tiene que distinguir
  // "no hay datos" de "el campo no vino".
  const totals: PeriodTotalsDTO = {
    income: "0.00",
    expenses: "0.00",
    transfers: "0.00",
    incomeCount: 0,
    expenseCount: 0,
    transferCount: 0,
  };

  for (const row of grouped) {
    // `_sum.amount` llega `null` cuando no hay ninguna fila de ese tipo: en SQL la
    // suma de un conjunto vacío es NULL, no 0. Es un caso real —un mes sin
    // transferencias— y sin este chequeo reventaría al llamar `.toFixed`.
    const amount = row._sum.amount === null ? "0.00" : row._sum.amount.toFixed(2);

    if (row.kind === "INCOME") {
      totals.income = amount;
      totals.incomeCount = row._count._all;
    } else if (row.kind === "EXPENSE") {
      totals.expenses = amount;
      totals.expenseCount = row._count._all;
    } else {
      totals.transfers = amount;
      totals.transferCount = row._count._all;
    }
  }

  return totals;
}

type MovementRow = Prisma.MovementGetPayload<{ include: typeof movementInclude }>;
type AccountRow = MovementRow["account"];
type CategoryRow = NonNullable<MovementRow["category"]>;

/**
 * Fila de cuenta, o cualquier cosa con la misma forma.
 *
 * Se declara ESTRUCTURALMENTE y no como `Prisma.Account` a propósito: así la
 * misma función sirve para convertir una fila cruda de Prisma Y para armar el
 * DTO desde un `AccountBalance` calculado (ver lib/balance.ts), sin que ninguno
 * de los dos tenga que fingir ser el otro con un cast.
 *
 * `openingBalance` acepta el `Decimal` de Prisma o directamente un string,
 * porque en el camino de los saldos el valor ya viene formateado.
 */
export interface AccountRowLike {
  id: string;
  name: string;
  kind: "CASH" | "BANK" | "CREDIT_CARD" | "LOAN";
  archived: boolean;
  openingBalance: { toFixed(dp: number): string } | string;
}

export function toAccountDTO(account: AccountRowLike): AccountDTO {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    archived: account.archived,
    // `toFixed(2)` y no `toString()`: si el saldo guardado es "0", `toString()`
    // devuelve "0" y el cliente que espera dos decimales muestra "0" en vez de
    // "0,00". La representación tiene que ser estable.
    openingBalance:
      typeof account.openingBalance === "string"
        ? account.openingBalance
        : account.openingBalance.toFixed(2),
  };
}

export function toCategoryDTO(category: CategoryRow): CategoryDTO {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind,
  };
}

export function toMovementDTO(movement: MovementRow): MovementDTO {
  return {
    id: movement.id,
    kind: movement.kind,
    amount: movement.amount.toFixed(2),
    // `dbToCalendar` y NO `toISOString().slice(0, 10)`: el segundo convierte a
    // UTC y con offset negativo devuelve el día anterior.
    date: dbToCalendar(movement.date),
    description: movement.description,
    account: toAccountDTO(movement.account),
    toAccount: movement.toAccount ? toAccountDTO(movement.toAccount) : null,
    category: movement.category ? toCategoryDTO(movement.category) : null,
  };
}

/**
 * Todo el texto disponible de un error, en un solo string.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO ALCANZA CON `error.meta.message`
 * ─────────────────────────────────────────────────────────────────────────────
 * `meta` sólo existe cuando Prisma RECONOCE el error. Para los códigos que no
 * tiene mapeados arma un error genérico con `user_facing_error: None` y mete el
 * texto de Postgres adentro de `error.message`.
 *
 * Y cuál es el código de las restricciones CHECK? El `23514`. Verificado contra
 * el servidor real:
 *
 *     Error occurred during query execution:
 *     ConnectorError(ConnectorError {
 *       user_facing_error: None,
 *       kind: QueryError(PostgresError { code: "23514", message: "...", ... })
 *     })
 *
 * O sea: `meta.message` es `undefined` justo para los errores que más falta hace
 * explicar. La primera versión de esta función leía sólo `meta` y por eso el
 * rechazo del trigger llegaba a la interfaz como un genérico "No se pudo
 * guardar el movimiento".
 *
 * Leyendo los dos caminos, funciona con los errores tipados Y con los que no.
 */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";

  const parts: string[] = [];

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") parts.push(message);

  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta === "object" && meta !== null) {
    const metaMessage = (meta as { message?: unknown }).message;
    if (typeof metaMessage === "string") parts.push(metaMessage);

    const target = (meta as { target?: unknown }).target;
    if (Array.isArray(target)) parts.push(target.join(","));
    else if (typeof target === "string") parts.push(target);
  }

  return parts.join("\n");
}

/**
 * Las reglas del dominio que la base hace cumplir, y qué decirle a la persona
 * cuando se violan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SE BUSCAN MARCADORES Y NO FRASES EN CASTELLANO
 * ─────────────────────────────────────────────────────────────────────────────
 * La tentación es buscar el texto del mensaje: `text.includes("No se puede
 * registrar un ingreso")`. Es lo primero que uno escribe y es una trampa,
 * porque ata el comportamiento de la aplicación a una frase escrita para que la
 * lea una persona.
 *
 * El día que se reescribe el mensaje para que se entienda mejor —una mejora, en
 * principio— el mapeo deja de coincidir y el error vuelve a mostrarse como 500.
 * Y nadie lo nota: no hay ningún test que conecte la redacción del mensaje con
 * el comportamiento de la interfaz.
 *
 * Por eso se busca un identificador que NO se reescribe nunca:
 *
 *   · Restricciones CHECK → Postgres incluye el nombre del constraint en el
 *     mensaje (`violates check constraint "movement_amount_positive"`), así que
 *     el nombre ya es un marcador estable y no hace falta agregar nada.
 *   · El trigger → no tiene nombre en el mensaje, así que lo agrega él mismo
 *     entre corchetes (ver la migración `marcadores_de_error_estables`).
 *
 * La explicación para la persona vive en `message`, y se puede cambiar sin
 * tocar `marker`.
 */
const DOMAIN_RULES: { marker: string; status: number; message: string }[] = [
  {
    marker: "movement_amount_positive",
    status: 400,
    message: "El monto tiene que ser mayor a cero.",
  },
  {
    marker: "movement_shape_by_kind",
    status: 400,
    message:
      "Los datos no corresponden a ese tipo de movimiento: una transferencia no lleva categoría, y un ingreso o un gasto no llevan cuenta de destino.",
  },
  {
    marker: "movement_transfer_to_other_account",
    status: 400,
    message: "Una transferencia tiene que ir a una cuenta distinta.",
  },
  {
    marker: "loan_has_parameters",
    status: 400,
    message:
      "Un préstamo necesita monto, tasa y cantidad de cuotas para poder calcular el interés de cada cuota. Sin eso, la app volvería a contar la cuota entera como gasto.",
  },
  {
    marker: "loan_parameters_only_on_loans",
    status: 400,
    message:
      "Los datos de préstamo (monto, tasa, cuotas) sólo se cargan en cuentas de tipo préstamo.",
  },
  {
    marker: "[finanzas:pasivo_no_recibe_ingreso]",
    status: 400,
    message:
      "No se puede registrar un ingreso en un préstamo o una tarjeta. Si te desembolsaron un préstamo, registralo como una transferencia desde la cuenta del préstamo hacia tu cuenta de dinero.",
  },
];

/**
 * Traduce un error de la base a un mensaje que se entiende.
 *
 * Devuelve `null` si el error no corresponde a una regla conocida, para que
 * quien llama decida qué hacer (normalmente, un 500 genérico).
 */
export function describeDatabaseError(error: unknown): {
  status: number;
  message: string;
} | null {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";

  const text = errorText(error);

  // ── Errores que Prisma sí reconoce y trae con código ───────────────────────
  switch (code) {
    case "P2002": {
      // Violación de índice único.
      if (text.includes("normalizedName")) {
        return { status: 409, message: "Ya existe una categoría con ese nombre." };
      }
      if (text.includes("name")) {
        return { status: 409, message: "Ya existe una cuenta con ese nombre." };
      }
      return { status: 409, message: "Ese dato ya existe." };
    }

    case "P2003":
      return {
        status: 409,
        message:
          "La cuenta tiene movimientos asociados. Archivala en vez de borrarla para no perder el historial.",
      };

    case "P2014":
      return {
        status: 409,
        message:
          "Ese cambio dejaría movimientos sin cuenta. Archivala en vez de borrarla.",
      };
  }

  // ── Reglas del dominio, por marcador estable ───────────────────────────────
  for (const rule of DOMAIN_RULES) {
    if (text.includes(rule.marker)) {
      return { status: rule.status, message: rule.message };
    }
  }

  return null;
}
