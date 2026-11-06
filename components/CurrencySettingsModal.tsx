"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CurrencyDTO } from "@/lib/finance";
import { CURRENCIES, currencyLabel, currencyNoun } from "@/lib/currency";
import { CURRENCIES_CHANGED_EVENT } from "@/lib/currency-preference";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { Button } from "@/components/ui/button";
import { Coins, Check } from "lucide-react";

interface Props {
  onClose: () => void;
}

/** Cuántas cuentas —archivadas incluidas— hay en cada moneda. */
type AccountCounts = Partial<Record<CurrencyDTO, number>>;

/**
 * El modal de monedas habilitadas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UNA MONEDA CON CUENTAS NO SE PUEDE APAGAR DESDE ACÁ
 * ─────────────────────────────────────────────────────────────────────────────
 * La API responde 409. Mostrar el checkbox habilitado, dejar que la persona
 * confirme y recién ahí darle un error sería un camino que la interfaz sabe de
 * antemano que termina mal. Acá el control se muestra BLOQUEADO y con el motivo
 * al lado: "tiene 2 cuentas; archivalas o cambialas a otra moneda primero".
 * El 409 sigue existiendo como red para un cliente que llame a la API de
 * frente, o para una carrera entre la lectura y el guardado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA DESHABILITACIÓN SE CONFIRMA EN DOS PASOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Es una acción que cambia lo que la app entera puede hacer. El primer toque
 * muestra el resumen y el segundo guarda; los dos pasos son INLINE (`window.
 * confirm` no existe para el driver de Maestro). Agregar una moneda no pide
 * confirmación: no destruye ninguna posibilidad.
 */
