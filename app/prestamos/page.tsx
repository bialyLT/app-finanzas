"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import LoanForm from "@/components/LoanForm";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { formatCalendar, todayCalendar } from "@/lib/dates";
import type {
  AccountBalanceDTO,
  LoanCommitmentsDTO,
  LoanPayResponseDTO,
  LoanViewDTO,
  LoansResponse,
} from "@/lib/finance";
import {
  centsToString,
  formatAmountInput,
  formatLiability,
  formatMoney,
  formatPercent,
  sumAmounts,
  toCents,
} from "@/lib/format";
import {
  INSTALLMENT_STATE_LEGEND,
  installmentState,
  loanStatus,
} from "@/lib/loan-ui";
import type { InstallmentState, LoanStatus } from "@/lib/loan-ui";
import { Handshake, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Pantalla de préstamos (Fase 4, ronda 2): lo que debés y lo que te deben.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNA SOLA FOTO POR PANTALLA
 * ─────────────────────────────────────────────────────────────────────────────
 * Todo sale de `GET /api/loans` (más `/api/accounts` para los selectores de
 * cuenta). La pantalla no recalcula NADA del contrato: cuota, capital pagado,
 * progreso y compromisos ya vienen calculados del servidor — la misma fuente
 * que usó el smoke de la ronda 1. El cliente sólo suma en centavos enteros
 * (`sumAmounts`) para los totales de sección y de compromisos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA PLATA SE MUEVE EN TRES LUGARES (y los tres son transferencias guiadas)
 * ─────────────────────────────────────────────────────────────────────────────
 * · **Desembolso**: cuando la tarjeta avisa que falta (el préstamo no tiene la
 *   transferencia real), el bloque `loan-disburse-*` la registra con el monto
 *   del contrato ya cargado (`principal`). Sin esto la deuda "vive de la nada"
 *   (ver `disbursed` en `lib/finance.ts`).
 * · **Pago de cuota**: el desglose se muestra TAL CUAL llega en
 *   `nextInstallment` (interés + capital): el cliente no divide nada, y manda
 *   `installmentNumber` explícito para que el servidor no adivine. El espacio
 *   "capital extra" no reimplementa la cancelación: es un dato opcional que la
 *   ruta suma al capital.
 * · **Cancelación**: dos pasos EN LÍNEA (nunca `window.confirm`), con el monto
 *   = capital pendiente calculado en centavos (`principal − capitalPaid`).
 *
 * `created: false` NUNCA es un error: es la respuesta idempotente de un doble
 * toque, y la pantalla lo cuenta como "ya estaba al día".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ NO HACE ESTA PANTALLA (diferidos explícitos de la ronda)
 * ─────────────────────────────────────────────────────────────────────────────
 * · No da de alta un préstamo con cronograma IMPORTADO: la ronda cubre el alta
 *   guiada que genera el cronograma (el modelo y el `LoanForm` ya lo soportan
 *   como sistema, pero la ruta de alta guiada no lo expone).
 * · No borra ni archiva desde acá: archivar/borrar una cuenta sigue viviendo
 *   en el panel, igual que el resto de las cuentas.
 * · No adelanta cuotas futuras sin la persona: el botón paga la cuota que la
 *   ruta acepta (`nextInstallment`), que es la próxima impaga.
 */

/** "2026-11" para el id estable del chip de un mes de compromisos. */
function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** El chip de estado de la tarjeta, con sus colores. */
const STATUS_CLASS: Record<LoanStatus, string> = {
  Cubierto:
    "bg-success/10 text-success ",
  "Al día": "bg-transfer/10 text-transfer ",
  Vencida: "bg-danger/10 text-danger ",
  "Sin cronograma":
    "bg-surface-3 text-fg-muted ",
};

/** La píldora de cada cuota del cronograma. */
const INSTALLMENT_STATE_CLASS: Record<InstallmentState, string> = {
  Pagada:
    "bg-success/10 text-success ",
  Cubierta: "bg-transfer/10 text-transfer ",
  Vencida: "bg-danger/10 text-danger ",
  Pendiente: "bg-surface-3 text-fg-muted ",
  "Solo interés":
    "bg-warning/10 text-warning ",
};

/** El bloque abierto de la pantalla: uno solo a la vez, como en `/tarjetas`. */
type BlockKind = "pay" | "cancel" | "disburse";

export default function LoansPage() {
  const [loans, setLoans] = useState<LoanViewDTO[]>([]);
  const [accounts, setAccounts] = useState<AccountBalanceDTO[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /** Id de la acción en curso: una sola a la vez, sin dobles toques. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [flashError, setFlashError] = useState(false);

  const [formOpen, setFormOpen] = useState(false);

  /**
   * El bloque abierto (pago / cancelación / desembolso) y sus campos.
   *
   * Los tres comparten `cashId` a propósito: es LA cuenta de dinero elegida
   * para esta pantalla, y salta de un bloque al otro sin volver a preguntar.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  const [openKind, setOpenKind] = useState<BlockKind | null>(null);
  const [blockDate, setBlockDate] = useState("");
  const [blockExtra, setBlockExtra] = useState("");
  const [blockError, setBlockError] = useState("");
  const [cashId, setCashId] = useState<string | null>(null);

  const today = todayCalendar();

  const load = useCallback(async (options: { archived: boolean }) => {
    setLoading(true);
    setLoadError("");

    try {
      const [loansRes, accountsRes] = await Promise.all([
        fetch(`/api/loans${options.archived ? "" : "?includeArchived=false"}`),
        fetch("/api/accounts"),
      ]);

      if (!loansRes.ok || !accountsRes.ok) {
        throw new Error("Alguno de los pedidos falló.");
      }

      const loansData = (await loansRes.json()) as LoansResponse;
      const accountsData = (await accountsRes.json()) as {
        accounts: AccountBalanceDTO[];
      };

      setLoans(loansData.loans);
      setAccounts(accountsData.accounts);
    } catch {
      setLoadError(
        "No se pudieron cargar los préstamos. Revisá que la base esté levantada y recargá.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load({ archived: false });
  }, [load]);

  // La cuenta por defecto del selector: la primera de banco. Se elige una vez
  // que las cuentas llegan, y se respeta la que la persona ya haya elegido.
  useEffect(() => {
    const origins = accounts.filter(
      (account) =>
        !account.archived &&
        (account.kind === "CASH" || account.kind === "BANK"),
    );
    if (origins.length === 0) return;

    setCashId((current) =>
      current && origins.some((account) => account.id === current)
        ? current
        : (origins.find((account) => account.kind === "BANK")?.id ??
          origins[0].id),
    );
  }, [accounts]);

  function showFlash(message: string, isError = false) {
    setFlash(message);
    setFlashError(isError);
  }

  /** Abre UN bloque y prepara sus campos (fecha de hoy, extra vacío). */
  function openBlock(id: string, kind: BlockKind) {
    setOpenId(id);
    setOpenKind(kind);
    setBlockDate(todayCalendar());
    setBlockExtra("");
    setBlockError("");
    showFlash("");
  }

  function closeBlock() {
    setOpenId(null);
    setOpenKind(null);
    setBlockError("");
  }

  function toggleArchived() {
    const next = !includeArchived;
    setIncludeArchived(next);
    closeBlock();
    showFlash("");
    load({ archived: next });
  }

  /** Cuentas desde las que se paga (o a las que llega): plata, no deuda. */
  const payOrigins = accounts.filter(
    (account) =>
      !account.archived &&
      (account.kind === "CASH" || account.kind === "BANK"),
  );

  const loanDebts = loans.filter((loan) => loan.kind === "LOAN");
  const receivables = loans.filter((loan) => loan.kind === "RECEIVABLE");
  const totalDebt = sumAmounts(loanDebts.map((loan) => loan.debt ?? "0"));
  const totalReceivable = sumAmounts(
    receivables.map((loan) => loan.receivable ?? "0"),
  );

  // ── Compromisos próximos: sólo lo que YO tengo que pagar ───────────────────
  // Un préstamo dado (RECEIVABLE) no compromete plata mía: no entra en la
  // suma. Los meses se agrupan por período y se suman en centavos.
  const debtCommitments = loanDebts
    .map((loan) => loan.commitments)
    .filter((value): value is LoanCommitmentsDTO => value !== null);
  const commitOverdue = sumAmounts(debtCommitments.map((c) => c.overdue));
  const commitOverdueCount = debtCommitments.reduce(
    (sum, c) => sum + c.overdueCount,
    0,
  );
  const commit6 = sumAmounts(debtCommitments.map((c) => c.next6Months));
  const commit12 = sumAmounts(debtCommitments.map((c) => c.next12Months));
  const commitMonths = (() => {
    const byMonth = new Map<string, { label: string; amounts: string[] }>();
    for (const commitments of debtCommitments) {
      for (const month of commitments.months) {
        const key = monthKey(month.year, month.month);
        const entry = byMonth.get(key) ?? { label: month.periodLabel, amounts: [] };
        entry.amounts.push(month.amount);
        byMonth.set(key, entry);
      }
    }
    return [...byMonth.entries()];
  })();

  // ── Pagar UNA cuota (o extra de capital) ───────────────────────────────────
  async function pay(loan: LoanViewDTO) {
    const installment = loan.nextInstallment;
    if (!installment || busyId) return;
    if (!cashId) {
      setBlockError("Elegí la cuenta de dinero: de dónde sale el pago.");
      return;
    }
    if (!blockDate.trim()) {
      setBlockError("La fecha del pago no puede estar vacía.");
      return;
    }
    const extraRaw = blockExtra.trim();
    if (extraRaw !== "" && formatAmountInput(blockExtra) === null) {
      setBlockError("El capital extra tiene que ser un monto válido.");
      return;
    }

    setBusyId(`pay-${loan.id}`);
    setBlockError("");
    try {
      const body: Record<string, unknown> = {
        accountId: loan.id,
        cashAccountId: cashId,
        date: blockDate,
        // Explícito a propósito: la ruta no adivina entre cuota y cancelación.
        installmentNumber: installment.number,
      };
      if (extraRaw !== "") body.extraCapital = extraRaw;

      const response = await fetch("/api/loans/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as
        | LoanPayResponseDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ??
            "No se pudo registrar el pago.",
        );
      }

      const result = data as LoanPayResponseDTO;
      if (!result.created) {
        // Idempotente: la cuota ya estaba cubierta. Se cuenta, no se grita.
        showFlash("El préstamo ya estaba al día: no se duplicó ningún pago.");
      } else {
        const parts: string[] = [];
        if (result.principalPaid !== null) {
          parts.push(`capital ${formatMoney(result.principalPaid)}`);
        }
        if (
          result.interestPaid !== null &&
          toCents(result.interestPaid) !== 0
        ) {
          parts.push(`interés ${formatMoney(result.interestPaid)}`);
        }
        const verb = loan.kind === "LOAN" ? "Pagaste" : "Cobraste";
        showFlash(
          `${verb} la cuota ${installment.number}${parts.length > 0 ? `: ${parts.join(" + ")}` : ""}.`,
        );
      }
      closeBlock();
      await load({ archived: includeArchived });
    } catch (err) {
      setBlockError(
        err instanceof Error ? err.message : "No se pudo registrar el pago.",
      );
    } finally {
      setBusyId(null);
    }
  }

  // ── Cancelar el préstamo entero (sin interés de lo que falta) ─────────────
  async function cancelLoan(loan: LoanViewDTO) {
    if (busyId) return;
    if (!cashId) {
      setBlockError("Elegí la cuenta de dinero para la cancelación.");
      return;
    }
    if (!blockDate.trim()) {
      setBlockError("La fecha de la cancelación no puede estar vacía.");
      return;
    }

    setBusyId(`cancel-${loan.id}`);
    setBlockError("");
    try {
      const response = await fetch("/api/loans/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: loan.id,
          cashAccountId: cashId,
          date: blockDate,
          cancel: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | LoanPayResponseDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ??
            "No se pudo cancelar el préstamo.",
        );
      }

      const result = data as LoanPayResponseDTO;
      if (!result.created) {
        showFlash("El préstamo ya estaba saldado: no se duplicó nada.");
      } else {
        const paid =
          result.principalPaid !== null
            ? formatMoney(result.principalPaid)
            : "el capital pendiente";
        showFlash(
          loan.kind === "LOAN"
            ? `Préstamo cancelado: ${paid} de capital y quedó saldado.`
            : `Cobraste todo: ${paid}. Ya no te deben nada.`,
        );
      }
      closeBlock();
      await load({ archived: includeArchived });
    } catch (err) {
      setBlockError(
        err instanceof Error ? err.message : "No se pudo cancelar el préstamo.",
      );
    } finally {
      setBusyId(null);
    }
  }

  // ── Registrar el desembolso que faltaba ────────────────────────────────────
  async function disburse(loan: LoanViewDTO) {
    if (busyId) return;
    if (!cashId) {
      setBlockError("Elegí la cuenta de dinero del desembolso.");
      return;
    }
    if (!blockDate.trim()) {
      setBlockError("La fecha del desembolso no puede estar vacía.");
      return;
    }
    // El monto es el PRINCIPAL del contrato, no la deuda viva: un préstamo
    // recién creado vale 0 (la plata todavía no se movió), y usar la deuda
    // acá daría un desembolso de $ 0. Mismo criterio que el paso 2 del alta.
    const amount = loan.principal;
    if (amount === null || toCents(amount) <= 0) {
      setBlockError("El préstamo no tiene un monto pendiente para desembolsar.");
      return;
    }

    setBusyId(`disburse-${loan.id}`);
    setBlockError("");
    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "TRANSFER",
          amount: centsToString(toCents(amount)),
          date: blockDate,
          // La dirección es la del desembolso: en un LOAN sale del préstamo;
          // en un RECEIVABLE entra a la cuenta por cobrar.
          accountId: loan.kind === "LOAN" ? loan.id : cashId,
          toAccountId: loan.kind === "LOAN" ? cashId : loan.id,
          description: "Desembolso del préstamo",
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          data.error ?? "No se pudo registrar el desembolso.",
        );
      }

      const cashName =
        payOrigins.find((account) => account.id === cashId)?.name ??
        "la cuenta elegida";
      showFlash(
        loan.kind === "LOAN"
          ? `Desembolso registrado: ${formatMoney(amount)} entraron a ${cashName}.`
          : `Desembolso registrado: ${formatMoney(amount)} salieron de ${cashName}.`,
      );
      closeBlock();
      await load({ archived: includeArchived });
    } catch (err) {
      setBlockError(
        err instanceof Error
          ? err.message
          : "No se pudo registrar el desembolso.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Título, alta y archivadas ────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-extrabold flex items-center gap-2"><Handshake className="size-6" aria-hidden />Préstamos</h1>
          <p className="text-sm text-fg-muted">
            Lo que debés y lo que te deben, con su cronograma y su progreso.
            Cada pago mueve plata de verdad: una transferencia por el capital y
            un gasto (o ingreso) por el interés.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            id="loans-new"
            variant="default"
            onClick={() => {
              showFlash("");
              setFormOpen(true);
            }}
            disabled={busyId !== null}
            className="px-3 py-2"
          >
            ＋ Nuevo préstamo
          </Button>
          <Button
            id="loans-toggle-archived"
            variant={includeArchived ? "secondary" : "outline"}
            onClick={toggleArchived}
            aria-pressed={includeArchived}
            className={`px-3 py-2 ${includeArchived ? "bg-primary text-primary-fg" : ""}`}
          >
            {includeArchived ? "Ocultar archivados" : "Ver archivados"}
          </Button>
        </div>
      </div>

      {/* ── Aviso de la última acción ────────────────────────────────────── */}
      {flash && (
        <p
          id="loans-flash"
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            flashError
              ? "bg-danger/10 text-danger "
              : "bg-success/10 text-success "
          }`}
        >
          {flash}
        </p>
      )}

      {loading && (
        <p className="bg-surface-2 rounded-md px-4 py-10 text-center text-fg-muted shadow-sm">
          Cargando…
        </p>
      )}

      {!loading && loadError && (
        <p
          role="alert"
          className="bg-surface-2 rounded-md px-4 py-8 text-center text-danger shadow-sm"
        >
          {loadError}
        </p>
      )}

      {!loading && !loadError && (
        <>
          {/* ── Compromisos próximos (sólo lo que debo) ──────────────────── */}
          {loanDebts.length > 0 && (
            <section
              id="loans-commitments"
              className="bg-surface-2 rounded-md shadow-sm px-4 py-4"
            >
              <h2 className="text-sm font-bold uppercase tracking-wide text-fg-muted">
                Compromisos próximos
              </h2>
              <p
                id="loans-commit-overdue"
                className={`mt-2 text-sm ${
                  commitOverdueCount > 0
                    ? "text-danger font-medium"
                    : "text-fg-muted"
                }`}
              >
                {commitOverdueCount > 0
                  ? `Vencido: ${formatMoney(commitOverdue)} (${commitOverdueCount} ${
                      commitOverdueCount === 1
                        ? "cuota ya pasada"
                        : "cuotas ya pasadas"
                    }, sin pagar).`
                  : "Sin cuotas vencidas."}
              </p>
              <p id="loans-commit-6" className="text-sm mt-0.5">
                Próximos 6 meses: <b>{formatMoney(commit6)}</b>
              </p>
              <p id="loans-commit-12" className="text-sm mt-0.5">
                Próximos 12 meses: <b>{formatMoney(commit12)}</b>
              </p>
              {commitMonths.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {commitMonths.map(([key, entry]) => (
                    <li
                      key={key}
                      id={`loans-commit-month-${key}`}
                      className="text-xs rounded-full bg-surface-3 px-2 py-0.5 text-fg-muted "
                    >
                      {entry.label} {formatMoney(sumAmounts(entry.amounts))}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-fg-muted mt-2">
                Sólo cuenta los préstamos que tenés que pagar: la plata que te
                deben no es un compromiso tuyo. Lo vencido va aparte y no se
                suma a los próximos 12 meses.
              </p>
            </section>
          )}

          {/* ── Debo ─────────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-bold flex items-center gap-2"><ArrowUpRight className="size-5" aria-hidden />Debo</h2>
              <p
                id="loans-total-debt"
                className="text-sm text-fg-muted "
              >
                Total: <b>{formatMoney(totalDebt)}</b>
              </p>
            </div>

            {loanDebts.length === 0 && (
              <div className="bg-surface-2 rounded-md px-4 py-8 text-center text-fg-muted shadow-sm">
                <p className="font-medium text-fg">No tenés préstamos que debas cargados</p>
                <p className="text-sm text-fg-muted mt-1">
                  Podés registrar uno nuevo usando el botón <b>＋ Nuevo préstamo</b> arriba.
                </p>
              </div>
            )}

            {loanDebts.map(renderLoan)}
          </section>

          {/* ── Me deben ─────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-bold flex items-center gap-2"><ArrowDownLeft className="size-5" aria-hidden />Me deben</h2>
              <p
                id="loans-total-receivable"
                className="text-sm text-fg-muted "
              >
                Total: <b>{formatMoney(totalReceivable)}</b>
              </p>
            </div>

            {receivables.length === 0 && (
              <div className="bg-surface-2 rounded-md px-4 py-8 text-center text-fg-muted shadow-sm">
                <p className="font-medium text-fg">No tenés préstamos que te deban cargados</p>
                <p className="text-sm text-fg-muted mt-1">
                  Si prestaste plata a alguien, podés registrarlo desde <b>＋ Nuevo préstamo</b> seleccionando que te deben.
                </p>
              </div>
            )}

            {receivables.map(renderLoan)}
          </section>
        </>
      )}

      <p className="text-center text-xs text-fg-subtle pb-2">
        <Link href="/" className="underline inline-flex items-center touch:min-h-11">
          ← Volver al panel
        </Link>
      </p>

      {/* ── Alta guiada ──────────────────────────────────────────────────── */}
      {formOpen && (
        <LoanForm
          cashAccounts={payOrigins}
          onClose={() => setFormOpen(false)}
          onSaved={(message) => {
            showFlash(message);
            load({ archived: includeArchived });
          }}
        />
      )}
    </main>
  );

  /** Una tarjeta de préstamo (la usa cada sección para su lista). */
  function renderLoan(loan: LoanViewDTO) {
    const status = loanStatus(loan, today);
    const plan = loan.plan;
    const next = loan.nextInstallment;
    const verb = loan.kind === "LOAN" ? "Pagar" : "Cobrar";

    const isOpen = openId === loan.id;
    const openPay = isOpen && openKind === "pay";
    const openCancel = isOpen && openKind === "cancel";
    const openDisburse = isOpen && openKind === "disburse";

    /** El capital pendiente de cancelación: reloj de centavos, sin floats. */
    const remainingCents =
      plan !== null && loan.capitalPaid !== null
        ? Math.max(0, toCents(plan.principal) - toCents(loan.capitalPaid))
        : 0;
    const canCancel =
      plan !== null && loan.capitalPaid !== null && remainingCents > 0;

    const progressWidth =
      loan.progressPercent === null
        ? 0
        : Math.min(100, Math.max(0, Number(loan.progressPercent) || 0));

    const progressVerb = loan.kind === "LOAN" ? "Cubriste" : "Cobraste";
    const progressText =
      plan === null
        ? ""
        : `${progressVerb} ${plan.paidCount} de ${plan.installmentCount}` +
          (loan.principal !== null && loan.capitalPaid !== null
            ? ` · capital ${formatMoney(loan.capitalPaid)} de ${formatMoney(loan.principal)}`
            : "") +
          (loan.progressPercent !== null
            ? ` (${formatPercent(loan.progressPercent)})`
            : "");

    const nextText =
      plan === null
        ? "Sin cronograma: es un saldo sin plan de pagos."
        : loan.system === "INTEREST_ONLY"
          ? "Solo interés: el interés del mes va como gasto y el capital se cancela aparte."
          : next === null
            ? "No queda ninguna cuota por pagar."
            : `Próxima cuota ${next.number} de ${plan.installmentCount}: ${formatMoney(next.payment)} · vence el ${formatCalendar(next.dueDate)}${
                next.dueDate < today ? " (ya venció)" : ""
              }`;

    return (
      <section
        key={loan.id}
        id={`loan-${loan.id}`}
        className="bg-surface-2 rounded-md shadow-sm"
      >
        {/* ── Encabezado de la tarjeta ───────────────────────────────────── */}
        <div className="px-4 pt-4 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-lg font-bold truncate">
              {loan.name}
              {loan.archived ? " (archivada)" : ""}
            </p>
            <p
              id={
                loan.kind === "LOAN"
                  ? `loan-debt-${loan.id}`
                  : `loan-receivable-${loan.id}`
              }
              className="mt-0.5 font-semibold"
            >
              {loan.kind === "LOAN"
                ? formatLiability(loan.debt ?? "0")
                : `te deben ${formatMoney(loan.receivable ?? "0")}`}
            </p>
            {plan !== null && (
              <p id={`loan-progress-${loan.id}`} className="text-sm mt-0.5">
                {progressText}
              </p>
            )}
            {plan !== null && loan.progressPercent !== null && (
              <div className="mt-1 h-1.5 w-full max-w-xs rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full bg-transfer"
                  style={{ width: `${progressWidth}%` }}
                />
              </div>
            )}
            {plan !== null &&
              loan.interestPaid !== null &&
              toCents(loan.interestPaid) > 0 && (
                <p className="text-xs text-fg-muted mt-0.5">
                  Interés ya pagado: {formatMoney(loan.interestPaid)}.
                </p>
              )}
            <p
              id={`loan-next-${loan.id}`}
              className="text-sm text-fg-muted mt-0.5"
            >
              {nextText}
            </p>
          </div>
          <p
            id={`loan-status-${loan.id}`}
            className={`shrink-0 text-xs font-bold rounded-full px-2 py-0.5 ${STATUS_CLASS[status]}`}
          >
            {status}
          </p>
        </div>

        {/* ── El desembolso que falta (aviso + alta en un toque) ─────────── */}
        {!loan.disbursed && (
          <div
            id={`loan-warning-${loan.id}`}
            className="mx-4 mt-3 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning "
          >
            <p>
              {loan.kind === "LOAN"
                ? "Falta registrar el desembolso: la deuda viva no incluye la plata que entró."
                : "Falta registrar el desembolso: lo que te deben no incluye la plata que prestaste."}
            </p>

            {!isOpen && (
              <Button
                id={`loan-disburse-open-${loan.id}`}
                variant="outline"
                size="sm"
                onClick={() => openBlock(loan.id, "disburse")}
                disabled={busyId !== null}
                className="mt-2 border-warning/40 px-3 py-1.5 hover:bg-warning/15"
              >
                Registrar el desembolso
              </Button>
            )}

            {openDisburse && (
              <div
                id={`loan-disburse-confirm-${loan.id}`}
                className="mt-2 flex flex-col gap-2"
              >
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label
                      htmlFor={`loan-disburse-date-${loan.id}`}
                      className="block text-xs font-medium"
                    >
                      Fecha del desembolso
                    </label>
                    <input
                      id={`loan-disburse-date-${loan.id}`}
                      type="date"
                      value={blockDate}
                      onChange={(e) => {
                        setBlockDate(e.target.value);
                        clearDateInputIfEmptied(e.target);
                      }}
                      className="mt-1 w-full rounded-md border border-warning/40 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`loan-disburse-cash-${loan.id}`}
                      className="block text-xs font-medium"
                    >
                      {loan.kind === "LOAN"
                        ? "Cuenta que lo recibió"
                        : "Cuenta que lo prestó"}
                    </label>
                    <select
                      id={`loan-disburse-cash-${loan.id}`}
                      value={cashId ?? ""}
                      onChange={(e) => setCashId(e.target.value)}
                      className="mt-1 w-full rounded-md border border-warning/40 bg-surface-2 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
                    >
                      {payOrigins.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {payOrigins.length === 0 && (
                  <p>
                    Necesitás una cuenta de banco o efectivo (no archivada):
                    creá una para poder registrar el desembolso.
                  </p>
                )}

                {blockError && (
                  <p
                    id={`loan-disburse-error-${loan.id}`}
                    role="alert"
                    className="rounded-lg bg-danger/10 text-danger px-3 py-2"
                  >
                    {blockError}
                  </p>
                )}

                <div className="flex gap-2">
                  <Button
                    id={`loan-disburse-go-${loan.id}`}
                    variant="secondary"
                    onClick={() => disburse(loan)}
                    disabled={busyId !== null || !cashId}
                    className="flex-1 py-2 bg-success hover:bg-success/90 text-primary-fg"
                  >
                    {busyId === `disburse-${loan.id}`
                      ? "Registrando…"
                      : loan.principal !== null
                        ? `Sí, registrar el desembolso de ${formatMoney(loan.principal)}`
                        : "Sí, registrar el desembolso"}
                  </Button>
                  <Button
                    id={`loan-disburse-back-${loan.id}`}
                    variant="outline"
                    onClick={closeBlock}
                    disabled={busyId !== null}
                    className="flex-1 py-2 border-warning/40 hover:bg-warning/15"
                  >
                    Mejor no
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Acciones: pagar la próxima cuota / cancelar todo ───────────── */}
        {!isOpen && (next !== null || canCancel) && (
          <div className="px-4 mt-3 flex flex-wrap gap-2">
            {next !== null && (
              <Button
                id={`loan-pay-open-${loan.id}`}
                variant="secondary"
                onClick={() => openBlock(loan.id, "pay")}
                disabled={busyId !== null}
                className="px-3 py-2 bg-transfer hover:bg-transfer/90 text-primary-fg"
              >
                {verb} cuota {next.number} · {formatMoney(next.payment)}
              </Button>
            )}
            {canCancel && (
              <Button
                id={`loan-cancel-open-${loan.id}`}
                variant="outline"
                onClick={() => openBlock(loan.id, "cancel")}
                disabled={busyId !== null}
                className="px-3 py-2"
              >
                {loan.kind === "LOAN" ? "Cancelar el préstamo" : "Cobrar todo"}
              </Button>
            )}
          </div>
        )}

        {/* ── Bloque de pago de cuota ────────────────────────────────────── */}
        {openPay && next !== null && plan !== null && (
          <div
            id={`loan-pay-confirm-${loan.id}`}
            className="mx-4 mt-3 rounded-md bg-transfer/10 px-3 py-3"
          >
            <p className="text-sm text-transfer ">
              Cuota {next.number} de {plan.installmentCount}: interés{" "}
              {formatMoney(next.interest)} + capital{" "}
              {formatMoney(next.principal)} ={" "}
              <b>{formatMoney(next.payment)}</b> · vence el{" "}
              {formatCalendar(next.dueDate)}.
            </p>
            <p className="mt-1 text-xs text-transfer ">
              {loan.kind === "LOAN"
                ? "Se transfiere el capital (baja la deuda) y se registra el interés como gasto."
                : "Se transfiere el capital (baja lo que te deben) y el interés entra como ingreso."}
            </p>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor={`loan-pay-extra-${loan.id}`}
                  className="block text-xs font-medium text-transfer "
                >
                  Capital extra (opcional)
                </label>
                <input
                  id={`loan-pay-extra-${loan.id}`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={blockExtra}
                  onChange={(e) => setBlockExtra(e.target.value)}
                  placeholder="0"
                  className="mt-1 w-full rounded-md border border-transfer/40 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
                />
                {blockExtra.trim() !== "" &&
                  formatAmountInput(blockExtra) !== null && (
                    <p className="mt-1 text-xs text-transfer ">
                      {formatAmountInput(blockExtra)}
                    </p>
                  )}
              </div>
              <div>
                <label
                  htmlFor={`loan-pay-date-${loan.id}`}
                  className="block text-xs font-medium text-transfer "
                >
                  Fecha
                </label>
                <input
                  id={`loan-pay-date-${loan.id}`}
                  type="date"
                  value={blockDate}
                  onChange={(e) => {
                    setBlockDate(e.target.value);
                    clearDateInputIfEmptied(e.target);
                  }}
                  className="mt-1 w-full rounded-md border border-transfer/40 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
                />
              </div>
            </div>

            <div className="mt-2">
              <label
                htmlFor={`loan-pay-account-${loan.id}`}
                className="block text-xs font-medium text-transfer "
              >
                {loan.kind === "LOAN"
                  ? "¿De qué cuenta sale el pago?"
                  : "¿A qué cuenta entra el cobro?"}
              </label>
              <Select
                value={cashId ?? ""}
                onValueChange={(v) => setCashId(v || null)}
              >
                <SelectTrigger
                  id={`loan-pay-account-${loan.id}`}
                  className="mt-1 w-full"
                >
                  <SelectValue placeholder="Cuenta de destino" />
                </SelectTrigger>
                <SelectContent>
                  {payOrigins.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {payOrigins.length === 0 && (
                <p className="mt-1 text-sm text-warning ">
                  Necesitás una cuenta de banco o efectivo (no archivada) para
                  registrar el pago.
                </p>
              )}
            </div>

            {loan.system === "AMERICAN" && (
              <p className="mt-2 text-xs text-transfer ">
                En el americano las cuotas mensuales son sólo interés (van como
                gasto): esta cuota es el cierre con el capital.
              </p>
            )}

            {blockError && (
              <p
                id={`loan-pay-error-${loan.id}`}
                role="alert"
                className="mt-2 rounded-lg bg-danger/10 text-danger px-3 py-2 text-sm"
              >
                {blockError}
              </p>
            )}

            <div className="mt-2 flex gap-2">
              {payOrigins.length > 0 && (
                <Button
                  id={`loan-pay-go-${loan.id}`}
                  variant="secondary"
                  onClick={() => pay(loan)}
                  disabled={busyId !== null || !cashId}
                  className="flex-1 py-2 bg-transfer hover:bg-transfer/90 text-primary-fg"
                >
                  {busyId === `pay-${loan.id}`
                    ? "Registrando…"
                    : loan.kind === "LOAN"
                      ? "Confirmar pago"
                      : "Confirmar cobro"}
                </Button>
              )}
              <Button
                id={`loan-pay-cancel-${loan.id}`}
                variant="outline"
                onClick={closeBlock}
                disabled={busyId !== null}
                className="flex-1 py-2 border-transfer/40 hover:bg-transfer/10"
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {/* ── Bloque de cancelación (dos pasos, sin diálogo nativo) ──────── */}
        {openCancel && plan !== null && canCancel && (
          <div
            id={`loan-cancel-confirm-${loan.id}`}
            className="mx-4 mt-3 rounded-md bg-danger/10 px-3 py-3"
          >
            <p className="text-sm text-danger ">
              {loan.kind === "LOAN"
                ? `Vas a cancelar todo el capital pendiente: ${formatMoney(centsToString(remainingCents))}.`
                : `Vas a cobrar todo el capital pendiente: ${formatMoney(centsToString(remainingCents))}.`}
            </p>
            <p className="mt-1 text-xs text-danger ">
              Sólo se mueve el capital: sin interés de las cuotas que faltan.
            </p>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor={`loan-cancel-date-${loan.id}`}
                  className="block text-xs font-medium text-danger "
                >
                  Fecha
                </label>
                <input
                  id={`loan-cancel-date-${loan.id}`}
                  type="date"
                  value={blockDate}
                  onChange={(e) => {
                    setBlockDate(e.target.value);
                    clearDateInputIfEmptied(e.target);
                  }}
                  className="mt-1 w-full rounded-md border border-danger/40 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
                />
              </div>
              <div>
                <label
                  htmlFor={`loan-cancel-account-${loan.id}`}
                  className="block text-xs font-medium text-danger "
                >
                  {loan.kind === "LOAN" ? "¿De qué cuenta sale?" : "¿A qué cuenta entra?"}
                </label>
                <Select
                  value={cashId ?? ""}
                  onValueChange={(v) => setCashId(v || null)}
                >
                  <SelectTrigger
                    id={`loan-cancel-account-${loan.id}`}
                    className="mt-1 w-full"
                  >
                    <SelectValue placeholder="Cuenta" />
                  </SelectTrigger>
                  <SelectContent>
                    {payOrigins.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {payOrigins.length === 0 && (
              <p className="mt-1 text-sm text-warning ">
                Necesitás una cuenta de banco o efectivo (no archivada).
              </p>
            )}

            {blockError && (
              <p
                id={`loan-cancel-error-${loan.id}`}
                role="alert"
                className="mt-2 rounded-lg bg-surface-2 text-danger px-3 py-2 text-sm"
              >
                {blockError}
              </p>
            )}

            <div className="mt-2 flex gap-2">
              <Button
                id={`loan-cancel-go-${loan.id}`}
                variant="destructive"
                onClick={() => cancelLoan(loan)}
                disabled={busyId !== null || !cashId}
                className="flex-1 py-2"
              >
                {busyId === `cancel-${loan.id}`
                  ? "Cancelando…"
                  : loan.kind === "LOAN"
                    ? "Sí, cancelar el préstamo"
                    : "Sí, cobrar todo"}
              </Button>
              <Button
                id={`loan-cancel-close-${loan.id}`}
                variant="outline"
                onClick={closeBlock}
                disabled={busyId !== null}
                className="flex-1 py-2 border-danger/40 hover:bg-danger/10"
              >
                Mejor no
              </Button>
            </div>
          </div>
        )}

        {/* ── Cronograma completo ────────────────────────────────────────── */}
        {plan !== null && (
          <details
            id={`loan-schedule-${loan.id}`}
            className="mt-4 border-t border-line "
          >
            <summary
              id={`loan-schedule-summary-${loan.id}`}
              className="cursor-pointer select-none px-4 py-3 text-sm font-bold uppercase tracking-wide text-fg-muted"
            >
              Cronograma ({loan.installments.length} cuotas)
            </summary>
            <ul className="px-4 pb-2 flex flex-col gap-1.5">
              {loan.installments.map((row) => {
                const state = installmentState(row, loan.system, today);
                return (
                  <li
                    key={row.number}
                    id={`loan-inst-${loan.id}-${row.number}`}
                    className="flex items-center justify-between gap-2 text-sm border-b border-line last:border-0 pb-1.5"
                  >
                    <span className="min-w-0">
                      <b>Cuota {row.number}</b> · {formatMoney(row.payment)} ·
                      vence el {formatCalendar(row.dueDate)}
                      <span className="text-xs text-fg-muted">
                        {" "}
                        · interés {formatMoney(row.interest)} + capital{" "}
                        {formatMoney(row.principal)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-xs font-bold rounded-full px-2 py-0.5 ${INSTALLMENT_STATE_CLASS[state]}`}
                    >
                      {state}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="px-4 pb-4 text-xs text-fg-muted">
              {INSTALLMENT_STATE_LEGEND}
            </p>
          </details>
        )}
      </section>
    );
  }
}