"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import CardConfigForm from "@/components/CardConfigForm";
import CardPlanForm from "@/components/CardPlanForm";
import { formatCalendar } from "@/lib/dates";
import type {
  AccountBalanceDTO,
  CardPlanDTO,
  CardsResponse,
  CardStatementsRunDTO,
  CardViewDTO,
  CategoryDTO,
  StatementDTO,
  StatementPayResponseDTO,
} from "@/lib/finance";
import { formatLiability, formatMoney, formatPercent } from "@/lib/format";

/**
 * Pantalla de tarjetas de crédito y cuotas (Fase 5, ronda 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNA SOLA FOTO POR PANTALLA
 * ─────────────────────────────────────────────────────────────────────────────
 * Todo sale de `GET /api/cards`: deuda, límite, período en curso, resúmenes,
 * planes y compromisos. La pantalla no recalcula nada — el cliente suma en
 * centavos enteros cuando hace falta, pero acá no hace falta: cada número ya
 * viene calculado y esta vista sólo lo pone en su lugar y en castellano.
 *
 * Decisión de diseño: los compromisos 6/12 viven ACÁ y no en el panel. El panel
 * ya tiene sus tarjetas del mes, la serie de patrimonio, la reconciliación y la
 * tarjeta de deudas; meterle otra más lo volvería una lista de listas. Desde el
 * encabezado, "💳 Tarjetas" está a un toque.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ NO HACE ESTA PANTALLA (diferidos explícitos de la ronda)
 * ─────────────────────────────────────────────────────────────────────────────
 * · No borra el pago de un resumen ("reabrir" el documento): la API lo permite
 *   (borrar la transferencia deja `paidMovementId` en NULL y la próxima corrida
 *   recalcula), pero acá no hay botón. El 409 de cambiar el cierre lo menciona
 *   como escape; la UI para hacerlo queda para otra ronda.
 * · No muestra el detalle rubro por rubro de un resumen (impuestos, cargos):
 *   el modelo no los tiene como datos separados.
 * · No paga parcialmente un resumen: el pago es por el total del documento.
 */

/** "nov 2026" — etiqueta corta de un mes de la proyección de cuotas. */
function shortMonthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("es-AR", {
    month: "short",
    year: "numeric",
  });
}

type Modal = { type: "config"; cardId: string } | { type: "plan"; cardId: string };

