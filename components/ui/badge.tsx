import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge — la etiqueta corta de estado.
 *
 * Las variantes de estado usan el patrón que el design system ya validó para
 * los tintes (`docs/design-system.md` §1.4): fondo del token al 10 %, borde al
 * 40 % y texto con el token pleno. El texto del estado sobre SU PROPIO tinte
 * al 10 % está medido por encima de 4,5:1 en los dos esquemas (el peor par:
 * `success` claro sobre la superficie elevada, 4,57:1).
 *
 * `rounded-full`: un badge ES una cápsula; no es un contenedor ni un control.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-line-strong text-fg",
        success: "border-success/40 bg-success/10 text-success",
        danger: "border-danger/40 bg-danger/10 text-danger",
        warning: "border-warning/40 bg-warning/10 text-warning",
        transfer: "border-transfer/40 bg-transfer/10 text-transfer",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
