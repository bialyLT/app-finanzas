-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · La categoría pasa a ser OPCIONAL en gastos e ingresos
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ
-- ─────────────────────────────────────────────────────────────────────────────
-- La migración `invariantes_de_dominio` exigió `categoryId IS NOT NULL` en todo
-- INCOME/EXPENSE con un argumento correcto: evitar el "gasto sin explicar".
--
-- La Fase 7 midió ese argumento contra el uso real y encontró el costo: cargar
-- la compra del kiosco —la operación MÁS frecuente de la app— obligaba a
-- inventar una categoría antes de guardar. Un campo obligatorio que se completa
-- con basura ("Varios", "Otros") no clasifica nada: ensucia el gráfico igual y
-- además agrega un paso a cada carga.
--
-- La categoría sigue existiendo, sigue siendo la misma columna y el mismo
-- gráfico — que YA sabe mostrarla ausente: `movementCategoryBreakdown` agrupa el
-- `categoryId = NULL` bajo "Sin categoría" desde el primer día. Lo único que
-- cambia es que la base deja de exigirla al INSERT.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LO QUE NO CAMBIA
-- ─────────────────────────────────────────────────────────────────────────────
--   · Una TRANSFER sigue SIN categoría y CON cuenta de destino. Eso no se
--     negocia: categorizar una transferencia la contaría en el gráfico de
--     gastos, que es el bug que el modelo existe para impedir.
--   · Un INCOME/EXPENSE sigue SIN cuenta de destino.
--   · Las REGLAS DE RECURRENCIA no se tocan: `recurrence_shape_by_kind` (otro
--     CHECK, en otra tabla) sigue exigiendo categoría. Una regla es una promesa
--     a futuro y ahí la categoría es parte del contrato; un movimiento suelto es
--     un hecho y se puede anotar sin clasificar.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ DROP + ADD Y NO `ALTER ... SET (…)`
-- ─────────────────────────────────────────────────────────────────────────────
-- Los CHECK no se editan: se reemplazan. El nombre se conserva
-- (`movement_shape_by_kind`) porque es el marcador estable que
-- `describeDatabaseError` usa para traducir la violación a un 400 explicativo
-- (ver lib/queries.ts, DOMAIN_RULES).
--
-- Los datos existentes ya cumplen la condición nueva: toda fila que hoy pasa el
-- CHECK viejo pasa el nuevo (el CHECK nuevo es estrictamente más permisivo).
-- La migración no toca ninguna fila.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "Movement" DROP CONSTRAINT "movement_shape_by_kind";

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
    )
  );
