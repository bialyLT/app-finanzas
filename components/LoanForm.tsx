"use client";

import { useEffect, useState } from "react";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { addMonths, todayCalendar } from "@/lib/dates";
import type { AccountBalanceDTO, LoanPreviewDTO } from "@/lib/finance";
import { AMORTIZATION_SYSTEM_LABEL } from "@/lib/finance";
import { formatAmountInput, formatMoney, formatPercent } from "@/lib/format";

interface Props {
  /** Cuentas de dinero (no archivadas, CASH o BANK) para el desembolso. */
  cashAccounts: AccountBalanceDTO[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

type Direction = "I_OWE" | "OWED_TO_ME";
type SystemOption = "FRENCH" | "GERMAN" | "AMERICAN" | "INTEREST_ONLY";

const SYSTEMS: { value: SystemOption; label: string }[] = [
  { value: "FRENCH", label: "Francés" },
  { value: "GERMAN", label: "Alemán" },
  { value: "AMERICAN", label: "Americano" },
  { value: "INTEREST_ONLY", label: "Solo interés" },
];

/** El préstamo recién creado, a la espera de su desembolso. */
interface CreatedLoan {
  id: string;
  name: string;
  kind: "LOAN" | "RECEIVABLE";
  principal: string;
}

/**
 * Alta guiada de un préstamo (lo debo / me lo deben) con su DESEMBOLSO como
 * paso explícito.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL DESEMBOLSO ES UN SEGUNDO PASO Y NO UN CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 * La deuda viva de un préstamo ES el saldo de su cuenta (ronda 1): sin una
 * transferencia de desembolso registrada, la deuda "aparece de la nada" y el
 * saldo miente. El check opt-in se saltea por definición; un segundo paso que
 * ya tiene todo cargado (monto, cuenta, fecha) se contesta en un toque — y si
 * la persona elige "Ahora no", la tarjeta del préstamo queda con el aviso y el
 * botón para arreglarlo después.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL ALTA NO ES IDEMPOTENTE (y por eso el botón se bloquea)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dos POST a `/api/accounts` = dos cuentas con dos cronogramas. El botón se
 * deshabilita mientras el alta está en vuelo (mismo candado que el alta de
 * compras en cuotas de `/tarjetas`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOS COLUMNAS, SIN SCROLL INTERNO (trampas 9/15 de `flows/README.md`)
 * ─────────────────────────────────────────────────────────────────────────────
 * El pie es `sticky bottom-0`: los campos que se TIPEAN van a la izquierda,
 * arriba del pie; la columna derecha (dirección, cuenta, sistema, vista previa)
 * usa selects y botones, que un tap los alcanza sin pelear con el pie.
 */
export default function LoanForm({ cashAccounts, onClose, onSaved }: Props) {
  const [step, setStep] = useState<"form" | "disburse">("form");

  const [direction, setDirection] = useState<Direction>("I_OWE");
  const [name, setName] = useState("");
  const [cashId, setCashId] = useState(
    () =>
      cashAccounts.find((account) => account.kind === "BANK")?.id ??
      cashAccounts[0]?.id ??
      "",
  );
  const [principal, setPrincipal] = useState("");
  const [system, setSystem] = useState<SystemOption>("FRENCH");
  const [tna, setTna] = useState("");
  const [count, setCount] = useState("");
  const [firstDate, setFirstDate] = useState(() => addMonths(todayCalendar(), 1));

  const [preview, setPreview] = useState<LoanPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** El préstamo creado, cuando ya se pasó al paso del desembolso. */
  const [created, setCreated] = useState<CreatedLoan | null>(null);
  const [disburseDate, setDisburseDate] = useState(() => todayCalendar());

  const principalRaw = principal.trim();
  const principalPreview = formatAmountInput(principal);

  // ── Vista previa ───────────────────────────────────────────────────────────
  // Se pide al servidor DESPUÉS de que la persona deja de escribir (300 ms).
  // El cálculo NO se hace acá: si el formulario reimplementara la fórmula,
  // podría mostrar una cuota distinta a la que después guarda la app (ver
  // `app/api/loans/preview/route.ts`).
  useEffect(() => {
    if (step !== "form") return;
    if (!principalRaw || !tna.trim() || !count.trim()) {
      setPreview(null);
      setPreviewError("");
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          principal: principalRaw,
          tnaPercent: tna.trim(),
          installmentCount: count.trim(),
          system,
        });
        if (firstDate !== "") params.set("firstInstallmentDate", firstDate);

        const response = await fetch(`/api/loans/preview?${params}`);

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setPreviewError(body.error ?? "No se pudo calcular la cuota.");
          setPreview(null);
          return;
        }

        setPreview((await response.json()) as LoanPreviewDTO);
        setPreviewError("");
      } catch {
        setPreviewError("No se pudo calcular la cuota.");
        setPreview(null);
      }
    }, 300);

    // Cancelar el envío pendiente si los valores cambian antes de que se cumpla
    // el tiempo: una respuesta lenta de una consulta vieja no debe pisar a una
    // nueva.
    return () => clearTimeout(timer);
  }, [step, principalRaw, tna, count, system, firstDate]);

  const kind: "LOAN" | "RECEIVABLE" = direction === "I_OWE" ? "LOAN" : "RECEIVABLE";
  const verb = direction === "I_OWE" ? "pagar" : "cobrar";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const missing: string[] = [];
    if (!name.trim()) missing.push("el nombre");
    if (!principalRaw) missing.push("el monto");
    if (!tna.trim()) missing.push("la tasa (TNA)");
    if (!count.trim()) missing.push("la cantidad de cuotas");
    if (!firstDate.trim()) missing.push("la fecha de la primera cuota");
    if (missing.length > 0) {
      setError(`Faltan datos: ${missing.join(", ")}.`);
      return;
    }
    if (formatAmountInput(principal) === null) {
      setError("El monto tiene que ser un número mayor a cero.");
      return;
    }
    const countNumber = Number(count.trim());
    if (!Number.isInteger(countNumber) || countNumber < 1 || countNumber > 600) {
      setError("La cantidad de cuotas tiene que ser un entero entre 1 y 600.");
      return;
    }
    if (cashAccounts.length === 0 || !cashId) {
      setError(
        "Necesitás una cuenta de banco o efectivo (no archivada): el alta registra el desembolso entre cuentas.",
      );
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          principal: principalRaw,
          tnaPercent: tna.trim(),
          installmentCount: countNumber,
          firstInstallmentDate: firstDate,
          amortizationSystem: system,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "No se pudo crear el préstamo.");
      }

      // Paso 2: el desembolso, con todo ya cargado.
      setCreated({
        id: data.id,
        name: name.trim(),
        kind,
        principal: principalRaw,
      });
      setDisburseDate(todayCalendar());
      setError("");
      setStep("disburse");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo crear el préstamo.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDisburse() {
    if (!created) return;
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "TRANSFER",
          amount: created.principal,
          date: disburseDate,
          // La dirección de la plata es la del desembolso: en un LOAN sale del
          // préstamo y entra a la cuenta de dinero; en un RECEIVABLE al revés.
          accountId: created.kind === "LOAN" ? created.id : cashId,
          toAccountId: created.kind === "LOAN" ? cashId : created.id,
          description: "Desembolso del préstamo",
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo registrar el desembolso.");
      }

      const cashName =
        cashAccounts.find((account) => account.id === cashId)?.name ??
        "la cuenta elegida";
      onSaved(
        created.kind === "LOAN"
          ? `Préstamo «${created.name}» creado: la plata entró a ${cashName} y la deuda ya está registrada.`
          : `Préstamo «${created.name}» creado: la plata salió de ${cashName} y ya figura que te la deben.`,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo registrar el desembolso.",
      );
    } finally {
      setSaving(false);
    }
  }

  function skipDisburse() {
    if (!created) return;
    onSaved(
      `Préstamo «${created.name}» creado. Faltó registrar el desembolso: podés hacerlo desde su tarjeta.`,
    );
    onClose();
  }

  /**
   * Cerrar el modal SIN completar el desembolso: si el préstamo ya se creó,
   * es un «Ahora no» implícito (la × y el fondo no pueden dejar la lista sin
   * refrescar y sin aviso: el préstamo YA existe en el servidor).
   */
  function closeOrSkip() {
    if (created) {
      skipDisburse();
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={closeOrSkip}
    >
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">🤝 Nuevo préstamo</h2>
          <button
            id="loanalta-close"
            onClick={closeOrSkip}
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        {step === "form" ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px] gap-4 sm:gap-5">
              {/* ── Columna de campos ─────────────────────────────────────── */}
              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="loanalta-name" className="block text-sm font-medium">
                    Nombre *
                  </label>
                  <input
                    id="loanalta-name"
                    autoFocus
                    autoComplete="off"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej: Préstamo del banco"
                    maxLength={100}
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="loanalta-principal"
                      className="block text-sm font-medium"
                    >
                      Monto *
                    </label>
                    <input
                      id="loanalta-principal"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={principal}
                      onChange={(e) => setPrincipal(e.target.value)}
                      placeholder="500.000"
                      className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    {principalPreview && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {principalPreview}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="loanalta-tna" className="block text-sm font-medium">
                      TNA % *
                    </label>
                    <input
                      id="loanalta-tna"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={tna}
                      onChange={(e) => setTna(e.target.value)}
                      placeholder="60"
                      className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="loanalta-count" className="block text-sm font-medium">
                      Cuotas *
                    </label>
                    <input
                      id="loanalta-count"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                      placeholder="12"
                      className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="loanalta-first" className="block text-sm font-medium">
                      Primera cuota *
                    </label>
                    <input
                      id="loanalta-first"
                      type="date"
                      value={firstDate}
                      onChange={(e) => {
                        setFirstDate(e.target.value);
                        clearDateInputIfEmptied(e.target);
                      }}
                      className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>
              </div>

              {/* ── Columna derecha: dirección, cuenta, sistema y vista previa ── */}
              <div className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-medium mb-1">¿Qué pasó? *</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      id="loan-dir-I_OWE"
                      type="button"
                      aria-pressed={direction === "I_OWE"}
                      onClick={() => setDirection("I_OWE")}
                      className={`rounded-xl py-2.5 px-2 text-xs font-medium border ${
                        direction === "I_OWE"
                          ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
                          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      💸 Recibí un préstamo
                    </button>
                    <button
                      id="loan-dir-OWED_TO_ME"
                      type="button"
                      aria-pressed={direction === "OWED_TO_ME"}
                      onClick={() => setDirection("OWED_TO_ME")}
                      className={`rounded-xl py-2.5 px-2 text-xs font-medium border ${
                        direction === "OWED_TO_ME"
                          ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
                          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      🤲 Presté plata
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="loanalta-cash" className="block text-sm font-medium">
                    {direction === "I_OWE"
                      ? "¿Dónde entró la plata? *"
                      : "¿De qué cuenta salió? *"}
                  </label>
                  {cashAccounts.length === 0 ? (
                    <p className="mt-1 text-xs rounded-xl bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                      No hay cuentas de banco o efectivo: creá una primero para
                      poder registrar el desembolso.
                    </p>
                  ) : (
                    <select
                      id="loanalta-cash"
                      value={cashId}
                      onChange={(e) => setCashId(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      {cashAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <p className="text-sm font-medium mb-1">Sistema *</p>
                  <div className="grid grid-cols-2 gap-2">
                    {SYSTEMS.map((option) => (
                      <button
                        key={option.value}
                        id={`loanalta-system-${option.value}`}
                        type="button"
                        aria-pressed={system === option.value}
                        onClick={() => setSystem(option.value)}
                        className={`rounded-xl py-2 text-xs font-medium border ${
                          system === option.value
                            ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
                            : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {AMORTIZATION_SYSTEM_LABEL[system]}
                    {system === "INTEREST_ONLY" &&
                      ": el interés va mes a mes; el capital se cancela aparte."}
                  </p>
                </div>

                {previewError && (
                  <p
                    id="loanalta-preview-error"
                    className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
                  >
                    {previewError}
                  </p>
                )}

                {preview ? (
                  <div
                    id="loanalta-preview"
                    className="rounded-xl bg-sky-50 dark:bg-sky-950 px-4 py-3 text-sm"
                  >
                    <p className="font-bold text-sky-900 dark:text-sky-100">
                      {count.trim()}{" "}
                      {Number(count.trim()) === 1 ? "cuota" : "cuotas"} de{" "}
                      {formatMoney(preview.payment)}
                    </p>
                    <p className="mt-1 text-sky-800 dark:text-sky-200">
                      Total a {verb}: <b>{formatMoney(preview.totalPaid)}</b>
                    </p>
                    <p className="mt-1 text-sky-800 dark:text-sky-200">
                      Interés: {formatMoney(preview.totalInterest)} (
                      {formatPercent(preview.interestSharePercent)} del total)
                    </p>
                    {system === "AMERICAN" && (
                      <p className="mt-1 text-xs text-sky-800 dark:text-sky-200">
                        La primera cuota es sólo interés: el capital se paga en
                        el cierre.
                      </p>
                    )}
                  </div>
                ) : (
                  !previewError && (
                    <p className="text-xs text-zinc-500 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-3">
                      La vista previa aparece cuando cargues el monto, la tasa y
                      la cantidad de cuotas.
                    </p>
                  )
                )}
              </div>
            </div>

            {/* Pie fijo: mismo motivo que en el resto de los modales. */}
            <div className="sticky bottom-0 -mx-6 -mb-6 mt-4 px-6 pb-6 pt-4 space-y-3 bg-white dark:bg-zinc-900">
              {error && (
                <p
                  id="loanalta-error"
                  role="alert"
                  className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  id="loanalta-cancel"
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium"
                >
                  Cancelar
                </button>
                <button
                  id="loanalta-submit"
                  type="submit"
                  disabled={saving || cashAccounts.length === 0}
                  className="flex-1 rounded-xl py-3 font-bold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50"
                >
                  {saving ? "Creando…" : "Crear préstamo"}
                </button>
              </div>
            </div>
          </form>
        ) : (
          /* ── Paso 2: el desembolso, explícito ──────────────────────────────── */
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-sky-50 dark:bg-sky-950 px-4 py-3 text-sm text-sky-900 dark:text-sky-100">
              <p className="font-bold">
                Un último paso: registrar el desembolso de{" "}
                {created
                  ? // `formatAmountInput` YA devuelve el monto formateado
                    // ("$ 500.000,00"): envolverlo en `formatMoney` lo
                    // reinterpretaría como número y mostraría NaN.
                    (formatAmountInput(created.principal) ?? created.principal)
                  : "0"}
              </p>
              <p className="mt-1">
                {direction === "I_OWE"
                  ? "El préstamo ya existe. La plata entró a tu cuenta: registrá esa transferencia para que la deuda viva no mienta."
                  : "El préstamo ya existe. La plata salió de tu cuenta: registrá esa transferencia para que conste lo que te deben."}
              </p>
              <p className="mt-1 text-xs">
                Es una transferencia entre tus cuentas: no es un gasto ni un
                ingreso.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="loanalta-disburse-date"
                  className="block text-sm font-medium"
                >
                  Fecha del desembolso
                </label>
                <input
                  id="loanalta-disburse-date"
                  type="date"
                  value={disburseDate}
                  onChange={(e) => {
                    setDisburseDate(e.target.value);
                    clearDateInputIfEmptied(e.target);
                  }}
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
              <div>
                <label htmlFor="loanalta-cash" className="block text-sm font-medium">
                  {direction === "I_OWE" ? "Cuenta que lo recibió" : "Cuenta que lo prestó"}
                </label>
                <select
                  id="loanalta-cash"
                  value={cashId}
                  onChange={(e) => setCashId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                >
                  {cashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="sticky bottom-0 -mx-6 -mb-6 px-6 pb-6 pt-4 space-y-3 bg-white dark:bg-zinc-900">
              {error && (
                <p
                  id="loanalta-error"
                  role="alert"
                  className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  id="loanalta-disburse-skip"
                  type="button"
                  onClick={skipDisburse}
                  disabled={saving}
                  className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium disabled:opacity-50"
                >
                  Ahora no
                </button>
                <button
                  id="loanalta-disburse-go"
                  type="button"
                  onClick={handleDisburse}
                  disabled={saving}
                  className="flex-1 rounded-xl py-3 font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
                >
                  {saving ? "Registrando…" : "Registrar el desembolso"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
