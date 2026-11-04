-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Fase 4: monedas
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Aditiva: NO reescribe ninguna fila. Todas las cuentas que ya existen quedan
-- en ARS (el DEFAULT), que es lo que son. Ningún movimiento cambia de monto y
-- ninguno tiene monto de destino.
--
-- Los invariantes nuevos van con CHECK y triggers, no con validación de
-- aplicación: el mismo criterio que el resto del esquema. Un invariante que
-- sólo vive en la API es un invariante que el próximo cliente se olvida.
--
-- Diseño completo: docs/fase4-monedas.md
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ARS', 'USD');

-- AlterTable · Account
ALTER TABLE "Account" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'ARS';

-- El nombre deja de ser único global: "Efectivo" en pesos y "Efectivo" en
-- dólares son dos cuentas distintas y legítimas. Repetirlo dentro de la MISMA
-- moneda sigue estando prohibido.
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

-- ═════════════════════════════════════════════════════════════════════════════
-- 1 · UNA TRANSFERENCIA ENTRE MONEDAS TIENE QUE DECIR CUÁNTO LLEGA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Es un trigger y no un CHECK porque la comparación es entre DOS filas de
-- "Account". Un CHECK sólo ve la fila que se está escribiendo.
--
-- La regla es BICONDICIONAL: si las monedas difieren, "toAmount" es
-- obligatorio; si son iguales, tiene que ser NULL. Aceptar "toAmount" en una
-- transferencia de la misma moneda abriría la puerta a un número que no
-- significa nada y que nadie validaría después.
-- ═════════════════════════════════════════════════════════════════════════════
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

-- ═════════════════════════════════════════════════════════════════════════════
-- 2 · LA MONEDA DE UNA CUENTA CON HISTORIA ES INMUTABLE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Cambiar ARS → USD en una cuenta con movimientos no reescribe ninguna fila:
-- reescribe el SIGNIFICADO de todas. Los mismos 5.000 pasan a ser 5.000
-- dólares sin que nadie los haya tocado.
--
-- Mientras la cuenta no tenga historia, se puede corregir: no hay nada que
-- contradecir. Mismo criterio que `category_kind_immutable_check`.
-- ═════════════════════════════════════════════════════════════════════════════
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
