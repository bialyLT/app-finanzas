/**
 * Generador de recurrencia y operaciones sobre ocurrencias ("desde la última
 * vez", sin cron).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO HAY UN CRON NI UN CURSOR GUARDADO
 * ─────────────────────────────────────────────────────────────────────────────
 * El generador no corre en un horario fijo: corre cuando alguien lo pide
 * (`POST /api/recurrence/run`, que la pantalla dispara al cargar). Eso hace que
 * el resultado tenga que ser el mismo sin importar CUÁNDO se corre ni CUÁNTAS
 * veces: la corrida materializa las fechas vencidas que todavía no existen y
 * nada más.
 *
 * "Desde dónde sigo" NO se guarda en una columna: se deriva del último
 * `dueDate` materializado. Un cursor guardado sería un segundo origen de
 * verdad frente a la tabla de ocurrencias, y el día que difieran (un borrado,
 * una edición, un bug) el generador saltearía fechas o las repetiría en
 * silencio. Mismo criterio que el saldo de una cuenta, que se calcula y no se
 * guarda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DOBLE POSTEO ES IMPOSIBLE, Y LA GARANTÍA VIVE EN LA BASE
 * ─────────────────────────────────────────────────────────────────────────────
 * La aplicación tiene tres defensas, y la última no depende de ella:
 *
 *   1. `@@unique([ruleId, dueDate])`  → una regla no puede tener dos
 *      ocurrencias para la misma fecha.
 *   2. `movementId @unique`           → un movimiento no puede responder a dos
 *      ocurrencias.
 *   3. El índice parcial `Movement_recurrence_rule_date_key` → una regla no
 *      puede tener dos movimientos con la misma fecha.
 *
 * Y el posteo, además, se reclama con un `updateMany` condicionado a
 * `status = PENDING`: dos "aceptar" simultáneos se serializan en la fila y sólo
 * uno crea el movimiento. El que pierde la carrera NO devuelve un error: relee
 * el estado y devuelve el movimiento ganador (aceptar es idempotente).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNA CORRIDA = UNA TRANSACCIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 * Materializar varias reglas en transacciones separadas deja estados a medias
 * cuando una falla: las primeras quedan escritas, la respuesta es un error y
 * nadie sabe qué se generó. La corrida entera va en UNA transacción: o se
 * materializa todo, o no se materializa nada. Perder una carrera contra otra
 * corrida simultánea también revierte todo, y el reintento es seguro porque lo
 * ya materializado se saltea por el `dueDate` máximo.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./balance";
import {
  calendarToDb,
  dbToCalendar,
  type CalendarDate,
} from "./dates";
import type {
  OccurrenceDTO,
  PendingOccurrenceDTO,
  RecurrenceResponse,
  RecurrenceRuleDTO,
  RecurrenceRunDTO,
  RecurrenceRunRuleDTO,
} from "./finance";
import { MOVEMENTS_MAX_ROWS } from "./finance";
import {
  nextOccurrence,
  occurrencesBetween,
  projectedOccurrences,
  type RecurrenceSpec,
} from "./recurrence";
import {
  movementInclude,
  toAccountDTO,
  toCategoryDTO,
  toMovementDTO,
} from "./queries";

/**
 * Tope de ocurrencias por regla y por corrida.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN TOPE (y por qué NO es silencioso)
 * ─────────────────────────────────────────────────────────────────────────────
 * Una regla diaria abandonada dos años tiene ~730 fechas vencidas. Materializar
 * todas en un solo pedido convierte "abrir la app" en una escritura enorme, y
 * una regla mal cargada (diaria desde 1990) no puede tumbar el servidor.
 *
 * El tope recorta la lista, pero la corrida NO miente: `capped: true` avisa que
 * quedaron fechas para la próxima. El generador avanza desde el último
 * `dueDate`, así que dos corridas seguidas terminan de ponerse al día sin
 * duplicar nada. Tope mudo + generador con cursor sería la combinación que
 * pierde fechas; acá no hay cursor y el avance se deriva del registro.
 */
export const RECURRENCE_RUN_MAX_PER_RULE = 500;

/** Cuántas fechas futuras proyecta cada regla en la respuesta de la API. */
export const RECURRENCE_UPCOMING_LIMIT = 5;

