/**
 * Tarjetas de crédito y cuotas: la parte que LEE Y ESCRIBE en la base.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE REPARTE EL TRABAJO CON `lib/cards.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/cards.ts` es puro: contesta "¿en qué período cae esta compra?", "¿cuánto
 * es el mínimo?", "¿cuánto queda comprometido?". Este módulo no reimplementa
 * NINGUNA de esas cuentas: las llama y se ocupa de lo que el módulo puro no
 * puede hacer — leer, escribir, y decidir qué está permitido según el estado de
 * la base.
 *
 * El mismo criterio que `lib/recurring.ts`: operaciones transaccionales,
 * errores de dominio con status HTTP (`CardError`), DTOs armados acá y rutas
 * que sólo validan la forma del body y traducen errores.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS CUATRO OPERACIONES DE LA FASE 5
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. `createCardPlan`  → comprar en cuotas: UN EXPENSE por el total + N items
 *                          que dicen en qué resumen se cobra cada cuota.
 *   2. `deleteCardPlan`  → deshacer la compra: plan + items + el gasto.
 *   3. `runCardStatements` → cerrar resúmenes de los períodos que YA cerraron,
 *                          idempotente por (tarjeta, año, mes de cierre).
 *   4. `payStatement`    → pagar un resumen con una TRANSFER (nunca un gasto).
 *
 * Más `getCardsView`, que arma todo lo que la pantalla de tarjetas necesita en
 * una sola respuesta (saldos, utilización, período en curso, compromisos,
 * resúmenes y planes).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./balance";
import { getAccountBalances, type AccountBalance } from "./balance";
import { categoryKindMessage } from "./category-kind";
import {
  addMonthsToPeriod,
  cardPeriodLabel,
  closingDateOf,
  commitmentsFromItems,
  comparePeriods,
  dueDateOf,
  installmentAmounts,
  isPeriodClosed,
  lastClosedPeriod,
  minimumPayment,
  nextPeriod,
  periodKey,
  periodWindow,
  statementPeriodOf,
  utilizationPercent,
  type StatementPeriod,
} from "./cards";
import { calendarToDb, dbToCalendar, type CalendarDate } from "./dates";
import type {
  AccountDTO,
  CardCommitmentsDTO,
  CardCurrentPeriodDTO,
  CardPlanDTO,
  CardPlanItemDTO,
  CardStatementsRunCardDTO,
  CardStatementsRunDTO,
  CardViewDTO,
  CardsResponse,
  ImplicitRateDTO,
  StatementDTO,
  StatementPayResponseDTO,
} from "./finance";
import { cleanName, normalizeCategoryName } from "./finance";
import {
  implicitFinancingRate,
  money,
  sum,
  zero,
  type Money,
} from "./money";
import { movementInclude, toAccountDTO, toMovementDTO } from "./queries";

/* ────────────────────────────────────────────────────────────────────────────
 * Topes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Máximo de períodos que una corrida materializa por tarjeta (20 años).
 *
 * Mismo criterio que `RECURRENCE_RUN_MAX_PER_RULE`: una tarjeta con una compra
 * vieja de 2005 no puede convertir "abrir la pantalla" en una escritura de
 * miles de resúmenes. Si se recorta, la respuesta lo dice (`truncated: true`) y
 * la próxima corrida sigue desde donde quedó — no se pierde nada en silencio.
 */
export const CARD_STATEMENTS_RUN_MAX_PER_CARD = 240;

/** Máximo de resúmenes que una tarjeta devuelve en `GET /api/cards`. */
export const CARD_STATEMENTS_MAX_ROWS = 60;

/* ────────────────────────────────────────────────────────────────────────────
 * Errores de dominio
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un error de dominio de la tarjeta, con su status HTTP.
 *
 * Igual que `RecurrenceError`: estas operaciones escriben en una transacción y
 * un error tiene que ABORTARLA. Devolver `{ ok: false }` dejaría a medias lo que
 * ya se escribió; una excepción no.
 */
export class CardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardError";
  }
}

