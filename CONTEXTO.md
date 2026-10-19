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
npm test                  # 449 tests (unitarios + integración contra finanzas_test)
npm run smoke             # 658 aserciones end-to-end (servidor arriba)
node scripts/tester-fase4/NN-*.mjs   # 989 checks adversariales server-side (Fase 4 r1; servidor arriba)
node scripts/tester-fase4/ui-*.mjs   # 286 checks adversariales de la UI (Fase 4 r2; servidor arriba)
node scripts/tester-fase5/NN-*.mjs   # 582 checks adversariales server-side (Fase 5; servidor arriba)
node scripts/tester-fase7/*.mjs      # 463 checks adversariales de carga rápida (Fase 7 r1; servidor arriba)
node scripts/tester-fase7r2/*.mjs    # 770 checks adversariales de la segunda capa (Fase 7 r2; servidor arriba)
npm run flows             # 25 flows de Maestro: siembra la base y corre; ~57m
```

Dos reglas de oro: el servidor tiene que estar arriba para smoke y flows, y **nunca correr Maestro en paralelo** (trampa 11: los JVMs comparten `~/.maestro/sessions` y pelean el lock; el síntoma es un flow que tarda el doble o falla en el primer `openLink`).

## Convenciones de trabajo

- Commits convencionales, uno por tarea, **sin atribución de IA** (nada de Co-Authored-By ni "generated by").
- Mensajes de commit en ASCII simple: PowerShell interpreta `$`, backticks y comillas dobles.
- Al terminar cada tarea: actualizar `ROADMAP.md` con el estado REAL verificado (no el planeado) y commitear.
- No usar `npm audit fix --force` (degradaría prisma). Los avisos de `braces` y `deepmerge-ts` son solo de herramientas de desarrollo.

## Próximo paso recomendado

**Fase 7 completa (2026-10-19) — desarrollo en pausa.** La ronda 2 cerró la segunda capa de la carga rápida: autocompletado de descripción (`GET /api/transactions/suggestions` sobre 400 recientes; «monto típico» = mediana en centavos; precarga categoría/cuenta siempre y monto sólo si está vacío), plantillas/favoritos (`FavoriteTemplate` con migración `20261019120000`, tope 24), paleta `Ctrl+K` (sonda CDP `scripts/probe-palette.mjs`, 46 checks; Maestro web no emite la combinación) e import CSV (preview, commit todo-o-nada, conciliación al centavo, advisory lock; formato en `docs/import-csv.md`). El tester adversarial arregló **4 bugs** con repro que falla primero (doble submit del CSV duplicaba filas; Escape cerraba el form entero; precarga de favorito con punto decimal; TRANSFER «A → A»), sumó **770 checks** (`scripts/tester-fase7r2/`, 9 baterías) y dejó la suite **25/25 en 56m 47s** (el flow nuevo pasó de `23` a `04b` pegado al `04`); criterio A **3 interacciones · 1.027 ms**. Gate del orquestador: typecheck 0 · **449/449**. **El usuario pidió frenar todo el desarrollo después de esta ronda para actualizar el servidor: no arrancar la Fase 9 (ni ninguna otra) hasta su señal.**

La Fase 4 (deudas y préstamos) quedó completa antes, en dos rondas (2026-10-18: ronda 1 server-side con 989 checks; ronda 2 UI de préstamos con 286 checks y suite 23/23 en 51m 17s). La Fase 3 (recurrencia) y la Fase 5 (tarjetas y cuotas) también cerraron completas. Al reanudar el desarrollo, la **Fase 9 (endurecimiento)** es la próxima.

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
