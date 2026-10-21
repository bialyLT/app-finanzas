-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · El tipo del movimiento tiene que ser el de su categoría
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL INVARIANTE QUE EL PROYECTO DECLARABA TENER Y NO TENÍA
--
-- En este proyecto una categoría de INCOME no puede acompañar a un EXPENSE (ni
-- al revés): "Alquiler" es un gasto, "Sueldo" es un ingreso, y un ingreso
-- clasificado como "Alquiler" es un dato que se contradice a sí mismo.
--
-- El esquema lo daba por hecho y NADA lo custodial:
--
--   · la API `POST /api/transactions` resolvía la categoría con un `upsert` de
--     `update: {}` (la categoría conserva su tipo) y guardaba el movimiento con
--     la categoría equivocada sin comparar nada;
--   · la base no tenía el candado: los CHECK de "Movement" son tres
--     (`movement_amount_positive`, `movement_shape_by_kind`,
--     `movement_transfer_to_other_account`) y ninguno mira el tipo de la
--     categoría — un CHECK no puede, porque necesitaría una subconsulta;
--   · el generador (`lib/recurring.ts`) copiaba `rule.kind` y `rule.categoryId`
--     tal cual, sin cruzarlos.
--
-- O sea: el invariante que el proyecto dice tener en la base NO EXISTÍA. La
-- fila que lo viola (un INCOME de 325.000 con la categoría de gasto "Alquiler")
-- entró sin que nadie la frenara.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ UN TRIGGER Y NO UN CHECK
--
-- La regla depende de una fila de OTRA tabla (`Category.kind`), y Postgres NO
-- permite subconsultas dentro de un CHECK. Es el mismo motivo del trigger que
-- ya existe para "una cuenta de pasivo no recibe ingresos" (ver
-- `20261015120152_invariantes_de_dominio`): el trigger es la herramienta
-- correcta para un invariante entre tablas, y se ejecuta en la misma
-- transacción que el INSERT, así que no hay ventana en la que el dato malo
-- exista.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LAS CUATRO REGLAS DE ESTA MIGRACIÓN
--
--   1. MOVIMIENTO: el tipo del movimiento tiene que coincidir con el de su
--      categoría (INCOME↔INCOME, EXPENSE↔EXPENSE).
--   2. REGLA: lo mismo para la regla de recurrencia y su categoría. La regla es
--      la PROMESA de un movimiento: si la promesa es imposible, el generador
--      no puede postear nunca y el fallo aparece meses después, en la bandeja.
--   3. CATEGORÍA: el tipo de una categoría que ya está en uso es INMUTABLE.
--      Si se pudiera cambiar, todos los movimientos que la usan quedarían
--      contradiciéndola de un plumazo — y el error no lo cometió nadie: lo
--      cometió un cambio de tipo.
--   4. TRANSFERENCIA: sin categoría (ya lo exige `movement_shape_by_kind`).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA FILA QUE YA VIOLA EL INVARIANTE (NO SE TOCA)
--
-- Hay un INCOME de 325.000 con la categoría de gasto "Alquiler". Los triggers
-- no se disparan sobre las filas que ya existen, así que la migración no la
-- rompe — pero tampoco la arregla: es dato de la persona y la persona decide.
--
-- Por eso el trigger de "Movement" NO revalida un UPDATE que no cambia ni el
-- tipo ni la categoría: una actualización legítima de esa fila (cambiarle la
-- descripción, por ejemplo) tiene que poder pasar. Lo que NO se puede es
-- cambiar su tipo o su categoría a algo que siga contradiciéndose.
--
-- Y la categoría "Alquiler" tampoco se puede cambiar de tipo (regla 3): está en
-- uso, y cambiarla dejaría el resto de sus movimientos contradiciéndola.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · EL MOVIMIENTO Y SU CATEGORÍA
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_movement_category_kind()
RETURNS TRIGGER AS $$
DECLARE
  target_name TEXT;
  target_kind "CategoryKind";
