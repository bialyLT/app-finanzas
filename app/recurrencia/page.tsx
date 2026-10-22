"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import RecurrenceRuleForm from "@/components/RecurrenceRuleForm";
import { formatCalendar } from "@/lib/dates";
import {
  MOVEMENT_KIND_LABEL,
  POSTING_MODE_LABEL,
  RECURRENCE_STATUS_LABEL,
  RECUR_FREQ_LABEL,
  type AccountBalanceDTO,
  type CategoryDTO,
  type MovementKindDTO,
  type PendingOccurrenceDTO,
  type RecurrenceResponse,
  type RecurrenceRuleDTO,
  type RecurrenceRuleStatusDTO,
  type RecurrenceRunDTO,
} from "@/lib/finance";
import { formatMoney } from "@/lib/format";
import { Banknote, Receipt, ArrowLeftRight, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";

/** Cómo se ve cada tipo en la bandeja y en la lista de reglas. */
const KIND_STYLE: Record<MovementKindDTO, { icon: LucideIcon; text: string }> = {
  INCOME: { icon: Banknote, text: "text-success" },
  EXPENSE: { icon: Receipt, text: "text-danger" },
  TRANSFER: { icon: ArrowLeftRight, text: "text-transfer" },
};

const STATUS_STYLE: Record<RecurrenceRuleStatusDTO, string> = {
  ACTIVE: "bg-success/10 text-success ",
  PAUSED: "bg-warning/10 text-warning ",
  ARCHIVED: "bg-surface-3 text-fg-muted ",
};

/** Un tramo del resumen de una regla: "Todos los meses (cada 2) · día 15". */
function ruleSchedule(rule: RecurrenceRuleDTO): string {
  const freq =
    rule.interval > 1
      ? `${RECUR_FREQ_LABEL[rule.freq]} (cada ${rule.interval})`
      : RECUR_FREQ_LABEL[rule.freq];
  const anchor = rule.dayOfMonth !== null ? ` · día ${rule.dayOfMonth}` : "";
  return `${freq}${anchor}`;
}

/** Desde/hasta/cuántas veces, como frase aparte. */
function ruleLimits(rule: RecurrenceRuleDTO): string {
  const parts = [`Desde el ${formatCalendar(rule.startDate)}`];
  if (rule.endDate) parts.push(`hasta el ${formatCalendar(rule.endDate)}`);
  if (rule.count !== null) {
    parts.push(`${rule.count} ${rule.count === 1 ? "vez" : "veces"}`);
  } else if (!rule.endDate) {
    parts.push("sin fin");
  }
  return parts.join(" · ");
}

/** De dónde sale o a dónde entra la plata, y con qué categoría. */
function ruleFlow(item: {
  kind: MovementKindDTO;
  account: { name: string; archived: boolean };
  toAccount: { name: string; archived: boolean } | null;
  category: { name: string } | null;
}): string {
  const source = `${item.account.name}${item.account.archived ? " (archivada)" : ""}`;
  if (item.kind === "TRANSFER") {
    const target = item.toAccount
      ? `${item.toAccount.name}${item.toAccount.archived ? " (archivada)" : ""}`
      : "?";
    return `${source} → ${target}`;
  }
  const category = item.category ? ` · ${item.category.name}` : "";
  return item.kind === "INCOME"
    ? `Entra a ${source}${category}`
    : `Sale de ${source}${category}`;
}

export default function RecurrencePage() {
  const [rules, setRules] = useState<RecurrenceRuleDTO[]>([]);
  const [pending, setPending] = useState<PendingOccurrenceDTO[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [accounts, setAccounts] = useState<AccountBalanceDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);

  const [run, setRun] = useState<RecurrenceRunDTO | null>(null);
  const [runError, setRunError] = useState("");

  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /** Id de la acción en curso: una sola a la vez, sin dobles toques. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [flashError, setFlashError] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formRule, setFormRule] = useState<RecurrenceRuleDTO | null>(null);

  /** Borrado en dos pasos: sin `window.confirm` (diálogo nativo). */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{ id: string; message: string } | null>(
    null,
  );

  /**
   * Carga la vista. Con `run: true` primero corre el generador —igual que el
   * panel— para que las ocurrencias vencidas ya estén materializadas (las AUTO
   * posteadas) antes de leer reglas y bandeja.
   *
   * El fallo del generador NO bloquea la vista: si lo que falla es la corrida,
   * se avisa en su tarjeta y se sigue con el GET, que no escribe y muestra lo
   * que haya. Un error de lectura sí corta, porque no hay nada que mostrar.
   */
  const load = useCallback(async (options: { run: boolean; archived: boolean }) => {
    setLoading(true);
    setLoadError("");

    if (options.run) {
      try {
        const runRes = await fetch("/api/recurrence/run", { method: "POST" });
        if (runRes.ok) {
          setRun((await runRes.json()) as RecurrenceRunDTO);
          setRunError("");
        } else {
          const data = (await runRes.json().catch(() => ({}))) as { error?: string };
          setRunError(data.error ?? "No se pudo correr el generador.");
        }
      } catch {
        setRunError("No se pudo correr el generador.");
      }
    }

    try {
      const [overviewRes, accountsRes, categoriesRes] = await Promise.all([
        fetch(`/api/recurrence${options.archived ? "?includeArchived=1" : ""}`),
        fetch("/api/accounts?includeArchived=true"),
        fetch("/api/categories"),
      ]);

      if (!overviewRes.ok || !accountsRes.ok || !categoriesRes.ok) {
        throw new Error("Alguno de los pedidos falló.");
      }

      const overview = (await overviewRes.json()) as RecurrenceResponse;
      const accountsData = (await accountsRes.json()) as { accounts: AccountBalanceDTO[] };
      const categoriesData = (await categoriesRes.json()) as { categories: CategoryDTO[] };

      setRules(overview.rules);
      setPending(overview.pending);
      setTruncated(overview.truncated);
      setAccounts(accountsData.accounts);
      setCategories(categoriesData.categories);
    } catch {
      setLoadError(
        "No se pudieron cargar los datos. Revisá que la base esté levantada y recargá.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load({ run: true, archived: false });
  }, [load]);

  function showFlash(message: string, isError = false) {
    setFlash(message);
    setFlashError(isError);
  }

  async function decide(occurrence: PendingOccurrenceDTO, action: "accept" | "skip") {
    if (busyId) return;
    setBusyId(occurrence.id);
    showFlash("");
    try {
      const response = await fetch("/api/recurrence/occurrences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: occurrence.id, action }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        created?: boolean;
        occurrence?: { movement?: { date?: string; amount?: string } | null };
      };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo resolver la ocurrencia.");
      }

      if (action === "accept") {
        const movement = data.occurrence?.movement ?? null;
        showFlash(
          movement?.date
            ? data.created === false
              ? `“${occurrence.title}” ya estaba como movimiento del ${formatCalendar(movement.date)}: no se duplicó.`
              : `Aceptada: “${occurrence.title}” del ${formatCalendar(movement.date)} quedó como movimiento de ${formatMoney(movement.amount ?? occurrence.amount)}.`
            : `Aceptada: “${occurrence.title}”.`,
        );
      } else {
        showFlash(
          `Saltada: “${occurrence.title}” del ${formatCalendar(occurrence.dueDate)} no se vuelve a generar.`,
        );
      }

      await load({ run: false, archived: includeArchived });
    } catch (err) {
      showFlash(err instanceof Error ? err.message : "No se pudo resolver.", true);
    } finally {
      setBusyId(null);
    }
  }

  async function patchStatus(rule: RecurrenceRuleDTO, status: RecurrenceRuleStatusDTO) {
    if (busyId) return;
    setBusyId(rule.id);
    showFlash("");
    try {
      const response = await fetch("/api/recurrence/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, status }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo actualizar la regla.");
      }

      showFlash(
        status === "PAUSED"
          ? `Regla “${rule.title}” pausada: no va a generar hasta que la reactives.`
          : status === "ACTIVE"
            ? `Regla “${rule.title}” reactivada.`
            : `Regla “${rule.title}” archivada: sale de la vista, pero sus movimientos quedan.`,
      );

      // Correr de nuevo tras reactivar es lo honesto: el generador materializa
      // lo vencido desde la última vez, igual que en la próxima recarga.
      await load({ run: true, archived: includeArchived });
    } catch (err) {
      showFlash(err instanceof Error ? err.message : "No se pudo actualizar.", true);
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: RecurrenceRuleDTO) {
    if (busyId) return;
    setBusyId(rule.id);
    showFlash("");
    setDeleteNotice(null);
    try {
      const response = await fetch(
        `/api/recurrence/rules?id=${encodeURIComponent(rule.id)}`,
        { method: "DELETE" },
      );

      if (response.status === 204) {
        setConfirmDeleteId(null);
        showFlash(`Regla “${rule.title}” borrada.`);
        await load({ run: false, archived: includeArchived });
        return;
      }

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "No se pudo borrar la regla.");
    } catch (err) {
      setConfirmDeleteId(null);
      setDeleteNotice({
        id: rule.id,
        message: err instanceof Error ? err.message : "No se pudo borrar la regla.",
      });
    } finally {
      setBusyId(null);
    }
  }

  function toggleArchived() {
    const next = !includeArchived;
    setIncludeArchived(next);
    setConfirmDeleteId(null);
    setDeleteNotice(null);
    showFlash("");
    load({ run: false, archived: next });
  }

  /**
   * Abre el formulario (alta con `null`, edición con la regla) y sube al
   * inicio de la página. El formulario es una sección al tope de la vista (no
   * un modal): sin el scroll, editar una regla del fondo lo dejaría fuera de
   * la pantalla.
   */
  function openForm(rule: RecurrenceRuleDTO | null) {
    setFormRule(rule);
    setFormOpen(true);
    window.scrollTo({ top: 0 });
  }

  // ── Resumen de la última corrida ───────────────────────────────────────────
  const runSummary = (() => {
    if (!run) return "Corriendo el generador…";
    const parts = [`Hoy es ${formatCalendar(run.today)}.`];
    parts.push(
      run.materialized === 0
        ? "No había fechas vencidas nuevas."
        : `Materializó ${run.materialized} ${run.materialized === 1 ? "fecha nueva" : "fechas nuevas"}.`,
    );
    if (run.posted > 0) {
      parts.push(
        `Posteó ${run.posted} ${run.posted === 1 ? "movimiento" : "movimientos"} sola.`,
      );
    }
    if (run.pending > 0) {
      parts.push(
        `${run.pending} ${run.pending === 1 ? "ocurrencia quedó" : "ocurrencias quedaron"} esperando confirmación.`,
      );
    }
    return parts.join(" ");
  })();

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Título y alta ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><RefreshCw className="size-6" aria-hidden />Recurrencia</h1>
          <p className="text-sm text-fg-muted">
            Lo que pasa cada tanto: alquiler, sueldo, servicios. Vos decís qué
            hacer cuando vence.
          </p>
        </div>
        <button
          id="rec-add-rule"
          onClick={() => openForm(null)}
          className="rounded-lg bg-primary text-primary-fg px-4 py-2.5 font-bold"
        >
          ＋ Nueva regla
        </button>
      </div>

      {/* ── Aviso de la última acción ────────────────────────────────────── */}
      {flash && (
        <p
          id="rec-flash"
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

      {/* ── Formulario de alta/edición ───────────────────────────────────── */}
      {/* Va acá arriba, en línea y no en un modal: el modal recortaba campos
          obligatorios (la categoría) detrás de un scroll interno propio. Ver
          la nota extensa en RecurrenceRuleForm. `openForm` sube al inicio al
          abrirlo para que editar una regla del fondo no lo deje fuera de la
          vista. */}
      {formOpen && (
        <RecurrenceRuleForm
          rule={formRule}
          accounts={accounts}
          categories={categories}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            showFlash(
              formRule
                ? `Regla “${formRule.title}” actualizada.`
                : "Regla creada. Si ya venció una fecha, la vas a ver en pendientes.",
            );
            load({ run: true, archived: includeArchived });
          }}
        />
      )}

      {/* ── Generador ────────────────────────────────────────────────────── */}
      {/* La app no tiene cron: el disparador es abrir la pantalla (o el panel)
          y este botón. La tarjeta cuenta qué hizo la última corrida. */}
      <section className="bg-surface-2 rounded-md px-4 py-4 shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-xs uppercase text-fg-muted tracking-wide">
              Generador de vencimientos
            </p>
            <p id="rec-run-summary" className="text-sm mt-1">
              {runSummary}
            </p>
          </div>
          <button
            id="rec-run-again"
            onClick={() => load({ run: true, archived: includeArchived })}
            disabled={loading}
            className="shrink-0 rounded-md border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
          >
            Generar de nuevo
          </button>
        </div>

        {runError && (
          <p
            id="rec-run-error"
            role="alert"
            className="mt-3 text-sm rounded-lg bg-danger/10 text-danger px-3 py-2"
          >
            No se pudo correr el generador: {runError} La vista de abajo no está
            afectada —podés revisar reglas y pendientes, y volver a generar.
          </p>
        )}

        {run?.capped && (
          <p
            id="rec-run-capped"
            role="alert"
            className="mt-3 text-sm rounded-lg bg-warning/10 text-warning px-3 py-2"
          >
            Había más fechas vencidas de las que una corrida materializa: quedó
            trabajo pendiente. Tocá <b>Generar de nuevo</b> para seguir.
          </p>
        )}

        {run && run.blocked.length > 0 && (
          <ul
            id="rec-run-blocked"
            className="mt-3 text-sm rounded-lg bg-warning/10 text-warning px-3 py-2 space-y-1"
          >
            {run.blocked.map((blocked) => (
              <li key={blocked.ruleId}>
                <TriangleAlert className="size-4 inline-block align-[-2px]" aria-hidden /> “{blocked.title}” no se pudo postear sola: {blocked.reason} Sus
                fechas quedaron en la bandeja.
              </li>
            ))}
          </ul>
        )}
      </section>

      {loadError && (
        <p
          role="alert"
          className="bg-surface-2 rounded-md px-4 py-8 text-center text-danger shadow-sm"
        >
          {loadError}
        </p>
      )}

      {!loadError && loading && (
        <p className="bg-surface-2 rounded-md px-4 py-10 text-center text-fg-muted shadow-sm">
          Cargando…
        </p>
      )}

      {!loadError && !loading && (
        <>
          {/* ── Bandeja de pendientes ────────────────────────────────────── */}
          <section className="bg-surface-2 rounded-md shadow-sm">
            <div className="px-4 pt-4">
              <h2 className="text-lg font-bold">
                Pendientes{" "}
                {pending.length > 0 && (
                  <span
                    className="ml-1 align-middle text-xs font-bold bg-warning/10 text-warning rounded-full px-2 py-0.5"
                  >
                    {pending.length}
                  </span>
                )}
              </h2>
              <p className="text-xs text-fg-muted mt-1">
                Plata que <b>todavía no se movió</b>. Aceptar un pendiente recién
                ahí lo convierte en movimiento: mientras tanto no suma a ningún
                total ni a tu patrimonio.
              </p>
            </div>

            {truncated && (
              <p
                id="rec-pending-truncated"
                role="alert"
                className="mx-4 mt-3 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2"
              >
                Hay más pendientes de los que se muestran, así que la lista está
                cortada. Resolvé los de arriba y recargá para ver el resto.
              </p>
            )}

            <div className="p-4 flex flex-col gap-2">
              {pending.length === 0 && (
                <p id="rec-pending-empty" className="text-center text-fg-muted py-6">
                  No hay nada pendiente. La bandeja está al día.
                </p>
              )}

              {pending.map((occurrence) => {
                const style = KIND_STYLE[occurrence.kind];
                const busy = busyId === occurrence.id;
                return (
                  <div
                    key={occurrence.id}
                    id={`rec-pending-${occurrence.id}`}
                    className="border border-line rounded-md px-3 py-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-lg bg-surface-3 ">
                        <style.icon className="size-4" aria-hidden />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">
                          {occurrence.title}{" "}
                          <span className="text-xs font-normal text-fg-muted">
                            · {MOVEMENT_KIND_LABEL[occurrence.kind]}
                          </span>
                        </p>
                        <p className="text-xs text-fg-muted mt-0.5">
                          Venció el {formatCalendar(occurrence.dueDate)} ·{" "}
                          {ruleFlow(occurrence)}
                        </p>
                      </div>
                      <p
                        className={`font-extrabold whitespace-nowrap pt-1 ${style.text}`}
                      >
                        {formatMoney(occurrence.amount)}
                      </p>
                    </div>

                    <div className="mt-2 flex gap-2">
                      <button
                        id={`rec-accept-${occurrence.id}`}
                        onClick={() => decide(occurrence, "accept")}
                        disabled={busyId !== null}
                        className="flex-1 rounded-md bg-success hover:bg-success/90 text-primary-fg py-2 text-sm font-bold disabled:opacity-50"
                      >
                        {busy ? "Aceptando…" : "✓ Aceptar"}
                      </button>
                      <button
                        id={`rec-skip-${occurrence.id}`}
                        onClick={() => decide(occurrence, "skip")}
                        disabled={busyId !== null}
                        className="flex-1 rounded-md border border-line-strong py-2 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
                      >
                        Saltar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Reglas ───────────────────────────────────────────────────── */}
          <section className="bg-surface-2 rounded-md shadow-sm">
            <div className="px-4 pt-4 flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-lg font-bold">Reglas</h2>
                <p className="text-xs text-fg-muted mt-1">
                  El calendario de cada regla. Las fechas de “lo que viene” son
                  una proyección: no son movimientos ni suman a ningún total.
                </p>
              </div>
              <button
                id="rec-toggle-archived"
                onClick={toggleArchived}
                aria-pressed={includeArchived}
                className={`shrink-0 rounded-md border px-3 py-2 text-sm font-medium ${
                  includeArchived
                    ? "border-transparent bg-primary text-primary-fg "
                    : "border-line-strong hover:bg-surface-3 "
                }`}
              >
                {includeArchived ? "Ocultar archivadas" : "Ver archivadas"}
              </button>
            </div>

            <div className="p-4 flex flex-col gap-3">
              {rules.length === 0 && (
                <div id="rec-rules-empty" className="text-center text-fg-muted py-6">
                  <p className="mb-1"><RefreshCw className="size-8 inline-block" aria-hidden /></p>
                  <p className="font-medium">No hay reglas todavía</p>
                  <p className="text-sm mt-1">
                    Tocá <b>＋ Nueva regla</b> para crear la primera.
                  </p>
                </div>
              )}

              {rules.map((rule) => {
                const style = KIND_STYLE[rule.kind];
                const busy = busyId === rule.id;
                const isArchived = rule.status === "ARCHIVED";
                const notice = deleteNotice?.id === rule.id ? deleteNotice : null;
                return (
                  <div
                    key={rule.id}
                    id={`rec-rule-${rule.id}`}
                    className="border border-line rounded-md px-3 py-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-lg bg-surface-3 ">
                        <style.icon className="size-5" aria-hidden />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">
                          {rule.title}
                          <span
                            className={`ml-2 align-middle text-[10px] uppercase font-bold rounded-full px-2 py-0.5 ${STATUS_STYLE[rule.status]}`}
                          >
                            {RECURRENCE_STATUS_LABEL[rule.status]}
                          </span>
                        </p>
                        <p className="text-sm mt-0.5">
                          <span className={style.text}>
                            {MOVEMENT_KIND_LABEL[rule.kind]}
                          </span>{" "}
                          · {formatMoney(rule.amount)} · {ruleSchedule(rule)}
                        </p>
                        <p className="text-xs text-fg-muted mt-0.5">{ruleFlow(rule)}</p>
                        <p className="text-xs text-fg-muted mt-0.5">
                          {ruleLimits(rule)} · {POSTING_MODE_LABEL[rule.postingMode]}
                        </p>

                        {/* Proyección: fechas del calendario, jamás plata. */}
                        <p id={`rec-upcoming-${rule.id}`} className="text-xs mt-1.5">
                          <span className="text-fg-muted">Próximas (proyección): </span>
                          {rule.upcoming.length === 0 ? (
                            <span className="text-fg-muted">
                              sin fechas próximas
                            </span>
                          ) : (
                            rule.upcoming.map((date) => (
                              <span
                                key={date}
                                className="inline-block mr-1.5 mb-1 rounded-full bg-surface-3 px-2 py-0.5"
                              >
                                {formatCalendar(date)}
                              </span>
                            ))
                          )}
                          <span className="text-fg-muted">
                            {" "}
                            — no son movimientos ni suman a ningún total.
                          </span>
                        </p>
                      </div>
                    </div>

                    {notice && (
                      <p
                        id={`rec-delete-notice-${rule.id}`}
                        role="alert"
                        className="mt-2 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2"
                      >
                        {notice.message}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap gap-2">
                      {!isArchived && (
                        <button
                          id={`rec-edit-${rule.id}`}
                          onClick={() => openForm(rule)}
                          disabled={busyId !== null}
                          className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
                        >
                          Editar
                        </button>
                      )}

                      {rule.status === "ACTIVE" && (
                        <button
                          id={`rec-pause-${rule.id}`}
                          onClick={() => patchStatus(rule, "PAUSED")}
                          disabled={busyId !== null}
                          className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
                        >
                          {busy ? "Pausando…" : "Pausar"}
                        </button>
                      )}

                      {rule.status !== "ACTIVE" && (
                        <button
                          id={`rec-resume-${rule.id}`}
                          onClick={() => patchStatus(rule, "ACTIVE")}
                          disabled={busyId !== null}
                          className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
                        >
                          Reactivar
                        </button>
                      )}

                      {!isArchived && (
                        <button
                          id={`rec-archive-${rule.id}`}
                          onClick={() => patchStatus(rule, "ARCHIVED")}
                          disabled={busyId !== null}
                          className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
                        >
                          Archivar
                        </button>
                      )}

                      {confirmDeleteId === rule.id ? (
                        <>
                          <span className="text-sm text-fg-muted py-1.5">
                            ¿Borrar la regla?
                          </span>
                          <button
                            id={`rec-delete-confirm-${rule.id}`}
                            onClick={() => removeRule(rule)}
                            disabled={busyId !== null}
                            className="rounded-lg bg-danger hover:bg-danger/90 text-primary-fg px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                          >
                            Sí, borrar
                          </button>
                          <button
                            id={`rec-delete-cancel-${rule.id}`}
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-3 "
                          >
                            Mejor no
                          </button>
                        </>
                      ) : (
                        <button
                          id={`rec-delete-${rule.id}`}
                          onClick={() => {
                            setConfirmDeleteId(rule.id);
                            setDeleteNotice(null);
                          }}
                          disabled={busyId !== null}
                          className="rounded-lg px-3 py-1.5 text-sm font-medium text-fg-muted hover:bg-surface-3 hover:text-danger disabled:opacity-50"
                        >
                          Borrar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      <p className="text-center text-xs text-fg-subtle pb-2">
        <Link href="/" className="underline inline-flex items-center touch:min-h-11">
          ← Volver al panel
        </Link>
      </p>

    </main>
  );
}
