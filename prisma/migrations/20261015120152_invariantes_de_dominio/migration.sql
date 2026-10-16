-- ═════════════════════════════════════════════════════════════════════════════
-- INVARIANTES DE DOMINIO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ ESTO VIVE EN LA BASE Y NO EN EL CÓDIGO
-- ─────────────────────────────────────────────────────────────────────────────
-- Prisma puede expresar tipos, nulabilidad y claves foráneas — pero NO puede
-- expresar reglas que dependen de VARIAS columnas a la vez. Y esas reglas son
-- justamente las que definen el modelo:
--
--   "una transferencia no puede tener categoría"
--   "un ingreso no puede tener cuenta de destino"
--
-- La tentación es validar eso sólo en la capa de aplicación. El problema es que
-- la base queda abierta a que cualquiera la escriba mal:
--
--   · un script de migración de datos (los que siempre se escriben apurados)
--   · un `prisma db push` de alguien que no leyó el esquema
--   · una consola de base de datos a las 2 de la mañana
--   · un bug en un endpoint nuevo
--
-- Y una vez que el dato quedó mal, la app tiene que aprender a convivir con el
-- error: cada consulta necesita defenderse. Eso es deuda técnica permanente.
--
-- Poniendo la regla en la BASE, el estado imposible no se puede guardar. No hay
-- nada que defender porque el dato malo nunca entró.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CÓMO LEER ESTAS RESTRICCIONES
-- ─────────────────────────────────────────────────────────────────────────────
-- Se escriben como una definición POSITIVA de cada tipo de movimiento, no como
-- una lista de prohibiciones. Definir qué ES una transferencia es más claro
-- (y más difícil de romper) que enumerar lo que no es.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. El monto es siempre positivo
-- ─────────────────────────────────────────────────────────────────────────────
-- El signo lo determina `kind`, no el número. Un EXPENSE de −500 sería un gasto
-- que suma plata: un dato que se contradice a sí mismo.
--
-- Sin esta restricción, un bug de signo en la interfaz no explotaría nunca:
-- el gasto simplemente aparecería restando al revés en los totales, y lo
-- descubrirías meses después con los números ya mal.
ALTER TABLE "Movement"
  ADD CONSTRAINT "movement_amount_positive" CHECK ("amount" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. La forma de cada movimiento depende de su tipo
-- ─────────────────────────────────────────────────────────────────────────────
--   INCOME   → entra plata a una cuenta. NO hay destino. SÍ hay categoría.
--   EXPENSE  → sale plata de una cuenta. NO hay destino. SÍ hay categoría.
--   TRANSFER → sale de una cuenta y entra a otra. NO hay categoría: una
--              transferencia entre bolsillos propios no es un gasto ni un
--              ingreso, así que categorizarla sería mentir.
--
-- La categoría obligatoria en INCOME/EXPENSE es lo que evita el "gasto sin
-- explicar": sin ella, el gráfico de gastos por categoría nunca cerraría
-- contra el total, y el usuario no tendría forma de saber por qué.
ALTER TABLE "Movement"
  ADD CONSTRAINT "movement_shape_by_kind" CHECK (
    (
      "kind" = 'TRANSFER'
      AND "toAccountId" IS NOT NULL
      AND "categoryId" IS NULL
    )
    OR
    (
      "kind" IN ('INCOME', 'EXPENSE')
      AND "toAccountId" IS NULL
      AND "categoryId" IS NOT NULL
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Una transferencia no puede ser a la misma cuenta
-- ─────────────────────────────────────────────────────────────────────────────
-- Mover plata de "Efectivo" a "Efectivo" no cambia el saldo de nada y no
-- significa nada. Si aparece, es un bug de la interfaz (dos selectores que
-- quedaron con el mismo valor), no una intención del usuario.
--
-- Sin la restricción, ese movimiento fantasma se guardaría y aparecería en el
-- historial para siempre.
ALTER TABLE "Movement"
  ADD CONSTRAINT "movement_transfer_to_other_account" CHECK (
    "toAccountId" IS NULL OR "toAccountId" <> "accountId"
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Una cuenta de pasivo no puede recibir un ingreso
-- ─────────────────────────────────────────────────────────────────────────────
-- A una cuenta de PASIVO no "entra plata": se le reduce la deuda. Recibir un
-- ingreso en un préstamo sería registrar que te pagaron por deber plata.
--
-- Lo que sí es válido, y es el corazón del modelo:
--   · TRANSFER desde el préstamo hacia tu banco  → te desembolsaron
--   · TRANSFER desde tu banco hacia el préstamo  → pagaste una cuota
--
-- Esta restricción es la que evita que alguien "arregle" el modelo tratando el
-- desembolso de un préstamo como un ingreso — que es exactamente el error que
-- producía el 49% de ahorro falso.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ ES UN TRIGGER Y NO UN CHECK
-- ─────────────────────────────────────────────────────────────────────────────
-- La regla depende de una fila de OTRA tabla (`Account.kind`), y Postgres NO
-- permite subconsultas dentro de un CHECK. La alternativa clásica es duplicar
-- `kind` en Movement con una clave foránea compuesta... que funciona, pero
-- agrega una columna redundante que hay que mantener sincronizada a mano.
--
-- El trigger es la herramienta correcta para un invariante entre tablas: se
-- ejecuta en la misma transacción que el INSERT y un `RAISE EXCEPTION` aborta
-- todo el statement. No hay ventana en la que el dato malo exista.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_movement_account_kind()
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

  IF NEW."kind" = 'INCOME' AND target_kind IN ('LOAN', 'CREDIT_CARD') THEN
    RAISE EXCEPTION
      'No se puede registrar un ingreso en una cuenta de pasivo (%). Usá una transferencia desde la cuenta de deuda hacia tu cuenta de dinero.',
      target_kind
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "movement_account_kind_check"
  BEFORE INSERT OR UPDATE ON "Movement"
  FOR EACH ROW
  EXECUTE FUNCTION check_movement_account_kind();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Un préstamo debe tener sus parámetros para poder calcular las cuotas
-- ─────────────────────────────────────────────────────────────────────────────
-- Si falta la tasa o la cantidad de cuotas, la app no puede descomponer la
-- cuota en capital e interés — y sin esa descomposición volvemos al problema
-- original: todo parece gasto.
--
-- Es mejor no poder crear un préstamo incompleto que crear uno que después
-- mienta en los totales.
ALTER TABLE "Account"
  ADD CONSTRAINT "loan_has_parameters" CHECK (
    "kind" <> 'LOAN'
    OR ("principal" IS NOT NULL AND "tnaPercent" IS NOT NULL AND "installmentCount" IS NOT NULL)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Los parámetros de préstamo no existen en cuentas que no son préstamos
-- ─────────────────────────────────────────────────────────────────────────────
-- Una cuenta de efectivo con "TNA 60%" cargada es un dato basura que va a
-- confundir a la próxima consulta que lea esos campos.
ALTER TABLE "Account"
  ADD CONSTRAINT "loan_parameters_only_on_loans" CHECK (
    "kind" = 'LOAN'
    OR ("principal" IS NULL AND "tnaPercent" IS NULL AND "installmentCount" IS NULL AND "firstInstallmentDate" IS NULL)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTA PARA LA MIGRACIÓN DE DATOS LEGADOS
-- ─────────────────────────────────────────────────────────────────────────────
-- Estas restricciones se aplican sobre una base ya limpia. Si en el futuro se
-- migran datos del esquema viejo, hay que cumplir DOS condiciones antes de
-- correr esta migración:
--
--   1. Todo movimiento necesita un `accountId`. El esquema viejo no tenía
--      cuentas, así que la migración tiene que crear una cuenta por defecto
--      (por ejemplo "Efectivo") y apuntar todo ahí.
--
--   2. Todo movimiento INCOME/EXPENSE necesita una categoría. El esquema viejo
--      la tenía obligatoria, así que ese dato ya existe — pero si algún
--      movimiento quedó con `categoryId` nulo por un borrado en cascada, hay
--      que asignarle una categoría antes.
--
-- Y una regla que NO se negocia: los movimientos viejos conservan su tipo.
-- Está prohibido reclasificar automáticamente un INCOME o un EXPENSE como
-- TRANSFER, porque no hay forma de saber si "pago de tarjeta" era el resumen
-- completo o una compra. Reclasificar mal es peor que no reclasificar: el
-- usuario puede corregir un dato, pero no puede corregir un dato que la app
-- cambió sola y no le avisó.
-- ═════════════════════════════════════════════════════════════════════════════
