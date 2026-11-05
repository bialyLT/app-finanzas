"use client";

import { useState } from "react";
import { Coins } from "lucide-react";
import CurrencySettingsModal from "./CurrencySettingsModal";

interface Props {
  /** `id` único: el nav tiene dos presentaciones (menú del teléfono y fila). */
  id: string;
  /**
   * En el menú del teléfono se lee como un destino más ("Monedas"); en la fila
   * del escritorio es un botón de icono para no comer ancho.
   */
  showLabel?: boolean;
}

/**
 * El acceso a la configuración de monedas, en el encabezado.
 *
 * El modal es global y se monta con cada botón. Sólo hay uno abierto a la vez
 * (cada presentación del nav tiene su propio estado) y los `id` son distintos
 * para no duplicar anclas en el DOM.
 */
export default function CurrencySettingsButton({ id, showLabel = false }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        id={id}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Configurar monedas"
        title="Monedas"
        className={
          showLabel
            ? "inline-flex items-center justify-center gap-2 touch:min-h-11 px-4 py-2 rounded-full border border-line-strong text-sm font-medium text-fg-muted hover:bg-surface-3"
            : "grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-fg-muted hover:bg-surface-3"
        }
      >
        <Coins className="size-5" aria-hidden />
        {showLabel && <span>Monedas</span>}
      </button>

      {open && <CurrencySettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
