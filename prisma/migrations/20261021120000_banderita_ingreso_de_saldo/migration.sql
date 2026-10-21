-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · La banderita de "esta plata cuenta como ingreso de este mes"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- QUÉ ES
--
-- `Account.openingIncomeMonth` es el MES (el primer día, en calendario) en el
-- que el saldo inicial de esa cuenta cuenta como INGRESO.
--
-- NULL = la bandera apagada = el comportamiento de siempre: el saldo inicial es
-- un STOCK (la plata que ya tenías antes de empezar a usar la app) y no entra en
-- los ingresos de ningún mes. Es lo que hace que esta migración NO mueva
-- ningún número: las cuentas que ya existen quedan con la bandera apagada, que
-- es exactamente su comportamiento actual.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL CANDADO (por qué un CHECK y no sólo la app)
--
-- La regla que la app valida es una regla de la BASE, y la base tiene que
-- custodiarla: si mañana un script, un `prisma db push` o una consola SQL
-- escribe la columna a mano, la fila que sale es una mentira.
--
-- La regla es: la plata declarada como ingreso sólo existe en una cuenta de
-- DINERO (CASH/BANK) y sólo si el saldo es POSITIVO.
--
--   · Una cuenta de deuda (LOAN, CREDIT_CARD) no tiene plata propia: su saldo
--     negativo es la DEUDA, y una deuda no es un ingreso. Contarla como ingreso
--     inflaría el mes con plata que el usuario no recibió.
--   · Un saldo NEGATIVO en una cuenta de dinero es, por el mismo motivo, un
--     pasivo: no entra en los ingresos.
--
-- OJO CON POR QUÉ UN CHECK Y NO UN TRIGGER: acá la regla depende de columnas
-- de la MISMA fila (`kind` y `openingBalance`), y un CHECK puede mirar
-- columnas de la fila que se está insertando. No hace falta una subconsulta
-- (que es lo que obliga a usar un trigger, como en la migración de
-- `20261020120000_invariante_categoria_movimiento`).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LO QUE NO TOCA ESTA MIGRACIÓN
--
-- No reescribe NI UNA fila. Sólo agrega una columna (nullable, sin default:
-- las cuentas que ya existen quedan con la bandera apagada) y su candado.
-- ═════════════════════════════════════════════════════════════════════════════

-- La columna: nullable, sin default. `DATE` (y no `TIMESTAMP`) porque es un
-- mes de CALENDARIO: el primer día del mes, sin hora ni zona.
ALTER TABLE "Account" ADD COLUMN "openingIncomeMonth" DATE;

-- El candado. `openingIncomeMonth IS NULL` → la bandera apagada, y la fila es
-- válida (es el caso de todas las cuentas que ya existían).
ALTER TABLE "Account"
  ADD CONSTRAINT "account_opening_income_month_check"
  CHECK (
    "openingIncomeMonth" IS NULL
    OR (
      "kind" IN ('CASH', 'BANK')
      AND "openingBalance" > 0
    )
  );
