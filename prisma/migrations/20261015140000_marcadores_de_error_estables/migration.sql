-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN · Marcadores de error estables
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL PROBLEMA QUE ESTA MIGRACIÓN ARREGLA
-- ─────────────────────────────────────────────────────────────────────────────
-- La migración `invariantes_de_dominio` agregó las restricciones que hacen que
-- la base rechace datos imposibles. Están bien: rechazan. El problema es CÓMO
-- llega el rechazo a la aplicación.
--
-- La primera versión de `describeDatabaseError` (lib/queries.ts) leía el mensaje
-- de Postgres desde `error.meta.message`. Funciona para los errores que Prisma
-- reconoce —las claves únicas, las claves foráneas— pero NO para los que no,
-- y el trigger de "un pasivo no recibe ingresos" cae en ese segundo grupo.
--
-- Lo que llega de verdad, verificado contra el servidor real:
--
--     Error occurred during query execution:
--     ConnectorError(ConnectorError {
--       user_facing_error: None,
--       kind: QueryError(PostgresError { code: "23514", message: "No se puede...", ... })
--     })
--
-- `user_facing_error: None` significa que Prisma NO armó un error con `code` ni
-- con `meta`. El texto de Postgres queda embebido en el mensaje del error, y
-- `meta.message` es `undefined`.
--
-- Resultado: la persona intentaba registrar el desembolso de un préstamo como
-- ingreso, la base lo rechazaba correctamente… y la interfaz mostraba
-- "No se pudo guardar el movimiento." El dato malo no entraba, pero el usuario
-- no tenía forma de saber qué había hecho mal. Una restricción que protege y no
-- explica es media restricción.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA SEGUNDA VERSIÓN, Y POR QUÉ NO ALCANZA
-- ─────────────────────────────────────────────────────────────────────────────
-- Podría buscarse el texto en castellano dentro del mensaje del error. Es lo
-- primero que uno escribe y es una trampa: el mapeo queda atado a una frase que
-- existe para que la lea una persona. El día que se reescribe el mensaje para
-- que se entienda mejor —una mejora, en principio— el mapeo deja de coincidir y
-- el error vuelve a mostrarse como 500. Nadie lo nota, porque no hay ningún test
-- que conecte las dos cosas.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA SOLUCIÓN: UN MARCADOR LEGIBLE POR MÁQUINA
-- ─────────────────────────────────────────────────────────────────────────────
-- El mensaje arranca con un código entre corchetes:
--
--     [finanzas:pasivo_no_recibe_ingreso] No se puede registrar un ingreso...
--     └────────────────┬────────────────┘ └────────── explicación ──────────┘
--          para el código              para la persona
--
-- Las dos partes tienen destinatarios distintos y se pueden cambiar por
-- separado: la explicación se reescribe cuando haga falta, y el marcador —que
-- sólo lee la aplicación— no se toca nunca.
--
-- Los identificadores de las restricciones CHECK ya cumplían este rol: Postgres
-- los incluye en el mensaje (`violates check constraint "movement_amount_positive"`),
-- así que ahí el nombre ES el marcador y no hace falta agregar nada.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ NO SE USA `USING ERRCODE`
-- ─────────────────────────────────────────────────────────────────────────────
-- La versión anterior usaba `USING ERRCODE = 'check_violation'` (23514), con la
-- idea de que Prisma lo traduciría a un error tipado. No lo hace, y de todos
-- modos no ayudaría: los seis invariantes comparten ese código, así que no
-- distingue CUÁL se violó. El marcador en el texto sí distingue, y no depende de
-- qué códigos decida mapear Prisma en la próxima versión.
--
-- Se conserva `ERRCODE = 'check_violation'` igual: es correcto semánticamente
-- (la fila no cumple una condición del dominio) y cualquier otra herramienta que
-- sí lo interprete —un cliente SQL, un pooler, un log— va a clasificarlo bien.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_movement_account_kind()
RETURNS TRIGGER AS $$
DECLARE
  target_kind "AccountKind";
BEGIN
  SELECT a."kind" INTO target_kind
  FROM "Account" a
  WHERE a."id" = NEW."accountId";

  -- Si la cuenta no existe, la clave foránea ya va a rechazar el INSERT.
  -- Este trigger sólo se ocupa de las cuentas que existen.
  IF target_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."kind" = 'INCOME' AND target_kind IN ('LOAN', 'CREDIT_CARD') THEN
    RAISE EXCEPTION
      '[finanzas:pasivo_no_recibe_ingreso] No se puede registrar un ingreso en una cuenta de pasivo (%). Usá una transferencia desde la cuenta de deuda hacia tu cuenta de dinero.',
      target_kind
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El trigger ya existe y apunta a esta función por nombre, así que
-- `CREATE OR REPLACE FUNCTION` alcanza: no hace falta recrearlo.
--
-- Se deja dicho explícitamente porque es lo que hace que esta migración sea
-- segura de aplicar sobre una base con datos: no toca ninguna tabla, no bloquea
-- ninguna fila y no reescribe nada. Sólo cambia el texto de un mensaje de error.
