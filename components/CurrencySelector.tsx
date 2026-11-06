"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CurrencyDTO } from "@/lib/finance";
import { DEFAULT_CURRENCY, currencyLabel } from "@/lib/currency";
import {
  CURRENCIES_CHANGED_EVENT,
  CURRENCY_STORAGE_KEY,
  resolveSelectedCurrency,
  shouldShowCurrencySelector,
} from "@/lib/currency-preference";

/**
 * Las monedas habilitadas como store externo, compartido por las pantallas.
 *
 * Arranca con `[ARS]` (el estado de fábrica) para que el primer render —el del
 * servidor y el de la hidratación— sea determinista. La primera suscripción
 * dispara el pedido a `/api/settings`; cuando llega, el snapshot cambia y las
 * dos pantallas que usan el hook se actualizan juntas.
 *
 * Se cachea en el módulo y no en cada componente a propósito: el panel y el
 * análisis piden LO MISMO, y dos fetch separados podrían mostrar dos listas
 * distintas por un instante. El aviso `CURRENCIES_CHANGED_EVENT` del modal
 * invalida la caché y vuelve a pedir.
 */
const SERVER_ENABLED_CURRENCIES: CurrencyDTO[] = [DEFAULT_CURRENCY];
let cachedEnabledCurrencies: CurrencyDTO[] = SERVER_ENABLED_CURRENCIES;
let enabledRequestStarted = false;
const enabledListeners = new Set<() => void>();

function notifyEnabledCurrencies() {
  for (const listener of enabledListeners) listener();
}

async function fetchEnabledCurrencies() {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) {
      // Un fallo (sesión vencida, red, 503) NO puede clavar la app en el
      // default para el resto de la sesión: se suelta el "single flight" para
      // que el próximo montaje (la otra pantalla, o volver a esta) reintente.
      enabledRequestStarted = false;
      return;
    }
    const data = (await response.json()) as {
      enabledCurrencies?: CurrencyDTO[];
    };
    if (Array.isArray(data.enabledCurrencies) && data.enabledCurrencies.length > 0) {
      cachedEnabledCurrencies = data.enabledCurrencies;
      notifyEnabledCurrencies();
    } else {
      enabledRequestStarted = false;
    }
  } catch {
    // Sin configuración se sigue con el default: el panel no puede quedar sin
    // moneda por un endpoint que no respondió. Pero el reintento queda abierto.
    enabledRequestStarted = false;
  }
}

function subscribeEnabledCurrencies(callback: () => void): () => void {
  enabledListeners.add(callback);

  if (!enabledRequestStarted) {
    enabledRequestStarted = true;
    void fetchEnabledCurrencies();
  }

  const handleChange = () => {
    enabledRequestStarted = true;
    void fetchEnabledCurrencies();
  };
  window.addEventListener(CURRENCIES_CHANGED_EVENT, handleChange);

  return () => {
    enabledListeners.delete(callback);
    window.removeEventListener(CURRENCIES_CHANGED_EVENT, handleChange);
  };
}

/** Las monedas habilitadas, compartidas por el panel y el análisis. */
export function useEnabledCurrencies(): {
  enabledCurrencies: CurrencyDTO[];
} {
  const enabledCurrencies = useSyncExternalStore(
    subscribeEnabledCurrencies,
    () => cachedEnabledCurrencies,
    () => SERVER_ENABLED_CURRENCIES,
  );

  return { enabledCurrencies };
}

/**
 * La preferencia como un store externo mínimo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `useSyncExternalStore` Y NO UN `useEffect`
 * ─────────────────────────────────────────────────────────────────────────────
 * `localStorage` no existe en el servidor: leerlo en el inicializador produce
 * HTML distinto al de la hidratación. La solución habitual es un efecto que
 * lee y hace `setState`, pero eso pinta primero una moneda y después la otra
 * (un parpadeo) y dispara un render en cascada. `useSyncExternalStore` es la
 * API pensada para esto: el servidor usa un snapshot nulo, el cliente lee el
 * valor real y React reconcilia sin efecto.
 *
 * El store avisa a las pestañas abiertas con el evento `storage` (lo dispara
 * el navegador) y a las demás suscripciones de la misma pestaña con la lista
 * local. Así elegir dólares en el panel también deja el análisis en dólares.
 */
const currencyListeners = new Set<() => void>();

function subscribeCurrencyPreference(callback: () => void): () => void {
  currencyListeners.add(callback);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === CURRENCY_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    currencyListeners.delete(callback);
    window.removeEventListener("storage", handleStorage);
  };
}

function readStoredCurrency(): string | null {
  try {
    return window.localStorage.getItem(CURRENCY_STORAGE_KEY);
  } catch {
    // Navegación privada o storage bloqueado: se resuelve con la primera
    // habilitada.
    return null;
  }
}

function notifyCurrencyChange() {
  for (const listener of currencyListeners) listener();
}

/**
 * La moneda de trabajo: preferencia persistida + lista de habilitadas.
 *
 * `resolveSelectedCurrency` es la que decide: preferencia si sigue habilitada,
 * primera habilitada si no. Así apagar dólares no deja la pantalla pidiendo una
 * moneda que ya no existe.
 */
export function useCurrencyPreference(
  enabledCurrencies: readonly CurrencyDTO[],
): [CurrencyDTO, (currency: CurrencyDTO) => void] {
  const stored = useSyncExternalStore(
    subscribeCurrencyPreference,
    readStoredCurrency,
    () => null,
  );

  const currency = resolveSelectedCurrency(enabledCurrencies, stored);

  const setCurrency = useCallback((next: CurrencyDTO) => {
    try {
      window.localStorage.setItem(CURRENCY_STORAGE_KEY, next);
    } catch {
      // La elección vale para esta sesión aunque no se pueda persistir.
    }
    // El `storage` event NO se dispara en la pestaña que escribe; este aviso
    // cubre el caso normal (elegir en el panel y ver el cambio al instante).
    notifyCurrencyChange();
  }, []);

  return [currency, setCurrency];
}

interface Props {
  enabledCurrencies: readonly CurrencyDTO[];
  value: CurrencyDTO;
  onChange: (currency: CurrencyDTO) => void;
  /** `id` propio para que el rótulo y los tests tengan un ancla estable. */
  id?: string;
  className?: string;
}

/**
 * El selector de moneda de trabajo.
 *
 * Presentacional a propósito: recibe la lista y el valor. Así la regla "no se
 * muestra con una sola moneda" se puede renderizar y verificar sin un DOM, y
 * las pantallas comparten el mismo control en vez de inventar cada una el suyo.
 */
export function CurrencySelector({
  enabledCurrencies,
  value,
  onChange,
  id = "currency-selector",
  className = "",
}: Props) {
  if (!shouldShowCurrencySelector(enabledCurrencies)) return null;

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <label
        htmlFor={id}
        className="text-xs uppercase text-fg-muted tracking-wide whitespace-nowrap"
      >
        Moneda
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as CurrencyDTO)}
        aria-label="Moneda de trabajo"
        className="min-w-0 flex-1 touch:min-h-11 rounded-md border border-line-strong bg-secondary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus [&>option]:bg-card [&>option]:text-fg"
      >
        {enabledCurrencies.map((currency) => (
          <option key={currency} value={currency}>
            {currencyLabel(currency)}
          </option>
        ))}
      </select>
    </div>
  );
}
