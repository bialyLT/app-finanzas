# Contexto del proyecto

Documento de traspaso para continuar el trabajo desde otro agente o desde otra máquina. Última actualización: 2026-10-19.

## Qué es

App personal de finanzas: ingresos, gastos, transferencias y préstamos sobre Next.js 16 (App Router), Prisma y PostgreSQL. La regla central del modelo: **la plata que se mueve entre bolsillos propios no es ingreso ni gasto**. De esa regla salen los tres tipos de movimiento (`INCOME`, `EXPENSE`, `TRANSFER`) y el tratamiento de préstamos y tarjetas como cuentas de pasivo.

## Estado verificado (2026-10-19)

- `main` tiene el rediseño completo del modelo de dinero (infra, auth, dominio, UI, tests, docs), ya pusheado a `origin` (`bialyLT/app-finanzas`).
- Batería verde: **449 tests** de vitest (15 archivos, unitarios + integración), **658 aserciones** de smoke, **3.090 checks** adversariales acumulados — **582** de la Fase 5 (`scripts/tester-fase5/`), **1.275** de la Fase 4 (`scripts/tester-fase4/`), **463** de la Fase 7 r1 (`scripts/tester-fase7/`) y **770** de la Fase 7 r2 (`scripts/tester-fase7r2/`) —, **25 flows** de Maestro (suite completa **25/25 en 56m 47s**; re-corrida en cada gate), build de producción limpio.
- Fases 0, 1, 2, 3, 4, 5, 6 y 7 cerradas (la 6 con la auditoría de seguridad pasada: sin hallazgos altos ni críticos; la 3, la 4 y la 5 en dos rondas cada una; la 7 en dos rondas: núcleo de carga rápida y segunda capa). La 9 sigue parcial (endurecimiento para producción); la 8 (presupuestos) sin empezar. **El desarrollo está en pausa desde el 2026-10-19 por pedido del usuario, para actualizar el servidor.**
- Entorno local: PostgreSQL 17 portable en `%LOCALAPPDATA%\pg17`, puerto **5433** (bases `finanzas_dev` y `finanzas_test`); la app se sirve con `npm start` en el puerto **3000**.

## Dónde está el detalle

- `ROADMAP.md` — el documento maestro: fases, criterios de aceptación, decisiones tomadas, las dieciséis trampas de Maestro y una tabla de estado real. **Es local y está en `.gitignore`**: si no está en tu copia, pedilo; este documento resume lo indispensable.
- `README.md` — arquitectura, capas de test y cómo correr todo.
- `agents/dev.md`, `agents/ui-tester.md` y `agents/security-auditor.md` — prompts de los subagentes autónomos (dev de ronda, tester de UI con Maestro y auditor de seguridad).
- `flows/README.md` — las **dieciséis trampas** de Maestro. Leer antes de tocar los flows.
- `docs/import-csv.md` — formato, validaciones y política del importador CSV (Fase 7 r2).
- Memoria persistente **Engram** (si está disponible en la máquina): buscar por proyecto; hay observaciones de arquitectura, bugs y decisiones.

## Decisiones que no se negocian

