import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "./button";
import { Badge, badgeVariants } from "./badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Input } from "./input";
import { Label } from "./label";
import { Separator } from "./separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

/**
 * Las primitivas de F1, probadas sin jsdom.
 *
 * Lo que usa PORTAL (dialog, sheet, select, dropdown-menu, tooltip) no se
 * renderiza acá: no tiene sentido inventar un DOM para verificar lo que Radix
 * ya prueba. Esas se cubren con typecheck + build, y su geometría se mide en
 * F2, cuando se migren los modales de verdad. Las que SÍ se pueden renderizar
 * en el servidor (button, badge, card, input, label, separator, table) se
 * renderizan con `react-dom/server` y se verifican de tres formas:
 *
 *   1. que la piel sea la del proyecto (tokens, no paleta de fábrica);
 *   2. que `cn` resuelva conflictos (la prop `className` pisa el default);
 *   3. que NINGUNA primitiva reintroduzca lo que el candado prohíbe (radios
 *      fuera de escala, `dark:` en un color, hex sueltos).
 *
 * El HTML se inspecciona como string: las clases prohibidas se buscan con una
 * expresión armada en runtime para que este archivo no contenga, ni siquiera
 * como ejemplo, una clase que el candado rechazaría.
 */

const RAIZ = resolve(import.meta.dirname, "..", "..");
const GLOBALS = resolve(RAIZ, "app", "globals.css");

const RADIO_FUERA_DE_ESCALA = new RegExp("round" + "ed-(?:sm|xl)\\b");
const DARK_EN_UN_COLOR = new RegExp(
  "dark:(?:bg|text|border|ring|fill|stroke|divide|outline)-",
);
const HEX = new RegExp("#[0-9a-fA-F]{3,8}\\b");

/** El HTML de las primitivas que no necesitan portal. */
function htmlDePrimitivas(): string {
  return [
    renderToStaticMarkup(<Button>Guardar</Button>),
    renderToStaticMarkup(<Button variant="destructive">Borrar</Button>),
    renderToStaticMarkup(<Badge variant="success">Pagado</Badge>),
    renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Cuenta</CardTitle>
          <CardDescription>Banco Galicia</CardDescription>
        </CardHeader>
        <CardContent>Contenido</CardContent>
        <CardFooter>Pie</CardFooter>
      </Card>,
    ),
    renderToStaticMarkup(<Input placeholder="Monto" />),
    renderToStaticMarkup(<Label htmlFor="monto">Monto</Label>),
    renderToStaticMarkup(<Separator decorative={false} />),
    renderToStaticMarkup(<Separator orientation="vertical" />),
    renderToStaticMarkup(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fecha</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>15/10</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    ),
  ].join("\n");
}

describe("cn", () => {
  it("resuelve conflictos de Tailwind con la ÚLTIMA clase", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("bg-primary", "bg-surface-2")).toBe("bg-surface-2");
    expect(cn("rounded-md", "rounded-lg")).toBe("rounded-lg");
  });

  it("acepta condicionales y arrays, y conserva lo que no conflictúa", () => {
    expect(cn("text-sm", false && "hidden", ["font-medium"], { "text-fg": true })).toBe(
      "text-sm font-medium text-fg",
    );
  });
});

describe("buttonVariants", () => {
  it("las seis variantes usan tokens del proyecto", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
    expect(buttonVariants({ variant: "outline" })).toContain("border-line-strong");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-surface-3");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-danger");
    expect(buttonVariants({ variant: "link" })).toContain("underline-offset-4");
  });

  it("los cuatro tamaños tienen la altura que declara cada uno", () => {
    expect(buttonVariants({ size: "sm" })).toContain("h-8");
    expect(buttonVariants({ size: "default" })).toContain("h-9");
    expect(buttonVariants({ size: "lg" })).toContain("h-10");
    expect(buttonVariants({ size: "icon" })).toContain("size-9");
  });

  it("la variante por defecto es primary/default y el radio es de la escala", () => {
    const clases = buttonVariants({});
    expect(clases).toContain("bg-primary");
    expect(clases).toContain("h-9");
    expect(clases).toContain("rounded-lg");
    expect(clases).toContain("focus-visible:ring-2");
    expect(clases).toContain("focus-visible:ring-ring");
  });

  it("ninguna variante NI tamaño pisa el piso táctil con min-h (la capa base manda)", () => {
    const todas = [
      buttonVariants({}),
      buttonVariants({ variant: "outline" }),
      buttonVariants({ variant: "destructive" }),
      buttonVariants({ size: "sm" }),
      buttonVariants({ size: "lg" }),
      buttonVariants({ size: "icon" }),
    ];
    for (const clases of todas) {
      expect(clases).not.toMatch(/(?:^|\s)(?:touch:)?min-(?:h|w)-\S+/);
    }
  });
});

