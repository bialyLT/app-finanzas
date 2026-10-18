/**
 * Cálculo de saldos y patrimonio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Podría parecer que "saldo = suma de movimientos" y listo. Pero con tres tipos
 * de movimiento la cuenta tiene CUATRO términos, no dos, y equivocarse en uno
 * solo desarma todo el modelo:
 *
 *     saldo = saldoInicial
 *           + ingresos                      (INCOME)
 *           − gastos                        (EXPENSE)
 *           − transferencias que salen      (TRANSFER desde esta cuenta)
 *           + transferencias que entran     (TRANSFER hacia esta cuenta)
 *
 * Si te olvidás de los dos últimos términos, mover plata del banco al efectivo
 * hace DESAPARECER la plata del banco sin que aparezca en ningún lado. El
 * patrimonio se desploma cada vez que pagás la tarjeta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE EVITA EL PROBLEMA DE LAS N+1 CONSULTAS
 * ─────────────────────────────────────────────────────────────────────────────
 * La forma obvia de escribir esto es recorrer las cuentas y, por cada una,
 * consultar sus movimientos. Con 10 cuentas son 10 consultas (o 40, contando
 * los cuatro tipos); con 50 cuentas, 200. Y el tiempo crece con la cantidad de
 * cuentas, no con la de datos que realmente necesitás.
 *
 * Acá se usan 5 consultas AGREGADAS en paralelo, sin importar cuántas cuentas
 * haya. La base hace la suma — que es para lo que está — y a la aplicación sólo
 * le llega un número por cuenta.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { calendarToDb } from "./dates";
import { money, sum, zero, type Money } from "./money";

/**
 * Un cliente de Prisma, o una transacción de Prisma.
 *
 * Los dos tipos sirven, y aceptar los dos permite reusar estas funciones dentro
 * de una transacción sin duplicar la lógica.
 */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface AccountBalance {
  id: string;
  name: string;
  kind: "CASH" | "BANK" | "CREDIT_CARD" | "LOAN";
  archived: boolean;

  /** Día de cierre del resumen (sólo tarjetas). `null` si no está cargado. */
  closingDay: number | null;
  /** Día de vencimiento del resumen (sólo tarjetas). `null` si no está cargado. */
  dueDay: number | null;
  /** Límite de compra (sólo tarjetas). `null` = no cargado, no es 0. */
  creditLimit: Money | null;

  /** Lo que la cuenta tenía antes de empezar a cargar movimientos. */
  opening: Money;
  /** Todo lo que entró: ingresos + transferencias recibidas. */
  inflow: Money;
  /** Todo lo que salió: gastos + transferencias enviadas. */
  outflow: Money;
  /** `opening + inflow − outflow`. */
  balance: Money;

  /**
   * Las cuentas de pasivo (tarjeta, préstamo) se muestran con el signo invertido.
   *
   * Hay dos convenciones y conviene ser explícito sobre cuál se usa:
   *
   *   · Saldo CONTABLE: deber 500.000 es un saldo de −500.000. Es lo que
   *     necesita la aritmética del patrimonio neto.
   *   · Deuda MOSTRADA: "debés 500.000". Es lo que la persona espera leer.
   *
   * `balance` usa la primera; `debt` usa la segunda. Mezclarlas en la interfaz
   * produce el clásico "−$ 500.000" en rojo que todos leemos como un error.
   */
  debt: Money | null;
  isLiability: boolean;
}

export interface NetWorth {
  /** Suma de las cuentas que tienen plata tuya (efectivo + banco). */
  assets: Money;
  /** Suma de lo que debés, en POSITIVO (500.000 = debés 500.000). */
  liabilities: Money;
  /** `assets − liabilities`. Puede ser negativo, y ese es un dato válido. */
  net: Money;
}

/**
 * Saldo de cada cuenta.
 *
 * @param asOf Fecha de calendario (`YYYY-MM-DD`). Si se pasa, sólo se cuentan
 *             los movimientos hasta esa fecha inclusive. Sirve para responder
 *             "¿cuánto tenía el mes pasado?" sin recalcular nada.
 *
 *             Ojo con el `<=` y no `<`: la fecha del movimiento es el día en
 *             que pasó, así que un movimiento del 31 tiene que entrar en el
 *             saldo del 31.
 */
