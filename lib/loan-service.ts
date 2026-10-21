/**
 * Servicio de préstamos: alta con cronograma materializado, vista con progreso
 * y compromisos, y pago de cuota / cancelación anticipada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DIVISIÓN DE RESPONSABILIDADES (la misma de tarjetas)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `lib/loans.ts` — las cuentas PURAS: sistemas, fechas, progreso,
 *     compromisos. Sin Prisma, sin reloj, sin red.
 *   · ESTE módulo — leer y escribir: transacciones, reclamos atómicos,
 *     idempotencia y armado de los DTOs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS REGLAS DE ORO DEL PAGO
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Serialización por préstamo.** Cada pago bloquea la fila de la cuenta
 *    (`SELECT ... FOR UPDATE`) antes de leer la cobertura. Dos toques
 *    simultáneos se ordenan y el segundo NUNCA duplica: con número explícito ve
 *    la cuota cubierta (`created: false`), y sin número sólo alcanza una cuota
 *    ya vencida — después del primer toque, la próxima tiene fecha futura y
 *    también responde `created: false` sin escribir. No hace falta una tabla de
 *    pagos: la cobertura se DERIVA de las transferencias (definición de la
 *    Fase 6) y el lock la hace consistente dentro de la transacción.
 * 2. **Las patas exactas del contrato.** La cuota se parte con la composición
 *    del cronograma MATERIALIZADO (no se recalcula): TRANSFER por el capital
 *    (jamás gasto ni ingreso) + EXPENSE/INCOME por el interés (el único costo
 *    real). Las patas de monto cero se omiten (la base prohíbe monto ≤ 0).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./balance";
import { getAccountBalances } from "./balance";
import { categoryKindMessage } from "./category-kind";
import { cardPeriodLabel } from "./cards";
import {
  calendarToDb,
  dbToCalendar,
  startOfMonth,
  todayCalendar,
  type CalendarDate,
} from "./dates";
import { cleanName, normalizeCategoryName } from "./finance";
import type {
  LoanCommitmentsDTO,
  LoanInstallmentDTO,
  LoanPayResponseDTO,
  LoanViewDTO,
  LoansResponse,
  MovementDTO,
} from "./finance";
import {
  dueDateSeries,
  loanCommitments,
  loanDirectionOf,
  loanProgressFor,
  loanScheduleFor,
  materializeSchedule,
  systemOf,
  type AmortizationSystem,
  type ImportedInstallmentInput,
} from "./loans";
import { money, sum, zero, type Installment, type Money } from "./money";
import { movementInclude, toAccountDTO, toMovementDTO } from "./queries";

/** Cuántos meses de compromisos mira la vista (6 se derivan de los primeros). */
export const LOAN_COMMITMENT_WINDOW_MONTHS = 12;

/** Máximo de cuotas de un cronograma importado. Mismo tope que la API. */
export const LOAN_MAX_INSTALLMENTS = 600;

/* ────────────────────────────────────────────────────────────────────────────
 * Errores de dominio
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un error de dominio del préstamo, con su status HTTP.
 *
 * Igual que `CardError` y `RecurrenceError`: estas operaciones escriben en una
 * transacción y un error tiene que ABORTARLA. Devolver `{ ok: false }` dejaría
 * a medias lo que ya se escribió; una excepción no.
 */
export class LoanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LoanError";
  }
}

