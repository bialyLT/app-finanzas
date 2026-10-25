"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Botón — la primitiva de acción.
 *
 * LA PIEL ES DEL PROYECTO, no de shadcn:
 *   · `rounded-lg` (8 px), el radio de «lo que se toca» (la escala es md 6 /
 *     lg 8 / full / none: `rounded-sm` y `rounded-xl` los prohíbe el candado).
 *   · las variantes salen de los tokens semánticos (`primary`, `secondary`,
 *     `line-strong`, `danger`), nunca de la paleta de fábrica.
 *   · el foco es `--focus` con el patrón de la app (anillo de 2 px + offset
 *     sobre el fondo), no un `outline` del navegador.
 *
 * EL TARGET TÁCTIL NO SE DECLARA ACÁ. La capa base de `app/globals.css` fuerza
 * `min-height`/`min-width` de 44 px en `button` cuando el puntero es grueso
 * (`any-pointer: coarse`). `h-9` fija `height`, no `min-height`: la regla base
 * sigue ganando en un teléfono y el escritorio conserva la densidad. Por eso
 * NINGUNA variante de tamaño agrega `touch:min-h-*` (pisaría el piso).
 *
 * Sin animaciones de entrada (eso es F3): sólo `transition-colors`.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline:
          "border border-line-strong bg-transparent text-fg hover:bg-surface-3",
        ghost: "bg-transparent text-fg hover:bg-surface-3",
        destructive: "bg-danger text-primary-fg hover:bg-danger/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      // `type="button"` por defecto: un botón dentro de un <form> sin `type`
      // es un submit. El que quiera enviar lo dice (`type="submit"`).
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
