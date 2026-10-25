import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Input de texto — la misma piel que el resto de los controles.
 *
 * `border-line-strong` y no `border-input`: el alias de shadcn apunta al borde
 * decorativo (`--line`, 1,4:1) y un control necesita 3:1. `--line-strong` está
 * medido a 3,00:1 en el peor par de los dos esquemas.
 *
 * `text-base` (16 px) a propósito: en iOS un input con cuerpo menor a 16 px
 * hace zoom al enfocar y descoloca el modal. La densidad no se compra con
 * legibilidad.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-line-strong bg-transparent px-3 py-1 text-base text-fg transition-colors outline-none",
        "placeholder:text-fg-subtle selection:bg-primary selection:text-primary-fg",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        "aria-invalid:border-danger",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