export async function getAccountBalances(
  db: Db,
  options: { asOf?: string; includeArchived?: boolean } = {},
): Promise<AccountBalance[]> {
  const { asOf, includeArchived = true } = options;

  const dateFilter = asOf ? { date: { lte: calendarToDb(asOf) } } : {};

  const [accounts, income, expense, transferOut, transferIn] = await Promise.all([
    db.account.findMany({
      where: includeArchived ? {} : { archived: false },
      select: {
        id: true,
        name: true,
        kind: true,
        archived: true,
        openingBalance: true,
        closingDay: true,
        dueDay: true,
        creditLimit: true,
      },
      // Desempate por nombre: sin él, dos cuentas creadas en el mismo
      // milisegundo pueden salir en cualquier orden y el saldo total de la
      // pantalla cambia entre recargas (los subtotales quedan iguales, pero la
      // lista se reordena y parece que la app está fallando).
      orderBy: [{ archived: "asc" }, { createdAt: "asc" }, { name: "asc" }],
    }),

    db.movement.groupBy({
      by: ["accountId"],
      where: { kind: "INCOME", ...dateFilter },
      _sum: { amount: true },
    }),

    db.movement.groupBy({
      by: ["accountId"],
      where: { kind: "EXPENSE", ...dateFilter },
      _sum: { amount: true },
    }),

    db.movement.groupBy({
      by: ["accountId"],
      where: { kind: "TRANSFER", ...dateFilter },
      _sum: { amount: true },
    }),

    db.movement.groupBy({
      by: ["toAccountId"],
      where: { kind: "TRANSFER", ...dateFilter },
      _sum: { amount: true },
    }),
  ]);

  // Índices por id para no recorrer la lista de movimientos por cada cuenta.
  // Sin esto, el cálculo es O(cuentas × movimientos) en memoria y con miles de
  // movimientos se nota.
  const toMap = (rows: { _sum: { amount: unknown } }[], key: string) => {
    const map = new Map<string, Money>();
    for (const row of rows) {
      const id = (row as unknown as Record<string, string | null>)[key];
      // El groupBy de `toAccountId` incluye un grupo `null` (los movimientos
      // que no son transferencias). Hay que descartarlo: no es una cuenta.
      if (!id) continue;
      const amount = row._sum.amount;
      if (amount === null || amount === undefined) continue;
      map.set(id, money(amount as string));
    }
    return map;
  };

  const incomeByAccount = toMap(income, "accountId");
  const expenseByAccount = toMap(expense, "accountId");
  const transferOutByAccount = toMap(transferOut, "accountId");
  const transferInByAccount = toMap(transferIn, "toAccountId");

  return accounts.map((account) => {
    const opening = money(account.openingBalance);
    const inflow = sum([
      incomeByAccount.get(account.id) ?? zero(),
      transferInByAccount.get(account.id) ?? zero(),
    ]);
    const outflow = sum([
      expenseByAccount.get(account.id) ?? zero(),
      transferOutByAccount.get(account.id) ?? zero(),
    ]);
    const balance = opening.plus(inflow).minus(outflow);
    const isLiability = account.kind === "LOAN" || account.kind === "CREDIT_CARD";

    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      archived: account.archived,
      closingDay: account.closingDay,
      dueDay: account.dueDay,
      // `money(...)` sólo si existe: un límite de 0 guardado no existe (CHECK),
      // pero `null` no se puede convertir sin inventar un 0.
      creditLimit: account.creditLimit === null ? null : money(account.creditLimit),
      opening,
      inflow,
      outflow,
      balance,
      // Sólo tiene sentido para pasivos. En una cuenta de dinero sería siempre
      // null y el consumidor tendría que ignorarlo — mejor no confundir.
      debt: isLiability ? balance.negated() : null,
      isLiability,
    };
  });
}

/**
 * Patrimonio neto: lo que tenés menos lo que debés.
 *
 * Es el único número de la app que no se puede maquillar. La tasa de ahorro
 * depende de qué contás como ingreso; el patrimonio neto no: o subió o bajó.
 *
 * Las cuentas de pasivo tienen saldo negativo, así que se suman en valor
 * absoluto para poder mostrarlas como "debés X" sin que el signo se mezcle con
 * el de las cuentas de dinero.
 */
export async function getNetWorth(
  db: Db,
  options: { asOf?: string } = {},
): Promise<NetWorth> {
  const balances = await getAccountBalances(db, {
    asOf: options.asOf,
    includeArchived: true,
  });

  const assets = sum(
    balances.filter((b) => !b.isLiability).map((b) => b.balance),
  );
  const liabilities = sum(
    balances.filter((b) => b.isLiability).map((b) => (b.debt ?? zero())),
  );

  return {
    assets,
    liabilities,
    net: assets.minus(liabilities),
  };
}

/**
 * Saldo de una sola cuenta. Atajo para cuando ya sabés cuál querés y no tiene
 * sentido calcular todas.
 */
export async function getAccountBalance(
  db: Db,
  accountId: string,
  options: { asOf?: string } = {},
): Promise<Money> {
  const balances = await getAccountBalances(db, options);
  return balances.find((b) => b.id === accountId)?.balance ?? zero();
}
