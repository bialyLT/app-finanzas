<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Reglas del proyecto (transversales, aplican a toda vista)

- **Responsive es criterio de aceptación, no un extra.** El layout se **adapta al espacio
  disponible**: nada de ajustarse a una lista de teléfonos. Son tres **invariantes**:
  **sin scroll horizontal** (el contenido no puede imponer su ancho mínimo al
  viewport), **el contenido entra en su caja** (nada cortado dentro de su tarjeta: un
  número partido es una mentira) y **targets táctiles de 44 px o más** en **cualquier
  pantalla que se opere con el dedo** (`any-pointer: coarse`: teléfono, tablet, pantalla
  táctil — el corte es por **modalidad del puntero**, no por ancho). Se verifica
  **barriendo un rango** de anchos (320→1024) **y las dos orientaciones** con
  `node scripts/responsive/audit-mobile.mjs` (6 vistas × 10 anchos + 11 modales × 3
  orientaciones), no probando tres devices.
- **Preferí layout fluido** (que el contenedor envuelva, `min-w-0` en los hijos de flex,
  scroll propio en tablas y listas largas, container queries) **antes** que media queries
  por teléfono: un `md:hidden md:block` no es responsive, es responsive de juguete.
- **Medí contra el device, no contra `innerWidth`**: cuando el contenido no puede
  achicarse, Chrome expande el viewport de layout y `innerWidth` miente.
- **Un solo escritor a la vez**; el orquestador es el único que commitea.
- Los gates se reportan con **números reales**; el cierre deja docs + commit + push.
- `ROADMAP.md` es local (gitignored): el repo lleva código, tests y docs de uso.
