-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Fase 4.6: el monto de destino en reglas y plantillas
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hasta acá sólo `Movement` sabía cuánto LLEGA a la cuenta de destino en una
-- transferencia entre monedas (F4.1/F4.1b). Una REGLA o una PLANTILLA con
-- cuentas en monedas distintas no podía expresar esa segunda punta, así que la
-- API las rechazaba con un 400 y el generador las mandaba a la bandeja.
--
-- Esta migración les da el mismo campo, con la MISMA bicondicional y el MISMO
-- mecanismo —CHECK + trigger con locking reads— que custodia `Movement`:
--
--   · monedas distintas → `toAmount` obligatorio y > 0;
--   · misma moneda      → `toAmount` prohibido;
--   · INCOME / EXPENSE  → `toAmount` prohibido (no hay segunda punta).
--
-- Aditiva: no reescribe ninguna fila. Las reglas y plantillas que ya existen
-- quedan con `toAmount = NULL`, que es exactamente lo que son (en su enorme
-- mayoría, transferencias de la misma moneda o movimientos de una sola punta).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · LAS COLUMNAS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "RecurrenceRule" ADD COLUMN "toAmount" DECIMAL(18,2);
ALTER TABLE "FavoriteTemplate" ADD COLUMN "toAmount" DECIMAL(18,2);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · LOS CHECK (la parte que NO necesita leer otra tabla)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Los mismos dos criterios que `movement_to_amount_positive` y
-- `movement_to_amount_only_on_transfer`, con el prefijo de cada tabla. Un
-- `toAmount` de 0 diría que a la cuenta de destino no llegó nada, y en una
-- transferencia eso no es un dato: es una contradicción. Uno en un gasto o un
-- ingreso no tiene segunda punta que signifique.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_to_amount_positive"
  CHECK ("toAmount" IS NULL OR "toAmount" > 0);

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_to_amount_only_on_transfer"
  CHECK ("kind" = 'TRANSFER' OR "toAmount" IS NULL);

ALTER TABLE "FavoriteTemplate"
  ADD CONSTRAINT "favorite_to_amount_positive"
  CHECK ("toAmount" IS NULL OR "toAmount" > 0);

ALTER TABLE "FavoriteTemplate"
  ADD CONSTRAINT "favorite_to_amount_only_on_transfer"
  CHECK ("kind" = 'TRANSFER' OR "toAmount" IS NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · LOS TRIGGERS (la bicondicional contra `Account.currency`)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tiene que ser un trigger y no un CHECK: la comparación es entre DOS filas de
-- "Account", y un CHECK sólo ve la fila que se está escribiendo.
--
-- Mismo patrón que `20261104130000_fase4_monedas_concurrencia`:
--
--   · locking reads `FOR SHARE` sobre las dos cuentas, en orden de `id` (sin el
--     `ORDER BY`, dos reglas en direcciones opuestas podrían tomar las filas en
--     orden inverso y bloquearse mutuamente);
--   · así, si un `UPDATE` de moneda está en vuelo, acá se espera y después se
--     lee el valor NUEVO. El trigger de la cuenta, a su vez, sube el lock a
--     `FOR UPDATE` y su chequeo de historia ve la regla ya commiteada. No hay
--     interleaving en el que las dos pasen.
--
-- Los marcadores son NUEVOS y por tabla: un test (o un log) tiene que poder
-- distinguir un rechazo de la regla de uno de la plantilla sin adivinar por el
-- nombre de la tabla en el mensaje de Postgres.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION check_recurrence_currency_shape()
RETURNS TRIGGER AS $$
DECLARE
  from_currency "Currency";
  to_currency "Currency";
BEGIN
  IF NEW."kind" <> 'TRANSFER' THEN
    RETURN NEW;
  END IF;

  -- Sin destino no hay nada que comparar: de eso se encarga el CHECK
  -- `recurrence_shape_by_kind`, que da un mensaje más preciso. Un trigger
  -- BEFORE corre antes que los CHECK, así que acá hay que dejarlo pasar.
  IF NEW."toAccountId" IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM "Account"
   WHERE "id" IN (NEW."accountId", NEW."toAccountId")
   ORDER BY "id"
     FOR SHARE;

  SELECT "currency" INTO from_currency FROM "Account" WHERE "id" = NEW."accountId";
  SELECT "currency" INTO to_currency   FROM "Account" WHERE "id" = NEW."toAccountId";

  IF from_currency IS DISTINCT FROM to_currency AND NEW."toAmount" IS NULL THEN
    RAISE EXCEPTION
      '[finanzas:regla_transferencia_entre_monedas_sin_monto_destino] La cuenta de origen está en % y la de destino en %: hace falta indicar cuánto llega a la cuenta de destino.',
      from_currency, to_currency;
  END IF;

  IF from_currency = to_currency AND NEW."toAmount" IS NOT NULL THEN
    RAISE EXCEPTION
      '[finanzas:regla_monto_destino_en_misma_moneda] Las dos cuentas están en %: el monto de destino no corresponde.',
      from_currency;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "recurrence_currency_shape_check"
  BEFORE INSERT OR UPDATE ON "RecurrenceRule"
  FOR EACH ROW
  EXECUTE FUNCTION check_recurrence_currency_shape();

CREATE OR REPLACE FUNCTION check_favorite_currency_shape()
RETURNS TRIGGER AS $$
DECLARE
  from_currency "Currency";
  to_currency "Currency";
BEGIN
  IF NEW."kind" <> 'TRANSFER' THEN
    RETURN NEW;
  END IF;

  IF NEW."toAccountId" IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM "Account"
   WHERE "id" IN (NEW."accountId", NEW."toAccountId")
   ORDER BY "id"
     FOR SHARE;

  SELECT "currency" INTO from_currency FROM "Account" WHERE "id" = NEW."accountId";
  SELECT "currency" INTO to_currency   FROM "Account" WHERE "id" = NEW."toAccountId";

  IF from_currency IS DISTINCT FROM to_currency AND NEW."toAmount" IS NULL THEN
    RAISE EXCEPTION
      '[finanzas:plantilla_transferencia_entre_monedas_sin_monto_destino] La cuenta de origen está en % y la de destino en %: hace falta indicar cuánto llega a la cuenta de destino.',
      from_currency, to_currency;
  END IF;

  IF from_currency = to_currency AND NEW."toAmount" IS NOT NULL THEN
    RAISE EXCEPTION
      '[finanzas:plantilla_monto_destino_en_misma_moneda] Las dos cuentas están en %: el monto de destino no corresponde.',
      from_currency;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "favorite_currency_shape_check"
  BEFORE INSERT OR UPDATE ON "FavoriteTemplate"
  FOR EACH ROW
  EXECUTE FUNCTION check_favorite_currency_shape();
