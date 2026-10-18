-- ═══════════════════════════════════════════════════════════════════════════
-- PRÉSTAMOS — FASE 4 · PARTE 2: EL CRONOGRAMA Y LAS INVARIANTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La parte 1 (migración anterior) agregó el valor RECEIVABLE al enum y creó
-- AmortizationSystem. Acá se usa: la columna nueva, la tabla del cronograma
-- materializado, los CHECKs y el trigger actualizado.
--
-- Mismo criterio que las migraciones anteriores: el estado imposible no se
-- puede guardar. Las validaciones de la API existen para dar mensajes claros;
-- las de acá existen para que ni un script, ni una consola SQL, ni un camino
-- futuro de la app puedan dejar la base describiendo un contrato que no es.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "amortizationSystem" "AmortizationSystem";

-- CreateTable
CREATE TABLE "Installment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "payment" DECIMAL(18,2) NOT NULL,
    "interest" DECIMAL(18,2) NOT NULL,
    "principal" DECIMAL(18,2) NOT NULL,
    "remainingBalance" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Installment_accountId_dueDate_idx" ON "Installment"("accountId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Installment_accountId_number_key" ON "Installment"("accountId", "number");

-- AddForeignKey
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- INVARIANTES DE LOS PRÉSTAMOS
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- Account · los parámetros del préstamo, ahora también para RECEIVABLE
-- ───────────────────────────────────────────────────────────────────────────
-- `loan_has_parameters` se REDEFINE (mismo nombre, mismo marcador de error en
-- la API) para cubrir las dos cuentas de préstamo — LOAN (yo debo) y
-- RECEIVABLE (me deben) — y para admitir UNA excepción de tasa: el sistema
-- IMPORTED. Un cronograma importado no tiene tasa de la que derivar nada: la
-- composición la dicta el documento externo. Los cuatro sistemas calculados
-- siguen exigiendo tnaPercent, sin excepción.
--
-- La comparación contra 'IMPORTED' usa IS NOT DISTINCT FROM, no `=`: con el
-- operador normal, una cuenta legada sin sistema (NULL = francés por defecto)
-- hace que `NULL = 'IMPORTED'` dé NULL, y un CHECK que da NULL SE CUMPLE — el
-- préstamo sin tasa se colaría. Con IS NOT DISTINCT FROM, NULL cae del lado
-- "no es IMPORTED" y la tasa vuelve a exigirse.
--
-- `firstInstallmentDate` NO entra en la restricción a propósito: es necesaria
-- para materializar el cronograma (la API la exige al crear), pero las cuentas
-- creadas antes de esta fase no la tienen y un CHECK retroactivo las dejaría
-- fuera de la base. La defensa de esos datos es la lectura (`systemOf`,
-- cronograma `null`), no un CHECK que rompería el pasado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "Account" DROP CONSTRAINT "loan_has_parameters";

ALTER TABLE "Account"
  ADD CONSTRAINT "loan_has_parameters" CHECK (
    "kind" NOT IN ('LOAN', 'RECEIVABLE')
    OR (
      "principal" IS NOT NULL
      AND "installmentCount" IS NOT NULL
      AND ("tnaPercent" IS NOT NULL OR "amortizationSystem" IS NOT DISTINCT FROM 'IMPORTED')
    )
  );

-- Los parámetros de préstamo no existen en cuentas que no son préstamos:
-- una cuenta de efectivo con "TNA 60%" cargada es un dato basura que va a
-- confundir a la próxima consulta que lea esos campos. Ahora la regla cubre
-- también `amortizationSystem`: un sistema de amortización en una caja de
-- ahorro sería una promesa vacía.
ALTER TABLE "Account" DROP CONSTRAINT "loan_parameters_only_on_loans";

