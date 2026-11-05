# Fase 4 · Monedas habilitadas: diseño de la migración

Estado: **implementada y en producción** (2026-11-05). Este documento es el diseño
aprobado; el detalle de lo que se desvió está en §5.1 y en los commits.

## Estado de implementación

| Fase | Qué quedó | Commit |
|---|---|---|
| F4.1 | Enum, `Account.currency`, `Movement.toAmount`, `Budget.currency`, `AppSettings`; 3 CHECK + 2 triggers | `f715b92` |
| F4.2 | Scoping por moneda en las 10 funciones de agregación, `getNetWorth` por moneda, `AccountDTO.currency` | `9ab1d8d` |
| F4.3 | Alta/edición de cuentas con moneda, `toAmount` en API y batch, CSV sólo-ARS | `aa8c1ae` |
| F4.4a | `formatMoney` por moneda, selector en el alta, segundo monto en transferencias | `8bedca1` |
| F4.4b | `/api/settings`, patrimonio por moneda en el panel, selector global, modal de monedas | `414da11` |
| F4.5 | Motor de voz con monedas habilitadas | `20e3a7f` |
| F4.1b | Migración de concurrencia: locking reads en ambos triggers | `aa8c1ae` |

**Diferido**: F4.6 (`toAmount` en `RecurrenceRule`/`FavoriteTemplate`), importación CSV
en otras monedas, y pago de resumen/cuota entre monedas (la base lo rechaza con 400
legible).

---


---

## 1. El problema real

Hoy la app es de una sola moneda **por omisión, no por diseño**: no hay ninguna
columna que diga "esto son pesos". La moneda está implícita en cada número.

Agregar una columna `currency` y listo **no alcanza**, porque crea dos clases de
mentira:

1. **Sumar monedas distintas.** `getNetWorth` (`lib/balance.ts`) suma todos los
   saldos en un solo `sum()`. Con una cuenta en dólares, "patrimonio: $1.200.000"
   sería la suma de pesos y dólares como si fueran lo mismo. Lo mismo pasa en
   `movementTotals` y `movementCashFlow` (`lib/queries.ts`), que agregan
   `Movement.amount` sin mirar la cuenta.
2. **Una transferencia que vale dos cosas.** `Movement.amount` es un único
   decimal positivo. Si salen 120.000 ARS y entran 100 USD, ese número no puede
   representar las dos puntas. Elegir una (por ejemplo, guardar 120.000) hace
   que la cuenta en dólares reciba 120.000 dólares.

El diseño tiene que resolver las dos, y que la base **no permita** guardar un
estado que se contradiga.

---

## 2. Decisiones de modelo

### D1 · La moneda vive en la CUENTA, no en el movimiento

`Account.currency` es obligatoria. `Movement` **no** lleva moneda: se deriva de
su cuenta de origen.

**Por qué.** Un movimiento pertenece a una cuenta; su moneda es la de esa
cuenta. Guardarla dos veces permite el estado imposible "movimiento en USD
dentro de una cuenta en ARS", que es el mismo error que el proyecto ya evitó al
no guardar el signo en `amount` (el signo lo dice `kind`).

**Consecuencia.** Toda consulta que agregue plata entre cuentas tiene que
declarar la moneda. Eso es trabajo, pero es trabajo honesto: el número que se
muestra pasa a tener una unidad explícita.

### D2 · El nombre de la cuenta deja de ser único global

`@@unique([name])` → `@@unique([name, currency])`.

**Por qué.** "Efectivo" en pesos y "Efectivo" en dólares son dos cuentas
distintas y legítimas. Con el índice actual, la segunda no se puede crear.

**Efecto colateral a no olvidar.** El manejo del error `P2002` en
`/api/accounts` hoy mira `meta.target = ["name"]`. Pasa a ser
`["name", "currency"]`; el mensaje tiene que decir "ya tenés una cuenta con ese
nombre en esa moneda", no "ese nombre ya existe".

### D3 · Transferencia entre monedas: `Movement.toAmount`

- `amount` = lo que **sale** de la cuenta de origen, en la moneda de origen.
- `toAmount` = lo que **entra** en la cuenta de destino, en la moneda de destino.
- Obligatorio si las monedas difieren; **prohibido** si son iguales.

