"use client";

import { useEffect, useState } from "react";
import {
  ACCOUNT_KIND_LABEL,
  type AccountKindDTO,
  type LoanPreviewDTO,
} from "@/lib/finance";
import { formatPercent } from "@/lib/format";
import { formatAmountInput, formatMoney } from "@/lib/format";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

const KIND_ORDER: AccountKindDTO[] = ["CASH", "BANK", "CREDIT_CARD", "LOAN"];

/** Explicación de cada tipo, para que elegir no sea adivinar. */
const KIND_HELP: Record<AccountKindDTO, string> = {
  CASH: "Plata que tenés encima: efectivo, billetera, caja de ahorro.",
  BANK: "Cuenta bancaria o billetera virtual (Mercado Pago, Ualá).",
  CREDIT_CARD:
    "Es deuda, no plata. Lo que gastás con la tarjeta se suma a lo que debés.",
  LOAN: "Plata que te prestaron y tenés que devolver con interés.",
};

export default function AccountForm({ onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKindDTO>("BANK");
  const [openingBalance, setOpeningBalance] = useState("");

  // Parámetros del préstamo.
  const [principal, setPrincipal] = useState("");
  const [tnaPercent, setTnaPercent] = useState("");
  const [installmentCount, setInstallmentCount] = useState("");
  const [firstInstallmentDate, setFirstInstallmentDate] = useState("");

  const [preview, setPreview] = useState<LoanPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isLoan = kind === "LOAN";

  // ── Vista previa del préstamo ──────────────────────────────────────────────
  // Se pide al servidor DESPUÉS de que la persona deja de escribir (300 ms), no
  // en cada tecla. Cada consulta es un viaje de ida y vuelta, y disparar una por
  // carácter ("5", "50", "500", "5000"…) es castigar al servidor con tres
  // consultas que ya no le importan a nadie.
  //
  // El cálculo NO se hace acá. Ver app/api/loans/preview/route.ts: si el
  // formulario reimplementara la fórmula, podría mostrar una cuota distinta a la
  // que después guarda la app.
  useEffect(() => {
    if (!isLoan || !principal.trim() || !tnaPercent.trim() || !installmentCount.trim()) {
      setPreview(null);
      setPreviewError("");
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          principal,
          tnaPercent,
          installmentCount,
        });
        const response = await fetch(`/api/loans/preview?${params}`);

        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
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

    // Cancelar el envío pendiente si el componente se desmonta o los valores
    // cambian antes de que se cumpla el tiempo. Sin esto, una respuesta lenta de
    // una consulta vieja puede llegar DESPUÉS de una nueva y sobrescribirla con
    // datos obsoletos.
    return () => clearTimeout(timer);
  }, [isLoan, principal, tnaPercent, installmentCount]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Poné un nombre para reconocer la cuenta.");
      return;
    }

    if (isLoan) {
      const missing: string[] = [];
      if (!principal.trim()) missing.push("el monto prestado");
      if (!tnaPercent.trim()) missing.push("la tasa (TNA)");
      if (!installmentCount.trim()) missing.push("la cantidad de cuotas");
      if (missing.length > 0) {
        setError(`Falta ${missing.join(", ")}.`);
        return;
      }
    }

    setSaving(true);
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          openingBalance: openingBalance.trim() || "0",
          ...(isLoan
            ? {
                principal,
                tnaPercent,
                installmentCount,
                ...(firstInstallmentDate ? { firstInstallmentDate } : {}),
              }
            : {}),
        }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo crear la cuenta.");
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  const openingPreview = formatAmountInput(openingBalance);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Nueva cuenta</h2>
          <button
            id="acc-close"
            onClick={onClose}
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="acc-name" className="text-sm font-medium">
              Nombre *
            </label>
            <input
              id="acc-name"
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Banco Galicia, Efectivo, Visa Santander"
              maxLength={60}
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <div>
            <label htmlFor="acc-kind" className="text-sm font-medium">
              Qué tipo de cuenta es *
            </label>
            <select
              id="acc-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as AccountKindDTO)}
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-3 outline-none focus:ring-2 focus:ring-sky-500"
            >
              {KIND_ORDER.map((option) => (
                <option key={option} value={option}>
                  {ACCOUNT_KIND_LABEL[option]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">{KIND_HELP[kind]}</p>
          </div>

          {/* ── Parámetros del préstamo ──────────────────────────────────── */}
          {isLoan ? (
            <>
              <div>
                <label htmlFor="loan-principal" className="text-sm font-medium">
                  Cuánto te prestaron *
                </label>
                <input
                  id="loan-principal"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  placeholder="500.000"
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="loan-tna" className="text-sm font-medium">
                    TNA % *
                  </label>
                  <input
                    id="loan-tna"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={tnaPercent}
                    onChange={(e) => setTnaPercent(e.target.value)}
                    placeholder="60"
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
                <div>
                  <label htmlFor="loan-count" className="text-sm font-medium">
                    Cuotas *
                  </label>
                  <input
                    id="loan-count"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={installmentCount}
                    onChange={(e) => setInstallmentCount(e.target.value)}
                    placeholder="12"
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="loan-first" className="text-sm font-medium">
                  Primera cuota{" "}
                  <span className="font-normal text-zinc-500">(opcional)</span>
                </label>
                <input
                  id="loan-first"
                  type="date"
                  value={firstInstallmentDate}
                  onChange={(e) => setFirstInstallmentDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              {/* ── La vista previa: acá es donde el usuario entiende ─────── */}
              {previewError && (
                <p className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                  {previewError}
                </p>
              )}

              {preview && (
                <div className="rounded-xl bg-sky-50 dark:bg-sky-950 px-4 py-3 text-sm">
                  <p className="font-bold text-sky-900 dark:text-sky-100">
                    {installmentCount} cuotas de {formatMoney(preview.payment)}
                  </p>
                  <p className="mt-1 text-sky-800 dark:text-sky-200">
                    Vas a pagar en total{" "}
                    <b>{formatMoney(preview.totalPaid)}</b>.
                  </p>
                  <p className="mt-1 text-sky-800 dark:text-sky-200">
                    De eso, <b>{formatMoney(preview.totalInterest)}</b> son
                    intereses: es lo que te cuesta el préstamo.
                  </p>
                  <p className="mt-1 text-sky-700 dark:text-sky-300 text-xs">
                    De cada 100 pesos que pagues,{" "}
                    <b>
                      {formatMoney(preview.interestSharePercent, {
                        withSymbol: false,
                      })}
                    </b>{" "}
                    se los queda el banco ({formatPercent(preview.interestSharePercent)}).
                    El resto baja tu deuda.
                  </p>
                </div>
              )}

              <p className="text-xs rounded-lg bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-zinc-600 dark:text-zinc-400">
                Cuando te desembolsen la plata, se registra como una{" "}
                <b>transferencia</b> desde esta cuenta hacia tu banco. Cobrar un
                préstamo no es un ingreso: te endeudaste, no ganaste.
              </p>
            </>
          ) : (
            <div>
              <label htmlFor="acc-opening" className="text-sm font-medium">
                Cuánta plata tiene hoy{" "}
                <span className="font-normal text-zinc-500">(opcional)</span>
              </label>
              <input
                id="acc-opening"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                placeholder="0,00"
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
              />
              <p className="mt-1 text-xs text-zinc-500">
                {openingPreview ? (
                  <>
                    Arranca con <b>{openingPreview}</b>.
                  </>
                ) : (
                  "Sirve para empezar hoy sin cargar meses de movimientos viejos."
                )}
              </p>
            </div>
          )}

          {/* Pie fijo: mismo motivo que en TransactionForm — en una pantalla
              baja los botones quedaban recortados por el contenedor con scroll.
              Ver el comentario largo de components/TransactionForm.tsx. */}
          <div className="sticky bottom-0 -mx-6 -mb-6 mt-4 px-6 pb-6 pt-4 space-y-3 bg-white dark:bg-zinc-900">
            {error && (
              <p
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                id="acc-cancel"
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium"
              >
                Cancelar
              </button>
              <button
                id="acc-submit"
                type="submit"
                disabled={saving}
                className="flex-1 rounded-xl py-3 font-bold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50"
              >
                {saving ? "Creando…" : "Crear cuenta"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