describe("Button", () => {
  it("renderiza un <button type=button> con la piel del proyecto", () => {
    const html = renderToStaticMarkup(<Button>Guardar</Button>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("bg-primary");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("Guardar");
  });

  it("con asChild entrega el estilo al hijo (un enlace sigue siendo un enlace)", () => {
    const html = renderToStaticMarkup(
      <Button asChild variant="link">
        <a href="/inicio">Volver</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/inicio"');
    expect(html).not.toContain("<button");
  });

  it("la prop className puede pisar el default (cn gana con la última)", () => {
    const html = renderToStaticMarkup(<Button className="bg-danger">Borrar</Button>);
    expect(html).toContain("bg-danger");
    // una sola familia de fondo en el resultado (el hover de la variante
    // sigue ahí a propósito: no es el mismo estado)
    expect(html).not.toMatch(/(?:^|\s)bg-primary(?:\s|")/);
  });
});

describe("Badge", () => {
  it("cada estado pinta el token con su tinte al 10 % y el borde al 40 %", () => {
    expect(badgeVariants({ variant: "success" })).toContain("bg-success/10");
    expect(badgeVariants({ variant: "success" })).toContain("border-success/40");
    expect(badgeVariants({ variant: "danger" })).toContain("bg-danger/10");
    expect(badgeVariants({ variant: "warning" })).toContain("bg-warning/10");
    expect(badgeVariants({ variant: "transfer" })).toContain("bg-transfer/10");
    expect(badgeVariants({ variant: "outline" })).toContain("border-line-strong");
  });

  it("es una cápsula (rounded-full) y renderiza el texto", () => {
    const html = renderToStaticMarkup(<Badge variant="warning">Pendiente</Badge>);
    expect(html).toContain("rounded-full");
    expect(html).toContain("Pendiente");
  });
});

describe("Card, Input, Label, Separator y Table", () => {
  it("Card compone todas sus partes con las superficies del sistema", () => {
    const html = htmlDePrimitivas();
    expect(html).toContain("bg-card");
    expect(html).toContain("border-line");
    expect(html).toContain("Cuenta");
    expect(html).toContain("Contenido");
    expect(html).toContain("Pie");
  });

  it("Input usa el borde de CONTROL (line-strong) y cuerpo de 16 px", () => {
    const html = renderToStaticMarkup(<Input placeholder="Monto" />);
    expect(html).toContain("border-line-strong");
    expect(html).toContain("text-base");
    expect(html).toContain("placeholder");
  });

  it("Label asocia la etiqueta con el control", () => {
    const html = renderToStaticMarkup(<Label htmlFor="monto">Monto</Label>);
    expect(html).toContain("<label");
    expect(html).toContain('for="monto"');
  });

  it("Separator decorativo no se anuncia y el semántico sí", () => {
    const decorativo = renderToStaticMarkup(<Separator />);
    const semantico = renderToStaticMarkup(<Separator decorative={false} />);
    expect(decorativo).toContain('data-orientation="horizontal"');
    expect(semantico).toContain('role="separator"');
  });

  it("Table scrollea por dentro (el documento no se va de ancho)", () => {
    const html = htmlDePrimitivas();
    expect(html).toContain('data-slot="table-container"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("<table");
  });
});

describe("las primitivas respetan el candado de estilo", () => {
  it("el HTML renderizado no trae radios fuera de escala, ni dark: en color, ni hex", () => {
    const html = htmlDePrimitivas();
    expect(html).not.toMatch(RADIO_FUERA_DE_ESCALA);
    expect(html).not.toMatch(DARK_EN_UN_COLOR);
    expect(html).not.toMatch(HEX);
  });

  it("no hay una sola clase de la paleta de fábrica en el HTML", () => {
    const html = htmlDePrimitivas();
    const paletas = [
      "zinc", "slate", "gray", "neutral", "stone", "red", "emerald", "green",
      "blue", "sky", "amber", "orange", "yellow", "indigo", "purple", "rose",
      "cyan", "teal", "lime", "violet", "fuchsia", "pink",
    ];
    for (const paleta of paletas) {
      expect(html, paleta).not.toMatch(
        new RegExp(`(?:bg|text|border|ring|fill|stroke)-${paleta}-\\d`),
      );
    }
  });
});

describe("el puente de tokens de shadcn", () => {
  const css = readFileSync(GLOBALS, "utf8");

  it("los alias apuntan a NUESTROS tokens (ningún valor es un color literal)", () => {
    const puente: Record<string, string> = {
      background: "--surface",
      foreground: "--fg",
      card: "--surface-2",
      "card-foreground": "--fg",
      popover: "--surface-2",
      "popover-foreground": "--fg",
      primary: "--primary",
      "primary-foreground": "--primary-fg",
      secondary: "--surface-3",
      "secondary-foreground": "--fg",
      muted: "--surface-3",
      "muted-foreground": "--fg-muted",
      accent: "--surface-3",
      "accent-foreground": "--fg",
      destructive: "--danger",
      "destructive-foreground": "--primary-fg",
      border: "--line",
      input: "--line",
      ring: "--focus",
    };

    for (const [alias, token] of Object.entries(puente)) {
      expect(css, `falta --color-${alias}`).toContain(
        `--color-${alias}: var(${token})`,
      );
    }
  });

  it("el puente NO agregó ni un hex: los valores siguen siendo 15 + 15", () => {
    // Sólo las DECLARACIONES de token, no los hex que aparecen en comentarios.
    const declaraciones = css.match(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(declaraciones).toHaveLength(30);
    const claro = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
    const oscuro = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(claro.match(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/g) ?? []).toHaveLength(15);
    expect(oscuro.match(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/g) ?? []).toHaveLength(15);
  });
});
