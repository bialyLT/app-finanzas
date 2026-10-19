# Contexto del proyecto

Documento de traspaso para continuar el trabajo desde otro agente o desde otra máquina. Última actualización: 2026-10-19.

## Qué es

App personal de finanzas: ingresos, gastos, transferencias y préstamos sobre Next.js 16 (App Router), Prisma y PostgreSQL. La regla central del modelo: **la plata que se mueve entre bolsillos propios no es ingreso ni gasto**. De esa regla salen los tres tipos de movimiento (`INCOME`, `EXPENSE`, `TRANSFER`) y el tratamiento de préstamos y tarjetas como cuentas de pasivo.

## Estado verificado (2026-10-19)

- `main` tiene el rediseño completo del modelo de dinero (infra, auth, dominio, UI, tests, docs), ya pusheado a `origin` (`bialyLT/app-finanzas`).
- Batería verde: **383 tests** de vitest (12 archivos, unitarios + integración), **599 aserciones** de smoke, **2.320 checks** adversariales acumulados — **582** de la Fase 5 (`scripts/tester-fase5/`), **1.275** de la Fase 4 (`scripts/tester-fase4/`: 989 server-side + 286 de UI) y **463** de la Fase 7 r1 (`scripts/tester-fase7/`: 3 server + 7 UI) —, **24 flows** de Maestro (suite completa **24/24 en 53m 55s**; re-corrida en cada gate), build de producción limpio.
- Fases 0, 1, 2, 3, 4, 5 y 6 cerradas (la 6 con la auditoría de seguridad pasada: sin hallazgos altos ni críticos; la 3, la 4 y la 5 en dos rondas cada una, núcleo server-side + UI; la 4 r2 cerró el 2026-10-18 con la UI de préstamos). La Fase 7 ronda 1 (carga rápida) cerró el 2026-10-19; falta su ronda 2. La 9 sigue parcial (endurecimiento para producción); la 8 (migración de datos viejos) sin empezar.
- Entorno local: PostgreSQL 17 portable en `%LOCALAPPDATA%\pg17`, puerto **5433** (bases `finanzas_dev` y `finanzas_test`); la app se sirve con `npm start` en el puerto **3000**.

## Dónde está el detalle

- `ROADMAP.md` — el documento maestro: fases, criterios de aceptación, decisiones tomadas, las dieciséis trampas de Maestro y una tabla de estado real. **Es local y está en `.gitignore`**: si no está en tu copia, pedilo; este documento resume lo indispensable.
- `README.md` — arquitectura, capas de test y cómo correr todo.
- `agents/dev.md`, `agents/ui-tester.md` y `agents/security-auditor.md` — prompts de los subagentes autónomos (dev de ronda, tester de UI con Maestro y auditor de seguridad).
- `flows/README.md` — las **dieciséis trampas** de Maestro. Leer antes de tocar los flows.
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
npm test                  # 383 tests (unitarios + integración contra finanzas_test)
npm run smoke             # 599 aserciones end-to-end (servidor arriba)
node scripts/tester-fase4/NN-*.mjs   # 989 checks adversariales server-side (Fase 4 r1; servidor arriba)
node scripts/tester-fase4/ui-*.mjs   # 286 checks adversariales de la UI (Fase 4 r2; servidor arriba)
node scripts/tester-fase5/NN-*.mjs   # 582 checks adversariales server-side (Fase 5; servidor arriba)
node scripts/tester-fase7/*.mjs      # 463 checks adversariales de carga rápida (Fase 7 r1; servidor arriba)
npm run flows             # 24 flows de Maestro: siembra la base y corre; ~54m
```

Dos reglas de oro: el servidor tiene que estar arriba para smoke y flows, y **nunca correr Maestro en paralelo** (trampa 11: los JVMs comparten `~/.maestro/sessions` y pelean el lock; el síntoma es un flow que tarda el doble o falla en el primer `openLink`).

## Convenciones de trabajo

- Commits convencionales, uno por tarea, **sin atribución de IA** (nada de Co-Authored-By ni "generated by").
- Mensajes de commit en ASCII simple: PowerShell interpreta `$`, backticks y comillas dobles.
- Al terminar cada tarea: actualizar `ROADMAP.md` con el estado REAL verificado (no el planeado) y commitear.
- No usar `npm audit fix --force` (degradaría prisma). Los avisos de `braces` y `deepmerge-ts` son solo de herramientas de desarrollo.

## Próximo paso recomendado

**Fase 7 (carga rápida) — ronda 1 completa (2026-10-19); sigue la ronda 2.** La ronda 1 cerró el núcleo: selector de 3 tipos, monto sin signo con vista previa, cuenta por defecto por tipo (localStorage), categoría opcional de punta a punta (migración que relaja el CHECK; los 5 lectores dicen «Sin categoría»), sugerencias con búsqueda difusa, chips Hoy/Ayer, autofocus, atajos `T`/`I`, toast de deshacer persistente, aviso de duplicados y clic afuera que no cierra. El tester adversarial midió los cuatro criterios: A **3 interacciones · 859 ms** (peor caso contado de forma conservadora: 4 · 9,75 s) y sumó **463 checks** durables (`scripts/tester-fase7/`, 10 baterías). Encontró y arregló **1 bug real** con repro: la zona muerta de la categoría (elegir una sugerencia dejaba el chip «Ayer» bajo la banda del pie fijo → tap muerto en silencio; se colapsan las ayudas). Gate: typecheck 0 · 383/383 · smoke 599 · build EXIT=0 · suite **24/24 en 53m 55s** (dir `~/.maestro/tests/2026-10-19_011717`). La **ronda 2** pendiente: autocompletado de descripción (precarga categoría + cuenta + monto típico), plantillas/favoritos, paleta `Ctrl+K` e import CSV.

La Fase 4 (deudas y préstamos) quedó completa antes, en dos rondas (2026-10-18: ronda 1 server-side con 989 checks; ronda 2 UI de préstamos con 286 checks y suite 23/23 en 51m 17s). La Fase 3 (recurrencia) y la Fase 5 (tarjetas y cuotas) también cerraron completas. Después de la Fase 7 r2: la **Fase 9 (endurecimiento)** para producción.

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