/**
 * Un error de dominio de la recurrencia, con su status HTTP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UNA CLASE Y NO UN `{ ok, error }`
 * ─────────────────────────────────────────────────────────────────────────────
 * Estas operaciones escriben en una transacción: cuando algo no corresponde
 * (una ocurrencia que no existe, una ya saltada) hay que CORTAR la transacción
 * para que no quede nada a medias. Un valor de retorno no aborta el trabajo que
 * ya se hizo; una excepción sí. La ruta traduce `status`/`message` a JSON y no
 * tiene que adivinar qué pasó.
 */
export class RecurrenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecurrenceError";
  }
}

/** Relaciones que necesita el DTO de una regla. */
export const recurrenceRuleInclude = {
  account: true,
  toAccount: true,
  category: true,
} as const satisfies Prisma.RecurrenceRuleInclude;

/** Relaciones que necesita la bandeja (los datos de la regla ya resueltos). */
export const occurrenceInclude = {
  rule: { include: recurrenceRuleInclude },
} as const satisfies Prisma.RecurrenceOccurrenceInclude;

/** La ocurrencia con el movimiento que la cumplió (si está posteada). */
const occurrenceWithMovementInclude = {
  ...occurrenceInclude,
  movement: { include: movementInclude },
} as const satisfies Prisma.RecurrenceOccurrenceInclude;

type RuleRow = Prisma.RecurrenceRuleGetPayload<{
  include: typeof recurrenceRuleInclude;
}>;
type OccurrenceRow = Prisma.RecurrenceOccurrenceGetPayload<{
  include: typeof occurrenceInclude;
}>;
type OccurrenceWithMovementRow = Prisma.RecurrenceOccurrenceGetPayload<{
  include: typeof occurrenceWithMovementInclude;
}>;

/** El error que se lanza cuando otro pedido se quedó con la ocurrencia. */
class ClaimLostError extends Error {}

/**
 * Traduce un error de la recurrencia a `{ status, message }`, o `null` si no es
 * un error de dominio.
 *
 * Es el mismo contrato que `describeDatabaseError` (lib/queries.ts) para que
 * las rutas combinen los dos sin ramas distintas: el de dominio primero, el de
 * la base después, y un 500 genérico al final.
 */
