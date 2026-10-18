import type {
  AmortizationSystemDTO,
  LoanInstallmentDTO,
  LoanViewDTO,
} from "./finance";

/**
 * Estados de la pantalla de préstamos: la cuota del cronograma y la píldora de
 * la tarjeta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVE ACÁ Y NO EN EL JSX
 * ─────────────────────────────────────────────────────────────────────────────
 * Es lógica de presentación con bordes finos —cobertura por prefijo, fecha de
 * calendario, cuotas sin amortización— y el JSX no da candados. Como
 * `lib/card-form.ts`, es puro y sin dependencias: se puede usar en componentes
 * de cliente (importa SÓLO tipos de `lib/finance.ts`, nada de Prisma).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DECISIONES DE BORDE (no obvias)
 * ─────────────────────────────────────────────────────────────────────────────
 * · **"Vence hoy" no es "vencida" ni es "adelanto".** Una cuota impaga que
 *   vence hoy es Pendiente (todavía la podés pagar en fecha); una cuota
 *   cubierta que vence hoy es Pagada. El signo de comparación es distinto a
 *   propósito: `dueDate < today` para lo impago, `dueDate <= today` para lo
 *   cubierto.
 * · **Los sistemas que no amortizan por cuota** (AMERICAN, INTEREST_ONLY) tienen
 *   filas de capital 0: rotularlas "Vencida" contradiría la semántica de la
 *   ronda 1 (su interés va como gasto y los compromisos NUNCA las cuentan como
 *   vencidas — ver `loanCommitments`). Por eso, impagas y sin amortización son
 *   "Solo interés". En AMERICAN el cierre (capital > 0) cae por la vía común.
 */

/** Lo que hace falta de una cuota para rotularla. */
export type InstallmentStateInput = Pick<
  LoanInstallmentDTO,
  "covered" | "dueDate" | "principal"
>;

/** El estado de una cuota del cronograma, ya en castellano. */
export type InstallmentState =
  | "Pagada"
  | "Cubierta"
  | "Vencida"
  | "Pendiente"
  | "Solo interés";

/**
 * La leyenda que acompaña al cronograma (explica los rótulos que no se leen
 * solos: "Cubierta" y "Solo interés").
 */
export const INSTALLMENT_STATE_LEGEND =
  "Pagada = cubierta y con la fecha ya caída · Cubierta = pagada por adelantado · " +
  "Vencida = pasó la fecha y sigue impaga · Solo interés = cuota sin amortización " +
  "(el capital se cancela aparte)";

/** El estado de UNA cuota: cobertura primero, después fecha y sistema. */
export function installmentState(
  installment: InstallmentStateInput,
  system: AmortizationSystemDTO,
  today: string,
): InstallmentState {
  if (installment.covered) {
    return installment.dueDate <= today ? "Pagada" : "Cubierta";
  }

  // `Number("0.00") === 0` es exacto para el cero; acá sólo se distingue cero
  // de no-cero, no se hace aritmética con el monto.
  const amortizes = Number(installment.principal) !== 0;
  if (!amortizes && (system === "AMERICAN" || system === "INTEREST_ONLY")) {
    return "Solo interés";
  }

  return installment.dueDate < today ? "Vencida" : "Pendiente";
}

/** Lo que hace falta de la vista para la píldora de estado de la tarjeta. */
export interface LoanStatusInput {
  plan: Pick<NonNullable<LoanViewDTO["plan"]>, "remainingCount"> | null;
  nextInstallment: Pick<LoanInstallmentDTO, "dueDate"> | null;
}

/** La píldora de la tarjeta: sin cronograma / cubierto / vencida / al día. */
export type LoanStatus = "Sin cronograma" | "Cubierto" | "Vencida" | "Al día";

/**
 * El estado de un préstamo, en una sola píldora.
 *
 * "Vencida" sólo puede decirla la cuota que la RUTA acepta (`nextInstallment`):
 * un rotativo (INTEREST_ONLY) no tiene ninguna y jamás queda "vencido" — su
 * interés del mes va como gasto (misma semántica de la ronda 1).
 */
export function loanStatus(loan: LoanStatusInput, today: string): LoanStatus {
  if (loan.plan === null) return "Sin cronograma";
  if (loan.plan.remainingCount === 0) return "Cubierto";
  if (loan.nextInstallment !== null && loan.nextInstallment.dueDate < today) {
    return "Vencida";
  }
  return "Al día";
}
