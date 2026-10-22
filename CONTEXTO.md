# Contexto del proyecto

Documento de traspaso para continuar el trabajo desde otro agente o desde otra máquina. Última actualización: 2026-10-22.

## Qué es

App personal de finanzas: ingresos, gastos, transferencias y préstamos sobre Next.js 16 (App Router), Prisma y PostgreSQL. La regla central del modelo: **la plata que se mueve entre bolsillos propios no es ingreso ni gasto**. De esa regla salen los tres tipos de movimiento (`INCOME`, `EXPENSE`, `TRANSFER`) y el tratamiento de préstamos y tarjetas como cuentas de pasivo.

## Estado verificado (2026-10-22)

- `main` tiene el rediseño completo del modelo de dinero (infra, auth, dominio, UI, tests, docs) **y el sistema de diseño propio** (Fase 10 F0a, commit `6778fbb`), ya pusheado a `origin` (`bialyLT/app-finanzas`).
- Batería verde: **545 tests** de vitest (20 archivos, unitarios + integración contra `finanzas_test`), **720 aserciones** de smoke, **1.190 checks** adversariales acumulados — **582** de la Fase 5 (`scripts/tester-fase5/`), **1.275** de la Fase 4 (`scripts/tester-fase4/`), **463** de la Fase 7 r1 (`scripts/tester-fase7/`), **770** de la Fase 7 r2 (`scripts/tester-fase7r2/`), **705** de la Fase 9 (`scripts/tester-responsive/`) y **485** de la F0a (`scripts/tester-responsive/28..31`) —, **25 flows** de Maestro (suite completa **25/25 en 56m 47s**; re-corrida en cada gate), build de producción limpio.
- **El aspecto por defecto quedó atrás**: la app usa el estilo **«C · Noche»** (15 tokens semánticos en `@theme` + `:root` con `prefers-color-scheme`, iconos `lucide-react` con un solo grosor, cero clases de la paleta de fábrica, cero emoji) y hay un **candado** (`npm run check:estilo`) que falla si reaparece un color de fábrica, un emoji, un radio fuera de escala, un hex suelto, un gradiente, una fuente fuera del tema, un `dark:` de color o un token sin valor en los dos esquemas. La lista de lo que **no** se hace está en `docs/design-system.md`.
- Fases 0, 1, 2, 3, 4, 5, 6 y 7 cerradas (la 6 con la auditoría de seguridad pasada: sin hallazgos altos ni críticos; la 3, la 4 y la 5 en dos rondas cada una; la 7 en dos rondas: núcleo de carga rápida y segunda capa). La 9 cerrada en su parte de UI y cálculo; **la 10 arrancada** (F0a lista). La 8 (presupuestos) sin empezar.
- Entorno local: PostgreSQL 17 portable en `%LOCALAPPDATA%\pg17`, puerto **5433** (bases `finanzas_dev` y `finanzas_test`); la app se sirve con `npm start` en el puerto **3000**.

## Dónde está el detalle

- `ROADMAP.md` — el documento maestro: fases, criterios de aceptación, decisiones tomadas, las dieciséis trampas de Maestro y una tabla de estado real. **Es local y está en `.gitignore`**: si no está en tu copia, pedilo; este documento resume lo indispensable.
- `README.md` — arquitectura, capas de test y cómo correr todo.
- `agents/dev.md`, `agents/ui-tester.md` y `agents/security-auditor.md` — prompts de los subagentes autónomos (dev de ronda, tester de UI con Maestro y auditor de seguridad).
- `flows/README.md` — las **dieciséis trampas** de Maestro. Leer antes de tocar los flows.
- `docs/import-csv.md` — formato, validaciones y política del importador CSV (Fase 7 r2).
- `docs/design-system.md` — **el estilo propio**: los 15 tokens, los ratios de contraste (los pares simples y los pares con tinte), la escala de radios, el set de iconos y la lista de «no hagas esto» con ejemplos reales del repo (Fase 10 F0a).
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
npm test                  # 545 tests (unitarios + integración contra finanzas_test)
npm run smoke             # 720 aserciones end-to-end (servidor arriba)
npm run check:estilo      # candado del estilo propio: 746 checks (Fase 10 F0a)
npm run check:css         # cero CSS a mano (Fase 9)
npm run gates             # smoke + 25 flows contra la INSTANCIA DE TESTS (:3101 / finanzas_test)
                          #   → nunca toca finanzas_dev (la base de la persona): el script lo
                          #   comprueba antes y después y ABORTA si un flow apunta al :3000.
                          #   El smoke con --reset y los flows también abortan si se los corre
                          #   contra la base o la instancia de la persona (--allow-personal-db /
                          #   -AllowPersonalInstance para exceptuar a propósito).