**Por qué no un `exchangeRate`.** El tipo de cambio se deriva (`toAmount /
amount`) y mostrarlo es útil, pero guardarlo crea un tercer número que puede
contradecir a los otros dos ("rate 1000" con 120.000 y 100 dice que el rate es
1200). Se calcula al mostrar, no se persiste.

**Por qué no dos movimientos.** Modelar "compré dólares" como un `EXPENSE` en
pesos + un `INCOME` en dólares rompe la regla de oro del proyecto: una
transferencia entre cuentas propias no es un gasto ni un ingreso, y contarla
como tal ensucia todos los reportes del mes.

### D4 · Invariantes en la base

Este proyecto no confía en que la API se acuerde. La migración agrega:

| Invariante | Dónde | Por qué |
|---|---|---|
| `toAmount > 0` si existe | CHECK | Mismo criterio que `movement_amount_positive`. |
| `toAmount` sólo en TRANSFER | CHECK | En INCOME/EXPENSE no hay destino. |
| Monedas distintas ⇔ `toAmount` presente | **trigger** | Un CHECK no puede leer `Account`. |
| La moneda de una cuenta con historia es inmutable | **trigger** | Cambiarla reescribiría el significado de todos sus movimientos sin tocar una fila. Mismo criterio que `category_kind_immutable_check`. |

### D5 · Monedas habilitadas: tabla singleton, no variable de entorno

```prisma
model AppSettings {
  id                Int        @id @default(1)
  enabledCurrencies Currency[] @default([ARS])
  updatedAt         DateTime   @updatedAt
}
```

**Por qué una tabla.** La persona cambia sus monedas desde la app; una variable
de entorno es configuración de despliegue, no una preferencia. Además el motor
de voz necesita la lista aunque todavía no exista ninguna cuenta en esa moneda
(para poder decir "todavía no habilitaste dólares" en vez de inventar).

**Por qué singleton.** Hoy hay un solo usuario. Una tabla de preferencias por
usuario sería una mentira con una fila. El CHECK `id = 1` lo hace explícito.

### D6 · Los presupuestos también necesitan moneda

`Budget` hoy es `@@unique([categoryId, month])` con un `amount` suelto. Con dos
monedas, "presupuesto de Supermercado de octubre" es ambiguo, y el cálculo
sumaría gastos de las dos monedas contra un límite que está en una sola.

Se agrega `Budget.currency` (default `ARS`) y el único pasa a
`@@unique([categoryId, month, currency])`.

### D7 · Límite explícito de la v1: generadores sólo en la misma moneda

`RecurrenceRule` y `FavoriteTemplate` también tienen `accountId`/`toAccountId` y
un `amount`. Se podría agregar `toAmount` a las dos, pero eso triplica la lógica
del trigger para un caso que hoy nadie usa.

**Decisión:** la base protege el **libro** (`Movement`); la API rechaza crear
una regla o plantilla cuyas cuentas tengan monedas distintas, con un mensaje
claro ("las transferencias entre monedas se cargan a mano"). Si con el uso
aparece la necesidad, se extiende en una fase aparte con el mismo patrón.

---

## 3. La migración

Un solo archivo: `prisma/migrations/20261104120000_fase4_monedas/migration.sql`.

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Fase 4: monedas
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Aditiva: no reescribe ninguna fila. Todas las cuentas que ya existen quedan
-- en ARS (el DEFAULT), que es lo que son. Ningún movimiento cambia de monto.
--
-- Los invariantes nuevos van con CHECK y triggers, no con validación de
-- aplicación: el mismo criterio que el resto del esquema.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ARS', 'USD');

-- AlterTable · Account
ALTER TABLE "Account" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'ARS';

-- El nombre deja de ser único global: "Efectivo" en pesos y "Efectivo" en
-- dólares son dos cuentas distintas.
DROP INDEX "Account_name_key";
CREATE UNIQUE INDEX "Account_name_currency_key" ON "Account"("name", "currency");

-- AlterTable · Movement
ALTER TABLE "Movement" ADD COLUMN "toAmount" DECIMAL(18,2);

ALTER TABLE "Movement"
  ADD CONSTRAINT "movement_to_amount_positive"
  CHECK ("toAmount" IS NULL OR "toAmount" > 0);

ALTER TABLE "Movement"
  ADD CONSTRAINT "movement_to_amount_only_on_transfer"
  CHECK ("kind" = 'TRANSFER' OR "toAmount" IS NULL);