/** Traduce un `CardError` a la forma que espera una ruta. `null` si no lo es. */
export function describeCardError(
  error: unknown,
): { status: number; message: string } | null {
  if (!(error instanceof CardError)) return null;
  return { status: error.status, message: error.message };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Includes y filas
 * ──────────────────────────────────────────────────────────────────────────── */

const planInclude = {
  // Las cuotas siempre en orden: el DTO las muestra enumeradas y el "cuota 3
  // de 12" no puede depender del orden en que Postgres devolvió las filas.
  items: { orderBy: { number: "asc" } },
  movement: { include: movementInclude },
} as const satisfies Prisma.CardPlanInclude;

type PlanRow = Prisma.CardPlanGetPayload<{ include: typeof planInclude }>;

const statementPaymentInclude = {
  account: true,
  paidMovement: { include: movementInclude },
} as const satisfies Prisma.StatementInclude;

/** La forma mínima de un resumen para armar el DTO. */
interface StatementLike {
  id: string;
  periodYear: number;
  periodMonth: number;
  closingDate: Date;
  dueDate: Date;
  totalDue: Money;
  minimumDue: Money;
  paidMovementId: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * DTOs
 * ──────────────────────────────────────────────────────────────────────────── */

function toImplicitRateDTO(
  rate: NonNullable<ReturnType<typeof implicitFinancingRate>>,
): ImplicitRateDTO {
  return {
    monthlyRatePercent: rate.monthlyRatePercent.toFixed(2),
    teaPercent: rate.teaPercent.toFixed(2),
    surcharge: rate.surcharge.toFixed(2),
  };
}

function toCardPlanItemDTO(item: {
  id: string;
  number: number;
  periodYear: number;
  periodMonth: number;
  amount: Money;
}): CardPlanItemDTO {
  return {
    id: item.id,
    number: item.number,
    periodYear: item.periodYear,
    periodMonth: item.periodMonth,
    periodLabel: cardPeriodLabel({
      year: item.periodYear,
      month: item.periodMonth,
    }),
    amount: item.amount.toFixed(2),
  };
}

function toCardPlanDTO(
  plan: PlanRow,
  closingDay: number | null,
  today: CalendarDate,
): CardPlanDTO {
  const rate =
    plan.cashPrice === null
      ? null
      : implicitFinancingRate(
          plan.items.map((item) => item.amount),
          plan.cashPrice,
        );

  return {
    id: plan.id,
    label: plan.label,
    totalAmount: plan.totalAmount.toFixed(2),
    installments: plan.installments,
    purchaseDate: dbToCalendar(plan.purchaseDate),
    cashPrice: plan.cashPrice === null ? null : plan.cashPrice.toFixed(2),
    items: plan.items.map(toCardPlanItemDTO),
    movement: toMovementDTO(plan.movement),
    implicitRate: rate === null ? null : toImplicitRateDTO(rate),
    billedInstallments:
      closingDay === null
        ? 0
        : plan.items.filter((item) =>
            isPeriodClosed(
              { year: item.periodYear, month: item.periodMonth },
              today,
              closingDay,
            ),
          ).length,
  };
}

function toStatementDTO(statement: StatementLike): StatementDTO {
  return {
    id: statement.id,
    year: statement.periodYear,
    month: statement.periodMonth,
    periodLabel: cardPeriodLabel({
      year: statement.periodYear,
      month: statement.periodMonth,
    }),
    closingDate: dbToCalendar(statement.closingDate),
    dueDate: dbToCalendar(statement.dueDate),
    totalDue: statement.totalDue.toFixed(2),
    minimumDue: statement.minimumDue.toFixed(2),
    paid: statement.paidMovementId !== null,
    paidMovementId: statement.paidMovementId,
  };
}

/** El DTO de una cuenta con saldo, a partir del cálculo de `lib/balance.ts`. */
function balanceToAccountDTO(balance: AccountBalance): AccountDTO {
  return toAccountDTO({
    id: balance.id,
    name: balance.name,
    kind: balance.kind,
    archived: balance.archived,
    openingBalance: balance.opening,
    closingDay: balance.closingDay,
    dueDay: balance.dueDay,
    creditLimit: balance.creditLimit,
  });
}

function emptyCommitments(): CardCommitmentsDTO {
  return {
    next6Months: "0.00",
    next12Months: "0.00",
    months: [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Categoría del gasto de la compra
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resuelve (o crea) la categoría del gasto de una compra en cuotas.
 *
 * La compra es un EXPENSE, así que la categoría es obligatoria en la práctica.
 * Se hace el mismo upsert por nombre normalizado que `POST /api/transactions`:
 * escribir "Tecnología" y "tecnologia" no puede partir el gráfico en dos.
 *
 * Y si la categoría existe con el tipo contrario (un Ingreso), NO se usa: el
 * gasto quedaría clasificado con una categoría de ingreso, que es un dato que
 * se contradice a sí mismo. Se dice cuál es el problema y qué hacer.
 */
async function resolveExpenseCategory(
  tx: Prisma.TransactionClient,
  rawName: string,
): Promise<string> {
  const name = cleanName(rawName);
  const normalizedName = normalizeCategoryName(name);

  // El `upsert` (y no un `find` + `create`) porque dos compras simultáneas
  // pueden necesitar la misma categoría: con el `upsert`, el segundo INSERT
  // espera al primero en vez de morir por violar el índice único.
  const category = await tx.category.upsert({
    where: { normalizedName },
    // Si ya existe, se conserva el nombre ORIGINAL que había puesto la persona.
    update: {},
    create: { name, normalizedName, kind: "EXPENSE" },
  });

  if (category.kind !== "EXPENSE") {
    throw new CardError(
      400,
      categoryKindMessage(category.name, "EXPENSE", category.kind),
    );
  }

  return category.id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Comprar en cuotas
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreateCardPlanInput {
  cardId: string;
  label: string;
  /** Total como string decimal exacto, positivo. */
  totalAmount: string;
  installments: number;
  /** Fecha de la compra. Sin valor: hoy. */
  purchaseDate?: CalendarDate;
  /** Precio de contado, si se conoce. */
  cashPrice?: string | null;
  categoryName: string;
}

/**
 * Registra una compra en cuotas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ESCRIBE (y en qué orden)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. El gasto ÚNICO por el total, en la fecha de compra, contra la tarjeta.
 *      Es el momento en que la deuda nació; la cuenta de la tarjeta ya muestra
 *      el total adeudado.
 *   2. El plan, enlazado a ese gasto (`movementId`, `@unique`).
 *   3. Las N cuotas, cada una con el período de resumen que le toca:
 *      `período de la compra + (cuota − 1)`.
 *
 * La asignación usa el `closingDay` de la tarjeta y la regla del cierre
 * inclusivo: una compra EN el día de cierre entra al resumen que cierra ese
 * día. Todo eso vive en `lib/cards.ts`; acá sólo se persiste el resultado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SIN DÍA DE CIERRE SE RECHAZA (409)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sin cierre no se puede decir en qué resumen cae cada cuota. Elegir un cierre
 * inventado (¿el 25? ¿el último día?) sería inventar un dato del contrato con el
 * banco. La persona configura el cierre una vez y la app no adivina.
 *
 * @throws CardError 404 tarjeta inexistente, 400 no es tarjeta / montos
 *         inválidos, 409 tarjeta sin cierre configurado.
 */
export async function createCardPlan(
  db: PrismaClient,
  input: CreateCardPlanInput,
  options: { today: CalendarDate },
): Promise<CardPlanDTO> {
  const { today } = options;
  const purchaseDate = input.purchaseDate ?? today;

  return db.$transaction(async (tx) => {
    const card = await tx.account.findUnique({ where: { id: input.cardId } });

    if (!card) throw new CardError(404, "Esa tarjeta no existe.");
    if (card.kind !== "CREDIT_CARD") {
      throw new CardError(
        400,
        "Las cuotas sólo se cargan en una tarjeta de crédito.",
      );
    }
    if (card.closingDay === null || card.dueDay === null) {
      throw new CardError(
        409,
        "La tarjeta no tiene día de cierre y vencimiento configurados: sin el cierre no se puede saber en qué resumen cae cada cuota. Configuralos en la cuenta y volvé a intentar.",
      );
    }

    let amounts: Money[];
    try {
      amounts = installmentAmounts(input.totalAmount, input.installments);
    } catch (error) {
      throw new CardError(
        400,
        error instanceof Error
          ? error.message
          : "No se pudo repartir el total en cuotas.",
      );
    }

    const total = money(input.totalAmount);
    const firstPeriod = statementPeriodOf(purchaseDate, card.closingDay);
    const categoryId = await resolveExpenseCategory(tx, input.categoryName);

    const movement = await tx.movement.create({
      data: {
        kind: "EXPENSE",
        amount: total.toFixed(2),
        date: calendarToDb(purchaseDate),
        description: input.label,
        accountId: card.id,
        categoryId,
      },
      include: movementInclude,
    });

    const plan = await tx.cardPlan.create({
      data: {
        accountId: card.id,
        label: input.label,
        totalAmount: total.toFixed(2),
        installments: input.installments,
        purchaseDate: calendarToDb(purchaseDate),
        cashPrice: input.cashPrice ?? null,
        movementId: movement.id,
        items: {
          create: amounts.map((amount, index) => {
            // La cuota k va al período de la compra + (k − 1). Es PURA y no
            // depende de la fecha en que se corre el resumen: dos corridas en
            // fechas distintas asignan las mismas cuotas a los mismos meses.
            const period = addMonthsToPeriod(firstPeriod, index);
            return {
              number: index + 1,
              periodYear: period.year,
              periodMonth: period.month,
              amount: amount.toFixed(2),
            };
          }),
        },
      },
      include: planInclude,
    });

    return toCardPlanDTO(plan, card.closingDay, today);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Borrar un plan
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Deshace una compra en cuotas: borra el plan, sus items y el gasto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE PUEDE BORRAR SI YA HAY UN RESUMEN PAGADO (409)
 * ─────────────────────────────────────────────────────────────────────────────
 * Un resumen pagado es historia: hay una transferencia que salió del banco y un
 * documento que decía cuánto vencer. Si se pudiera borrar la compra, ese resumen
 * habría facturado cuotas de un plan inexistente. El pasado no se reescribe: para
 * corregir una compra vieja, se emite una nota de crédito (una compra negativa),
 * que es lo que hace un banco de verdad.
 *
 * Si los resúmenes están impagos, borrar el plan es seguro: la próxima corrida
 * recalcula los totales sin esas cuotas (el resumen no está congelado).
 *
 * @throws CardError 404 plan inexistente, 409 resumen pagado.
 */
export async function deleteCardPlan(db: PrismaClient, planId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const plan = await tx.cardPlan.findUnique({
      where: { id: planId },
      include: { items: true },
    });

    if (!plan) throw new CardError(404, "Ese plan en cuotas no existe.");

    const paidStatement = await tx.statement.findFirst({
      where: {
        accountId: plan.accountId,
        paidMovementId: { not: null },
        OR: plan.items.map((item) => ({
          periodYear: item.periodYear,
          periodMonth: item.periodMonth,
        })),
      },
      select: { periodYear: true, periodMonth: true },
    });

    if (paidStatement) {
      throw new CardError(
        409,
        `El plan tiene un resumen ya pagado (${cardPeriodLabel(
          {
            year: paidStatement.periodYear,
            month: paidStatement.periodMonth,
          },
        )}): no se puede borrar sin reescribir el historial. Si la compra fue un error, registrá el ajuste como un gasto negativo.`,
      );
    }

    // Primero el plan (se lleva los items), después el gasto: el FK
    // `CardPlan_movementId_fkey` es Restrict y no deja el gasto sin plan.
    await tx.cardPlan.delete({ where: { id: planId } });
    await tx.movement.delete({ where: { id: plan.movementId } });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Correr los resúmenes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CardStatementsRunOptions {
  today: CalendarDate;
  /** Sólo esta tarjeta. Sin valor: todas las tarjetas. */
  cardId?: string;
}

/**
 * Materializa y actualiza los resúmenes de los períodos que YA cerraron.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ENTRA EN EL TOTAL DE UN RESUMEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Dos fuentes, y sólo dos:
 *
 *   1. Las cuotas de los planes cuyo período de resumen es este.
 *   2. Las compras DIRECTAS con la tarjeta (un EXPENSE suelto) con fecha en la
 *      ventana del período: después del cierre anterior y hasta el cierre
 *      inclusive.
 *
 * El gasto de una compra en cuotas NO se cuenta como compra directa: está
 * representado por sus cuotas. Se excluye por identidad (`CardPlan.movementId`),
 * no por fecha ni por monto. Sin esa exclusión, la compra aparecería dos veces:
 * completa el día que se hizo y de nuevo repartida en cuotas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCIA Y CONGELAMIENTO
 * ─────────────────────────────────────────────────────────────────────────────
 * La clave única (accountId, periodYear, periodMonth) hace que correr dos veces
 * no duplique nada. Un resumen IMPAGO se recalcula (una compra cargada tarde en
 * un período cerrado tiene que aparecer); uno PAGADO se congela, porque es el
 * documento que la persona ya pagó. Si se borra el pago, `paidMovementId` vuelve
 * a NULL (FK SetNull) y el resumen se vuelve a recalcular solo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ PERÍODOS SE TOCAN
 * ─────────────────────────────────────────────────────────────────────────────
 * Desde el período de la primera actividad de la tarjeta (primera compra o
 * primer plan) hasta el último período CERRADO. El período en curso no se
 * materializa: todavía se está llenando. Un resumen que se generara a mitad de
 * mes quedaría con un total que no es el que el banco va a cobrar, y "correr el
 * cierre" dos días antes no puede producir un documento falso.
 */
export async function runCardStatements(
  db: PrismaClient,
  options: CardStatementsRunOptions,
): Promise<CardStatementsRunDTO> {
  const { today, cardId } = options;

  return db.$transaction(async (tx) => {
    const cards = await tx.account.findMany({
      where: {
        kind: "CREDIT_CARD",
        ...(cardId ? { id: cardId } : {}),
      },
      orderBy: [{ archived: "asc" }, { name: "asc" }],
    });

    if (cards.length === 0) {
      throw new CardError(
        404,
        cardId
          ? "Esa tarjeta no existe."
          : "No hay tarjetas de crédito para correr resúmenes.",
      );
    }

    const results: CardStatementsRunCardDTO[] = [];
    const skipped: CardStatementsRunDTO["skipped"] = [];
    let truncated = false;

    for (const card of cards) {
      const firstExpense = await tx.movement.findFirst({
        where: { kind: "EXPENSE", accountId: card.id },
        orderBy: { date: "asc" },
        select: { date: true },
      });

      // Los resúmenes ya emitidos también son actividad: si se borró la última
      // compra, el resumen impago tiene que poder recalcularse a cero. Saltear
      // la tarjeta dejaría un documento diciendo que se debe plata que ya no
      // existe.
      const firstStatement = await tx.statement.findFirst({
        where: { accountId: card.id },
        orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
        select: { periodYear: true, periodMonth: true },
      });

      if (firstExpense === null && firstStatement === null) {
        // Tarjeta sin compras ni resúmenes: no hay nada que resumir. No es un
        // error ni un "skipped": simplemente no participa de la corrida.
        continue;
      }

      if (card.closingDay === null || card.dueDay === null) {
        skipped.push({
          cardId: card.id,
          cardName: card.name,
          reason:
            "La tarjeta tiene compras o resúmenes pero no tiene día de cierre y vencimiento configurados: no se pueden emitir resúmenes.",
        });
        continue;
      }

      const closingDay = card.closingDay;
      const dueDay = card.dueDay;

      const firstPeriod = (() => {
        const fromMovement =
          firstExpense === null
            ? null
            : statementPeriodOf(dbToCalendar(firstExpense.date), closingDay);

        const fromStatement =
          firstStatement === null
            ? null
            : {
                year: firstStatement.periodYear,
                month: firstStatement.periodMonth,
              };

        if (fromMovement === null) return fromStatement!;
        if (fromStatement === null) return fromMovement;

        return comparePeriods(fromStatement, fromMovement) < 0
          ? fromStatement
          : fromMovement;
      })();

      const lastPeriod = lastClosedPeriod(today, closingDay);

      // Nada cerró todavía: no hay resumen que emitir.
      if (
        firstPeriod.year * 12 + firstPeriod.month >
        lastPeriod.year * 12 + lastPeriod.month
      ) {
        results.push({
          card: toAccountDTO(card),
          created: 0,
          updated: 0,
          unchanged: 0,
          frozen: 0,
          statements: [],
        });
        continue;
      }

      // Todas las cuotas de la tarjeta, con el id del gasto de su plan (para no
      // contar la compra completa como compra directa).
      const plans = await tx.cardPlan.findMany({
        where: { accountId: card.id },
        select: {
          movementId: true,
          items: {
            select: {
              periodYear: true,
              periodMonth: true,
              amount: true,
            },
          },
        },
      });

      const planItemsByPeriod = new Map<string, Money>();
      const purchaseMovementIds = new Set<string>();

      for (const plan of plans) {
        purchaseMovementIds.add(plan.movementId);
        for (const item of plan.items) {
          const key = periodKey({
            year: item.periodYear,
            month: item.periodMonth,
          });
          planItemsByPeriod.set(
            key,
            (planItemsByPeriod.get(key) ?? zero()).plus(item.amount),
          );
        }
      }

      // Ventana completa de la corrida: (cierre anterior al primer período,
      // cierre del último período]. Se trae una sola vez y se reparte en memoria.
      const firstWindow = periodWindow(firstPeriod, closingDay);
      const lastClosing = closingDateOf(lastPeriod, closingDay);

      const directExpenses = await tx.movement.findMany({
        where: {
          kind: "EXPENSE",
          accountId: card.id,
          date: {
            gt: calendarToDb(firstWindow.after),
            lte: calendarToDb(lastClosing),
          },
        },
        select: { id: true, amount: true, date: true },
      });

      const directByPeriod = new Map<string, Money>();
      for (const expense of directExpenses) {
        if (purchaseMovementIds.has(expense.id)) continue;

        const key = periodKey(
          statementPeriodOf(dbToCalendar(expense.date), closingDay),
        );
        directByPeriod.set(
          key,
          (directByPeriod.get(key) ?? zero()).plus(expense.amount),
        );
      }

      // Arranque efectivo de la corrida (recorte por tope).
      let startPeriod = firstPeriod;
      const totalPeriods =
        (lastPeriod.year - firstPeriod.year) * 12 +
        (lastPeriod.month - firstPeriod.month) +
        1;

      if (totalPeriods > CARD_STATEMENTS_RUN_MAX_PER_CARD) {
        startPeriod = addMonthsToPeriod(
          lastPeriod,
          -(CARD_STATEMENTS_RUN_MAX_PER_CARD - 1),
        );
        truncated = true;
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let frozen = 0;

      const periods: StatementPeriod[] = [];
      for (let index = 0; index < CARD_STATEMENTS_RUN_MAX_PER_CARD; index += 1) {
        const period = addMonthsToPeriod(startPeriod, index);
        if (
          period.year * 12 + period.month >
          lastPeriod.year * 12 + lastPeriod.month
        ) {
          break;
        }
        periods.push(period);
      }

      for (const period of periods) {
        const key = periodKey(period);
        const total = (planItemsByPeriod.get(key) ?? zero()).plus(
          directByPeriod.get(key) ?? zero(),
        );
        const minimum = minimumPayment(total);
        const closingDate = closingDateOf(period, closingDay);
        const dueDate = dueDateOf(period, closingDay, dueDay);

        const existing = await tx.statement.findUnique({
          where: {
            accountId_periodYear_periodMonth: {
              accountId: card.id,
              periodYear: period.year,
              periodMonth: period.month,
            },
          },
        });

        if (existing === null) {
          // Un período sin nada facturado no genera un resumen de $0: un
          // documento que no existe en el banco no se inventa acá.
          if (total.isZero()) continue;

          await tx.statement.create({
            data: {
              accountId: card.id,
              periodYear: period.year,
              periodMonth: period.month,
              closingDate: calendarToDb(closingDate),
              dueDate: calendarToDb(dueDate),
              totalDue: total.toFixed(2),
              minimumDue: minimum.toFixed(2),
            },
          });
          created += 1;
          continue;
        }

        if (existing.paidMovementId !== null) {
          frozen += 1;
          continue;
        }

        const changed =
          !existing.totalDue.equals(total) ||
          !existing.minimumDue.equals(minimum) ||
          dbToCalendar(existing.closingDate) !== closingDate ||
          dbToCalendar(existing.dueDate) !== dueDate;

        if (!changed) {
          unchanged += 1;
          continue;
        }

        await tx.statement.update({
          where: { id: existing.id },
          data: {
            closingDate: calendarToDb(closingDate),
            dueDate: calendarToDb(dueDate),
            totalDue: total.toFixed(2),
            minimumDue: minimum.toFixed(2),
          },
        });
        updated += 1;
      }

      const statementCount = await tx.statement.count({
        where: { accountId: card.id },
      });

      if (statementCount > CARD_STATEMENTS_MAX_ROWS) truncated = true;

      const statementRows = await tx.statement.findMany({
        where: { accountId: card.id },
        orderBy: [
          { periodYear: "desc" },
          { periodMonth: "desc" },
        ],
        take: CARD_STATEMENTS_MAX_ROWS,
      });

      results.push({
        card: toAccountDTO(card),
        created,
        updated,
        unchanged,
        frozen,
        statements: statementRows.map(toStatementDTO),
      });
    }

    return {
      runDate: today,
      results,
      skipped,
      truncated,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Pagar un resumen
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PayStatementInput {
  statementId: string;
  fromAccountId: string;
}

/**
 * Paga un resumen con una TRANSFER desde otra cuenta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ TRANSFER Y NO EXPENSE (criterio de aceptación 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * El gasto ya se registró UNA vez, cuando se compró. Pagar el resumen es pagar
 * una deuda: sale plata del banco y baja la deuda de la tarjeta. Si este
 * movimiento fuera un EXPENSE, el gasto se contaría DOS veces: una al comprar y
 * otra al pagar. La transferencia es la única forma de mover plata entre dos
 * cuentas propias sin inventar un gasto nuevo.
 *
 * El monto es el `totalDue` GUARDADO (no se recalcula acá): el documento dice
 * cuánto se paga y eso es lo que sale del banco.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCIA
 * ─────────────────────────────────────────────────────────────────────────────
 * Si el resumen ya está pago, devuelve el pago existente con `created: false`
 * (un doble clic no genera una segunda transferencia). La carrera real se
 * resuelve con el `updateMany` condicionado a `paidMovementId = NULL`: sólo una
 * transacción puede reclamar el resumen, y `paidMovementId @unique` lo garantiza
 * en la base.
 *
 * @throws CardError 404 resumen inexistente, 400 cuenta de origen inválida,
 *         409 resumen sin saldo o reclamado por otra operación.
 */
export async function payStatement(
  db: PrismaClient,
  input: PayStatementInput,
  options: { today: CalendarDate },
): Promise<StatementPayResponseDTO> {
  const { today } = options;

  return db.$transaction(async (tx) => {
    const statement = await tx.statement.findUnique({
      where: { id: input.statementId },
      include: statementPaymentInclude,
    });

    if (!statement) throw new CardError(404, "Ese resumen no existe.");

    if (statement.paidMovementId !== null) {
      if (statement.paidMovement === null) {
        // Defensivo: el FK SetNull mantiene esto coherente, pero si alguna vez
        // hubiera un id sin fila, es mejor decirlo que devolver un DTO roto.
        throw new CardError(
          409,
          "El resumen figura como pagado pero el pago no existe. Revisá la base.",
        );
      }

      return {
        statement: toStatementDTO(statement),
        movement: toMovementDTO(statement.paidMovement),
        created: false,
      };
    }

    if (statement.totalDue.lessThanOrEqualTo(0)) {
      throw new CardError(
        409,
        "Ese resumen no tiene saldo: no hay nada que pagar.",
      );
    }

    const from = await tx.account.findUnique({
      where: { id: input.fromAccountId },
    });

    if (!from) {
      throw new CardError(400, "La cuenta de origen no existe.");
    }
    if (from.id === statement.accountId) {
      throw new CardError(
        400,
        "La cuenta de origen tiene que ser distinta a la tarjeta que se paga.",
      );
    }

    const movement = await tx.movement.create({
      data: {
        kind: "TRANSFER",
        amount: statement.totalDue.toFixed(2),
        date: calendarToDb(today),
        description: `Pago resumen ${statement.account.name} ${cardPeriodLabel(
          { year: statement.periodYear, month: statement.periodMonth },
        )}`,
        accountId: from.id,
        toAccountId: statement.accountId,
      },
      include: movementInclude,
    });

    // Reclamo atómico: dos pagos simultáneos se serializan en la fila y sólo
    // uno enlaza su transferencia. El que pierde aborta (y con él su transfer).
    const claimed = await tx.statement.updateMany({
      where: { id: statement.id, paidMovementId: null },
      data: { paidMovementId: movement.id },
    });

    if (claimed.count === 0) {
      throw new CardError(
        409,
        "Ese resumen se estaba pagando en otra operación. Volvé a intentar.",
      );
    }

    return {
      statement: toStatementDTO({ ...statement, paidMovementId: movement.id }),
      movement: toMovementDTO(movement),
      created: true,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. La vista de tarjetas
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CardsViewOptions {
  today: CalendarDate;
  includeArchived?: boolean;
}

/**
 * Todo lo que la pantalla de tarjetas necesita, en una sola respuesta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE CALCULA Y QUÉ SE GUARDA
 * ─────────────────────────────────────────────────────────────────────────────
 * El saldo (la deuda) NO se guarda: se deriva de los movimientos, igual que en
 * cualquier cuenta. Lo que se guarda son los resúmenes ya emitidos —documentos—
 * y los planes. El "período en curso" es una PROYECCIÓN: no se escribe hasta
 * que cierra y se corre la corrida.
 *
 * La utilización es `deuda / límite`; sin límite cargado devuelve `null` ("no
 * se sabe"), nunca 0.
 *
 * Las cuotas comprometidas de los próximos 6 y 12 meses EXCLUYEN las cuotas de
 * resúmenes ya pagados y los períodos ya cerrados (ver `commitmentsFromItems`).
 */
export async function getCardsView(
  db: Db,
  options: CardsViewOptions,
): Promise<CardsResponse> {
  const { today, includeArchived = true } = options;

  const balances = await getAccountBalances(db, { includeArchived });
  const cards = balances.filter((balance) => balance.kind === "CREDIT_CARD");

  let truncated = false;

  const views: CardViewDTO[] = [];

  for (const balance of cards) {
    const [planRows, statementRows, statementCount] = await Promise.all([
      db.cardPlan.findMany({
        where: { accountId: balance.id },
        include: planInclude,
        orderBy: { purchaseDate: "desc" },
      }),
      db.statement.findMany({
        where: { accountId: balance.id },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
        take: CARD_STATEMENTS_MAX_ROWS,
      }),
      db.statement.count({ where: { accountId: balance.id } }),
    ]);

    if (statementCount > CARD_STATEMENTS_MAX_ROWS) truncated = true;

    const debt = balance.debt ?? zero();
    const utilization = utilizationPercent(debt, balance.creditLimit);
    const plans = planRows.map((plan) =>
      toCardPlanDTO(plan, balance.closingDay, today),
    );

    let currentPeriod: CardCurrentPeriodDTO | null = null;
    let commitments = emptyCommitments();

    if (balance.closingDay !== null && balance.dueDay !== null) {
      const closingDay = balance.closingDay;
      const dueDay = balance.dueDay;
      const current = statementPeriodOf(today, closingDay);

      // Los resúmenes pagados "sacan" sus cuotas de los compromisos futuros:
      // ya no se van a pagar.
      const paidPeriods = new Set(
        statementRows
          .filter((statement) => statement.paidMovementId !== null)
          .map((statement) =>
            periodKey({
              year: statement.periodYear,
              month: statement.periodMonth,
            }),
          ),
      );

      // ¿El período actual ya tiene un resumen GUARDADO? Pasa cuando el cierre
      // es HOY (se puede correr el cierre el mismo día) o cuando el cierre
      // cambió y el período "actual" quedó con un documento de la regla
      // anterior. Si el documento existe, sus cuotas YA se facturaron: viven
      // en el resumen (y en `currentPeriod`), no en "cuotas comprometidas".
      // Sumarlas en los dos lados las contaría dos veces — exactamente lo que
      // D10 y el criterio 2 existen para evitar.
      const persisted =
        statementRows.find(
          (statement) =>
            statement.periodYear === current.year &&
            statement.periodMonth === current.month,
        ) ?? null;

      // El corrimiento depende del estado del documento:
      //   · IMPAGO: sus cuotas no las saca nadie más (no están en
      //     `paidPeriods`), así que la ventana arranca en el período
      //     siguiente. El mes facturado vive en su resumen (D10).
      //   · PAGADO: `paidPeriods` ya lo excluye (bucket en 0) y la ventana
      //     conserva su alineación con los próximos meses calendario, que es
      //     lo que promete "próximos 6 meses" (el mes en curso es un bucket
      //     más, en cero porque ya se pagó).
      const commitmentsFrom =
        persisted !== null && persisted.paidMovementId === null
          ? nextPeriod(current)
          : current;

      const planItems = planRows.flatMap((plan) => plan.items);
      const commitmentsValue = commitmentsFromItems(
        planItems,
        commitmentsFrom,
        12,
        paidPeriods,
      );

      commitments = {
        next6Months: sum(
          commitmentsValue.months.slice(0, 6).map((month) => month.amount),
        ).toFixed(2),
        next12Months: commitmentsValue.total.toFixed(2),
        months: commitmentsValue.months.map((month) => ({
          year: month.year,
          month: month.month,
          periodLabel: cardPeriodLabel({
            year: month.year,
            month: month.month,
          }),
          amount: month.amount.toFixed(2),
        })),
      };

      if (persisted) {
        // El documento guardado manda: si existe, los números son los que se
        // emitieron, no una proyección que podría diferir por un recálculo.
        currentPeriod = {
          year: current.year,
          month: current.month,
          periodLabel: cardPeriodLabel(current),
          closingDate: dbToCalendar(persisted.closingDate),
          dueDate: dbToCalendar(persisted.dueDate),
          totalDue: persisted.totalDue.toFixed(2),
          minimumDue: persisted.minimumDue.toFixed(2),
          closed: true,
          persisted: true,
          paid: persisted.paidMovementId !== null,
        };
      } else {
        const window = periodWindow(current, closingDay);
        // Proyección: sólo cargos con fecha hasta HOY (un movimiento futuro
        // precargado no debería inflar el "vas a pagar" de este período).
        const cutoff = today < window.through ? today : window.through;

        const directRows = await db.movement.findMany({
          where: {
            kind: "EXPENSE",
            accountId: balance.id,
            date: {
              gt: calendarToDb(window.after),
              lte: calendarToDb(cutoff),
            },
          },
          select: { id: true, amount: true },
        });

        const purchaseMovementIds = new Set(
          planRows.map((plan) => plan.movementId),
        );

        const itemsAmount = sum(
          planItems
            .filter(
              (item) =>
                item.periodYear === current.year &&
                item.periodMonth === current.month,
            )
            .map((item) => item.amount),
        );

        const directAmount = sum(
          directRows
            .filter((movement) => !purchaseMovementIds.has(movement.id))
            .map((movement) => movement.amount),
        );

        const total = itemsAmount.plus(directAmount);

        currentPeriod = {
          year: current.year,
          month: current.month,
          periodLabel: cardPeriodLabel(current),
          closingDate: window.through,
          dueDate: dueDateOf(current, closingDay, dueDay),
          totalDue: total.toFixed(2),
          minimumDue: minimumPayment(total).toFixed(2),
          closed: isPeriodClosed(current, today, closingDay),
          persisted: false,
          paid: false,
        };
      }
    }

    views.push({
      ...balanceToAccountDTO(balance),
      balance: balance.balance.toFixed(2),
      debt: balance.debt === null ? null : balance.debt.toFixed(2),
      isLiability: balance.isLiability,
      inflow: balance.inflow.toFixed(2),
      outflow: balance.outflow.toFixed(2),
      creditLimit:
        balance.creditLimit === null ? null : balance.creditLimit.toFixed(2),
      utilizationPercent:
        utilization === null ? null : utilization.toFixed(2),
      currentPeriod,
      commitments,
      statements: statementRows.map(toStatementDTO),
      plans,
    });
  }

  return { cards: views, truncated };
}