node scripts/db-state.mjs # snapshot de SOLO LECTURA de finanzas_dev (incluye la banderita)
node scripts/tester-fase4/NN-*.mjs   # 989 checks adversariales server-side (Fase 4 r1; servidor arriba)
node scripts/tester-fase4/ui-*.mjs   # 286 checks adversariales de la UI (Fase 4 r2; servidor arriba)
node scripts/tester-fase5/NN-*.mjs   # 582 checks adversariales server-side (Fase 5; servidor arriba)
node scripts/tester-fase7/*.mjs      # 463 checks adversariales de carga rápida (Fase 7 r1; servidor arriba)
node scripts/tester-fase7r2/*.mjs    # 770 checks adversariales de la segunda capa (Fase 7 r2; servidor arriba)
node scripts/responsive/audit-mobile.mjs  # auditoría responsive: 8 anchos × 6 vistas + 10 modales (Fase 9)
node scripts/tester-responsive/*.mjs      # 1.190 checks adversariales de responsive (705 de la Fase 9 + 485 de la F0a; servidor arriba)
npm run flows             # 25 flows de Maestro: siembra la base y corre; ~57m (usar npm run gates: va contra la instancia de tests)
```

Dos reglas de oro: el servidor tiene que estar arriba para smoke y flows, y **nunca correr Maestro en paralelo** (trampa 11: los JVMs comparten `~/.maestro/sessions` y pelean el lock; el síntoma es un flow que tarda el doble o falla en el primer `openLink`).

**Y tres trampas del arnés que ya nos mordieron:** (a) los flows **no** se corren con
`flows.ps1` contra `:3101` (el `env: BASE` del flow gana) → hay que usar `scripts/gates.ps1`;
(b) **`npm test` vacía `finanzas_test`**, así que si corrés la auditoría después te da falsos
positivos; (c) el gate tiene que esperar al servidor con paciencia (el primer request tarda
~23 s y el servidor puede tardar ~61 s en levantar).

## Convenciones de trabajo

- Commits convencionales, uno por tarea, **sin atribución de IA** (nada de Co-Authored-By ni "generated by").
- Mensajes de commit en ASCII simple: PowerShell interpreta `$`, backticks y comillas dobles.
- Al terminar cada tarea: actualizar `ROADMAP.md` con el estado REAL verificado (no el planeado) y commitear.
- No usar `npm audit fix --force` (degradaría prisma). Los avisos de `braces` y `deepmerge-ts` son solo de herramientas de desarrollo.

## Próximo paso recomendado

**Fase 10 «sistema de diseño» — arrancada (2026-10-22).** El problema era medible: 762 clases
`zinc-*`, 1.378 clases de la paleta de fábrica, 151 `rounded-xl` genéricos, 39 emojis como icono y
la fuente **Geist** (la de Next por defecto) — la firma de una app hecha por IA: **nada se decidió,
todo salió por defecto**. La persona eligió el estilo **«C · Noche»** de un spike con tres variantes
renderizadas sobre el mismo panel (`spike-estilos/`, con los ratios calculados en el navegador).
La **F0a** quedó cerrada y pusheada (`6778fbb`): 15 tokens semánticos con ratios WCAG verificados
también **sobre los tintes**, iconos `lucide-react` con un solo grosor, cero colores de fábrica y un
**candado** (`npm run check:estilo`, 746 checks) que el tester endureció hasta tapar siete puertas
de servicio (la lista incompleta de familias de paleta, el gradiente `bg-linear-*` de Tailwind v4,
los radios pelado/arbitrario/lógico, el color en `rgb()`, `font-serif`, un token declarado sin
valor y el `dark:` de color que dejaba el header negro en Noche). **VerDE con 13 bugs corregidos.**

**Sigue de la Fase 10**: **F0b** (tipografía propia: una fuente que no sea la de Next por defecto +
cifras tabulares, **con la recalibración del modelo de medidas** que ya hubo que hacer cuando
cambió la fuente en la cuota del préstamo) · **F1** (primitivas sobre Radix/shadcn **con nuestros tokens**) ·
**F2** (migración de superficies y modales, de a uno) · **F3** (detalle fino: foco visible,
micro-interacciones, estados vacíos que explican qué hacer, modo claro pulido y densidad).

**Fase 9 «responsive» + cálculo: la app ya se usa en personal (2026-10-21).** Cerrado: el mobile roto (el nav de 532 px sin wrap empujaba el documento a 664 px → scroll horizontal en las 6 vistas) · el Tailwind puro (cero estilos a mano, con un gate que lo impide) · el **invariante que faltaba** (la categoría de un movimiento tiene que ser del mismo tipo: trigger en la base + API + generador, aplicado en los seis caminos que crean movimientos) · los **gates que no tocan los datos de la persona** (`npm run gates`: segunda instancia en `:3101` con `finanzas_test`, compara `finanzas_dev` antes/después y **aborta** si un flow apunta al `:3000`) · y la **banderita por cuenta** («Contar este saldo como ingreso de este mes», con selector de mes): el modelo de la cuenta no cambia, la plata declarada entra a los ingresos del mes en que la declaraste (con la banderita de la persona encendida: ingresos 332.000 · ahorro **+600** · patrimonio 600 · reconciliación 0,00 explicando los 7.000). **Dos cosas que cambiaron de reglas:** (a) la app tiene **datos reales** → nada de agentes ni gates tocan `finanzas_dev`, y los que siembran corren contra `finanzas_test`; (b) el **dev no corre la suite completa** (la corre el tester) y las rondas son de **un solo ítem** con presupuesto de tiempo.

**Queda de la Fase 9**: el **denominador del ahorro** ("de lo que tenías disponible": el saldo de efectivo y bancos al inicio del mes + los ingresos, para los meses en que se gasta de lo acumulado) y el resto (backups automáticos, log de errores, rate limiting, CSP, CI, índices/performance, export a CSV/JSON). Y lo único que bloquea el **deploy real**: **Neon** (rotar credenciales y respaldar antes de migrar) y **Vercel** (reactivar la protección de deployment).

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