-- AlterTable · Budget
ALTER TABLE "Budget" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'ARS';

DROP INDEX "Budget_categoryId_month_key";
CREATE UNIQUE INDEX "Budget_categoryId_month_currency_key"
  ON "Budget"("categoryId", "month", "currency");

-- CreateTable · AppSettings (singleton)
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabledCurrencies" "Currency"[] NOT NULL DEFAULT ARRAY['ARS']::"Currency"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_settings_singleton" CHECK ("id" = 1),
    -- `cardinality` y NO `array_length`: en un array vacío `array_length`
    -- devuelve NULL, y un CHECK que evalúa a NULL PASA. La restricción habría
    -- aceptado una lista vacía sin decir nada.
    CONSTRAINT "app_settings_at_least_one_currency"
      CHECK (cardinality("enabledCurrencies") >= 1)
);

INSERT INTO "AppSettings" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP);

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · UNA TRANSFERENCIA ENTRE MONEDAS TIENE QUE DECIR CUÁNTO LLEGA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Es un trigger y no un CHECK porque la comparación es entre DOS filas de
-- "Account". Un CHECK sólo ve la fila que se está escribiendo.
--
-- La regla es bicondicional: si las monedas difieren, "toAmount" es
-- obligatorio; si son iguales, "toAmount" tiene que ser NULL. Aceptar
-- "toAmount" en una transferencia de la misma moneda abriría la puerta a un
-- número que no significa nada y que nadie validaría después.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION check_movement_currency_shape()
RETURNS TRIGGER AS $$
DECLARE
  from_currency "Currency";
  to_currency "Currency";
BEGIN
  IF NEW."kind" <> 'TRANSFER' THEN
    RETURN NEW;
  END IF;

  -- Sin destino no hay nada que comparar: de eso se encarga el CHECK
  -- `movement_shape_by_kind`, que da un mensaje más preciso. Un trigger BEFORE
  -- corre antes que los CHECK, así que acá hay que dejarlo pasar.
  IF NEW."toAccountId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "currency" INTO from_currency FROM "Account" WHERE "id" = NEW."accountId";
  SELECT "currency" INTO to_currency   FROM "Account" WHERE "id" = NEW."toAccountId";

  IF from_currency IS DISTINCT FROM to_currency AND NEW."toAmount" IS NULL THEN
    RAISE EXCEPTION
      '[finanzas:transferencia_entre_monedas_sin_monto_destino] La cuenta de origen está en % y la de destino en %: hace falta indicar cuánto llega a la cuenta de destino.',
      from_currency, to_currency;
  END IF;

  IF from_currency = to_currency AND NEW."toAmount" IS NOT NULL THEN
    RAISE EXCEPTION
      '[finanzas:monto_destino_en_misma_moneda] Las dos cuentas están en %: el monto de destino no corresponde.',
      from_currency;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "movement_currency_shape_check"
  BEFORE INSERT OR UPDATE ON "Movement"
  FOR EACH ROW
  EXECUTE FUNCTION check_movement_currency_shape();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · LA MONEDA DE UNA CUENTA CON HISTORIA ES INMUTABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cambiar ARS → USD en una cuenta con movimientos no reescribe ninguna fila:
-- reescribe el SIGNIFICADO de todas. Los mismos 5.000 pasan a ser 5.000
-- dólares sin que nadie los haya tocado.
--
-- Mientras la cuenta no tenga historia, se puede corregir: no hay nada que
-- contradecir.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION check_account_currency_immutable()
RETURNS TRIGGER AS $$
DECLARE
  en_uso BOOLEAN;
BEGIN
  IF NEW."currency" IS NOT DISTINCT FROM OLD."currency" THEN
    RETURN NEW;
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM "Movement" m
             WHERE m."accountId" = OLD."id" OR m."toAccountId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "RecurrenceRule" r
                WHERE r."accountId" = OLD."id" OR r."toAccountId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "FavoriteTemplate" f
                WHERE f."accountId" = OLD."id" OR f."toAccountId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "CardPlan" p WHERE p."accountId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "Statement" s WHERE s."accountId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "Installment" i WHERE i."accountId" = OLD."id")
  INTO en_uso;

  IF en_uso THEN
    RAISE EXCEPTION
      '[finanzas:cuenta_en_uso_no_cambia_moneda] La cuenta «%» ya tiene historia: no se puede cambiar su moneda.',
      OLD."name";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "account_currency_immutable_check"
  BEFORE UPDATE OF "currency" ON "Account"
  FOR EACH ROW
  EXECUTE FUNCTION check_account_currency_immutable();
