-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Plantillas / favoritos de carga rápida (Fase 7 ronda 2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Una plantilla es un formulario guardado, NO un movimiento ni una regla de
-- recurrencia. No tiene fecha, no entra en totales y no la toca el generador.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ TABLA PROPIA
-- ─────────────────────────────────────────────────────────────────────────────
-- `RecurrenceRule` describe un calendario (frecuencia, ancla, fin, posteo) y
-- exige una categoría en INCOME/EXPENSE. Un favorito no vence ni necesita
-- categoría: reutilizar esa tabla obligaría a inventar una frecuencia y a
-- mezclar favoritos con ocurrencias pendientes. La tabla propia mantiene las
-- dos semánticas separadas.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOS CANDADOS (mismos criterios que el resto del esquema)
-- ─────────────────────────────────────────────────────────────────────────────
--   · `normalizedName` UNIQUE: no puede haber dos "Café" / "cafe" (single-user).
--   · `favorite_shape_by_kind`: TRANSFER exige destino distinto y prohíbe
--     categoría; INCOME/EXPENSE prohíben destino. Es la misma forma que
--     `movement_shape_by_kind`, para que un favorito no pueda describir un
--     movimiento imposible.
--   · `favorite_amount_positive`: NULL significa "sin monto"; 0 o negativo no
--     es un monto válido en este modelo.
--   · Largos acotados en la base: nombre 1..40 y descripción <= 200, los mismos
--     límites que valida la API.
--
-- El tope de 24 plantillas es de aplicación (API): un CHECK no puede contar
-- filas. Se documenta y se prueba en la ruta.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "FavoriteTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "amount" DECIMAL(18,2),
    "description" TEXT NOT NULL DEFAULT '',
    "categoryId" TEXT,
    "accountId" TEXT NOT NULL,
    "toAccountId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FavoriteTemplate_pkey" PRIMARY KEY ("id")
);

-- Un nombre normalizado = una plantilla. Single-user: no hay userId que exija
-- un índice compuesto.
CREATE UNIQUE INDEX "FavoriteTemplate_normalizedName_key"
    ON "FavoriteTemplate"("normalizedName");

-- La lista de favoritos se ordena por último uso y se filtra por tipo.
CREATE INDEX "FavoriteTemplate_lastUsedAt_idx"
    ON "FavoriteTemplate"("lastUsedAt");
CREATE INDEX "FavoriteTemplate_kind_idx"
    ON "FavoriteTemplate"("kind");

-- Las cuentas son comodidad, no historia: si una cuenta se borra (sólo puede
-- pasar si no tiene movimientos), sus plantillas ya no sirven y se van con ella.
-- La categoría, en cambio, es opcional: borrarla deja el favorito sin categoría.
ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "FavoriteTemplate_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "FavoriteTemplate_toAccountId_fkey"
    FOREIGN KEY ("toAccountId") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "FavoriteTemplate_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Los límites que la API valida también quedan escritos en la base. Si mañana
-- otra ruta (o un script) escribe sin pasar por la API, el dato no puede quedar
-- fuera de forma.
ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "favorite_name_valid" CHECK (
        char_length(btrim("name")) BETWEEN 1 AND 40
        AND char_length(btrim("normalizedName")) BETWEEN 1 AND 40
    );

ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "favorite_description_length" CHECK (
        char_length("description") <= 200
    );

ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "favorite_amount_positive" CHECK (
        "amount" IS NULL OR "amount" > 0
    );

ALTER TABLE "FavoriteTemplate"
    ADD CONSTRAINT "favorite_shape_by_kind" CHECK (
        (
            "kind" = 'TRANSFER'
            AND "toAccountId" IS NOT NULL
            AND "toAccountId" <> "accountId"
            AND "categoryId" IS NULL
        )
        OR
        (
            "kind" IN ('INCOME', 'EXPENSE')
            AND "toAccountId" IS NULL
        )
    );
