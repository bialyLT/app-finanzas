import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Une clases condicionales y resuelve los conflictos de Tailwind.
 *
 * `clsx` arma la lista (acepta strings, arrays y objetos) y `tailwind-merge`
 * deja la ÚLTIMA clase de cada familia: `cn("p-2", "p-4")` da `"p-4"`, no las
 * dos. Sin eso, una prop `className` no podría pisar el default del
 * componente y la piel del proyecto dependería del orden de las clases en el
 * CSS compilado.
 *
 * Es el `cn()` estándar de shadcn: la convención importa porque `components.json`
 * declara `aliases.utils = "@/lib/utils"` y un futuro `npx shadcn add` va a
 * importar desde acá.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
