# 💰 Mis Finanzas

App web para registrar **plata que entra y plata que sale**, y entender a dónde fue.

Next.js 16 (App Router) + React 19 + Prisma + PostgreSQL.

---

## La regla que ordena todo

> **Un movimiento entre bolsillos propios nunca es ingreso ni gasto.**

Es la regla que separa a las apps de finanzas que sirven de las que mienten. Transferir
plata del banco al efectivo no te hace más rico ni más pobre: movés la misma plata de
lugar. Si eso suma como ingreso, el número de "ganaste este mes" es humo.

De ahí sale el modelo entero:

- Un movimiento entre tus propias cuentas es `TRANSFER` y **no entra en ningún total**
  de ingreso o gasto.
- Pagar el resumen de la tarjeta es `TRANSFER`: baja la deuda, no es un gasto nuevo.
  El gasto fue la compra, y ya se contó cuando la hiciste.
- El capital de un préstamo es `TRANSFER` (baja la deuda). **Sólo el interés es
  gasto**, porque es lo único que realmente pagaste por el préstamo.
- La tarjeta y el préstamo son **cuentas de pasivo**: una deuda es un saldo negativo
  en una cuenta, no un tipo especial de movimiento.

Y una regla de higiene que vale para toda la base: **`amount` siempre es positivo**. El
signo lo pone el tipo de movimiento. Un monto negativo es un dato que se puede escribir
de dos maneras, y cuando un dato tiene dos representaciones, tarde o temprano aparecen
las dos y las sumas dan mal.

### Cómo se registra cada evento real

| Lo que pasó en la vida real | Qué se carga | Por qué |
|---|---|---|
| Cobraste el sueldo | `INCOME` a Banco | entra plata |
| Compraste comida | `EXPENSE` desde Banco | sale plata |
| Pasaste plata al efectivo | `TRANSFER` Banco → Efectivo | la misma plata, otro bolsillo |
| Pagaste con tarjeta | `EXPENSE` **desde la tarjeta** | sube la deuda; no salió de ningún banco |
| Pagaste el resumen | `TRANSFER` Banco → Tarjeta | baja la deuda, no es un gasto nuevo |
| Te depositaron un préstamo | `TRANSFER` Préstamo → Banco | tenés la plata, y debés más |
| Pagaste una cuota del préstamo | `TRANSFER` Banco → Préstamo (capital) **+** `EXPENSE` desde Banco (interés) | el capital baja la deuda; el interés es el costo real |

Esa última fila es la que casi ninguna app hace bien: muestra la cuota partida en dos
movimientos, porque son dos cosas distintas. Si no los separa, no puede decirte cuánto
te costó el préstamo de verdad.

---

## Requisitos

- **Node.js 20+**
- **PostgreSQL 14+** — local o en la nube (Neon, Supabase, Railway…)

## Puesta en marcha

```bash
npm install
```

```bash
# 1. Variables de entorno
cp .env.example .env      # y completá DATABASE_URL + SESSION_SECRET + APP_PASSWORD

# 2. Base de datos
npm run db:deploy         # aplica las migraciones

# 3. Arrancar
npm run dev               # http://localhost:3000
```

### ¿No tenés Postgres a mano?

El repo trae uno portátil para desarrollo y pruebas:

```bash
npm run db:local:start    # levanta PostgreSQL 17.6 en el puerto 5433
npm run db:local:status
npm run db:local:stop
npm run db:local:reset    # borra y recrea las dos bases
```

No se instala como servicio ni toca tu sistema: vive en una carpeta de usuario y se
apaga cuando querés.

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | ✅ | Conexión a PostgreSQL |
| `SESSION_SECRET` | ✅ | Firma los tokens de sesión (HMAC-SHA256). Sin esto la app **no deja entrar** — falla cerrada a propósito. Se genera con `npm run auth:secret`. |
| `APP_PASSWORD` | ⚠️ una de las dos | La contraseña, en texto plano. Cómoda para desarrollo. |
| `APP_PASSWORD_HASH` | ⚠️ una de las dos | La contraseña hasheada con scrypt. **Es la que va en producción.** Se genera con `npm run auth:hash`. |
| `APP_URL` | producción | La URL real de la app (`https://…`). De acá sale si la cookie de sesión lleva `Secure`. Si no está, se usa `NODE_ENV`. |
| `DATABASE_URL_TEST` | tests | La base que usan los tests de integración. Se apuntan a una base **aparte** para que no puedan tocar tus datos. |
| `NEXT_PUBLIC_CURRENCY` | — | Moneda a mostrar. Por defecto `ARS`. |
| `NEXT_PUBLIC_LOCALE` | — | Formato de números y fechas. Por defecto `es-AR`. |

`.env.example` explica cada una con más detalle, incluidas las trampas.

> **Sobre `APP_URL`:** si la app corre por `http` en una dirección que **no** es de
> loopback, sin esta variable la cookie sale `Secure` y el navegador la descarta sin
> decir nada: entrás, y la app te devuelve al login sin ningún error. No es un bug de
> la contraseña — es una variable faltante.

## Scripts