```

### Cambios equivalentes en `prisma/schema.prisma`

```prisma
enum Currency {
  ARS
  USD
}

model Account {
  // ...
  currency Currency @default(ARS)
  // ...
  @@unique([name, currency])
}

model Movement {
  // ...
  /// Sólo en TRANSFER entre cuentas de distinta moneda: cuánto LLEGA a la
  /// cuenta de destino, en la moneda de destino. NULL en el resto.
  toAmount Decimal? @db.Decimal(18, 2)
}

model Budget {
  // ...
  currency Currency @default(ARS)
  @@unique([categoryId, month, currency])
}

model AppSettings {
  id                Int        @id @default(1)
  enabledCurrencies Currency[] @default([ARS])
  updatedAt         DateTime   @updatedAt
}
```

---

## 4. Compatibilidad con los datos que ya existen

| Dato | Efecto |
|---|---|
| Cuentas (1 en producción, `Historial`) | `currency = 'ARS'` por el DEFAULT. |
| Movimientos (34) | `toAmount = NULL`. Ninguno es TRANSFER, así que el trigger no los toca. |
| Presupuestos | `currency = 'ARS'`. |
| `Account_name_key` → nuevo índice | No hay nombres repetidos hoy: la creación del índice no puede fallar. |
| `Budget_categoryId_month_key` → nuevo índice | Idem. |

**La migración no borra ni reescribe una sola fila.** Se puede aplicar sobre
`finanzas_test` y verificar con `npm test` antes de tocar producción.

---

## 5. Impacto en el código (esto es lo que hay que cambiar, no la migración)

### 5.1 · Consultas que hoy suman monedas distintas

| Archivo | Función | Qué cambia |
|---|---|---|
| `lib/queries.ts` | `movementTotals` | Filtra por `account: { currency }`. |
| `lib/queries.ts` | `movementCashFlow` | **Caso especial**: el término "entra" de una transferencia entre monedas tiene que usar `toAmount`, no `amount`. Un `aggregate` de Prisma no hace `COALESCE`; va con `$queryRaw` o dos consultas. |
| `lib/queries.ts` | `movementCategoryBreakdown` | Filtra por moneda: un gráfico de gastos no puede mezclar. |
| `lib/queries.ts` | `declaredIncomeInPeriod` | La banderita de saldo inicial es de una cuenta: hereda su moneda. |
| `lib/balance.ts` | `getNetWorth` | Pasa a devolver **un patrimonio por moneda**, no uno solo. Es el cambio de contrato más visible. |
| `lib/balance.ts` | `getAccountBalances` | **Sí cambió**: la pata entrante de una transferencia entre monedas acredita `toAmount`, no `amount`. Sin esto, un cambio ARS→USD acreditaba 120.000 dólares en vez de 100. |
| `lib/queries.ts` | `getMonthReconciliation` | Suma el término `transferNet`: en una sola moneda vale 0; con dos, un cambio de moneda mueve el patrimonio de cada moneda y sin restarlo la reconciliación daba `balanced: false`. |

**Contrato propuesto para `getNetWorth`:**

```ts
// antes
{ assets: Money; liabilities: Money; net: Money }

