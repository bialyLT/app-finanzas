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
import { calendarToDb, dbToCalendar, type CalendarDate } from "./dates";
import type {
  AccountDTO,
  CategoryBreakdownDTO,
  CategoryDTO,
  DateBreakdownDTO,
  MovementDTO,
  PeriodTotalsDTO,
} from "./finance";
import { sum, zero } from "./money";

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
 * El `cashFlow` del DTO NO se deriva acá: sale de `movementCashFlow`, que es la
 * única implementación de la fórmula del §5.2 del ROADMAP. Así el panel y
 * `/api/reports` no pueden divergir en el mismo número.
 *
 * @param db Cliente de Prisma inyectado, igual que en `lib/balance.ts`. Existe
 *           para que los tests de integración puedan apuntarlo a
 *           `finanzas_test` en vez de a la base de desarrollo.
 */
export async function movementTotals(
  db: Db,
  where: Prisma.MovementWhereInput,
): Promise<PeriodTotalsDTO> {
  // El `groupBy` y el flujo de caja no dependen entre sí: van en paralelo.
  const [grouped, cashFlow] = await Promise.all([
    db.movement.groupBy({
      by: ["kind"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    movementCashFlow(db, where),
  ]);

  // Se arranca en cero y no en vacío para que un período sin movimientos tenga la
  // misma forma que uno con movimientos: quien consume no tiene que distinguir
  // "no hay datos" de "el campo no vino".
  const totals: PeriodTotalsDTO = {
    income: "0.00",
    expenses: "0.00",
    transfers: "0.00",
    cashFlow,
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

/**
 * Cuentas de dinero ("activo"): donde el saldo es plata disponible.
 *
 * Es la definición de "cuenta activo" del §5.2 del ROADMAP escrita una sola
 * vez. Tarjeta y préstamo quedan afuera porque su saldo es deuda, no liquidez.
 * Se declara como `AccountWhereInput` para que los literales "CASH"/"BANK"
 * queden tipados contra el enum sin casts.
 */
const moneyAccount: Prisma.AccountWhereInput = { kind: { in: ["CASH", "BANK"] } };

/**
 * Flujo de caja (liquidez) del período, como string decimal exacto.
 *
 *     entradas = Σ INCOME con cuenta en efectivo/banco
 *              + Σ TRANSFER cuyo DESTINO es efectivo/banco
 *     salidas  = Σ EXPENSE con cuenta en efectivo/banco
 *              + Σ TRANSFER cuyo ORIGEN es efectivo/banco
 *     flujo    = entradas − salidas
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LAS TRANSFERENCIAS SE MIRAN POR LAS DOS PUNTAS
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirar sólo el origen haría desaparecer la plata que llega al banco desde un
 * préstamo; mirar sólo el destino haría desaparecer la que sale a pagar la
 * deuda. Mirando las dos, cada transferencia se resuelve sola:
 *
 *   · Banco → efectivo: suma como entrada por el destino Y como salida por el
 *     origen. Neto CERO, que es exactamente lo que pasó — la plata cambió de
 *     lugar, no entró ni salió del sistema.
 *   · Préstamo → banco (desembolso): ENTRA. Es plata disponible para gastar,
 *     aunque no sea un ingreso.
 *   · Banco → préstamo (capital de la cuota): SALE. Ya no está disponible,
 *     aunque no sea un gasto.
 *   · Banco → tarjeta (pago del resumen): SALE. Recién acá la compra con
 *     tarjeta toca la caja: hasta ese momento la deuda subió sin que saliera un
 *     peso de ninguna cuenta de dinero.
 *
 * Una compra con tarjeta (EXPENSE sobre una cuenta CREDIT_CARD) no participa:
 * no hay ningún lado de dinero en el movimiento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CUATRO AGREGADOS Y NO UNO
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque la dirección de una transferencia vive en DOS columnas (`accountId` y
 * `toAccountId`) y `groupBy` sólo agrupa por columnas del propio movimiento:
 * "entra" vs "sale" no es expresable con una sola agrupación. Cada agregado es
 * un término de la fórmula, escrito al lado de la consulta que lo implementa, y
 * los cuatro van en paralelo: cada uno devuelve una fila y la aritmética la
 * hace la base, no la memoria de la aplicación.
 *
 * El `kind` de cada `where` pisa cualquier `kind` externo, igual que en
 * `movementCategoryBreakdown`: es la definición de la métrica, no un filtro
 * opcional. El resto del `where` (fechas, categoría, texto) sí acota el
 * período — el flujo de un subconjunto es el flujo de ese subconjunto.
 *
 * @param db Cliente de Prisma inyectado (ver `movementTotals` para el porqué).
 */
export async function movementCashFlow(
  db: Db,
  where: Prisma.MovementWhereInput,
): Promise<string> {
  const [income, expense, transferOut, transferIn] = await Promise.all([
    db.movement.aggregate({
      where: { ...where, kind: "INCOME", account: moneyAccount },
      _sum: { amount: true },
    }),
    db.movement.aggregate({
      where: { ...where, kind: "EXPENSE", account: moneyAccount },
      _sum: { amount: true },
    }),
    db.movement.aggregate({
      where: { ...where, kind: "TRANSFER", account: moneyAccount },
      _sum: { amount: true },
    }),
    db.movement.aggregate({
      where: { ...where, kind: "TRANSFER", toAccount: moneyAccount },
      _sum: { amount: true },
    }),
  ]);

  // `_sum.amount` es `null` cuando no hay filas de ese término: la suma de un
  // conjunto vacío en SQL es NULL, no 0 — el mismo caso defensivo que en
  // `movementTotals`. Acá no se puede devolver "0.00" por término porque el
  // flujo es UNA resta: se resuelve al final, con la aritmética de `lib/money`.
  const inflow = sum([income._sum.amount ?? zero(), transferIn._sum.amount ?? zero()]);
  const outflow = sum([expense._sum.amount ?? zero(), transferOut._sum.amount ?? zero()]);

  return inflow.minus(outflow).toFixed(2);
}

/**
 * La torta de `/analisis`: cuánto se gastó en cada categoría, agregado en la
 * base sobre el período COMPLETO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `kind: "EXPENSE"` SE APLICA ACÁ Y NO SE PIDE AFUERA
 * ─────────────────────────────────────────────────────────────────────────────
 * La torta responde "en qué se fue la plata", y la plata sólo se va en un
 * EXPENSE: un INCOME no es una porción de gasto y una TRANSFER no es ni una
 * cosa ni la otra (no tiene categoría, por regla de la base). Si el `where`
 * viniera con otro `kind` —o sin `kind`—, la definición del gráfico quedaría a
 * cargo de quien llama, y el día que alguien sume todos los tipos, la torta
 * mostraría gastos que no existen. La definición vive acá, al lado del
 * `groupBy` que la implementa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL NOMBRE SE RESUELVE CON UNA SEGUNDA CONSULTA
 * ─────────────────────────────────────────────────────────────────────────────
 * `groupBy` sólo puede agrupar por columnas del propio modelo: por `categoryId`,
 * no por el nombre de la relación. Traer la fila completa con `include` para
 * leer `category.name` obligaría a una consulta por movimiento — miles de filas
 * para terminar usando un puñado de nombres distintos. En cambio, con los ids
 * del resultado alcanza UN `findMany` limitado a esos ids: a lo sumo, una fila
 * por categoría del período, sin importar cuántos movimientos haya.
 *
 * @param db Cliente de Prisma inyectado (ver `movementTotals` para el porqué).
 */
export async function movementCategoryBreakdown(
  db: Db,
  where: Prisma.MovementWhereInput,
): Promise<CategoryBreakdownDTO[]> {
  const grouped = await db.movement.groupBy({
    by: ["categoryId"],
    // El `kind: "EXPENSE"` va DESPUÉS del spread a propósito: pisa cualquier
    // `kind` que traiga el `where` externo. Es la definición del gráfico, no un
    // filtro opcional.
    where: { ...where, kind: "EXPENSE" },
    _sum: { amount: true },
    // Ordenado por monto descendente —el orden en el que se lee la torta—, y de
    // paso el resultado es determinista entre corridas.
    orderBy: { _sum: { amount: "desc" } },
  });

  const categoryIds = grouped
    .map((row) => row.categoryId)
    .filter((id): id is string => id !== null);

  // Sin ids no hace falta consultar: el período sólo tiene movimientos sin
  // categoría (caso defensivo; hoy la base exige categoría en un EXPENSE).
  const categories =
    categoryIds.length > 0
      ? await db.category.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [];

  const nameById = new Map(categories.map((category) => [category.id, category.name]));

  return grouped.map((row) => {
    // En SQL la suma de un conjunto vacío es NULL, y acá un grupo siempre tiene
    // al menos una fila, pero el tipo lo admite: se trata como "0.00" igual que
    // en `movementTotals` para no reventar con un `.toFixed` sobre `null`.
    const amount = row._sum.amount === null ? "0.00" : row._sum.amount.toFixed(2);

    return {
      categoryId: row.categoryId,
      name:
        row.categoryId === null
          ? "Sin categoría"
          : // El `?? "Sin categoría"` cubre la carrera de borrar una categoría
            // entre el `groupBy` y el `findMany`: preferimos un nombre honesto
            // a una fila que reviente por un `undefined`.
            nameById.get(row.categoryId) ?? "Sin categoría",
      amount,
    };
  });
}

/**
 * Las barras de "Evolución": ingresos y gastos por día del período, agregados
 * en la base.
 *
 * Agrupar por `["date", "kind"]` deja en una sola consulta todas las barras de
 * todos los días —a lo sumo 2 filas por día, sin importar cuántos movimientos
 * haya—. El cliente después sólo re-bucketiza: decide en qué barra cae cada
 * día según la vista (semana, mes, año) con `bucketIndex`, que compara fechas
 * de CALENDARIO. Ese reparto depende de la pantalla, no de los datos, así que
 * vive allá.
 *
 * Las transferencias quedan afuera por definición: `kind: { in: [...] }` las
 * excluye en el `where` y no hay forma de que se cuelen en una barra.
 */
export async function movementDateBreakdown(
  db: Db,
  where: Prisma.MovementWhereInput,
): Promise<DateBreakdownDTO[]> {
  const grouped = await db.movement.groupBy({
    by: ["date", "kind"],
    where: { ...where, kind: { in: ["INCOME", "EXPENSE"] } },
    _sum: { amount: true },
    orderBy: [{ date: "asc" }, { kind: "asc" }],
  });

  return grouped.map((row) => ({
    // `dbToCalendar` y NUNCA `toISOString`: la columna es `@db.Date` y leerla
    // con el serializador UTC implícito devolvería el día anterior con offset
    // negativo (el bug B1/B2 del ROADMAP, otra vez).
    date: dbToCalendar(row.date),
    // El `where` ya garantizó que no hay TRANSFER; el ternario es lo que le dice
    // eso al compilador sin un cast.
    kind: row.kind === "INCOME" ? "INCOME" : "EXPENSE",
    amount: row._sum.amount === null ? "0.00" : row._sum.amount.toFixed(2),
  }));
}

/**
 * Las categorías que tienen al menos un movimiento en el rango de fechas.
 *
 * Es la lista que puebla el selector de `/analisis`. NO recibe los filtros de
 * categoría ni de texto a propósito (ver `ReportsResponse`): el selector tiene
 * que ofrecer todas las opciones del período, incluso las que no matchean el
 * filtro actual — si no, elegir una categoría dejaría al usuario encerrado en
 * ella.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ FILTRA POR RELACIÓN Y NO CON UN `groupBy` DE MOVIMIENTOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque la pregunta es "qué categorías aparecen", no "cuánto sumó cada una"
 * (eso ya lo responde `movementCategoryBreakdown`). Un `findMany` con
 * `movements: { some: ... }` expresa exactamente eso: la categoría existe en la
 * respuesta si tiene AL MENOS un movimiento en el rango. Y como el filtro es
 * por relación, los movimientos TRANSFER no pueden colarse: no tienen
 * categoría.
 *
 * `from` y `to` pueden venir `null` —el endpoint de reportes es permisivo con
 * fechas inválidas o ausentes, igual que `GET /api/transactions`—; el extremo
 * que falta simplemente no acota el rango.
 *
 * Ordena por `normalizedName` y no por el nombre crudo: en Postgres las
 * mayúsculas ordenan antes que las minúsculas, así que "Comida" y "comida"
 * terminarían separadas — el bug de duplicación, disfrazado de orden. Es el
 * mismo criterio que `GET /api/categories`.
 */
export async function categoriesInPeriod(
  db: Db,
  from: CalendarDate | null,
  to: CalendarDate | null,
): Promise<CategoryDTO[]> {
  const date =
    from || to
      ? {
          ...(from ? { gte: calendarToDb(from) } : {}),
          ...(to ? { lte: calendarToDb(to) } : {}),
        }
      : null;

  const categories = await db.category.findMany({
    // Con `date: null`, `some: {}` significa "tiene al menos un movimiento":
    // sin extremos de rango, todas las categorías usadas alguna vez.
    where: { movements: { some: date ? { date } : {} } },
    orderBy: { normalizedName: "asc" },
  });

  return categories.map(toCategoryDTO);
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