| Comando | Hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` / `npm start` | Build de producción (antes aplica las migraciones pendientes) y servidor |
| `npm run test` | Tests unitarios y de integración (vitest) |
| `npm run typecheck` | TypeScript sin emitir |
| `npm run lint` | ESLint |
| `npm run smoke` | Test de humo **contra la app corriendo**: siembra un escenario completo y verifica 52 números de punta a punta |
| `npm run smoke -- --reset` | Igual, borrando primero todo lo que había |
| `npm run flows` | Siembra el escenario y corre los tests de UI (Maestro) |
| `npm run db:migrate` | Crea una migración (desarrollo) |
| `npm run db:deploy` | Aplica migraciones pendientes (producción) |
| `npm run db:studio` | Explorador visual de la base |
| `npm run auth:hash` / `auth:secret` | Genera el hash de la contraseña / el secreto de sesión |

## Tests

Cuatro capas, y cada una cubre lo que la anterior no puede:

| Capa | Qué verifica | Cómo se corre |
|---|---|---|
| **Unitarios** | Fórmulas de dinero, fechas calendario, amortización | `npm run test` |
| **Integración** | Que las **invariantes se cumplan en la base**, no sólo en el código | `npm run test` (necesita `DATABASE_URL_TEST`) |
| **Humo** | 52 números reales: totales, patrimonio, deuda, bordes de mes | `npm run smoke` |
| **UI (Maestro)** | Que la persona vea esos números en pantalla, en un navegador de verdad | `npm run flows` |

Las invariantes del modelo **viven en la base de datos**, no sólo en la aplicación: hay
`CHECK` constraints y un trigger que rechazan un ingreso en un préstamo, un monto en
cero, una transferencia con categoría o una transferencia a la misma cuenta. El código
valida lo mismo por arriba para dar un buen mensaje, pero la última palabra la tiene
Postgres. Una regla de negocio que sólo vive en la aplicación se rompe la primera vez
que alguien escribe un script.

Los tests de UI necesitan la app **compilada y corriendo** (`npm run build && npm start`),
no en modo desarrollo. Los motivos están en `flows/README.md`, junto con las trampas de
Maestro que costó descubrir.

## Estructura

```
app/page.tsx                     panel: KPIs del mes, cuentas, movimientos
app/analisis/page.tsx            análisis por período
app/login/page.tsx               login
app/api/auth/                    login y logout
app/api/accounts/                cuentas (crear, archivar)
app/api/categories/              categorías
app/api/transactions/            movimientos (listar, crear, editar, borrar)
app/api/loans/preview/           vista previa de una cuota de préstamo
proxy.ts                         primera capa de auth (cortina optimista)
lib/auth/                        sesión firmada, DAL, contraseñas, CSRF
lib/money.ts                     aritmética de dinero exacta (Prisma.Decimal)
lib/dates.ts                     fechas calendario (nunca zonas horarias)
lib/balance.ts                   totales, patrimonio, KPIs
lib/finance.ts                   capa de escritura (crear/editar/borrar con validación)
lib/queries.ts                   capa de lectura + traducción de errores de la base
lib/format.ts                    formato de números y fechas (seguro en el cliente)
prisma/schema.prisma             el modelo de datos
prisma/migrations/               migraciones versionadas
components/                      formularios, header, filtros
flows/                           tests de UI (Maestro)
scripts/                         base local, smoke test, herramientas
```

### Modelo de datos

- **`Account`** — un bolsillo: efectivo, banco, tarjeta, préstamo. Lleva `openingBalance`
  para que puedas empezar hoy sin cargar tres años de historial. Si es un préstamo,
  guarda además `principal`, `tnaPercent`, `installmentCount` y `firstInstallmentDate`.
  Las cuentas archivadas salen de los formularios pero su historia sigue contando.
- **`Category`** — para qué fue. Sólo aplica a `INCOME` y `EXPENSE`; una transferencia no
  tiene categoría porque no tiene sentido preguntar "¿en qué se fue?" cuando la plata
  sigue siendo tuya. Tiene un `normalizedName` único, así que "Comida" y "COMIDA" no
  pueden convertirse en dos categorías distintas.
- **`Movement`** — `kind` (`INCOME` / `EXPENSE` / `TRANSFER`), `amount` (siempre
  positivo), `date`, `description`, y las cuentas de origen y destino. Que la cuenta de
  destino exista **sólo** en las transferencias lo garantiza la base.

### Dónde se calculan los totales

**En la base, nunca en el navegador.** El endpoint de movimientos devuelve
`{ movements, truncated, totals }`: la lista viaja topeada en `MOVEMENTS_MAX_ROWS`
(500) para no mandar miles de filas al navegador, y los totales se agregan con un
`groupBy` sobre el mismo filtro pero **sin** el tope.

La distinción importa y costó un bug: el tope limita lo que se **muestra**, nunca
lo que se **calcula**. Un panel que suma la lista que recibió da números
subestimados en cuanto el período pasa las 500 filas — y los da con la misma cara
de confianza que los correctos, que es lo peligroso.

`/analisis` todavía arma sus propios agregados sobre la lista, así que avisa con
un cartel cuando el período está truncado. Es el primer ítem pendiente de la
Fase 6 del roadmap.

## Despliegue

En Vercel, la variable `APP_URL` tiene que apuntar al dominio real para que la cookie de
sesión se marque `Secure`.

**La app necesita autenticación, y no alcanza con la del hosting.** La protección de
deployment de Vercel (si está activada) es una puerta a nivel de plataforma: no cubre el
acceso directo a la base de datos. Por eso la app trae la suya, y cubre tanto las páginas
como las rutas de API — una pantalla de login sobre APIs abiertas es teatro, porque se
saltea con un `curl`.