BEGIN
  -- Sin categoría no hay nada que cruzar. Y una TRANSFERENCIA no lleva
  -- categoría: lo exige el CHECK `movement_shape_by_kind`.
  IF NEW."categoryId" IS NULL OR NEW."kind" = 'TRANSFER' THEN
    RETURN NEW;
  END IF;

  -- En un UPDATE que no toca el tipo ni la categoría NO se revalida: así una
  -- fila que ya viene de antes (y que hoy contradice la regla) se puede
  -- actualizar sin quedar trancada. Lo que no se puede es cambiar su tipo o su
  -- categoría a algo que siga contradiciéndose.
  IF TG_OP = 'UPDATE'
     AND NEW."kind" = OLD."kind"
     AND NEW."categoryId" IS NOT DISTINCT FROM OLD."categoryId" THEN
    RETURN NEW;
  END IF;

  SELECT c."kind", c."name" INTO target_kind, target_name
  FROM "Category" c
  WHERE c."id" = NEW."categoryId";

  -- Si la categoría no existe, la clave foránea ya va a rechazar el INSERT.
  IF target_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF target_kind::TEXT <> NEW."kind"::TEXT THEN
    RAISE EXCEPTION
      '[finanzas:categoria_no_corresponde] La categoría «%» es de tipo % y no puede clasificar un %.',
      target_name,
      CASE target_kind WHEN 'INCOME' THEN 'Ingreso' ELSE 'Gasto' END,
      CASE NEW."kind" WHEN 'INCOME' THEN 'Ingreso' ELSE 'Gasto' END
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "movement_category_kind_check"
  BEFORE INSERT OR UPDATE ON "Movement"
  FOR EACH ROW
  EXECUTE FUNCTION check_movement_category_kind();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · LA REGLA DE RECURRENCIA Y SU CATEGORÍA
--
-- La regla es la promesa de un movimiento: si su tipo y el de su categoría se
-- contradicen, TODOS los movimientos que postee serían imposibles. Bloquearlo
-- acá es avisar en el momento de cargar la regla, y no meses después en la
-- bandeja de ocurrencias.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_recurrence_category_kind()
RETURNS TRIGGER AS $$
DECLARE
  target_name TEXT;
  target_kind "CategoryKind";
BEGIN
  IF NEW."categoryId" IS NULL OR NEW."kind" = 'TRANSFER' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."kind" = OLD."kind"
     AND NEW."categoryId" IS NOT DISTINCT FROM OLD."categoryId" THEN
    RETURN NEW;
  END IF;

  SELECT c."kind", c."name" INTO target_kind, target_name
  FROM "Category" c
  WHERE c."id" = NEW."categoryId";

  IF target_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF target_kind::TEXT <> NEW."kind"::TEXT THEN
    RAISE EXCEPTION
      '[finanzas:regla_categoria_no_corresponde] La regla es de tipo % pero su categoría «%» es de tipo %: no puede postear ese movimiento.',
      CASE NEW."kind" WHEN 'INCOME' THEN 'Ingreso' ELSE 'Gasto' END,
      target_name,
      CASE target_kind WHEN 'INCOME' THEN 'Ingreso' ELSE 'Gasto' END
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "recurrence_category_kind_check"
  BEFORE INSERT OR UPDATE ON "RecurrenceRule"
  FOR EACH ROW
  EXECUTE FUNCTION check_recurrence_category_kind();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · EL TIPO DE UNA CATEGORÍA EN USO ES INMUTABLE
--
-- "En uso" significa que algo la referencia: un movimiento, una regla de
-- recurrencia o una plantilla. Cambiarle el tipo a una categoría en uso
-- dejaría a TODOS esos movimientos contradiciéndola, y nadie los reescribió:
-- el cambio de tipo los volvería falsos de un plumazo.
--
-- Mientras la categoría no la use nadie, el tipo se puede cambiar: no hay nada
-- que contradecir.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_category_kind_immutable()
RETURNS TRIGGER AS $$
DECLARE
  en_uso BOOLEAN;
BEGIN
  IF NEW."kind" IS NOT DISTINCT FROM OLD."kind" THEN
    RETURN NEW;
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM "Movement" m WHERE m."categoryId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "RecurrenceRule" r WHERE r."categoryId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "FavoriteTemplate" f WHERE f."categoryId" = OLD."id")
  INTO en_uso;

  IF en_uso THEN
    RAISE EXCEPTION
      '[finanzas:categoria_en_uso_no_cambia_tipo] La categoría «%» ya está en uso: no se puede cambiar su tipo.',
      OLD."name"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "category_kind_immutable_check"
  BEFORE UPDATE OF "kind" ON "Category"
  FOR EACH ROW
  EXECUTE FUNCTION check_category_kind_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTA
--
-- Esta migración no reescribe ninguna fila: sólo agrega tres triggers. Los
-- datos que ya están (incluida la fila que hoy contradice el invariante)
-- quedan exactamente como están, y la decisión sobre esa fila es de la
-- persona, no de una migración.
-- ═════════════════════════════════════════════════════════════════════════════