// después
{ byCurrency: Record<Currency, { assets: Money; liabilities: Money; net: Money }> }
```

Sumar dos `net` de monedas distintas para mostrar "patrimonio total" es
exactamente el número que este proyecto no quiere mostrar. Si la UI quiere un
total, tiene que pedir un tipo de cambio, y eso es una decisión de producto
aparte (ver §7).

### 5.2 · Endpoints

- `GET/POST /api/accounts`: aceptan y devuelven `currency`; `P2002` se resuelve
  por `["name","currency"]`.
- `POST /api/transactions` y `POST /api/transactions/batch`: validan
  `toAmount` con las mismas reglas que el trigger (la base es la red, no la
  única validación).
- `GET /api/reports`: parámetro `currency` (default `ARS`).
- `GET/PATCH /api/settings`: nuevo, para `enabledCurrencies`.

### 5.3 · Servicios

- `lib/card-service.ts`: una tarjeta en USD funciona sin cambios de lógica; el
  resumen y las cuotas heredan la moneda de la cuenta.
- `lib/loan-service.ts`: ídem.
- `lib/csv-import.ts`: hoy asume pesos. En v1, rechaza filas si la cuenta
  elegida no es ARS, con un mensaje claro, en vez de importar montos mal.
- `lib/voice-capture/*`: `ParseInput` suma `currencies: string[]`; `buildPrompt`
  las declara; `resolveBatch` marca aclaración `currency` si la moneda no está
  habilitada o no coincide con la cuenta resuelta. El esquema ya tiene el campo
  `currency` en `ParsedMovement`.

### 5.4 · UI

- Formulario de cuenta: selector de moneda (sólo monedas habilitadas).
- Formulario de transferencia: si origen y destino difieren en moneda, aparece
  el segundo monto ("¿cuánto llega?"). Sin ese campo, el guardar está bloqueado.
- Pantalla de configuración inicial de monedas (T4.2).
- Reportes y panel: selector de moneda; el patrimonio se muestra por moneda.

---

## 6. Tareas

| ID | Tarea | Aceptación |
|---|---|---|
| **F4.1** | Migración + `schema.prisma` + tests de integración de los 4 invariantes | Los 4 casos prohibidos fallan en la base: `toAmount` faltante entre monedas, `toAmount` en misma moneda, `toAmount` en EXPENSE, cambio de moneda con historia. |
| **F4.2** | Scoping por moneda en `queries.ts` y `balance.ts` | Un test con ARS y USD mezclados verifica que ningún total suma monedas distintas y que `getNetWorth` devuelve dos bloques. |
| **F4.3** | Endpoints de cuentas, transacciones y batch | Crear "Efectivo" ARS y "Efectivo" USD funciona; el error de nombre repetido es por moneda. |
| **F4.4** | UI: cuenta, transferencia entre monedas, configuración | No se puede guardar una transferencia entre monedas sin el segundo monto. |
| **F4.5** | Motor de voz: monedas habilitadas | El prompt no menciona monedas no habilitadas; "100 dólares" con USD apagado produce aclaración `currency`. |
| **F4.6** | (diferido) `toAmount` en `RecurrenceRule` y `FavoriteTemplate` | Sólo si el uso lo pide. |

Orden: **F4.1 → F4.2 → F4.3 → F4.4 → F4.5**. La migración sola no cambia
ningún número visible; los reportes empiezan a mentir menos recién en F4.2.

---

## 7. Riesgos y preguntas abiertas

| Riesgo | Mitigación |
|---|---|
| Algún reporte olvida filtrar por moneda y suma de más | Default explícito `ARS` en la firma de cada función, y un test con datos mixtos. |
| `P2002` mal manejado tras cambiar el índice | Test de integración del caso "mismo nombre, misma moneda" y "mismo nombre, distinta moneda". |
| El trigger de moneda inmutable bloquea una corrección legítima | Sólo bloquea si hay historia; una cuenta recién creada se corrige sin problema. |
| El tipo de cambio queda desactualizado | No se guarda: se calcula al mostrar. |
| `Budget` con moneda duplica la pantalla de presupuestos | En v1 el selector muestra sólo las monedas habilitadas; con una sola, no se ve. |

**Q1 · ¿Hace falta un patrimonio total convertido? — DECIDIDO: no.**
Se muestra **por moneda**. Un total convertido exigiría una cotización (manual o
externa) y convertiría un número honesto en uno que depende de cuándo se
actualizó esa cotización. `getNetWorth` devuelve un bloque por moneda y la UI no
inventa un total.

**Q2 · ¿ARS + USD alcanza?** El enum se extiende con una línea
(`ALTER TYPE "Currency" ADD VALUE 'BRL'`), pero cada moneda nueva necesita
formato y símbolo en la UI. Recomendación: arrancar con dos.

---

## 8. Lo que este diseño NO hace

- No convierte montos entre monedas ni guarda cotizaciones.
- No permite transferencias entre monedas desde reglas de recurrencia ni
  plantillas (D7).
- No migra la importación de CSV a otras monedas.
- No cambia la semántica de `amount`: sigue siendo siempre positivo y en la
  moneda de la cuenta de origen.