export default function CardsPage() {
  const [cards, setCards] = useState<CardViewDTO[]>([]);
  const [accounts, setAccounts] = useState<AccountBalanceDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [truncated, setTruncated] = useState(false);

  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /** Id de la acción en curso: una sola a la vez, sin dobles toques. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [flashError, setFlashError] = useState(false);

  const [modal, setModal] = useState<Modal | null>(null);

  /** Resumen cuyo bloque de pago está abierto (y con qué cuenta se pagaría). */
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payFromId, setPayFromId] = useState<string | null>(null);

  /** Borrado de un plan en dos pasos, sin `window.confirm`. */
  const [confirmPlanId, setConfirmPlanId] = useState<string | null>(null);
  const [planNotice, setPlanNotice] = useState<{ id: string; message: string } | null>(
    null,
  );

  /**
   * Carga la vista completa. Las tarjetas son la vista principal; las cuentas
   * se piden para el selector de "desde qué cuenta se paga" y las categorías
   * para el datalist del alta de cuotas.
   */
  const load = useCallback(async (options: { archived: boolean }) => {
    setLoading(true);
    setLoadError("");

    try {
      const [cardsRes, accountsRes, categoriesRes] = await Promise.all([
        fetch(`/api/cards${options.archived ? "" : "?includeArchived=false"}`),
        fetch("/api/accounts"),
        fetch("/api/categories"),
      ]);

      if (!cardsRes.ok || !accountsRes.ok || !categoriesRes.ok) {
        throw new Error("Alguno de los pedidos falló.");
      }

      const cardsData = (await cardsRes.json()) as CardsResponse;
      const accountsData = (await accountsRes.json()) as {
        accounts: AccountBalanceDTO[];
      };
      const categoriesData = (await categoriesRes.json()) as {
        categories: CategoryDTO[];
      };

      setCards(cardsData.cards);
      setTruncated(cardsData.truncated);
      setAccounts(accountsData.accounts);
      setCategories(categoriesData.categories);
    } catch {
      setLoadError(
        "No se pudieron cargar las tarjetas. Revisá que la base esté levantada y recargá.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load({ archived: false });
  }, [load]);

  function showFlash(message: string, isError = false) {
    setFlash(message);
    setFlashError(isError);
  }

  /** Cuentas desde las que se puede pagar un resumen: plata, no deuda. */
  const payOrigins = accounts.filter(
    (account) =>
      !account.archived &&
      (account.kind === "CASH" || account.kind === "BANK"),
  );

  function openPay(statementId: string) {
    const bank = payOrigins.find((account) => account.kind === "BANK");
    setPayingId(statementId);
    setPayFromId(bank?.id ?? payOrigins[0]?.id ?? null);
  }

  function toggleArchived() {
    const next = !includeArchived;
    setIncludeArchived(next);
    setPayingId(null);
    setConfirmPlanId(null);
    setPlanNotice(null);
    showFlash("");
    load({ archived: next });
  }

  // ── Correr el cierre de una tarjeta ────────────────────────────────────────
  async function runClose(card: CardViewDTO) {
    if (busyId) return;
    setBusyId(`run-${card.id}`);
    showFlash("");
    try {
      const response = await fetch("/api/cards/statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | CardStatementsRunDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "No se pudo correr el cierre.",
        );
      }

      const run = data as CardStatementsRunDTO;
      const result = run.results[0];
      const skipped = run.skipped.find((entry) => entry.cardId === card.id);

      let message: string;
      if (skipped) {
        message = `No se pudo correr el cierre de ${card.name}: ${skipped.reason}`;
      } else if (
        !result ||
        (result.created === 0 &&
          result.updated === 0 &&
          result.unchanged === 0 &&
          result.frozen === 0)
      ) {
        message = `Cierre corrido: ${card.name} no tenía períodos cerrados nuevos para emitir.`;
      } else {
        const parts: string[] = [];
        if (result.created > 0) {
          parts.push(
            `${result.created} ${result.created === 1 ? "resumen nuevo" : "resúmenes nuevos"}`,
          );
        }
        if (result.updated > 0) {
          parts.push(`${result.updated} actualizado(s)`);
        }
        if (result.unchanged > 0) {
          parts.push(`${result.unchanged} sin cambios`);
        }
        if (result.frozen > 0) {
          parts.push(
            `${result.frozen} ${result.frozen === 1 ? "pagado que no se toca" : "pagados que no se tocan"}`,
          );
        }
        message = `Cierre corrido: ${parts.join(" · ")}.`;
      }

      showFlash(message);
      await load({ archived: includeArchived });
    } catch (err) {
      showFlash(
        err instanceof Error ? err.message : "No se pudo correr el cierre.",
        true,
      );
    } finally {
      setBusyId(null);
    }
  }

  // ── Pagar un resumen ───────────────────────────────────────────────────────
  async function pay(statement: StatementDTO) {
    if (busyId || !payFromId) return;
    setBusyId(`pay-${statement.id}`);
    showFlash("");
    try {
      const response = await fetch("/api/cards/statements/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statementId: statement.id,
          fromAccountId: payFromId,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | StatementPayResponseDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "No se pudo pagar el resumen.",
        );
      }

      const result = data as StatementPayResponseDTO;
      const fromName =
        accounts.find((account) => account.id === payFromId)?.name ??
        "la cuenta elegida";

      showFlash(
        result.created === false
          ? "El resumen ya estaba pago: no se duplicó la transferencia."
          : `Resumen de ${statement.periodLabel} pagado: se transfirieron ${formatMoney(statement.totalDue)} desde ${fromName}.`,
      );
      setPayingId(null);
      await load({ archived: includeArchived });
    } catch (err) {
      showFlash(
        err instanceof Error ? err.message : "No se pudo pagar el resumen.",
        true,
      );
    } finally {
      setBusyId(null);
    }
  }

  // ── Borrar una compra en cuotas ────────────────────────────────────────────
  async function removePlan(plan: CardPlanDTO) {
    if (busyId) return;
    setBusyId(`plan-${plan.id}`);
    showFlash("");
    setPlanNotice(null);
    try {
      const response = await fetch(
        `/api/cards/plans?id=${encodeURIComponent(plan.id)}`,
        { method: "DELETE" },
      );

      if (response.status === 204) {
        setConfirmPlanId(null);
        showFlash(
          `Compra en cuotas “${plan.label}” borrada: el gasto y sus cuotas se fueron con ella.`,
        );
        await load({ archived: includeArchived });
        return;
      }

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(data.error ?? "No se pudo borrar la compra en cuotas.");
    } catch (err) {
      setConfirmPlanId(null);
      setPlanNotice({
        id: plan.id,
        message:
          err instanceof Error
            ? err.message
            : "No se pudo borrar la compra en cuotas.",
      });
    } finally {
      setBusyId(null);
    }
  }

  const modalCard = modal
    ? (cards.find((card) => card.id === modal.cardId) ?? null)
    : null;

  /** El texto del estado del período en curso, según el documento y el cierre. */
  function currentPeriodStatus(card: CardViewDTO): string {
    const period = card.currentPeriod;
    if (!period) return "";
    if (period.persisted && period.paid) {
      return "El resumen de este período ya está emitido y pagado.";
    }
    if (period.persisted) {
      return "Ya hay un resumen emitido de este período, sin pagar: los montos son los del documento.";
    }
    if (period.closed) {
      return "El cierre ya pasó: corré el cierre para emitirlo como resumen.";
    }
    return `Todavía abierto: se cierra el ${formatCalendar(period.closingDate)}.`;
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Título y archivadas ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-extrabold">💳 Tarjetas</h1>
          <p className="text-sm text-zinc-500">
            Deuda, límite, resúmenes y cuotas comprometidas de cada tarjeta. Las
            cuotas son deuda que ya nació: acá ves cuándo la vas a pagar.
          </p>
        </div>
        <button
          id="cards-toggle-archived"
          onClick={toggleArchived}
          aria-pressed={includeArchived}
          className={`shrink-0 rounded-xl border px-3 py-2 text-sm font-medium ${
            includeArchived
              ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
              : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          {includeArchived ? "Ocultar archivadas" : "Ver archivadas"}
        </button>
      </div>

      {/* ── Aviso de la última acción ────────────────────────────────────── */}
      {flash && (
        <p
          id="cards-flash"
          role="status"
          className={`rounded-xl px-3 py-2 text-sm ${
            flashError
              ? "bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300"
              : "bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200"
          }`}
        >
          {flash}
        </p>
      )}

      {truncated && (
        <p
          id="cards-truncated"
          role="alert"
          className="rounded-xl bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2 text-sm"
        >
          Hay más resúmenes de los que se muestran: la lista está recortada.
        </p>
      )}

      {loading && (
        <p className="bg-white dark:bg-zinc-900 rounded-2xl px-4 py-10 text-center text-zinc-500 shadow-sm">
          Cargando…
        </p>
      )}

      {!loading && loadError && (
        <p
          role="alert"
          className="bg-white dark:bg-zinc-900 rounded-2xl px-4 py-8 text-center text-rose-600 dark:text-rose-400 shadow-sm"
        >
          {loadError}
        </p>
      )}

      {!loading && !loadError && cards.length === 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl px-4 py-10 text-center shadow-sm">
          <p className="text-3xl mb-1">💳</p>
          <p className="font-medium">No hay tarjetas de crédito cargadas</p>
          <p className="text-sm text-zinc-500 mt-1">
            Creá una desde el panel: <b>Nueva cuenta</b> → tipo{" "}
            <b>Tarjeta de crédito</b>.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center touch:min-h-11 mt-3 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black px-4 py-2 font-bold"
          >
            Ir al panel
          </Link>
        </div>
      )}

      {/* ── Cada tarjeta ─────────────────────────────────────────────────── */}
      {!loading &&
        !loadError &&
        cards.map((card) => {
          const closingText =
            card.closingDay === null || card.dueDay === null
              ? "Sin día de cierre configurado: no se pueden correr resúmenes ni repartir cuotas."
              : `Cierra el día ${card.closingDay} · vence el día ${card.dueDay}.`;

          const utilizationText =
            card.utilizationPercent === null
              ? "Utilización: no se sabe (sin límite cargado)."
              : `Utilización: ${formatPercent(card.utilizationPercent, 2)} del límite de ${formatMoney(card.creditLimit ?? "0")}.`;

          const runBusy = busyId === `run-${card.id}`;
          const period = card.currentPeriod;

          return (
            <section
              key={card.id}
              id={`card-${card.id}`}
              className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm"
            >
              {/* ── Encabezado de la tarjeta ─────────────────────────────── */}
              <div className="px-4 pt-4 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-lg font-bold truncate">
                    {card.name}
                    {card.archived ? " (archivada)" : ""}
                  </p>
                  <p id={`card-debt-${card.id}`} className="mt-0.5 font-semibold">
                    {formatLiability(card.debt ?? "0")}
                  </p>
                  <p id={`card-utilization-${card.id}`} className="text-sm text-zinc-600 dark:text-zinc-400 mt-0.5">
                    {utilizationText}
                  </p>
                  <p id={`card-closing-${card.id}`} className="text-xs text-zinc-500 mt-0.5">
                    {closingText}
                  </p>
                </div>
                <button
                  id={`card-config-${card.id}`}
                  onClick={() => setModal({ type: "config", cardId: card.id })}
                  disabled={busyId !== null}
                  className="shrink-0 rounded-xl border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  ⚙️ Configurar
                </button>
              </div>

              {/* ── Período en curso ─────────────────────────────────────── */}
              {period && (
                <div
                  id={`card-current-${card.id}`}
                  className="mx-4 mt-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 px-3 py-3"
                >
                  <p className="text-sm font-semibold">
                    Período en curso: {period.periodLabel}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Cierra el {formatCalendar(period.closingDate)} · vence el{" "}
                    {formatCalendar(period.dueDate)}.
                  </p>
                  <p className="text-sm mt-1">
                    {period.persisted ? "Total del resumen" : "Total proyectado"}:{" "}
                    {formatMoney(period.totalDue)} · mínimo:{" "}
                    {formatMoney(period.minimumDue)}.
                  </p>
                  <p className="text-xs text-zinc-500 mt-1">
                    {period.persisted
                      ? currentPeriodStatus(card)
                      : `${currentPeriodStatus(card)} Es una proyección: no es un documento emitido.`}
                  </p>
                  <button
                    id={`card-run-${card.id}`}
                    onClick={() => runClose(card)}
                    disabled={busyId !== null}
                    className="mt-2 rounded-xl border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {runBusy ? "Corriendo…" : "▶ Correr el cierre"}
                  </button>
                </div>
              )}

              {/* ── Resúmenes emitidos ───────────────────────────────────── */}
              <div className="px-4 pt-4">
                <p className="text-sm font-bold uppercase tracking-wide text-zinc-500">
                  Resúmenes emitidos
                </p>

                {card.statements.length === 0 ? (
                  <p
                    id={`card-statements-empty-${card.id}`}
                    className="text-sm text-zinc-500 mt-2"
                  >
                    Todavía no hay resúmenes emitidos.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {card.statements.map((statement) => {
                      const payBusy = busyId === `pay-${statement.id}`;
                      return (
                        <div
                          key={statement.id}
                          id={`stmt-${statement.id}`}
                          className="border border-zinc-100 dark:border-zinc-800 rounded-xl px-3 py-2.5"
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0">
                              <p className="font-semibold">
                                {statement.periodLabel}
                              </p>
                              <p className="text-xs text-zinc-500 mt-0.5">
                                Cerró el {formatCalendar(statement.closingDate)} ·
                                vence el {formatCalendar(statement.dueDate)}.
                              </p>
                              <p className="text-sm mt-0.5">
                                Total: {formatMoney(statement.totalDue)} ·
                                mínimo: {formatMoney(statement.minimumDue)}.
                              </p>
                            </div>
                            <p
                              id={
                                statement.paid
                                  ? `stmt-paid-${statement.id}`
                                  : `stmt-unpaid-${statement.id}`
                              }
                              className={`shrink-0 text-xs font-bold rounded-full px-2 py-0.5 ${
                                statement.paid
                                  ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                                  : "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200"
                              }`}
                            >
                              {statement.paid ? "Pagado" : "Sin pagar"}
                            </p>
                          </div>

                          {!statement.paid && payingId !== statement.id && (
                            <button
                              id={`stmt-pay-${statement.id}`}
                              onClick={() => openPay(statement.id)}
                              disabled={busyId !== null}
                              className="mt-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 text-sm font-bold disabled:opacity-50"
                            >
                              Pagar resumen
                            </button>
                          )}

                          {!statement.paid && payingId === statement.id && (
                            <div
                              id={`stmt-pay-confirm-${statement.id}`}
                              className="mt-2 rounded-xl bg-emerald-50 dark:bg-emerald-950 px-3 py-3"
                            >
                              <p className="text-sm text-emerald-900 dark:text-emerald-100">
                                Se transfieren{" "}
                                {formatMoney(statement.totalDue)} a {card.name}{" "}
                                desde:
                              </p>

                              {payOrigins.length === 0 ? (
                                <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
                                  Necesitás una cuenta de banco o efectivo
                                  (no archivada) para pagar el resumen.
                                </p>
                              ) : (
                                <select
                                  id={`stmt-pay-from-${statement.id}`}
                                  value={payFromId ?? ""}
                                  onChange={(e) => setPayFromId(e.target.value)}
                                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                                >
                                  {payOrigins.map((account) => (
                                    <option key={account.id} value={account.id}>
                                      {account.name}
                                    </option>
                                  ))}
                                </select>
                              )}

                              <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">
                                Es una transferencia entre tus cuentas: baja la
                                deuda de la tarjeta y no se cuenta como gasto
                                otra vez.
                              </p>

                              <div className="mt-2 flex gap-2">
                                {payOrigins.length > 0 && (
                                  <button
                                    id={`stmt-pay-go-${statement.id}`}
                                    onClick={() => pay(statement)}
                                    disabled={busyId !== null || !payFromId}
                                    className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white py-2 text-sm font-bold disabled:opacity-50"
                                  >
                                    {payBusy ? "Pagando…" : "Confirmar pago"}
                                  </button>
                                )}
                                <button
                                  id={`stmt-pay-cancel-${statement.id}`}
                                  onClick={() => setPayingId(null)}
                                  disabled={busyId !== null}
                                  className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                                >
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Compras en cuotas ────────────────────────────────────── */}
              <div className="px-4 pt-4 pb-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-sm font-bold uppercase tracking-wide text-zinc-500">
                    Compras en cuotas
                  </p>
                  {card.closingDay !== null && (
                    <button
                      id={`card-new-plan-${card.id}`}
                      onClick={() => setModal({ type: "plan", cardId: card.id })}
                      disabled={busyId !== null}
                      className="rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black px-3 py-2 text-sm font-bold disabled:opacity-50"
                    >
                      ＋ Compra en cuotas
                    </button>
                  )}
                </div>

                {card.closingDay === null && (
                  <p
                    id={`card-plans-noclose-${card.id}`}
                    className="text-sm text-zinc-500 mt-2"
                  >
                    Sin día de cierre no se pueden cargar compras en cuotas:
                    configuralo con ⚙️ Configurar.
                  </p>
                )}

                {card.closingDay !== null && card.plans.length === 0 && (
                  <p
                    id={`card-plans-empty-${card.id}`}
                    className="text-sm text-zinc-500 mt-2"
                  >
                    Sin compras en cuotas.
                  </p>
                )}

                {card.closingDay !== null && card.plans.length > 0 && (
                  <div className="mt-2 flex flex-col gap-2">
                    {card.plans.map((plan) => {
                      const busy = busyId === `plan-${plan.id}`;
                      const notice =
                        planNotice?.id === plan.id ? planNotice : null;
                      const firstItem = plan.items[0] ?? null;
                      const lastItem = plan.items[plan.items.length - 1] ?? null;
                      const billed = plan.billedInstallments;

                      const statusText =
                        billed < plan.installments
                          ? `Cuota ${billed + 1} de ${plan.installments} · ${formatMoney(firstItem?.amount ?? plan.totalAmount)} por mes`
                          : `Las ${plan.installments} cuotas ya se facturaron`;

                      return (
                        <div
                          key={plan.id}
                          id={`plan-${plan.id}`}
                          className="border border-zinc-100 dark:border-zinc-800 rounded-xl px-3 py-2.5"
                        >
                          <p className="font-semibold">
                            {plan.label} · {plan.installments}{" "}
                            {plan.installments === 1 ? "cuota" : "cuotas"}
                          </p>
                          <p className="text-sm mt-0.5">{statusText}</p>
                          <p className="text-xs text-zinc-500 mt-0.5">
                            Compra del {formatCalendar(plan.purchaseDate)} ·
                            total {formatMoney(plan.totalAmount)}.
                          </p>
                          {firstItem && lastItem && (
                            <p className="text-xs text-zinc-500 mt-0.5">
                              Cuotas de {firstItem.periodLabel} a{" "}
                              {lastItem.periodLabel}.
                            </p>
                          )}
                          {plan.implicitRate && (
                            <p className="text-xs mt-1 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-2 py-1">
                              Tasa implícita:{" "}
                              {formatPercent(plan.implicitRate.monthlyRatePercent)}{" "}
                              por mes — TEA{" "}
                              {formatPercent(plan.implicitRate.teaPercent)} ·
                              sobreprecio{" "}
                              {formatMoney(plan.implicitRate.surcharge)}.
                            </p>
                          )}

                          {notice && (
                            <p
                              id={`plan-delete-notice-${plan.id}`}
                              role="alert"
                              className="mt-2 text-xs rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
                            >
                              {notice.message}
                            </p>
                          )}

                          <div className="mt-2 flex flex-wrap gap-2">
                            {confirmPlanId === plan.id ? (
                              <>
                                <span className="text-sm text-zinc-500 py-1.5">
                                  ¿Borrar la compra y su gasto?
                                </span>
                                <button
                                  id={`plan-delete-confirm-${plan.id}`}
                                  onClick={() => removePlan(plan)}
                                  disabled={busyId !== null}
                                  className="rounded-lg bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                                >
                                  {busy ? "Borrando…" : "Sí, borrar"}
                                </button>
                                <button
                                  id={`plan-delete-cancel-${plan.id}`}
                                  onClick={() => setConfirmPlanId(null)}
                                  disabled={busyId !== null}
                                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                                >
                                  Mejor no
                                </button>
                              </>
                            ) : (
                              <button
                                id={`plan-delete-${plan.id}`}
                                onClick={() => {
                                  setConfirmPlanId(plan.id);
                                  setPlanNotice(null);
                                }}
                                disabled={busyId !== null}
                                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-rose-600 disabled:opacity-50"
                              >
                                Borrar
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Cuotas comprometidas ─────────────────────────────────── */}
              <div className="border-t border-zinc-100 dark:border-zinc-800 px-4 py-4">
                <p className="text-sm font-bold uppercase tracking-wide text-zinc-500">
                  Cuotas comprometidas
                </p>

                {card.closingDay === null ? (
                  <p className="text-sm text-zinc-500 mt-2">
                    Sin día de cierre no hay proyección de cuotas.
                  </p>
                ) : card.commitments.next12Months === "0.00" ? (
                  <p
                    id={`card-commitments-empty-${card.id}`}
                    className="text-sm text-zinc-500 mt-2"
                  >
                    Sin cuotas comprometidas todavía.
                  </p>
                ) : (
                  <div id={`card-commitments-${card.id}`} className="mt-2">
                    <p id={`commitments-6-${card.id}`} className="text-sm">
                      Próximos 6 meses:{" "}
                      <b>{formatMoney(card.commitments.next6Months)}</b>
                    </p>
                    <p id={`commitments-12-${card.id}`} className="text-sm mt-0.5">
                      Próximos 12 meses:{" "}
                      <b>{formatMoney(card.commitments.next12Months)}</b>
                    </p>
                    <ul
                      id={`commitments-months-${card.id}`}
                      className="mt-2 flex flex-wrap gap-1.5"
                    >
                      {card.commitments.months.map((month) => (
                        <li
                          key={`${month.year}-${month.month}`}
                          className="text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-zinc-600 dark:text-zinc-300"
                        >
                          {shortMonthLabel(month.year, month.month)}{" "}
                          {formatMoney(month.amount)}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-zinc-500 mt-2">
                      Es lo que ya compraste en cuotas: los próximos resúmenes lo
                      van a cobrar sí o sí. No incluye el período en curso si ya
                      tiene resumen emitido, ni las cuotas de resúmenes pagados.
                    </p>
                  </div>
                )}
              </div>
            </section>
          );
        })}

      <p className="text-center text-xs text-zinc-400 pb-2">
        <Link href="/" className="underline inline-flex items-center touch:min-h-11">
          ← Volver al panel
        </Link>
      </p>

      {/* ── Modales ──────────────────────────────────────────────────────── */}
      {modalCard && modal?.type === "config" && (
        <CardConfigForm
          card={modalCard}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            showFlash(message);
            load({ archived: includeArchived });
          }}
        />
      )}

      {modalCard && modal?.type === "plan" && (
        <CardPlanForm
          card={modalCard}
          categories={categories}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            showFlash(message);
            load({ archived: includeArchived });
          }}
        />
      )}
    </main>
  );
}