- Montos: `Decimal(18,2)` en Postgres y `Prisma.Decimal` en código. Nada de centavos en `Int` ni `BigInt`.
- Tres tipos de movimiento: `INCOME | EXPENSE | TRANSFER`. Una categoría TRANSFER no es representable (`CategoryKind { INCOME, EXPENSE }`).
- Tarjeta y préstamo son cuentas de pasivo (`AccountKind: CASH | BANK | CREDIT_CARD | LOAN`). Comprar con tarjeta = EXPENSE en la tarjeta; pagar la tarjeta = TRANSFER banco → tarjeta; cuota de préstamo = TRANSFER (capital) + EXPENSE (interés).
- Invariantes en la base: 5 CHECK constraints + 1 trigger. No duplicar validaciones críticas solo en la app.
- Fechas de calendario con `@db.Date` y parseo local explícito; nunca `toISOString()`; lectura con `getUTCDate()`.
- Los totales SIEMPRE se calculan en la base (`movementTotals`). El tope de 500 filas (`MOVEMENTS_MAX_ROWS`) limita lo que se muestra, nunca lo que se calcula.
- Moneda única: ARS. No hay campo `currency`; no mezclar monedas en fórmulas.
- Auth: password único + cookie firmada HMAC-SHA256; las mutaciones exigen `Origin` válido (CSRF); sin `SESSION_SECRET` la app falla cerrada.
- El cliente (`lib/format.ts`) suma en centavos enteros; los montos viajan como string en los DTO.
- **Responsive por definición**: el layout se adapta al espacio disponible; nada de ajustarse
  a una lista de teléfonos. Son **invariantes**: sin scroll horizontal (el contenido no puede
  imponer su ancho mínimo al viewport), **el contenido entra en su caja** (un número cortado
  dentro de su tarjeta es una mentira) y targets táctiles de **44 px o más** en **cualquier
  pantalla que se opere con el dedo** (`any-pointer: coarse`: el corte es por **modalidad del
  puntero**, no por ancho — un teléfono en landscape también cumple). La auditoría
  (`scripts/responsive/audit-mobile.mjs`) **barre un rango** de anchos (320→1024) **y las dos
  orientaciones** sobre las 6 vistas y los 11 modales, y es un gate de toda ronda que toque UI.
  Se prefieren soluciones fluidas (wrap, `min-w-0`, scroll propio, container queries) sobre
  media queries por teléfono.

## Cómo levantar el entorno

```powershell
npm run db:local:start    # PostgreSQL local (puerto 5433)
npm run build             # prisma generate + next build
npm start                 # servidor de producción en el puerto 3000
```

La contraseña de desarrollo vive en `.env` (no versionado) como `APP_PASSWORD`. Los flows la leen de ahí.

## La batería de verificación

```powershell
npm run typecheck         # tipos
npm test                  # 456 tests (unitarios + integración contra finanzas_test)
npm run smoke             # 658 aserciones end-to-end (servidor arriba)
node scripts/tester-fase4/NN-*.mjs   # 989 checks adversariales server-side (Fase 4 r1; servidor arriba)
node scripts/tester-fase4/ui-*.mjs   # 286 checks adversariales de la UI (Fase 4 r2; servidor arriba)
node scripts/tester-fase5/NN-*.mjs   # 582 checks adversariales server-side (Fase 5; servidor arriba)
node scripts/tester-fase7/*.mjs      # 463 checks adversariales de carga rápida (Fase 7 r1; servidor arriba)
node scripts/tester-fase7r2/*.mjs    # 770 checks adversariales de la segunda capa (Fase 7 r2; servidor arriba)
node scripts/responsive/audit-mobile.mjs  # auditoría responsive: 8 anchos × 6 vistas + 10 modales (Fase 9)
node scripts/tester-responsive/*.mjs      # 326 checks adversariales de responsive (Fase 9; servidor arriba)
npm run flows             # 25 flows de Maestro: siembra la base y corre; ~57m
```

Dos reglas de oro: el servidor tiene que estar arriba para smoke y flows, y **nunca correr Maestro en paralelo** (trampa 11: los JVMs comparten `~/.maestro/sessions` y pelean el lock; el síntoma es un flow que tarda el doble o falla en el primer `openLink`).

## Convenciones de trabajo

- Commits convencionales, uno por tarea, **sin atribución de IA** (nada de Co-Authored-By ni "generated by").
- Mensajes de commit en ASCII simple: PowerShell interpreta `$`, backticks y comillas dobles.
- Al terminar cada tarea: actualizar `ROADMAP.md` con el estado REAL verificado (no el planeado) y commitear.
- No usar `npm audit fix --force` (degradaría prisma). Los avisos de `braces` y `deepmerge-ts` son solo de herramientas de desarrollo.

## Próximo paso recomendado