ALTER TABLE "Account"
  ADD CONSTRAINT "loan_parameters_only_on_loans" CHECK (
    "kind" IN ('LOAN', 'RECEIVABLE')
    OR (
      "principal" IS NULL
      AND "tnaPercent" IS NULL
      AND "installmentCount" IS NULL
      AND "firstInstallmentDate" IS NULL
      AND "amortizationSystem" IS NULL
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Installment · la cuota del contrato
-- ───────────────────────────────────────────────────────────────────────────
-- La cuota se define POSITIVAMENTE: número desde 1, pago > 0 (una cuota de
-- cero no es una cuota), interés y capital no negativos, y la identidad que
-- descompone la cuota — `payment = interest + principal` — exigida al centavo
-- porque ES el modelo: lo que se paga es, exactamente, costo real (interés) +
-- amortización (capital). Sin esta identidad, sumar el interés de las cuotas
-- cubiertas (la definición de la Fase 6) mediría algo que no coincide con lo
-- que se pagó.
--
-- El saldo del contrato nunca es negativo: un cronograma que "debe" al revés
-- describe una quita disfrazada, no un préstamo.
--
-- NOTA sobre el rotativo: en INTEREST_ONLY todas las cuotas tienen capital 0 y
-- `remainingBalance` queda en el capital original — la única excepción a
-- "cierra a 0". Los CHECKs la admiten porque es un contrato posible y real
-- (línea de crédito rotativa); la diferencia se documenta en `lib/loans.ts`,
-- no se prohíbe en la base.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_number_positive" CHECK ("number" >= 1);

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_payment_positive" CHECK ("payment" > 0);

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_interest_nonnegative" CHECK ("interest" >= 0);

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_principal_nonnegative" CHECK ("principal" >= 0);

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_split_matches_payment" CHECK (
    "payment" = "interest" + "principal"
  );

ALTER TABLE "Installment"
  ADD CONSTRAINT "installment_remaining_nonnegative" CHECK (
    "remainingBalance" >= 0
  );

-- ───────────────────────────────────────────────────────────────────────────
-- El trigger de la cuenta de origen, extendido a RECEIVABLE
-- ───────────────────────────────────────────────────────────────────────────
-- La regla de la Fase 2 ("a una cuenta de pasivo no le 'entra plata', se le
-- reduce la deuda") ahora cubre tres kinds. El tercero —RECEIVABLE— tiene su
-- propio matiz que el mensaje explica: a la cuenta que te deben tampoco le
-- "entra un ingreso"; el interés que cobrás es un ingreso real, pero entra a
-- tu cuenta de dinero (la plata que te dan), y el capital que te devuelven es
-- una transferencia. Registrar un ingreso EN la cuenta por cobrar inflaría un
-- activo sin que haya entrado un peso.
--
-- El marcador `[finanzas:pasivo_no_recibe_ingreso]` se CONSERVA (es el
-- identificador estable que mapea `DOMAIN_RULES`): sólo cambia el texto, que
-- es para la persona.
--
-- OJO CON EL NOMBRE: desde la migración de recurrencia, esta función se llama
-- `check_no_income_on_liability_account` — el renombre de `20261017144659` dejó
-- dicho que la usan DOS tablas (Movement y RecurrenceRule, que comparten el
-- nombre de columna `accountId`). Redefinir el nombre viejo
-- (`check_movement_account_kind`) compila igual, pero crearía una función
-- MUERTA y la regla real seguiría sin conocer RECEIVABLE. Por eso acá se
-- redefine el nombre vivo: los dos triggers existentes apuntan a la función
-- por OID, así que quedan extendidos de una sola vez.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_no_income_on_liability_account()
RETURNS TRIGGER AS $$
DECLARE
  target_kind "AccountKind";
BEGIN
  SELECT a."kind" INTO target_kind
  FROM "Account" a
  WHERE a."id" = NEW."accountId";

  -- Si la cuenta no existe, la clave foránea ya va a rechazar el INSERT.
  IF target_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."kind" = 'INCOME'
     AND target_kind IN ('LOAN', 'CREDIT_CARD', 'RECEIVABLE') THEN
    RAISE EXCEPTION
      '[finanzas:pasivo_no_recibe_ingreso] No se puede registrar un ingreso en una cuenta de deuda ni en un préstamo que diste (%). Usá una transferencia desde la cuenta de deuda hacia tu cuenta de dinero; el interés cobrado es un ingreso, pero entra a tu cuenta de dinero.',
      target_kind
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
