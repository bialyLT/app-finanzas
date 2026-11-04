-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Fase 4: la bicondicional de monedas también bajo concurrencia
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL AGUJERO QUE ESTA MIGRACIÓN CIERRA
-- ─────────────────────────────────────────────────────────────────────────────
-- Los triggers de `20261104120000_fase4_monedas` validaban la bicondicional
-- leyendo `Account.currency` con el snapshot de la sentencia, ANTES de que la
-- FK tomara su `FOR KEY SHARE`. Ese lock es COMPATIBLE con el que necesita un
-- `UPDATE` de moneda: las dos transacciones podían commitear y dejar una fila
-- imposible.
--
-- El caso concreto, reproducido con dos conexiones:
--
--   1. Tx A inserta ARS→USD con toAmount.
--   2. Tx B cambia la moneda de la cuenta destino a ARS, leyendo "sin
--      movimientos" ANTES de que A commitee.
--   3. Las dos commitean.
--
--   Resultado: una transferencia USD→USD CON toAmount. `getAccountBalances`
--   acredita el `amount` (rama misma moneda): la fila dice que llegaron 10 USD
--   y el saldo sube 1.000.
--
--   Y al revés: ARS→ARS sin toAmount que termina ARS→USD, donde salen 1.000
--   pesos y al destino le llegan 0 dólares. La plata desaparece.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL ARREGLO
-- ─────────────────────────────────────────────────────────────────────────────
-- Locking reads que sí se pelean:
--
--   · el trigger del movimiento toma `FOR SHARE` sobre las DOS cuentas, en
--     orden de `id` (para que dos transferencias en direcciones opuestas no se
--     abracen en un deadlock);
--   · el trigger de la cuenta sube el lock a `FOR UPDATE` sobre su propia fila,
--     que conflictúa con el `FOR KEY SHARE` de un INSERT de movimiento en
--     vuelo.
--
-- Gane quien gane, el que pierde espera y después lee el estado commiteado:
-- o rechaza por la bicondicional, o rechaza por "la cuenta ya tiene historia".
-- No hay interleaving en el que las dos pasen.
--
-- `CREATE OR REPLACE FUNCTION` alcanza: los triggers ya apuntan al nombre.
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

  IF NEW."toAccountId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Locking read ANTES de leer las monedas. Si un `UPDATE` de moneda está en
  -- vuelo, acá se espera y después se lee el valor NUEVO. El `ORDER BY "id"`
  -- es el orden canónico de adquisición: sin él, dos transferencias cruzadas
  -- podrían tomar las filas en orden inverso y bloquearse mutuamente.
  PERFORM 1 FROM "Account"
   WHERE "id" IN (NEW."accountId", NEW."toAccountId")
   ORDER BY "id"
     FOR SHARE;

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

CREATE OR REPLACE FUNCTION check_account_currency_immutable()
RETURNS TRIGGER AS $$
DECLARE
  en_uso BOOLEAN;
BEGIN
  IF NEW."currency" IS NOT DISTINCT FROM OLD."currency" THEN
    RETURN NEW;
  END IF;

  -- Sube el lock de esta fila a exclusivo. Si un INSERT de movimiento está en
  -- vuelo, su FK tiene un `FOR KEY SHARE` y este `FOR UPDATE` lo espera: cuando
  -- vuelve, el EXISTS de abajo ve la fila ya commiteada.
  PERFORM 1 FROM "Account" WHERE "id" = OLD."id" FOR UPDATE;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- CAPTURA (defensa en profundidad)
-- ─────────────────────────────────────────────────────────────────────────────
-- Los triggers corren en READ COMMITTED: las locking reads cierran la ventana
-- conocida, pero si una transacción cambia su aislamiento a REPEATABLE READ el
-- snapshot es fijo y la ventana vuelve. Este índice no arregla eso; lo que hace
-- es que el EXISTS de historia sobre `Movement` no dependa de un scan grande.
--
-- Ya existen `Movement_accountId_date_idx` y `Movement_toAccountId_date_idx`
-- (F0), así que no hace falta uno nuevo. Esta sección queda como nota para que
-- nadie lo "optimice" duplicándolo.