/** Traduce un `LoanError` a la forma que espera una ruta. `null` si no lo es. */
export function describeLoanError(
  error: unknown,
): { status: number; message: string } | null {
  if (!(error instanceof LoanError)) return null;
  return { status: error.status, message: error.message };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fila y tipos internos
 * ──────────────────────────────────────────────────────────────────────────── */

/** Los parámetros del contrato que viven en la cuenta. */
interface LoanParamsRow {
  id: string;
  principal: Money | null;
  tnaPercent: Money | null;
  installmentCount: number | null;
  firstInstallmentDate: Date | null;
  amortizationSystem: AmortizationSystem | null;
}

type LoanKind = "LOAN" | "RECEIVABLE";
type InstallmentRow = Prisma.InstallmentGetPayload<object>;

/** La fila de cuota convertida a la forma que consumen las funciones puras. */
function toInstallment(row: InstallmentRow): Installment {
  return {
    number: row.number,
    payment: money(row.payment),
    interest: money(row.interest),
    principal: money(row.principal),
    remainingBalance: money(row.remainingBalance),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Alta: la cuenta y su cronograma, en UNA transacción
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreateLoanAccountInput {
  name: string;
  kind: LoanKind;
  openingBalance: string;
  system: AmortizationSystem;
  principal: Money;
  /** Obligatoria salvo en IMPORTED (la composición la dicta el cronograma). */
  tnaPercent: Money | null;
  /** Obligatoria salvo en IMPORTED (se deriva del largo del cronograma). */
  installmentCount: number | null;
  /** Obligatoria salvo en IMPORTED (es la fecha de su primera cuota). */
  firstInstallmentDate: CalendarDate | null;
  /** Sólo para IMPORTED: las cuotas tal como las declaró el banco. */
  imported: readonly ImportedInstallmentInput[] | null;
}

/**
 * Traduce el error de una fórmula pura (`lib/loans.ts`) a `LoanError` 400.
 *
 * Las fórmulas puras tiran `Error` con mensajes en castellano pensados para la
 * persona ("el préstamo es demasiado chico para esa cantidad de cuotas…"): son
 * DATOS del pedido, no fallas del servidor. Sin esta traducción, el mensaje
 * igual llegaría al cliente —pero con un 500— y el usuario no sabría que puede
 * corregir lo que mandó.
 */
function asLoanError(error: unknown): LoanError {
  if (error instanceof LoanError) return error;
  if (error instanceof Error) return new LoanError(400, error.message);
  return new LoanError(
    400,
    "El cronograma del préstamo no se pudo calcular con esos datos.",
  );
}

/**
 * El cronograma de un préstamo recién creado: aritmética + fechas.
 *
 * Es una función aparte para que las DOS validaciones que dependen del sistema
 * (imported necesita `imported`; los calculados necesitan tasa, cuotas y fecha)
 * tengan un solo camino y el error salga en castellano como `LoanError` 400.
 */
function buildSchedule(input: CreateLoanAccountInput): {
  schedule: ReturnType<typeof materializeSchedule>;
  installmentCount: number;
  firstInstallmentDate: CalendarDate;
} {
  const { system } = input;

  if (system === "IMPORTED") {
    if (input.imported === null || input.imported.length === 0) {
      throw new LoanError(
        400,
        "Un préstamo importado necesita el cronograma del banco (fechas, pago e interés de cada cuota).",
      );
    }

    let schedule: ReturnType<typeof materializeSchedule>;
    try {
      schedule = materializeSchedule(
        loanScheduleFor({
          system,
          principal: input.principal,
          tnaPercent: input.tnaPercent,
          installmentCount: input.imported.length,
          imported: input.imported,
        }),
        input.imported.map((item) => item.dueDate),
      );
    } catch (error) {
      throw asLoanError(error);
    }

    return {
      schedule,
      installmentCount: schedule.length,
      firstInstallmentDate: schedule[0].dueDate,
    };
  }

  if (
    input.tnaPercent === null ||
    input.installmentCount === null ||
    input.firstInstallmentDate === null
  ) {
    throw new LoanError(
      400,
      "Un préstamo necesita el monto, la tasa (TNA), la cantidad de cuotas y la fecha de la primera cuota: sin eso no se puede armar el cronograma.",
    );
  }

  try {
    const scheduled = loanScheduleFor({
      system,
      principal: input.principal,
      tnaPercent: input.tnaPercent,
      installmentCount: input.installmentCount,
    });
    const dueDates = dueDateSeries(input.firstInstallmentDate, input.installmentCount);

    return {
      schedule: materializeSchedule(scheduled, dueDates),
      installmentCount: input.installmentCount,
      firstInstallmentDate: input.firstInstallmentDate,
    };
  } catch (error) {
    throw asLoanError(error);
  }
}

/**
 * Crea una cuenta de préstamo (LOAN o RECEIVABLE) CON su cronograma, en una
 * sola transacción.
 *
 * La atomicidad no es decorativa: un préstamo sin cronograma es una cuenta
 * cuya única pregunta importante —"¿qué cuotas tengo comprometidas?"— no se
 * puede contestar. O quedan los dos, o no queda ninguno.
 *
 * Los errores de las fórmulas puras ("el préstamo es demasiado chico…") se
 * traducen a `LoanError` 400: son datos del pedido, no fallas del servidor.
 */
export async function createLoanAccount(
  db: PrismaClient,
  input: CreateLoanAccountInput,
): Promise<Prisma.AccountGetPayload<object>> {
  const built = buildSchedule(input);

  return db.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: {
        name: input.name,
        kind: input.kind,
        openingBalance: input.openingBalance,
        principal: input.principal.toFixed(2),
        tnaPercent: input.tnaPercent ? input.tnaPercent.toFixed(4) : null,
        installmentCount: built.installmentCount,
        firstInstallmentDate: calendarToDb(built.firstInstallmentDate),
        amortizationSystem: input.system,
      },
    });

    await tx.installment.createMany({
      data: built.schedule.map((installment) => ({
        accountId: account.id,
        number: installment.number,
        dueDate: calendarToDb(installment.dueDate),
        payment: installment.payment.toFixed(2),
        interest: installment.interest.toFixed(2),
        principal: installment.principal.toFixed(2),
        remainingBalance: installment.remainingBalance.toFixed(2),
      })),
    });

    return account;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Curación del cronograma (idempotente)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Rellena las cuotas FALTANTES de un préstamo con parámetros completos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ HACE Y QUÉ NO (la decisión, con su porqué)
 * ─────────────────────────────────────────────────────────────────────────────
 * · HACE: crear las filas que faltan, derivadas de los parámetros de la cuenta
 *   y de la serie de fechas. Es idempotente: `createMany ... skipDuplicates`
 *   sobre el único `(accountId, number)` hace que dos corridas (o dos GET
 *   simultáneos) no dupliquen nada.
 * · NO HACE: reescribir filas existentes. El cronograma es un DOCUMENTO: si una
 *   fila existe, esa es la cuota pactada, aunque los parámetros de la cuenta
 *   hayan cambiado después (hoy no hay PATCH de parámetros de préstamo, pero la
 *   regla queda escrita). Igualar "documento" con "parámetros" es lo que
 *   permite que el progreso se mida contra algo que no se mueve.
 *
 * Devuelve cuántas filas creó. En IMPORTED devuelve 0 y no toca nada: el
 * cronograma externo no se puede inventar si falta (habría que adivinar lo que
 * dice el banco). En cuentas legadas (sin fecha o sin tasa) tampoco.
 */
export async function ensureLoanInstallments(
  db: Db,
  account: LoanParamsRow,
): Promise<number> {
  const system = systemOf(account.amortizationSystem);
  if (system === "IMPORTED") return 0;
  if (
    account.principal === null ||
    account.tnaPercent === null ||
    account.installmentCount === null ||
    account.installmentCount <= 0 ||
    account.firstInstallmentDate === null
  ) {
    return 0;
  }

  const schedule = loanScheduleFor({
    system,
    principal: account.principal,
    tnaPercent: account.tnaPercent,
    installmentCount: account.installmentCount,
  });
  const dueDates = dueDateSeries(
    dbToCalendar(account.firstInstallmentDate),
    account.installmentCount,
  );
  const rows = materializeSchedule(schedule, dueDates);

  const result = await db.installment.createMany({
    data: rows.map((installment) => ({
      accountId: account.id,
      number: installment.number,
      dueDate: calendarToDb(installment.dueDate),
      payment: installment.payment.toFixed(2),
      interest: installment.interest.toFixed(2),
      principal: installment.principal.toFixed(2),
      remainingBalance: installment.remainingBalance.toFixed(2),
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Capital que consta (la definición de la Fase 6, por dirección)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Σ del capital que consta en cada préstamo, hasta `asOf`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DEFINICIÓN ES LA DE LA FASE 6, GENERALIZADA POR DIRECCIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 * · LOAN (I_OWE): Σ de las TRANSFERENCIAS que ENTRARON al préstamo. El pago
 *   extra cuenta: es plata que bajó la deuda.
 * · RECEIVABLE (OWED_TO_ME): Σ de las TRANSFERENCIAS que SALIERON de la cuenta
 *   por cobrar (lo que te devolvieron). El desembolso (lo que vos prestaste)
 *   ENTRÓ a la cuenta y no cuenta como recuperado — si contara, el progreso
 *   arrancaría en 100% el día del préstamo.
 *
 * Una transferencia creada a mano también cuenta (pagar de más cargando solo
 * la transferencia es un camino legítimo y soportado). Por eso la cobertura no
 * se guarda: se deriva de la plata que consta.
 */
async function capitalPaidByLoan(
  db: Db,
  ids: { loans: string[]; receivables: string[] },
  asOf: CalendarDate,
): Promise<Map<string, Money>> {
  const [intoLoans, outOfReceivables] = await Promise.all([
    ids.loans.length > 0
      ? db.movement.groupBy({
          by: ["toAccountId"],
          where: {
            kind: "TRANSFER",
            toAccountId: { in: ids.loans },
            date: { lte: calendarToDb(asOf) },
          },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    ids.receivables.length > 0
      ? db.movement.groupBy({
          by: ["accountId"],
          where: {
            kind: "TRANSFER",
            accountId: { in: ids.receivables },
            date: { lte: calendarToDb(asOf) },
          },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
  ]);

  const map = new Map<string, Money>();
  for (const row of intoLoans) {
    if (row.toAccountId === null || row._sum.amount === null) continue;
    map.set(row.toAccountId, money(row._sum.amount));
  }
  for (const row of outOfReceivables) {
    if (row._sum.amount === null) continue;
    map.set(row.accountId, money(row._sum.amount));
  }
  return map;
}

/**
 * Los préstamos cuyo DESEMBOLSO consta como transferencia registrada.
 *
 * Es el espejo de `capitalPaidByLoan`: no la plata que pagó la deuda, sino la
 * que la DECLARÓ.
 *   · LOAN: una TRANSFERENCIA que SALIÓ de la cuenta del préstamo.
 *   · RECEIVABLE: una TRANSFERENCIA que ENTRÓ a la cuenta por cobrar.
 *
 * Sin esto, un alta guiada que se saltea el desembolso deja un saldo que
 * "aparece de la nada" (ver `disbursed` en `LoanViewDTO`). Acotado a
 * `date <= asOf`, igual que el capital pagado: la vista es una foto a una
 * fecha.
 */
async function disbursedLoanIds(
  db: Db,
  ids: { loans: string[]; receivables: string[] },
  asOf: CalendarDate,
): Promise<Set<string>> {
  const [outOfLoans, intoReceivables] = await Promise.all([
    ids.loans.length > 0
      ? db.movement.groupBy({
          by: ["accountId"],
          where: {
            kind: "TRANSFER",
            accountId: { in: ids.loans },
            date: { lte: calendarToDb(asOf) },
          },
        })
      : Promise.resolve([]),
    ids.receivables.length > 0
      ? db.movement.groupBy({
          by: ["toAccountId"],
          where: {
            kind: "TRANSFER",
            toAccountId: { in: ids.receivables },
            date: { lte: calendarToDb(asOf) },
          },
        })
      : Promise.resolve([]),
  ]);

  const set = new Set<string>();
  for (const row of outOfLoans) set.add(row.accountId);
  for (const row of intoReceivables) {
    if (row.toAccountId !== null) set.add(row.toAccountId);
  }
  return set;
}

/* ────────────────────────────────────────────────────────────────────────────
 * La vista de préstamos
 * ──────────────────────────────────────────────────────────────────────────── */

/** El DTO de una cuota, con su cobertura derivada. */
function toInstallmentDTO(
  row: InstallmentRow,
  covered: boolean,
): LoanInstallmentDTO {
  return {
    number: row.number,
    dueDate: dbToCalendar(row.dueDate),
    payment: row.payment.toFixed(2),
    interest: row.interest.toFixed(2),
    principal: row.principal.toFixed(2),
    remainingBalance: row.remainingBalance.toFixed(2),
    covered,
  };
}

/**
 * Arma la vista de UN préstamo a partir de lo que ya se leyó.
 *
 * Es una función pura de ensamblado: no consulta nada. Eso permite que la
 * lista y el pago devuelvan EXACTAMENTE la misma forma sin duplicar el armado.
 */
function assembleLoanView(args: {
  balance: {
    id: string;
    name: string;
    kind: LoanKind;
    archived: boolean;
    opening: Money;
    closingDay: number | null;
    dueDay: number | null;
    creditLimit: Money | null;
    inflow: Money;
    outflow: Money;
    balance: Money;
    debt: Money | null;
    isLiability: boolean;
  };
  params: LoanParamsRow | undefined;
  rows: InstallmentRow[];
  capitalPaid: Money;
  disbursed: boolean;
  today: CalendarDate;
}): LoanViewDTO {
  const { balance, params, rows, capitalPaid, disbursed, today } = args;
  const system = systemOf(params?.amortizationSystem ?? null);
  const direction = loanDirectionOf(balance.kind);

  const base = toAccountDTO({
    id: balance.id,
    name: balance.name,
    kind: balance.kind,
    archived: balance.archived,
    openingBalance: balance.opening,
    closingDay: balance.closingDay,
    dueDay: balance.dueDay,
    creditLimit: balance.creditLimit,
    amortizationSystem: params?.amortizationSystem ?? null,
  });

  const hasSchedule = rows.length > 0;

  let plan: LoanViewDTO["plan"] = null;
  let capitalPaidDto: string | null = null;
  let interestPaidDto: string | null = null;
  let progressPercent: string | null = null;
  let coveredCount = 0;
  let nextInstallment: LoanInstallmentDTO | null = null;
  let commitments: LoanCommitmentsDTO | null = null;

  if (hasSchedule) {
    const schedule = rows.map(toInstallment);
    const contractPrincipal = params?.principal ?? sum(schedule.map((i) => i.principal));
    const progress = loanProgressFor(
      {
        system,
        principal: contractPrincipal,
        tnaPercent: params?.tnaPercent ?? null,
        installmentCount: schedule.length,
      },
      schedule,
      capitalPaid,
    );

    coveredCount = progress.installmentsCovered;

    plan = {
      payment: rows[0].payment.toFixed(2),
      principal: progress.principal.toFixed(2),
      installmentCount: schedule.length,
      paidCount: progress.installmentsCovered,
      remainingCount: progress.remainingCount,
    };
    capitalPaidDto = progress.capitalPaid.toFixed(2);
    interestPaidDto =
      progress.interestPaid === null ? null : progress.interestPaid.toFixed(2);
    progressPercent = progress.progressPercent.toFixed(2);

    // La próxima cuota impaga: la única que la ruta de pago acepta.
    //   · INTEREST_ONLY: ninguna — el interés va como gasto y el capital se
    //     cancela aparte (ver `payLoanInstallment`).
    //   · AMERICAN: la primera con amortización (el cierre). Las de sólo
    //     interés no tocan el saldo y la cobertura es todo-o-nada.
    //   · resto: la primera impaga del prefijo.
    let next: InstallmentRow | undefined = rows[coveredCount];
    if (system === "INTEREST_ONLY") {
      next = undefined;
    } else if (system === "AMERICAN") {
      next =
        coveredCount > 0
          ? undefined
          : rows.find((row) => money(row.principal).greaterThan(0));
    }
    nextInstallment = next ? toInstallmentDTO(next, false) : null;

    const commitmentValue = loanCommitments(
      rows.map((row) => ({
        dueDate: dbToCalendar(row.dueDate),
        payment: money(row.payment),
        covered: row.number <= coveredCount,
      })),
      startOfMonth(today),
      LOAN_COMMITMENT_WINDOW_MONTHS,
      // Los rotativos y los americanos no derivan "vencido" del saldo (su
      // interés va como gasto): comprometerían cuotas de sólo interés ya
      // pagadas como si debieran. Mismo criterio en los dos (ver lib/loans.ts).
      { countOverdue: system !== "INTEREST_ONLY" && system !== "AMERICAN" },
    );

    const monthSix = commitmentValue.months.slice(0, 6);
    commitments = {
      next6Months: sum(monthSix.map((month) => month.amount)).toFixed(2),
      next12Months: commitmentValue.total.toFixed(2),
      months: commitmentValue.months.map((month) => ({
        year: month.year,
        month: month.month,
        periodLabel: cardPeriodLabel({ year: month.year, month: month.month }),
        amount: month.amount.toFixed(2),
      })),
      overdue: commitmentValue.overdue.toFixed(2),
      overdueCount: commitmentValue.overdueCount,
    };
  }

  return {
    ...base,
    kind: balance.kind,
    direction,
    system,
    balance: balance.balance.toFixed(2),
    debt: balance.debt === null ? null : balance.debt.toFixed(2),
    receivable:
      balance.kind === "RECEIVABLE" ? balance.balance.toFixed(2) : null,
    disbursed,
    isLiability: balance.isLiability,
    inflow: balance.inflow.toFixed(2),
    outflow: balance.outflow.toFixed(2),
    principal: params?.principal ? params.principal.toFixed(2) : null,
    tnaPercent: params?.tnaPercent ? params.tnaPercent.toFixed(4) : null,
    installmentCount: params?.installmentCount ?? (hasSchedule ? rows.length : null),
    firstInstallmentDate: params?.firstInstallmentDate
      ? dbToCalendar(params.firstInstallmentDate)
      : hasSchedule
        ? dbToCalendar(rows[0].dueDate)
        : null,
    plan,
    capitalPaid: capitalPaidDto,
    interestPaid: interestPaidDto,
    progressPercent,
    nextInstallment,
    installments: rows.map((row) => toInstallmentDTO(row, row.number <= coveredCount)),
    commitments,
  };
}

/**
 * Carga las vistas de TODOS los préstamos (LOAN y RECEIVABLE), sin filtrar.
 *
 * Antes de leer, cura: si a un préstamo con parámetros completos le faltan
 * filas de cronograma (cuenta creada antes de esta fase, o una importación que
 * quedó a medias), las completa. La curación es idempotente e inofensiva en el
 * camino normal (no crea nada cuando ya están todas).
 */
async function loadLoanViews(
  db: Db,
  options: { today: CalendarDate; includeArchived: boolean },
): Promise<LoanViewDTO[]> {
  const { today, includeArchived } = options;

  const [balances, paramRows] = await Promise.all([
    getAccountBalances(db, { asOf: today, includeArchived }),
    db.account.findMany({
      where: { kind: { in: ["LOAN", "RECEIVABLE"] } },
      select: {
        id: true,
        principal: true,
        tnaPercent: true,
        installmentCount: true,
        firstInstallmentDate: true,
        amortizationSystem: true,
      },
    }),
  ]);

  const loans = balances.filter(
    (balance): balance is typeof balance & { kind: LoanKind } =>
      balance.kind === "LOAN" || balance.kind === "RECEIVABLE",
  );
  const paramsById = new Map(paramRows.map((row) => [row.id, row]));

  // ── La curación (idempotente) ──────────────────────────────────────────────
  for (const balance of loans) {
    const params = paramsById.get(balance.id);
    if (!params) continue;

    // El conteo esperado, en una local: la condición de arriba no alcanza
    // para que TypeScript descarte el `null` dos usos después.
    const expectedCount = params.installmentCount;
    const healable =
      systemOf(params.amortizationSystem) !== "IMPORTED" &&
      expectedCount !== null &&
      expectedCount > 0;

    if (healable && expectedCount !== null) {
      const existing = await db.installment.count({
        where: { accountId: balance.id },
      });
      if (existing < expectedCount) {
        try {
          await ensureLoanInstallments(db, params);
        } catch {
          // Datos legados que no describen un contrato (p. ej. una tasa
          // corrupta): la vista los muestra sin cronograma, no se cae.
        }
      }
    }
  }

  const ids = loans.map((loan) => loan.id);
  const loanIds = loans.filter((l) => l.kind === "LOAN").map((l) => l.id);
  const receivableIds = loans
    .filter((l) => l.kind === "RECEIVABLE")
    .map((l) => l.id);
  const [rows, capitalPaid, disbursedTransfers] = await Promise.all([
    ids.length > 0
      ? db.installment.findMany({
          where: { accountId: { in: ids } },
          orderBy: [{ accountId: "asc" }, { number: "asc" }],
        })
      : Promise.resolve([]),
    capitalPaidByLoan(db, { loans: loanIds, receivables: receivableIds }, today),
    disbursedLoanIds(db, { loans: loanIds, receivables: receivableIds }, today),
  ]);

  const rowsByAccount = new Map<string, InstallmentRow[]>();
  for (const row of rows) {
    const list = rowsByAccount.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccount.set(row.accountId, list);
  }

  return loans.map((balance) =>
    assembleLoanView({
      balance,
      params: paramsById.get(balance.id),
      rows: rowsByAccount.get(balance.id) ?? [],
      capitalPaid: capitalPaid.get(balance.id) ?? zero(),
      disbursed:
        disbursedTransfers.has(balance.id) ||
        // Apertura que YA declara la plata (un préstamo migrado a mano):
        // LOAN negativo = deuda de antes; RECEIVABLE positivo = crédito.
        (balance.kind === "LOAN"
          ? balance.opening.lessThan(0)
          : balance.opening.greaterThan(0)),
      today,
    }),
  );
}

/** `GET /api/loans`: todos los préstamos con su contrato y sus compromisos. */
export async function getLoansView(
  db: Db,
  options: { today?: CalendarDate; includeArchived?: boolean } = {},
): Promise<LoansResponse> {
  const today = options.today ?? todayCalendar();
  const views = await loadLoanViews(db, {
    today,
    includeArchived: options.includeArchived ?? true,
  });

  // Misma regla de visibilidad que el reporte de deudas: una cuenta archivada
  // sin saldo se omite (es una fila que ya no dice nada); con saldo pendiente
  // se muestra marcada — la deuda no desaparece por archivar.
  return {
    loans: views.filter(
      (view) => !(view.archived && money(view.balance).isZero()),
    ),
  };
}

/** La vista de UN préstamo, exista o no en la lista visible (usa el pago). */
export async function getLoanView(
  db: Db,
  accountId: string,
  options: { today?: CalendarDate } = {},
): Promise<LoanViewDTO> {
  const today = options.today ?? todayCalendar();
  const views = await loadLoanViews(db, { today, includeArchived: true });
  const view = views.find((item) => item.id === accountId);
  if (!view) throw new LoanError(404, "Ese préstamo no existe.");
  return view;
}

/* ────────────────────────────────────────────────────────────────────────────
 * El pago (y la cancelación anticipada)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PayLoanInput {
  accountId: string;
  /** La cuenta de dinero: de donde sale el pago (I_OWE) o donde entra (OWED_TO_ME). */
  cashAccountId: string;
  date: CalendarDate;
  /** La cuota a pagar. `null` = la próxima impaga (la única que se puede saltear por API no es salteable, ver abajo). */
  installmentNumber: number | null;
  /** Capital de más que se suma a la cuota (pago parcial/extra). */
  extraCapital: Money | null;
  /** Cancelación anticipada: paga TODO el capital que queda, sin interés. */
  cancel: boolean;
  /** Categoría del interés. Default "Intereses". */
  categoryName: string | null;
}

/** Lo que la transacción devolvió, antes de armar el DTO de respuesta. */
interface PayResult {
  created: boolean;
  cancelled: boolean;
  installmentNumber: number | null;
  principalPaid: Money | null;
  interestPaid: Money | null;
  movements: MovementDTO[];
}

/**
 * El interés de un pago: la categoría por defecto y su resolución.
 *
 * La categoría se resuelve por nombre NORMALIZADO (igual que en movimientos):
 * "Intereses" y "INTERESES" son la misma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL NOMBRE POR DEFECTO DEPENDE DE LA DIRECCIÓN
 *
 * El interés que pagás es un GASTO y el que cobrás es un INGRESO. Una
 * categoría tiene UN solo tipo, así que los dos intereses NO pueden llamarse
 * igual: "Intereses" (el que pagás) y "Intereses cobrados" (el que cobrás).
 *
 * Antes se usaba "Intereses" para los dos, con un `upsert` de `update: {}`: la
 * categoría conservaba el tipo del primer uso y el segundo interés se
 * guardaba con una categoría del tipo contrario. Eso lo destapó el invariante
 * nuevo (trigger `movement_category_kind_check`): el cobro de un préstamo a
 * cobrar devolvía 400, y con razón.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const DEFAULT_INTEREST_CATEGORY: Record<"INCOME" | "EXPENSE", string> = {
  EXPENSE: "Intereses",
  INCOME: "Intereses cobrados",
};

async function resolveInterestCategory(
  tx: Prisma.TransactionClient,
  categoryName: string,
  kind: "INCOME" | "EXPENSE",
): Promise<string> {
  const name = cleanName(categoryName) || DEFAULT_INTEREST_CATEGORY[kind];
  const normalizedName = normalizeCategoryName(name);

  // El `upsert` (y no un `find` + `create`) porque dos pagos simultáneos
  // pueden necesitar la misma categoría: con el `upsert`, el segundo INSERT
  // espera al primero en vez de morir por violar el índice único.
  const category = await tx.category.upsert({
    where: { normalizedName },
    update: {},
    create: { name, normalizedName, kind },
  });

  // La categoría existe con el tipo contrario: no se puede usar (el
  // movimiento sería imposible). Se dice cuál es el problema y qué hacer.
  if (category.kind !== kind) {
    throw new LoanError(
      400,
      `${categoryKindMessage(category.name, kind, category.kind)} ` +
        `Si no querés clasificarla, no envíes el nombre de la categoría: ` +
        `se usa «${DEFAULT_INTEREST_CATEGORY[kind]}».`,
    );
  }

  return category.id;
}

/**
 * Paga la próxima cuota de un préstamo (o lo cancela por anticipado).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CONTRATO DEL PAGO (qué se puede y qué no, y por qué)
 * ─────────────────────────────────────────────────────────────────────────────
 * · **Sólo la próxima cuota impaga.** La cobertura camina el cronograma en
 *   orden: pagar la 5 sin la 4 haría que las cuotas cubiertas no sean un
 *   prefijo y todo el cálculo de progreso mentiría. La ruta acepta la cuota
 *   `cubiertas + 1` (u omitirla: es la misma), y una cuota ya cubierta devuelve
 *   `created: false` — la respuesta idempotente del doble toque.
 * · **Sin número, sólo lo ya vencido.** Omitir el número significa "la próxima
 *   impaga, si ya venció": si su vencimiento es posterior a `date`, la
 *   respuesta es `created: false` sin escribir nada. Es lo que hace seguro al
 *   reintento de una misma petición — el primer toque paga la cuota y el
 *   segundo ya no encuentra nada vencido, en vez de adelantar la siguiente.
 *   Para adelantar una cuota futura, se manda su número explícito.
 * · **Capital extra.** Se suma a la cuota del contrato y amortiza de más. El
 *   interés de la cuota NO cambia: el cronograma es el contrato y no se
 *   recalcula (la cuota futura no "baja" por pagar de más hoy — decisión
 *   documentada en lib/loans.ts).
 * · **Cancelación anticipada.** Paga el capital que queda, SIN interés futuro
 *   (el interés no devengado no se debe). No combina con cuota ni extra. Si el
 *   capital ya está cubierto, `created: false`: cancelar dos veces no paga dos
 *   veces.
 * · **Rotativos y americanos.** Un préstamo de sólo interés no acepta pago de
 *   cuotas por esta ruta: el pago del interés del mes va como gasto (categoría
 *   Intereses) y el capital se cancela con `cancel` o se amortiza con una
 *   transferencia. En un americano pasa lo mismo con sus cuotas de sólo interés
 *   (capital 0): no se pagan por acá — el interés va como gasto — y la única
 *   cuota que esta ruta acepta es el CIERRE (la última: ahí está todo el
 *   capital). El motivo es el mismo en los dos: el interés no toca el saldo de
 *   la cuenta, así que la cobertura no se puede derivar y un doble toque sería
 *   indetectable.
 *
 * Las patas se crean en el MISMO orden conceptual que la realidad:
 *   I_OWE     → TRANSFER banco → préstamo (capital) + EXPENSE desde el banco (interés).
 *   OWED_TO_ME → TRANSFER cuenta por cobrar → banco (capital) + INCOME al banco (interés).
 * Las de monto cero se omiten (la base prohíbe monto ≤ 0).
 *
 * @throws LoanError 404 cuenta inexistente; 400 pedido inválido; nada más:
 *         la cobertura derivada hace que la repetición sea `created: false`.
 */
export async function payLoanInstallment(
  db: PrismaClient,
  input: PayLoanInput,
  options: { today?: CalendarDate } = {},
): Promise<LoanPayResponseDTO> {
  const today = options.today ?? todayCalendar();
  const extraCapital =
    input.extraCapital !== null && input.extraCapital.isZero()
      ? null
      : input.extraCapital;

  if (input.cancel && (input.installmentNumber !== null || extraCapital !== null)) {
    throw new LoanError(
      400,
      "La cancelación anticipada paga todo el capital que queda: no se combina con una cuota ni con capital extra.",
    );
  }

  // ── Ids que la base no puede ni consultar ────────────────────────────────
  // Un byte NUL (\u0000) en el id es una secuencia UTF-8 inválida para
  // Postgres (22021): la consulta muere ANTES de buscar y el error ni siquiera
  // llega con código de Prisma — era un 500. Para la persona, un id así es un
  // id que no existe, exactamente lo que ya responde un id común que no está:
  // 404 para el préstamo, 400 para la cuenta de dinero. El lock de abajo es lo
  // PRIMERO que toca la base con el id, así que el guard va antes de abrir la
  // transacción.
  if (input.accountId.includes("\u0000")) {
    throw new LoanError(404, "Ese préstamo no existe.");
  }
  if (input.cashAccountId.includes("\u0000")) {
    throw new LoanError(400, "La cuenta de dinero no existe.");
  }

  const result = await db.$transaction<PayResult>(async (tx) => {
    // ── El lock por préstamo ────────────────────────────────────────────────
    // La fila de la cuenta se bloquea ANTES de leer nada: es lo que serializa
    // dos pagos simultáneos. Sin él, los dos leerían la misma cobertura, los
    // dos armarían las patas y el doble toque duplicaría el pago.
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${input.accountId} FOR UPDATE`;

    const account = await tx.account.findUnique({ where: { id: input.accountId } });
    if (!account) throw new LoanError(404, "Ese préstamo no existe.");
    if (account.kind !== "LOAN" && account.kind !== "RECEIVABLE") {
      throw new LoanError(400, "Esa cuenta no es un préstamo.");
    }
    const kind = account.kind;
    const direction = loanDirectionOf(kind);
    const system = systemOf(account.amortizationSystem);

    if (!input.cancel && system === "INTEREST_ONLY") {
      throw new LoanError(
        400,
        "Un préstamo de solo interés no amortiza cuotas: el interés de cada mes se registra como gasto (categoría Intereses) y el capital se cancela por anticipado.",
      );
    }

    const cash = await tx.account.findUnique({ where: { id: input.cashAccountId } });
    if (!cash) throw new LoanError(400, "La cuenta de dinero no existe.");
    if (cash.id === account.id) {
      throw new LoanError(
        400,
        "La cuenta de dinero tiene que ser distinta a la del préstamo.",
      );
    }
    if (cash.kind !== "CASH" && cash.kind !== "BANK") {
      throw new LoanError(
        400,
        "El pago tiene que salir de (o entrar a) una cuenta de dinero: efectivo o banco.",
      );
    }

    // ── El cronograma ───────────────────────────────────────────────────────
    let rows = await tx.installment.findMany({
      where: { accountId: account.id },
      orderBy: { number: "asc" },
    });

    if (rows.length === 0) {
      // Cuenta creada antes de esta fase: se intenta curar y se vuelve a leer.
      try {
        await ensureLoanInstallments(tx, account);
      } catch {
        // Se resuelve abajo con el mensaje de "sin cronograma".
      }
      rows = await tx.installment.findMany({
        where: { accountId: account.id },
        orderBy: { number: "asc" },
      });
    }

    if (rows.length === 0) {
      throw new LoanError(
        400,
        "Ese préstamo no tiene cronograma: sin cuotas materializadas no hay contrato que pagar. Cargá los parámetros (monto, tasa, cuotas y primera fecha) o usá una transferencia a mano.",
      );
    }

    const schedule = rows.map(toInstallment);
    const contractPrincipal =
      account.principal ?? sum(schedule.map((installment) => installment.principal));
    const progressInput = {
      system,
      principal: contractPrincipal,
      tnaPercent: account.tnaPercent,
      installmentCount: schedule.length,
    };

    // El capital que consta HASTA LA FECHA DEL PAGO: una transferencia futura
    // (precargada) no cubre una cuota todavía.
    const paidMap = await capitalPaidByLoan(
      tx,
      {
        loans: kind === "LOAN" ? [account.id] : [],
        receivables: kind === "RECEIVABLE" ? [account.id] : [],
      },
      input.date,
    );
    const capitalPaid = paidMap.get(account.id) ?? zero();
    const progress = loanProgressFor(progressInput, schedule, capitalPaid);
    const covered = progress.installmentsCovered;

    const remaining = (() => {
      const rest = contractPrincipal.minus(progress.capitalPaid);
      return rest.lessThan(0) ? zero() : rest;
    })();

    // ── Cancelación anticipada ──────────────────────────────────────────────
    if (input.cancel) {
      if (remaining.isZero()) {
        // Ya está cancelado (o cubierto del todo): idempotente.
        return {
          created: false,
          cancelled: false,
          installmentNumber: null,
          principalPaid: null,
          interestPaid: null,
          movements: [],
        };
      }

      const movement = await createCapitalLeg(tx, {
        direction,
        cashAccountId: cash.id,
        loanAccountId: account.id,
        amount: remaining,
        date: input.date,
        description: "Cancelación anticipada · capital",
      });

      return {
        created: true,
        cancelled: true,
        installmentNumber: null,
        principalPaid: remaining,
        interestPaid: null,
        movements: [toMovementDTO(movement)],
      };
    }

    // ── Pago de cuota ───────────────────────────────────────────────────────
    // La cuota que la ruta acepta:
    //   · AMERICAN: la primera con amortización — el CIERRE. Sus cuotas de sólo
    //     interés (capital 0) no tocan el saldo (el interés va como gasto
    //     manual), así que no son pagables por acá y la cobertura es
    //     todo-o-nada del capital: expected es el cierre, no cubiertas + 1.
    //   · resto: la próxima impaga del prefijo (cubiertas + 1).
    const expected = (() => {
      if (system !== "AMERICAN") return covered + 1;

      const closing = schedule.findIndex((item) =>
        item.principal.greaterThan(0),
      );
      if (closing === -1) {
        throw new LoanError(
          400,
          "Ese préstamo americano no tiene ninguna cuota que amortice capital: no hay nada que pagar por esta ruta.",
        );
      }
      return closing + 1;
    })();

    if (input.installmentNumber !== null && input.installmentNumber <= covered) {
      // Doble toque / reintento: esa cuota ya está cubierta. Nada se escribe.
      return {
        created: false,
        cancelled: false,
        installmentNumber: input.installmentNumber,
        principalPaid: null,
        interestPaid: null,
        movements: [],
      };
    }

    if (covered >= rows.length) {
      // Todas las cuotas cubiertas: no hay nada que pagar (en un americano
      // cerrado, la única cuota pagable ya se pagó).
      return {
        created: false,
        cancelled: false,
        installmentNumber: null,
        principalPaid: null,
        interestPaid: null,
        movements: [],
      };
    }

    if (input.installmentNumber !== null && input.installmentNumber !== expected) {
      const requested =
        input.installmentNumber <= schedule.length
          ? schedule[input.installmentNumber - 1]
          : undefined;

      // En un americano, pedir una cuota de sólo interés merece el porqué
      // completo (no un "en orden" que no explica nada): no toca el saldo y su
      // interés se registra como gasto — el mismo criterio que el rotativo.
      if (
        system === "AMERICAN" &&
        requested !== undefined &&
        requested.principal.isZero()
      ) {
        throw new LoanError(
          400,
          `En un préstamo americano las cuotas de solo interés no se pagan por esta ruta: el interés de cada mes se registra como gasto (categoría Intereses) y el capital se paga en el cierre — la cuota ${expected} de ${rows.length}.`,
        );
      }

      throw new LoanError(
        400,
        `Las cuotas se pagan en orden: la próxima impaga es la ${expected} de ${rows.length}.`,
      );
    }

    // Sin número, la ruta paga "la próxima impaga" sólo si YA venció. Es lo
    // que hace seguro al reintento de una misma petición: el primer toque paga
    // la cuota (una fecha futura no se toca sin número), y el segundo ya la ve
    // cubierta y encuentra la siguiente con fecha futura → `created: false`.
    // Para adelantar una cuota futura, se manda el número explícito.
    if (input.installmentNumber === null) {
      const due = dbToCalendar(rows[expected - 1].dueDate);
      if (due > input.date) {
        return {
          created: false,
          cancelled: false,
          installmentNumber: null,
          principalPaid: null,
          interestPaid: null,
          movements: [],
        };
      }
    }

    const installment = schedule[expected - 1];
    const principalLeg = installment.principal.plus(extraCapital ?? zero());
    const interestLeg = installment.interest;

    if (principalLeg.greaterThan(remaining)) {
      throw new LoanError(
        400,
        `El capital de este pago (${principalLeg.toFixed(2)}) supera el saldo que queda (${remaining.toFixed(2)}). Para cerrar el préstamo entero, usá la cancelación anticipada.`,
      );
    }

    const movements: MovementDTO[] = [];

    if (principalLeg.greaterThan(0)) {
      const transfer = await createCapitalLeg(tx, {
        direction,
        cashAccountId: cash.id,
        loanAccountId: account.id,
        amount: principalLeg,
        date: input.date,
        description: `Cuota ${expected} · capital`,
      });
      movements.push(toMovementDTO(transfer));
    }

    if (interestLeg.greaterThan(0)) {
      const interest = await createInterestLeg(tx, {
        direction,
        cashAccountId: cash.id,
        amount: interestLeg,
        date: input.date,
        description: `Cuota ${expected} · interés`,
        categoryName: input.categoryName,
      });
      movements.push(toMovementDTO(interest));
    }

    return {
      created: true,
      cancelled: false,
      installmentNumber: expected,
      principalPaid: principalLeg,
      interestPaid: interestLeg,
      movements,
    };
  });

  // La vista posterior se arma FUERA de la transacción, con una lectura
  // fresca: es presentación, y el estado consistente ya está commiteado.
  const loan = await getLoanView(db, input.accountId, { today });

  const installment = result.installmentNumber
    ? (loan.installments.find(
        (item) => item.number === result.installmentNumber,
      ) ?? null)
    : null;

  return {
    created: result.created,
    cancelled: result.cancelled,
    installment: installment ? { ...installment, covered: true } : null,
    principalPaid: result.principalPaid ? result.principalPaid.toFixed(2) : null,
    interestPaid: result.interestPaid ? result.interestPaid.toFixed(2) : null,
    movements: result.movements,
    loan,
  };
}

/** La pata de capital: una TRANSFER, en la dirección del préstamo. */
async function createCapitalLeg(
  tx: Prisma.TransactionClient,
  args: {
    direction: "I_OWE" | "OWED_TO_ME";
    cashAccountId: string;
    loanAccountId: string;
    amount: Money;
    date: CalendarDate;
    description: string;
  },
) {
  const iOwe = args.direction === "I_OWE";
  return tx.movement.create({
    data: {
      kind: "TRANSFER",
      amount: args.amount.toFixed(2),
      date: calendarToDb(args.date),
      description: args.description,
      // I_OWE: banco → préstamo (amortizo). OWED_TO_ME: por cobrar → banco (me devuelven).
      accountId: iOwe ? args.cashAccountId : args.loanAccountId,
      toAccountId: iOwe ? args.loanAccountId : args.cashAccountId,
    },
    include: movementInclude,
  });
}

/** La pata del interés: EXPENSE si lo pagás, INCOME si lo cobrás. */
async function createInterestLeg(
  tx: Prisma.TransactionClient,
  args: {
    direction: "I_OWE" | "OWED_TO_ME";
    cashAccountId: string;
    amount: Money;
    date: CalendarDate;
    description: string;
    categoryName: string | null;
  },
) {
  const kind = args.direction === "I_OWE" ? "EXPENSE" : "INCOME";
  const categoryId = await resolveInterestCategory(
    tx,
    args.categoryName ?? DEFAULT_INTEREST_CATEGORY[kind],
    kind,
  );

  return tx.movement.create({
    data: {
      kind,
      amount: args.amount.toFixed(2),
      date: calendarToDb(args.date),
      description: args.description,
      // El interés sale de (o entra a) la cuenta de dinero SIEMPRE: es el
      // único costo real del préstamo, y la cuenta de deuda no lo toca.
      accountId: args.cashAccountId,
      categoryId,
    },
    include: movementInclude,
  });
}