export default function CurrencySettingsModal({ onClose }: Props) {
  const dialogRef = useFocusTrap<HTMLDivElement>();

  const [selected, setSelected] = useState<CurrencyDTO[]>(["ARS"]);
  const [initial, setInitial] = useState<CurrencyDTO[]>(["ARS"]);
  const [counts, setCounts] = useState<AccountCounts>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * El conteo de cuentas no se pudo leer.
   *
   * Es un estado APARTE de `loadFailed`: la configuración sí llegó, pero sin los
   * conteos no se sabe qué moneda tiene cuentas. Mostrar "Sin cuentas." sería
   * afirmar un dato que no se leyó (y habilitar el check de una moneda con
   * cuentas para terminar en un 409 que la interfaz podía evitar).
   */
  const [countsFailed, setCountsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [settingsRes, accountsRes] = await Promise.all([
          fetch("/api/settings"),
          fetch("/api/accounts?includeArchived=true"),
        ]);
        if (!settingsRes.ok) {
          throw new Error("No se pudo leer la configuración de monedas.");
        }

        const settings = (await settingsRes.json()) as {
          enabledCurrencies?: CurrencyDTO[];
        };
        // Si el conteo falla, se sigue con la configuración pero SIN inventar
        // "0 cuentas": el botón de guardar se apaga y la lista lo dice.
        const accounts = accountsRes.ok
          ? ((await accountsRes.json()) as {
              accounts?: { currency?: CurrencyDTO }[];
            })
          : { accounts: [] };

        if (cancelled) return;

        setCountsFailed(!accountsRes.ok);
        const enabled =
          settings.enabledCurrencies && settings.enabledCurrencies.length > 0
            ? settings.enabledCurrencies
            : (["ARS"] as CurrencyDTO[]);
        const nextCounts: AccountCounts = {};
        for (const account of accounts.accounts ?? []) {
          if (!account.currency) continue;
          nextCounts[account.currency] =
            (nextCounts[account.currency] ?? 0) + 1;
        }

        setSelected(enabled);
        setInitial(enabled);
        setCounts(nextCounts);
      } catch (loadError) {
        if (cancelled) return;
        setLoadFailed(true);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudo leer la configuración de monedas.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingRemovals = initial.filter(
    (currency) => !selected.includes(currency),
  );
  const canSave =
    selected.length > 0 && !loading && !saving && !loadFailed && !countsFailed;

  function toggle(currency: CurrencyDTO) {
    setConfirming(false);
    setError("");
    setSelected((current) =>
      current.includes(currency)
        ? current.filter((item) => item !== currency)
        : [...current, currency].sort(
            (a, b) => CURRENCIES.indexOf(a) - CURRENCIES.indexOf(b),
          ),
    );
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledCurrencies: selected }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? "No se pudo guardar la configuración.");
        setConfirming(false);
        return;
      }

      // El selector de cada pantalla escucha este evento y vuelve a pedir la
      // lista; si su moneda quedó apagada, cae a una habilitada y recarga.
      window.dispatchEvent(new Event(CURRENCIES_CHANGED_EVENT));
      onClose();
    } catch {
      setError("No se pudo guardar la configuración de monedas.");
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  // PORTAL AL BODY, NO ANIDADO EN EL HEADER: el `<header>` tiene
  // `backdrop-blur`, que crea un *containing block* para `position: fixed`.
  // Sin el portal, el overlay y el panel se posicionaban respecto del header y
  // el botón de cerrar (y el primer foco de la trampa) quedaba en y ≈ -115.
  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Monedas habilitadas"
        className="w-full sm:max-w-md max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex-none px-6 pt-6">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Coins className="size-5 text-success" aria-hidden />
              Monedas
            </h2>
            <Button
              id="currency-settings-close"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-xl leading-none text-fg-subtle hover:text-fg-muted px-2 h-auto w-auto"
              aria-label="Cerrar"
            >
              ×
            </Button>
          </div>
          <p className="text-sm text-fg-muted">
            Elegí con qué monedas trabajás. Con una sola habilitada, el selector
            de moneda no se muestra.
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 flex flex-col gap-2">
          {loading && <p className="text-sm text-fg-muted">Cargando…</p>}

          {!loading &&
            CURRENCIES.map((currency) => {
              const accounts = counts[currency] ?? 0;
              const checked = selected.includes(currency);
              // Sólo se bloquea DESHABILITAR una moneda con cuentas. Volver a
              // habilitarla —si quedó apagada por un estado viejo— siempre se
              // puede: no rompe nada.
              const locked = checked && accounts > 0;

              return (
                <label
                  key={currency}
                  htmlFor={`currency-toggle-${currency}`}
                  className={`flex items-start gap-3 touch:min-h-11 rounded-md border px-3 py-2 ${
                    locked
                      ? "border-line bg-surface-3/40"
                      : "border-line-strong hover:bg-surface-3/60"
                  }`}
                >
                  <input
                    id={`currency-toggle-${currency}`}
                    type="checkbox"
                    checked={checked}
                    disabled={locked || saving}
                    onChange={() => toggle(currency)}
                    className="mt-1 size-5 shrink-0 accent-success"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {currencyLabel(currency)}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {countsFailed
                        ? "No se pudieron leer las cuentas: no se puede deshabilitar ninguna moneda."
                        : accounts === 0
                          ? "Sin cuentas."
                          : `${accounts} ${
                              accounts === 1 ? "cuenta" : "cuentas"
                            } en ${currencyNoun(currency)}.`}
                    </span>
                    {locked && (
                      <span className="block text-xs text-warning mt-0.5">
                        No se puede deshabilitar con cuentas: archivalas o
                        cambialas a otra moneda primero.
                      </span>
                    )}
                  </span>
                  {checked && (
                    <Check
                      className="size-4 shrink-0 text-success mt-0.5"
                      aria-hidden
                    />
                  )}
                </label>
              );
            })}

          {!loading && selected.length === 0 && (
            <p className="text-xs text-danger" role="alert">
              Tiene que quedar al menos una moneda habilitada.
            </p>
          )}
        </div>

        <div className="flex-none border-t border-line px-6 py-4 flex flex-col gap-2">
          {error && (
            <p className="text-xs rounded-md bg-danger/10 text-danger px-3 py-2" role="alert" aria-live="polite">
              {error}
            </p>
          )}

          {confirming && pendingRemovals.length > 0 && (
            <p className="text-xs rounded-md bg-warning/10 text-warning px-3 py-2">
              Vas a deshabilitar{" "}
              {pendingRemovals.map((currency) => currencyNoun(currency)).join(" y ")}.
              Las cuentas que ya existen no se borran, pero no vas a poder crear
              movimientos nuevos en esa moneda. Tocá de nuevo para confirmar.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button
              id="currency-settings-save"
              type="button"
              onClick={() => {
                if (!canSave) return;
                if (pendingRemovals.length > 0 && !confirming) {
                  setConfirming(true);
                  return;
                }
                void save();
              }}
              disabled={!canSave}
            >
              {saving
                ? "Guardando…"
                : confirming
                  ? "Confirmar cambios"
                  : "Guardar cambios"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(dialog, document.body);
}