export function describeRecurrenceError(
  error: unknown,
): { status: number; message: string } | null {
  if (error instanceof RecurrenceError) {
    return { status: error.status, message: error.message };
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function isMissingRow(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}

/**
 * Adapta una fila de `RecurrenceRule` al contrato del motor puro.
 *
 * El motor no sabe de Prisma ni de `Date`: recibe fechas de CALENDARIO. La
 * conversión se hace acá, en el borde, con `dbToCalendar` — nunca con
 * `toISOString`, que convierte a UTC y con offset negativo devuelve el día
 * anterior.
 */
export function specFromRule(rule: {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  startDate: Date;
  endDate: Date | null;
  count: number | null;
  dayOfMonth: number | null;
}): RecurrenceSpec {
  return {
    freq: rule.freq,
    interval: rule.interval,
    startDate: dbToCalendar(rule.startDate),
    endDate: rule.endDate ? dbToCalendar(rule.endDate) : null,
    count: rule.count,
    dayOfMonth: rule.dayOfMonth,
  };
}

/** Los datos con los que una regla postea un movimiento en una fecha. */
function movementDataFromRule(
  rule: {
    id: string;
    title: string;
    kind: "INCOME" | "EXPENSE" | "TRANSFER";
    amount: Prisma.Decimal;
    accountId: string;
    toAccountId: string | null;
    categoryId: string | null;
  },
  date: CalendarDate,
): Prisma.MovementUncheckedCreateInput {
  return {
    kind: rule.kind,
    amount: rule.amount.toFixed(2),
    date: calendarToDb(date),
    description: rule.title.slice(0, 200),
    accountId: rule.accountId,
    toAccountId: rule.toAccountId,
    categoryId: rule.categoryId,
    // El vínculo con la regla no es decorativo: es lo que hace que
    // `Movement_recurrence_rule_date_key` pueda impedir el doble posteo.
    recurrenceRuleId: rule.id,
  };
}

/**
 * ¿La regla puede postear sola? Una transferencia siempre puede (no lleva
 * categoría); un ingreso o gasto necesita su categoría. Si la categoría fue
 * borrada (el FK es `SetNull`), postear violaría `movement_shape_by_kind` en la
 * base: la ocurrencia se encola en la bandeja y la corrida sigue.
 */
function canAutoPost(rule: {
  kind: "INCOME" | "EXPENSE" | "TRANSFER";
  categoryId: string | null;
}): boolean {
  return rule.kind === "TRANSFER" || rule.categoryId !== null;
}

/**
 * Materializa las ocurrencias vencidas de todas las reglas ACTIVE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SIGNIFICA "VENCIDA"
 * ─────────────────────────────────────────────────────────────────────────────
 * Una fecha es vencida si es `<= today`. El día de hoy entra: el sueldo que se
 * acredita hoy es un hecho de hoy, y un generador que espera a mañana para
 * postearlo obliga a la persona a cargarlo a mano el mismo día. La fecha del
 * movimiento es la de la ocurrencia, no la de la corrida: ponerse al día un 20
 * no convierte un gasto del 1 en un gasto del 20.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE NO HACE
 * ─────────────────────────────────────────────────────────────────────────────
 * No toca las ocurrencias que ya existen (ni PENDING ni SKIPPED ni POSTED): la
 * marca de una saltada es lo que impide que el pasado se reescriba solo. No
 * postea una pendiente ajena: sólo lo hace con las que crea esta corrida y su
 * regla es AUTO. No mira reglas PAUSED ni ARCHIVED.
 */
export async function runDueOccurrences(
  db: PrismaClient,
  options: { today: CalendarDate },
): Promise<RecurrenceRunDTO> {
  const { today } = options;

  return db.$transaction(
    async (tx) => {
      const now = new Date();
      const rules = await tx.recurrenceRule.findMany({
        where: { status: "ACTIVE" },
        // Orden estable: la respuesta (y el orden de las filas creadas) no
        // cambia entre corridas idénticas.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const results: RecurrenceRunRuleDTO[] = [];
      const blocked: RecurrenceRunDTO["blocked"] = [];
      let capped = false;

      for (const rule of rules) {
        // El "desde dónde sigo" sale del registro, no de un cursor: la última
        // fecha materializada de esta regla, sea PENDING, POSTED o SKIPPED.
        const last = await tx.recurrenceOccurrence.findFirst({
          where: { ruleId: rule.id },
          orderBy: { dueDate: "desc" },
          select: { dueDate: true },
        });

        const spec = specFromRule(rule);
        const dates = occurrencesBetween(spec, {
          after: last ? dbToCalendar(last.dueDate) : null,
          through: today,
          limit: RECURRENCE_RUN_MAX_PER_RULE,
        });

        if (dates.length === 0) continue;

        // La decisión se toma UNA vez por regla: si la categoría falta, todas
        // sus ocurrencias de esta corrida van a la bandeja (y se avisa).
        const postable = canAutoPost(rule);
        if (rule.postingMode === "AUTO" && !postable) {
          blocked.push({
            ruleId: rule.id,
            title: rule.title,
            reason:
              "La regla quedó sin categoría y no puede postear sola: sus ocurrencias esperan en la bandeja.",
          });
        }
        const autoPost = rule.postingMode === "AUTO" && postable;

        let posted = 0;

        for (const date of dates) {
          if (autoPost) {
            const movement = await tx.movement.create({
              data: movementDataFromRule(rule, date),
            });
            await tx.recurrenceOccurrence.create({
              data: {
                ruleId: rule.id,
                dueDate: calendarToDb(date),
                status: "POSTED",
                postedAt: now,
                movementId: movement.id,
              },
            });
            posted += 1;
          } else {
            await tx.recurrenceOccurrence.create({
              data: { ruleId: rule.id, dueDate: calendarToDb(date) },
            });
          }
        }

        results.push({
          ruleId: rule.id,
          title: rule.title,
          materialized: dates.length,
          posted,
          pending: dates.length - posted,
        });

        // ¿Quedaron fechas vencidas sin materializar? Se pregunta al motor por
        // la próxima después de la última generada. Mirar sólo
        // `dates.length === RECURRENCE_RUN_MAX_PER_RULE` no distingue "cortó el
        // tope" de "justo terminaba ahí".
        if (dates.length === RECURRENCE_RUN_MAX_PER_RULE) {
          const following = nextOccurrence(spec, {
            after: dates[dates.length - 1],
          });
          if (following !== null && following <= today) capped = true;
        }
      }

      const materialized = results.reduce((total, row) => total + row.materialized, 0);
      const posted = results.reduce((total, row) => total + row.posted, 0);

      return {
        today,
        materialized,
        posted,
        pending: materialized - posted,
        capped,
        rules: results,
        blocked,
      } satisfies RecurrenceRunDTO;
    },
    // La transacción inserta hasta `RECURRENCE_RUN_MAX_PER_RULE` ocurrencias por
    // regla. El default de Prisma (5s) es corto para una puesta al día con
    // varias reglas; 30s deja margen sin volver el cuelgue una opción.
    { timeout: 30_000 },
  );
}

/**
 * Acepta una ocurrencia pendiente: crea el movimiento que la cumple.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ES IDEMPOTENTE, Y POR QUÉ TIENE QUE SERLO
 * ─────────────────────────────────────────────────────────────────────────────
 * Un doble clic en "aceptar", dos pestañas abiertas, un reintento después de un
 * timeout: todos llegan con la misma ocurrencia. Si el estado ya es POSTED, la
 * respuesta devuelve el movimiento que existe (`created: false`) en vez de un
 * error o —peor— de un segundo movimiento. La garantía no depende de la UI:
 * depende del reclamo condicional y de los índices únicos.
 *
 * El movimiento se crea con los datos VIGENTES de la regla (monto, cuentas,
 * categoría, título). Editar la regla cambia lo que todavía no pasó; los
 * movimientos ya posteados son historia y no se tocan.
 */
export async function acceptOccurrence(
  db: PrismaClient,
  occurrenceId: string,
): Promise<{ occurrence: OccurrenceDTO; created: boolean }> {
  try {
    return await db.$transaction(async (tx) => {
      const occurrence = await tx.recurrenceOccurrence.findUnique({
        where: { id: occurrenceId },
        include: occurrenceWithMovementInclude,
      });

      if (!occurrence) {
        throw new RecurrenceError(404, "Esa ocurrencia no existe.");
      }
      if (occurrence.status === "SKIPPED") {
        throw new RecurrenceError(
          409,
          "Esa ocurrencia ya fue saltada: la fecha no se vuelve a generar.",
        );
      }
      if (occurrence.status === "POSTED") {
        if (!occurrence.movement) {
          throw new RecurrenceError(
            500,
            "La ocurrencia figura posteada pero su movimiento no existe. Es un error de integridad de la app.",
          );
        }
        return { occurrence: toOccurrenceDTO(occurrence), created: false };
      }

      const rule = occurrence.rule;
      if (!canAutoPost(rule)) {
        throw new RecurrenceError(
          409,
          `La regla «${rule.title}» quedó sin categoría. Editala antes de aceptar la ocurrencia.`,
        );
      }

      const movement = await tx.movement.create({
        data: movementDataFromRule(rule, dbToCalendar(occurrence.dueDate)),
        include: movementInclude,
      });

      // El reclamo: sólo pasa de PENDING a POSTED quien llega primero. El
      // update y el movimiento viven en la misma transacción, así que el que
      // pierde revierte el movimiento que había creado.
      const claim = await tx.recurrenceOccurrence.updateMany({
        where: { id: occurrenceId, status: "PENDING" },
        data: { status: "POSTED", postedAt: new Date(), movementId: movement.id },
      });
      if (claim.count === 0) throw new ClaimLostError();

      return {
        occurrence: toOccurrenceDTO({
          ...occurrence,
          status: "POSTED",
          postedAt: new Date(),
          movementId: movement.id,
          movement,
        }),
        created: true,
      };
    });
  } catch (error) {
    if (error instanceof ClaimLostError || isUniqueViolation(error)) {
      // Perdimos la carrera (o el índice parcial nos ganó el insert). El estado
      // final ya es de otro: se lee y se devuelve ESE movimiento. Si la
      // ocurrencia sigue PENDING, fue un conflicto raro de datos y se pide
      // reintentar; nunca se inventa una respuesta.
      return resolveLostClaim(db, occurrenceId);
    }
    throw error;
  }
}

/** El que pierde el reclamo lee el estado final y responde con la verdad. */
async function resolveLostClaim(
  db: PrismaClient,
  occurrenceId: string,
): Promise<{ occurrence: OccurrenceDTO; created: boolean }> {
  const current = await db.recurrenceOccurrence.findUnique({
    where: { id: occurrenceId },
    include: occurrenceWithMovementInclude,
  });

  if (!current) {
    throw new RecurrenceError(404, "Esa ocurrencia no existe.");
  }
  if (current.status === "POSTED" && current.movement) {
    return { occurrence: toOccurrenceDTO(current), created: false };
  }
  if (current.status === "SKIPPED") {
    throw new RecurrenceError(
      409,
      "Esa ocurrencia ya fue saltada: la fecha no se vuelve a generar.",
    );
  }
  throw new RecurrenceError(
    409,
    "No se pudo postear la ocurrencia. Recargá e intentá de nuevo.",
  );
}

/**
 * Salta una ocurrencia pendiente.
 *
 * La fila NO se borra: queda en `SKIPPED` con `skippedAt`. Ese es el punto
 * entero de la bandeja persistida — si saltar fuera un borrado, la próxima
 * corrida recrearía la fecha y el pasado se reescribiría solo. Saltar es
 * idempotente; postearla primero y saltarla después es un 409, porque deshacer
 * un movimiento es otra operación (borrarlo, que reabre la ocurrencia).
 */
export async function skipOccurrence(
  db: PrismaClient,
  occurrenceId: string,
): Promise<OccurrenceDTO> {
  try {
    return await db.$transaction(async (tx) => {
      const occurrence = await tx.recurrenceOccurrence.findUnique({
        where: { id: occurrenceId },
        include: occurrenceWithMovementInclude,
      });

      if (!occurrence) {
        throw new RecurrenceError(404, "Esa ocurrencia no existe.");
      }
      if (occurrence.status === "SKIPPED") {
        return toOccurrenceDTO(occurrence);
      }
      if (occurrence.status === "POSTED") {
        throw new RecurrenceError(
          409,
          "Esa ocurrencia ya está posteada. Para deshacerla, primero borrá el movimiento.",
        );
      }

      const claim = await tx.recurrenceOccurrence.updateMany({
        where: { id: occurrenceId, status: "PENDING" },
        data: { status: "SKIPPED", skippedAt: new Date() },
      });
      if (claim.count === 0) throw new ClaimLostError();

      return toOccurrenceDTO({
        ...occurrence,
        status: "SKIPPED",
        skippedAt: new Date(),
      });
    });
  } catch (error) {
    if (error instanceof ClaimLostError) {
      const current = await db.recurrenceOccurrence.findUnique({
        where: { id: occurrenceId },
        include: occurrenceWithMovementInclude,
      });
      if (!current) {
        throw new RecurrenceError(404, "Esa ocurrencia no existe.");
      }
      if (current.status === "SKIPPED") return toOccurrenceDTO(current);
      if (current.status === "POSTED") {
        throw new RecurrenceError(
          409,
          "Esa ocurrencia ya está posteada. Para deshacerla, primero borrá el movimiento.",
        );
      }
      throw new RecurrenceError(
        409,
        "No se pudo saltar la ocurrencia. Recargá e intentá de nuevo.",
      );
    }
    throw error;
  }
}

/**
 * Borra un movimiento y, si vino de una regla, reabre su ocurrencia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE DEJA QUE EL `ON DELETE SET NULL` HAGA EL TRABAJO
 * ─────────────────────────────────────────────────────────────────────────────
 * El FK de `RecurrenceOccurrence.movementId` es `SetNull`, y eso parece
 * suficiente: al borrar el movimiento, la ocurrencia queda sin vínculo. Pero la
 * ocurrencia seguiría en `POSTED`, y el CHECK `occurrence_shape_by_status`
 * exige que una POSTED TENGA movimiento. El `SetNull` violaría el CHECK y el
 * DELETE fallaría con un error de integridad que no explica nada.
 *
 * Por eso la ocurrencia vuelve a `PENDING` (sin `postedAt`, sin `movementId`)
 * ANTES de borrar el movimiento, en la misma transacción.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA OCURRENCIA REABIERTA ESPERA EN LA BANDEJA (NO SE RE-POSTEA SOLA)
 * ─────────────────────────────────────────────────────────────────────────────
 * Decisión deliberada: una regla AUTO NO vuelve a postear la ocurrencia que
 * quedó pendiente por un borrado. El generador sólo decide por las fechas
 * NUEVAS; reabrir una posteada es una consecuencia de un acto explícito de la
 * persona (borrar un movimiento), y deshacerlo en la próxima recarga sería
 * pelearse con ella: la plata "reaparecería" sola después de borrarla.
 *
 * La ocurrencia reabierta se ve en la bandeja y se resuelve a mano: aceptarla
 * la vuelve a postear, saltarla la cierra para siempre. Y como su fecha ya está
 * materializada, el generador nunca la recrea por su cuenta.
 */
export async function deleteMovement(
  db: PrismaClient,
  movementId: string,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await tx.recurrenceOccurrence.updateMany({
        where: { movementId },
        data: { status: "PENDING", movementId: null, postedAt: null },
      });
      await tx.movement.delete({ where: { id: movementId } });
    });
  } catch (error) {
    if (isMissingRow(error)) {
      throw new RecurrenceError(404, "Ese movimiento ya no existe.");
    }
    throw error;
  }
}

/**
 * La vista de recurrencia: reglas activas/pausadas y la bandeja de pendientes.
 *
 * No escribe nada: materializar es trabajo de `POST /api/recurrence/run`, y un
 * GET que escribe rompe la semántica de HTTP (un precargado del navegador, un
 * crawl o un reintento postearían movimientos). La pantalla corre el generador
 * y después lee esta vista.
 *
 * `upcoming` se proyecta ESTRICTAMENTE después de hoy: lo de hoy ya está en la
 * bandeja (o posteado), y repetirlo en la lista de "lo que viene" mostraría dos
 * veces la misma fecha con dos significados distintos.
 */
export async function getRecurrenceOverview(
  db: Db,
  options: { today: CalendarDate },
): Promise<RecurrenceResponse> {
  const [rules, pending] = await Promise.all([
    db.recurrenceRule.findMany({
      where: { status: { not: "ARCHIVED" } },
      include: recurrenceRuleInclude,
      // ACTIVE antes que PAUSED (el orden del enum) y, dentro de cada estado,
      // de la más vieja a la más nueva: la lista no se reordena entre recargas.
      orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    db.recurrenceOccurrence.findMany({
      where: { status: "PENDING" },
      include: occurrenceInclude,
      // La más vieja primero: la bandeja se resuelve en orden, y una deuda de
      // hace tres meses no puede quedar escondida abajo de la de ayer.
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: MOVEMENTS_MAX_ROWS + 1,
    }),
  ]);

  const truncated = pending.length > MOVEMENTS_MAX_ROWS;

  return {
    rules: rules.map((rule) => toRecurrenceRuleDTO(rule, options.today)),
    pending: pending
      .slice(0, MOVEMENTS_MAX_ROWS)
      .map((occurrence) => toPendingOccurrenceDTO(occurrence)),
    truncated,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Filas → DTOs
 * ──────────────────────────────────────────────────────────────────────────── */

export function toRecurrenceRuleDTO(
  rule: RuleRow,
  today: CalendarDate,
): RecurrenceRuleDTO {
  return {
    id: rule.id,
    title: rule.title,
    kind: rule.kind,
    amount: rule.amount.toFixed(2),
    freq: rule.freq,
    interval: rule.interval,
    dayOfMonth: rule.dayOfMonth,
    startDate: dbToCalendar(rule.startDate),
    endDate: rule.endDate ? dbToCalendar(rule.endDate) : null,
    count: rule.count,
    postingMode: rule.postingMode,
    status: rule.status,
    account: toAccountDTO(rule.account),
    toAccount: rule.toAccount ? toAccountDTO(rule.toAccount) : null,
    category: rule.category ? toCategoryDTO(rule.category) : null,
    upcoming: projectedOccurrences(specFromRule(rule), {
      after: today,
      limit: RECURRENCE_UPCOMING_LIMIT,
    }),
  };
}

function toPendingOccurrenceDTO(
  occurrence: OccurrenceRow,
): PendingOccurrenceDTO {
  const { rule } = occurrence;

  return {
    id: occurrence.id,
    ruleId: rule.id,
    dueDate: dbToCalendar(occurrence.dueDate),
    title: rule.title,
    kind: rule.kind,
    amount: rule.amount.toFixed(2),
    account: toAccountDTO(rule.account),
    toAccount: rule.toAccount ? toAccountDTO(rule.toAccount) : null,
    category: rule.category ? toCategoryDTO(rule.category) : null,
  };
}

function toOccurrenceDTO(occurrence: OccurrenceWithMovementRow): OccurrenceDTO {
  return {
    ...toPendingOccurrenceDTO(occurrence),
    status: occurrence.status,
    movementId: occurrence.movementId,
    movement: occurrence.movement ? toMovementDTO(occurrence.movement) : null,
  };
}
