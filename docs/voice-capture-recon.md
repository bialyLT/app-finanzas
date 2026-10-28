# Reconocimiento del sistema para Carga por Voz y Texto (T0.1)

Fecha: 2026-10-22
Estado: Completado tras inspección del código fuente y modelo de datos.

---

## 1. Mapeo de Arquitectura y Componentes Existentes

### 1.1 Modelo de Datos (Prisma + PostgreSQL)
- **Archivo**: `prisma/schema.prisma`
- **Tipos de Movimiento**: `MovementKind { INCOME, EXPENSE, TRANSFER }`.
- **Cuentas**: `Account` con `AccountKind { CASH, BANK, CREDIT_CARD, LOAN, RECEIVABLE }`.
  - `RECEIVABLE`: Préstamo otorgado a terceros (activo).
  - `CREDIT_CARD`: Cuenta de pasivo con `closingDay`, `dueDay`, `creditLimit`.
  - `LOAN`: Cuenta de pasivo (préstamo recibido).
- **Categorías**: `Category` con `name`, `normalizedName` (único) y `kind { INCOME, EXPENSE }`.
  - Restricción: Los movimientos `TRANSFER` no llevan categoría.
  - Restricción: Un `INCOME` no puede usar una categoría `EXPENSE` y viceversa (`movement_category_kind_check`).
- **Planes de Tarjeta**: `CardPlan` y `CardPlanItem` vinculados a un movimiento `EXPENSE` en la tarjeta.
- **Fechas**: `@db.Date`. Se operan con `lib/dates.ts` (`todayCalendar()`, `calendarToDb()`, `isCalendarDate()`). Nunca usar `toISOString()`.
- **Moneda**: **Moneda única ARS**. No hay columna de moneda en `Account` ni en `Movement`.

### 1.2 Creación de Movimientos
- **Endpoint simple**: `POST /api/transactions` (`app/api/transactions/route.ts`).
  - Recibe `amount` como string/number, parsea con `parseMoneyInput(rawAmount)` de `lib/money.ts`.
  - Valida reglas de negocio: origen != destino en transferencias, transferencias sin categoría.
  - Normaliza categoría con `cleanName()` y `normalizeCategoryName()` de `lib/finance.ts`, ejecutando `upsert` con `categoryKindConflicts()`.
  - Inserta en `prisma.movement.create` con `include: movementInclude` de `lib/queries.ts`.
- **Compras en cuotas con tarjeta**: `lib/card-service.ts` -> `createCardPlan(db, input, { today })`.
  - Crea el `EXPENSE` en la tarjeta y genera los registros en `CardPlan` y `CardPlanItem` calculando los cierres de resumen correspondientes.
- **Pago de resumen de tarjeta**: `lib/card-service.ts` -> `payStatement(db, input)`.
  - Genera una `TRANSFER` de la cuenta origen a la tarjeta.
- **Pago de cuotas de préstamo**: `lib/loan-service.ts` -> `payLoanInstallment(db, input)`.
  - Genera la `TRANSFER` (amortización de capital) y el `EXPENSE` (interés).

### 1.3 Autenticación y Seguridad
- **Archivos**: `lib/auth/dal.ts`, `lib/auth/session.ts`, `lib/auth/csrf.ts`.
- **Mecanismo**: Contraseña única (`APP_PASSWORD`) almacenada en cookie HMAC-SHA256 (`finanzas_session`).
- **Verificación en API**:
  ```ts
  if (!(await requireApiSession())) return unauthorized();
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  ```
- **Tenancy**: Monousuario. Todas las cuentas y movimientos pertenecen al usuario único autenticado.

### 1.4 Sistema de Diseño y Frontend
- **Referencia**: `docs/design-system.md` («C · Noche»).
- **Tokens semánticos**: 15 tokens (`--surface`, `--surface-2`, `--fg`, `--primary`, `--danger`, etc.).
- **Reglas innegociables**:
  - Cero clases de colores por defecto de Tailwind (`zinc-*`, `blue-*`, etc.).
  - Cero emojis en interfaz.
  - Iconos vía `lucide-react`.
  - Targets táctiles de al menos 44 px en dispositivos táctiles (`any-pointer: coarse`).
  - Candados obligatorios: `npm run check:estilo` y `npm run check:css`.

---

## 2. Respuestas a las Preguntas Abiertas de la Sección 9

### Q1: ¿Cada `Account` tiene su propia moneda? ¿Cómo se representa el monto: entero en centavos o decimal?
- **Moneda**: No hay multimoneda. La app opera **exclusivamente en Pesos Argentinos (ARS)**. No existe campo `currency` en la base de datos ni en el dominio.
- **Monto**: En PostgreSQL es `Decimal(18,2)`. En Prisma es `Prisma.Decimal`. En la API viaja como `string` formateado. En el cliente se utiliza la aritmética exacta de `lib/money.ts` (`parseMoneyInput`, `money()`).

### Q2: ¿Cómo maneja hoy el sistema una `TRANSFER` entre cuentas de distinta moneda (compra o venta de dólares)? ¿Existe tipo de cambio en el movimiento?
- **Respuesta**: No existe soporte para cuentas en moneda extranjera ni tipo de cambio en transferencias. Todo movimiento ocurre en ARS.
- **Impacto en el plan**: La Fase 4 ("Monedas habilitadas") original queda descartada para la v1. Si el usuario ingresa conceptos como "dólares" o "USD", el motor debe registrar una **aclaración** explícita indicando que la aplicación actualmente opera solo en pesos.

### Q3: ¿Cómo se crea hoy un movimiento (función o servicio)? ¿Ya encapsula `CardPlan` y las validaciones de saldo o límite?
- **Respuesta**:
  - No existe un servicio único que centralice la creación de movimientos simples y en cuotas.
  - Movimientos simples se crean directamente en `POST /api/transactions` usando `prisma.movement.create` dentro de una transacción.
  - `CardPlan` está completamente encapsulado en `lib/card-service.ts` mediante `createCardPlan(tx, ...)`.
  - Por lo tanto, para `POST /api/movements/batch`, se debe implementar una función de servicio (`saveMovementBatch`) que dentro de un único `prisma.$transaction` procese cada item según su naturaleza (creación simple o `createCardPlan`).

### Q4: ¿Existe soft delete o forma de revertir un lote de movimientos?
- **Respuesta**:
  - No hay soft delete (no existen campos `deletedAt`).
  - `DELETE /api/transactions?id=...` borra físicamente llamando a `deleteMovement` de `lib/recurring.ts` para no romper invariantes con recurrencias.
  - Para deshacer un lote recién guardado, la API de batch debe retornar los IDs de los movimientos creados, permitiendo eliminarlos mediante la lógica estándar si el usuario pulsa "Deshacer".

### Q5: ¿Cómo se identifica la sesión de usuario en los endpoints (para rate limit y para filtrar cuentas y categorías)?
- **Respuesta**:
  - La sesión se valida con `await requireApiSession()` de `lib/auth/dal.ts`.
  - No hay `userId`: todas las cuentas y categorías de la base pertenecen a la persona.
  - Para rate limiting: se puede utilizar una clave en memoria del servidor basada en la IP de la solicitud (`req.headers.get("x-forwarded-for") ?? "local"`), limitando la cantidad de invocaciones a `/api/parse` por ventana de tiempo (ej. 15 llamadas por minuto).