**Fase 9 «responsive» en curso (2026-10-20) — la app se estaba rompiendo en el teléfono.** La causa raíz era **una sola**: el nav del header (`div.flex.items-center.gap-2` de 532 px **sin wrap**) empujaba el documento a **664 px**, así que **las 6 vistas** tenían scroll horizontal en cualquier device más angosto (y 745 targets táctiles de 32-40 px). El dev lo arregló con `components/Nav.tsx` (fila de escritorio con `flex-wrap` + menú «☰» de dos columnas en el teléfono, **un solo conjunto de destinos en el DOM** para no duplicar ids), grillas fluidas, la previsualización del CSV en fichas, `role="dialog"` en 5 modales y la regla de 44 px **atada al puntero** (`pointer: coarse`, no al ancho: un teléfono en landscape también la cumple). Resultado medido: **32 de 48 mediciones con desborde y 745 targets chicos → 0 y 0**; auditoría `RESULT ok=202 fail=0`; 456 tests · smoke 658 · build 0 · suite **25/25**. El tester adversarial **verificó la auditoría con fixtures reales** (detecta una fuga real y aborta si la emulación no aplicó), encontró 2 bugs (la paleta en landscape; los montos de 18 caracteres que rompían el documento) y dejó **3 huecos del gate** → ronda r2 abierta: la zona muerta del pie que puede **descartar lo cargado**, el check «contenido que no entra en su caja» que no fallaba, y el barrido que era sólo portrait. **Gate nuevo de toda ronda que toque UI:** `node scripts/responsive/audit-mobile.mjs` (8 anchos × 6 vistas + 10 modales; falla con exit 1).

La **Fase 7** quedó completa antes (2026-10-19, dos rondas: núcleo de carga rápida y segunda capa con autocompletado, plantillas/favoritos, paleta `Ctrl+K` e import CSV; 4 bugs del tester, 770 checks, suite 25/25, criterio A 3 interacciones · 1.027 ms). La Fase 4 (deudas y préstamos) también, en dos rondas (2026-10-18). La Fase 3 (recurrencia) y la Fase 5 (tarjetas y cuotas) cerraron completas.

**La Fase 9 «responsive» cerró completa (2026-10-20, dos rondas + una de CSS)**: la app se rompía en el teléfono por **una sola causa** (el nav de 532 px sin wrap empujaba el documento a 664 px) → **32 de 48 mediciones con desborde y 745 targets chicos pasaron a 0 y 0**; la zona muerta del pie pegajoso (que en el modal de préstamo **descartaba lo cargado**) quedó **estructuralmente** resuelta (el área scrolleable termina donde empieza el pie) y el gate de auditoría ahora **barre las dos orientaciones** y cuenta el contenido que no entra en su caja. Con la ronda de CSS, el proyecto quedó **Tailwind puro**: `app/globals.css` son 234 líneas de **configuración** (tema, `@custom-variant touch`, `@custom-variant angosta`, 4 `@utility`, `@layer base`) y **cero estilos a mano**, con la fuente **Geist** por fin (antes renderizaba en Arial porque un `font-family` a mano pisaba la del layout). **Gate nuevo** `npm run check:css` + `npm test` + `npm run smoke -- --reset` + `node scripts/responsive/audit-mobile.mjs` + `npm run flows`. **Al reanudar: el resto de la Fase 9** — backups automáticos, log de errores, rate limiting, CSP, CI, índices/performance y export a CSV/JSON.

## Bloqueos que necesitan a la persona

- **Neon producción**: rotar credenciales y respaldar antes de migrar; falta el `DATABASE_URL` de producción.
- **Vercel**: reactivar la protección de deployment (que pida autenticación) antes de volver a levantar el sitio.

## Acceso a GitHub (resuelto)

El 2026-10-16 la credencial quedó guardada en el Administrador de Credenciales de Windows (usuario `bialyLT`; el repo usa el helper local `wincred`): los pushes desde esta máquina funcionan sin pasos extra. Para rehacerla: flujo de código de dispositivo de GitHub (client id `01ab8ac9400c4e429b23`) y `git credential approve`. Desde otra máquina hay que autenticarse ahí.

## Nota del entorno (no perseguir fantasmas)

La UI de OpenCode puede mostrar tarjetas de "ejecuciones" en estado corriendo que en realidad son registros viejos de shells ya terminados (dev servers y corridas de Maestro de días anteriores). No corresponden a procesos vivos. Verificación rápida del entorno real:

```powershell
Get-NetTCPConnection -LocalPort 3000,5433 -State Listen
```
