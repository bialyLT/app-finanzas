import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import {
  categoryKindConflicts,
  ruleCategoryKindMessage,
} from "@/lib/category-kind";
import {
  calendarToDb,
  dbToCalendar,
  isCalendarDate,
  todayCalendar,
  type CalendarDate,
} from "@/lib/dates";
import { cleanName, normalizeCategoryName } from "@/lib/finance";
import { parseMoneyInput } from "@/lib/money";
import { describeDatabaseError } from "@/lib/queries";
import {
  RecurrenceError,
  describeRecurrenceError,
  recurrenceRuleInclude,
  toRecurrenceRuleDTO,
} from "@/lib/recurring";

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const POSTING_MODES = ["AUTO", "NOTIFY"] as const;
const STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;

type RecurFreq = (typeof FREQS)[number];
type PostingMode = (typeof POSTING_MODES)[number];
type RuleStatus = (typeof STATUSES)[number];
type MovementKind = "INCOME" | "EXPENSE" | "TRANSFER";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Los campos de una regla, ya normalizados y validados por `parseRuleFields`.
 *
 * `categoryName` y `categoryId` viajan JUNTOS a propósito: en un alta la
 * categoría llega por nombre (y se resuelve con upsert); en una edición puede
 * no venir, y entonces `categoryId` conserva la que ya tenía. Validar la forma
 * de la regla es mirar la categoría RESUELTA, no sólo lo que llegó en el body.
 */
interface RuleFields {
  title: string;
  kind: MovementKind;
  amount: string;
  accountId: string;
  toAccountId: string | null;
  /** Nombre tal como lo escribió la persona, para el upsert por nombre normalizado. */
  categoryName: string | null;
  /** Categoría ya existente (sólo edición, cuando no se manda un nombre nuevo). */
  categoryId: string | null;
  freq: RecurFreq;
  interval: number;
  dayOfMonth: number | null;
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  count: number | null;
  postingMode: PostingMode;
  status: RuleStatus;
}

/** El shape crudo que la validación necesita de una regla existente (edición). */
interface ExistingRule {
  id: string;
  title: string;
  kind: MovementKind;
  amount: { toFixed(dp: number): string };
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  freq: RecurFreq;
  interval: number;
  dayOfMonth: number | null;
  startDate: Date;
  endDate: Date | null;
  count: number | null;
  postingMode: PostingMode;
  status: RuleStatus;
}

/**
 * Valida y normaliza los campos de una regla —alta o edición— en UN solo lugar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA EDICIÓN SE VALIDA SOBRE EL RESULTADO MEZCLADO
 * ─────────────────────────────────────────────────────────────────────────────
 * Un PATCH es parcial: "cambiá sólo el monto". Validar campo por campo lo que
 * llegó no alcanza, porque la regla que queda tiene que ser válida COMO UN
 * TODO: cambiar `kind` a TRANSFER sin mandar `toAccountId` deja una
 * transferencia sin destino, aunque cada campo suelto esté bien. Por eso la
 * validación se hace sobre `existente ⊕ body` y no sobre el body.
 *
 * Los campos del tipo viejo se limpian solos al cambiar de tipo (la forma la
 * define `kind`, igual que el CHECK `recurrence_shape_by_kind`): cambiar a
 * TRANSFER descarta la categoría, y cambiar a INCOME/EXPENSE descarta el
 * destino. El campo obligatorio del tipo nuevo sí hay que mandarlo.
 */
function parseRuleFields(input: {
  body: Record<string, unknown>;
  existing: ExistingRule | null;
}): { ok: true; fields: RuleFields } | { ok: false; message: string } {
  const { body, existing } = input;
  const isPatch = existing !== null;
  const fail = (message: string) =>
    ({ ok: false, message }) as { ok: false; message: string };

  // ── Nombre ─────────────────────────────────────────────────────────────────
  let title: string;
  if (body.title !== undefined) {
    title = cleanName(typeof body.title === "string" ? body.title : "");
    if (!title) return fail("La regla necesita un nombre.");
    if (title.length > 200) {
      return fail("El nombre de la regla no puede superar los 200 caracteres.");
    }
  } else if (existing) {
    title = existing.title;
  } else {
    return fail("La regla necesita un nombre.");
  }

  // ── Tipo ───────────────────────────────────────────────────────────────────
  let kind: MovementKind;
  if (body.kind !== undefined) {
    if (body.kind !== "INCOME" && body.kind !== "EXPENSE" && body.kind !== "TRANSFER") {
      return fail("Tipo de movimiento inválido.");
    }
    kind = body.kind;
  } else if (existing) {
    kind = existing.kind;
  } else {
    return fail("Tipo de movimiento inválido.");
  }

  // ── Monto ──────────────────────────────────────────────────────────────────
  // NUNCA `Number(body.amount)`: el monto se interpreta como texto decimal
  // exacto, igual que en POST /api/transactions.
  let amount: string;
  if (body.amount !== undefined) {
    const raw =
      typeof body.amount === "number"
        ? body.amount.toFixed(2)
        : String(body.amount ?? "");
    const parsed = parseMoneyInput(raw);
    if (parsed === null) {
      return fail("El monto no se entiende. Escribilo como 1234,56 o 1.234,56.");
    }
    if (parsed.lessThanOrEqualTo(0)) {
      return fail("El monto tiene que ser mayor a cero.");
    }
    amount = parsed.toFixed(2);
  } else if (existing) {
    amount = existing.amount.toFixed(2);
  } else {
    return fail("Falta el monto de la regla.");
  }

  // ── Cuenta de origen ───────────────────────────────────────────────────────
  let accountId: string;
  if (body.accountId !== undefined) {
    accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) return fail("Falta indicar la cuenta.");
  } else if (existing) {
    accountId = existing.accountId;
  } else {
    return fail("Falta indicar la cuenta.");
  }

  // ── Cuenta de destino (sólo TRANSFER) ──────────────────────────────────────
  let toAccountId: string | null;
  if (kind === "TRANSFER") {
    if (body.toAccountId !== undefined) {
      toAccountId =
        typeof body.toAccountId === "string" ? body.toAccountId : "";
      if (!toAccountId) {
        return fail(
          "Una transferencia necesita una cuenta de destino. Si no hay destino, no es una transferencia.",
        );
      }
    } else if (existing && existing.kind === "TRANSFER" && existing.toAccountId) {
      toAccountId = existing.toAccountId;
    } else {
      return fail(
        "Una transferencia necesita una cuenta de destino. Si no hay destino, no es una transferencia.",
      );
    }
    if (toAccountId === accountId) {
      return fail("La cuenta de destino tiene que ser distinta a la de origen.");
    }
  } else {
    if (
      body.toAccountId !== undefined &&
      body.toAccountId !== null &&
      body.toAccountId !== ""
    ) {
      return fail(
        kind === "INCOME"
          ? "Un ingreso no lleva cuenta de destino: la plata entra a la cuenta que indicaste."
          : "Un gasto no lleva cuenta de destino: la plata sale de la cuenta que indicaste.",
      );
    }
    // La forma la define el tipo: al dejar de ser TRANSFER, el destino se
    // limpia solo (no tiene sentido conservarlo).
    toAccountId = null;
  }

  // ── Categoría ──────────────────────────────────────────────────────────────
  let categoryName: string | null = null;
  let categoryId: string | null = null;

  if (kind === "TRANSFER") {
    if (
      body.categoryName !== undefined &&
      body.categoryName !== null &&
      body.categoryName !== ""
    ) {
      return fail(
        "Una transferencia entre cuentas propias no lleva categoría: no es un gasto ni un ingreso.",
      );
    }
  } else if (body.categoryName !== undefined) {
    categoryName = cleanName(
      typeof body.categoryName === "string" ? body.categoryName : "",
    );
    if (!categoryName) {
      return fail(
        kind === "INCOME"
          ? "Falta indicar de dónde viene el ingreso."
          : "Falta indicar en qué se gastó.",
      );
    }
  } else if (existing && existing.categoryId) {
    categoryId = existing.categoryId;
  } else {
    return fail(
      kind === "INCOME"
        ? "Falta indicar de dónde viene el ingreso."
        : "Falta indicar en qué se gastó.",
    );
  }

  // ── Frecuencia e intervalo ─────────────────────────────────────────────────
  let freq: RecurFreq;
  if (body.freq !== undefined) {
    if (!(FREQS as readonly unknown[]).includes(body.freq)) {
      return fail("Frecuencia inválida. Tiene que ser DAILY, WEEKLY, MONTHLY o YEARLY.");
    }
    freq = body.freq as RecurFreq;
  } else if (existing) {
    freq = existing.freq;
  } else {
    return fail("Falta la frecuencia de la regla.");
  }

  let interval: number;
  if (body.interval !== undefined && body.interval !== null && body.interval !== "") {
    const parsed = Number(body.interval);
    // Un intervalo 0 (o negativo) sería una división por cero esperando en el
    // generador. La base lo prohíbe con `recurrence_interval_positive`; acá se
    // corta antes, con un mensaje que se entiende.
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      return fail("El intervalo tiene que ser un número entero entre 1 y 365.");
    }
    interval = parsed;
  } else if (existing) {
    interval = existing.interval;
  } else {
    interval = 1;
  }

  // ── Ancla del día del mes ──────────────────────────────────────────────────
  //
  // ────────────────────────────────────────────────────────────────────────────
  // UN `null` EXPLÍCITO LIMPIA EL ANCLA, Y UNA FRECUENCIA SIN ANCLA LA LIMPIA SOLA
  // ────────────────────────────────────────────────────────────────────────────
  // El ancla sólo existe en MONTHLY y YEARLY. Dos consecuencias:
  //
  //   · `dayOfMonth: null` (o "") significa "volvé al día de `startDate`" —
  //     igual que `endDate`. Antes se trataba como «no vino» y el ancla vieja
  //     sobrevivía: cambiar una regla mensual con ancla a diaria quedaba
  //     IMPOSIBLE por PATCH (no había body que sacara el ancla, y la validación
  //     de abajo rechazaba la heredada con un 400).
  //   · Si la frecuencia resultante no admite ancla (DAILY/WEEKLY) y no vino una
  //     nueva, el ancla se limpia sola: la forma la define `freq`, igual que
  //     `kind` limpia la categoría o el destino (mismo criterio que D8). Sólo
  //     un ancla EXPLÍCITA junto a una frecuencia que no la admite es un error
  //     de la petición.
  let dayOfMonth: number | null;
  if (body.dayOfMonth === null || body.dayOfMonth === "") {
    dayOfMonth = null;
  } else if (body.dayOfMonth !== undefined) {
    const parsed = Number(body.dayOfMonth);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
      return fail("El día del mes tiene que ser un número entero entre 1 y 31.");
    }
    dayOfMonth = parsed;
  } else if (existing && (freq === "MONTHLY" || freq === "YEARLY")) {
    dayOfMonth = existing.dayOfMonth;
  } else {
    dayOfMonth = null;
  }
  if (dayOfMonth !== null && freq !== "MONTHLY" && freq !== "YEARLY") {
    return fail("El día del mes sólo se usa en reglas mensuales o anuales.");
  }

  // ── Fechas ─────────────────────────────────────────────────────────────────
  let startDate: CalendarDate;
  if (
    body.startDate !== undefined &&
    body.startDate !== null &&
    body.startDate !== ""
  ) {
    const value = String(body.startDate);
    if (!isCalendarDate(value)) {
      return fail(
        "La fecha de inicio no es válida. Se espera el formato AAAA-MM-DD con un día que exista.",
      );
    }
    startDate = value;
  } else if (existing) {
    startDate = dbToCalendar(existing.startDate);
  } else {
    startDate = todayCalendar();
  }

  let endDate: CalendarDate | null;
  if (body.endDate !== undefined) {
    if (body.endDate === null || body.endDate === "") {
      endDate = null;
    } else {
      const value = String(body.endDate);
      if (!isCalendarDate(value)) {
        return fail(
          "La fecha de fin no es válida. Se espera el formato AAAA-MM-DD con un día que exista.",
        );
      }
      endDate = value;
    }
  } else if (existing) {
    endDate = existing.endDate ? dbToCalendar(existing.endDate) : null;
  } else {
    endDate = null;
  }
  if (endDate !== null && endDate < startDate) {
    return fail("La fecha de fin no puede ser anterior a la de inicio.");
  }

  // ── Cantidad de ocurrencias ────────────────────────────────────────────────
  //
  // Mismo criterio que `dayOfMonth` y `endDate`: `null` (o "") es un valor
  // EXPLÍCITO que limpia el tope —"esta regla ya no se corta sola"—, no un "no
  // vino". Antes se colaba por el `else if (existing)` y `count` viejo
  // sobrevivía: quitarle el tope a una regla era IMPOSIBLE por PATCH (mandar
  // `count: null` lo conservaba en silencio, y la regla seguía terminando en la
  // ocurrencia N aunque la persona hubiera pedido "para siempre").
  let count: number | null;
  if (body.count === null || body.count === "") {
    count = null;
  } else if (body.count !== undefined) {
    const parsed = Number(body.count);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      return fail("La cantidad de ocurrencias tiene que ser un número entero entre 1 y 10000.");
    }
    count = parsed;
  } else if (existing) {
    count = existing.count;
  } else {
    count = null;
  }

  // ── Modo de posteo y estado ────────────────────────────────────────────────
  let postingMode: PostingMode;
  if (body.postingMode !== undefined) {
    if (!(POSTING_MODES as readonly unknown[]).includes(body.postingMode)) {
      return fail("Modo de posteo inválido. Tiene que ser AUTO o NOTIFY.");
    }
    postingMode = body.postingMode as PostingMode;
  } else if (existing) {
    postingMode = existing.postingMode;
  } else {
    postingMode = "NOTIFY";
  }

  let status: RuleStatus;
  if (body.status !== undefined) {
    if (!(STATUSES as readonly unknown[]).includes(body.status)) {
      return fail("Estado inválido. Tiene que ser ACTIVE, PAUSED o ARCHIVED.");
    }
    status = body.status as RuleStatus;
  } else if (existing) {
    status = existing.status;
  } else {
    status = "ACTIVE";
  }

  return {
    ok: true,
    fields: {
      title,
      kind,
      amount,
      accountId,
      toAccountId,
      categoryName,
      categoryId,
      freq,
      interval,
      dayOfMonth,
      startDate,
      endDate,
      count,
      postingMode,
      status,
    },
  };
}

/** Las dos cuentas de una regla tienen que existir; se avisa antes del FK. */
async function accountsExist(fields: RuleFields): Promise<string | null> {
  const ids = [fields.accountId, ...(fields.toAccountId ? [fields.toAccountId] : [])];
  const found = await prisma.account.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (!found.some((account) => account.id === fields.accountId)) {
    return "La cuenta indicada no existe.";
  }
  if (fields.toAccountId && !found.some((account) => account.id === fields.toAccountId)) {
    return "La cuenta de destino no existe.";
  }
  return null;
}

/**
 * POST /api/recurrence/rules
 *
 * Body:
 *   {
 *     title: "Alquiler",
 *     kind: "INCOME" | "EXPENSE" | "TRANSFER",
 *     amount: "1234,56",
 *     accountId: "...",
 *     toAccountId: "...",          // SÓLO TRANSFER
 *     categoryName: "Vivienda",    // SÓLO INCOME y EXPENSE
 *     freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY",
 *     interval: 1,                 // opcional, por defecto 1
 *     dayOfMonth: 31,              // opcional, SÓLO MONTHLY y YEARLY
 *     startDate: "2026-10-17",     // opcional, por defecto hoy
 *     endDate: null,               // opcional
 *     count: null,                 // opcional
 *     postingMode: "AUTO" | "NOTIFY",  // opcional, por defecto NOTIFY
 *     status: "ACTIVE" | "PAUSED" | "ARCHIVED"  // opcional, por defecto ACTIVE
 *   }
 *
 * La categoría se resuelve por nombre NORMALIZADO, igual que en los
 * movimientos: "Alquiler" y "ALQUILER" son la misma.
 *
 * La regla nace sin ocurrencias: materializarlas es trabajo de la corrida
 * (`POST /api/recurrence/run`). Si `startDate` es hoy y hay una ocurrencia
 * vencida, aparece en la bandeja (o se postea, si es AUTO) recién en la próxima
 * corrida — nunca "por crear la regla".
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.title`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const parsed = parseRuleFields({ body, existing: null });
  if (!parsed.ok) return badRequest(parsed.message);

  const missing = await accountsExist(parsed.fields);
  if (missing) return badRequest(missing);

  try {
    const rule = await createOrUpdateRule(parsed.fields, null);
    return NextResponse.json(toRecurrenceRuleDTO(rule, todayCalendar()), {
      status: 201,
    });
  } catch (error) {
    console.error(error);

    const described =
      describeRecurrenceError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo crear la regla." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/recurrence/rules
 *
 * Body: `{ id, ...campos a cambiar }` — todos opcionales menos `id`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ PASA CON EL PASADO YA MATERIALIZADO
 * ─────────────────────────────────────────────────────────────────────────────
 * Editar una regla NO toca nada de lo que ya pasó: las ocurrencias existentes
 * (y menos aún los movimientos posteados) quedan como están. El generador
 * retoma desde el último `dueDate` materializado, así que el calendario nuevo
 * rige sólo para fechas ESTRICTAMENTE posteriores a la última ocurrencia.
 *
 * Una ocurrencia PENDIENTE tampoco quedó congelada: al aceptarla se postea con
 * los datos VIGENTES de la regla. La promesa cambiada cambia lo que todavía no
 * pasó; lo ya posteado es historia y no se reescribe.
 *
 * `status` viaja por acá: pausar, reactivar y archivar son ediciones. Archivar
 * es la salida para una regla con ocurrencias que ya no querés ver (borrarla
 * está prohibido si generó algo: el historial es el producto).
 */
export async function PATCH(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  // Mismo caso que en POST: `null` es JSON válido y no es un objeto.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return badRequest("Falta el id de la regla.");

  const existing = await prisma.recurrenceRule.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Esa regla no existe." }, { status: 404 });
  }

  const parsed = parseRuleFields({ body, existing });
  if (!parsed.ok) return badRequest(parsed.message);

  const missing = await accountsExist(parsed.fields);
  if (missing) return badRequest(missing);

  try {
    const rule = await createOrUpdateRule(parsed.fields, id);
    return NextResponse.json(toRecurrenceRuleDTO(rule, todayCalendar()));
  } catch (error) {
    console.error(error);

    const described =
      describeRecurrenceError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo actualizar la regla." },
      { status: 500 },
    );
  }
}

/** Alta y edición comparten el upsert de la categoría y la escritura. */
async function createOrUpdateRule(fields: RuleFields, id: string | null) {
  return prisma.$transaction(async (tx) => {
    let categoryId = fields.categoryId;
    let category: {
      id: string;
      kind: "INCOME" | "EXPENSE";
      name: string;
    } | null = null;

    if (fields.categoryName) {
      const normalizedName = normalizeCategoryName(fields.categoryName);
      category = await tx.category.upsert({
        where: { normalizedName },
        // Si ya existe, se conserva el nombre ORIGINAL y su tipo (mismo
        // criterio que POST /api/transactions).
        update: {},
        create: {
          name: fields.categoryName,
          normalizedName,
          kind: fields.kind === "INCOME" ? "INCOME" : "EXPENSE",
        },
      });
      categoryId = category.id;
    } else if (categoryId) {
      // En una EDICIÓN la categoría puede venir de la regla existente: el
      // `upsert` de arriba no corre y, sin esta lectura, el cruce de tipos
      // no se haría (y una regla que cambia de Ingreso a Gasto conservaría la
      // categoría vieja sin que nadie lo note).
      category = await tx.category.findUnique({ where: { id: categoryId } });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EL TIPO DE LA REGLA Y EL DE SU CATEGORÍA TIENEN QUE SER EL MISMO
    // ─────────────────────────────────────────────────────────────────────────
    // Una regla es la PROMESA de un movimiento: si su tipo y el de su categoría
    // se contradicen, TODOS los movimientos que postee serían imposibles. La
    // base lo rechaza con el trigger `recurrence_category_kind_check`; acá se
    // corta antes, con un mensaje que dice qué hacer.
    // ─────────────────────────────────────────────────────────────────────────
    if (category && categoryKindConflicts(fields.kind, category.kind)) {
      throw new RecurrenceError(
        400,
        ruleCategoryKindMessage(category.name, fields.kind, category.kind),
      );
    }

    const data = {
      title: fields.title,
      kind: fields.kind,
      amount: fields.amount,
      accountId: fields.accountId,
      toAccountId: fields.toAccountId,
      categoryId,
      freq: fields.freq,
      interval: fields.interval,
      dayOfMonth: fields.dayOfMonth,
      startDate: calendarToDb(fields.startDate),
      endDate: fields.endDate ? calendarToDb(fields.endDate) : null,
      count: fields.count,
      postingMode: fields.postingMode,
      status: fields.status,
    };

    // El `today` no entra acá: la escritura no depende del reloj.
    return id
      ? tx.recurrenceRule.update({ where: { id }, data, include: recurrenceRuleInclude })
      : tx.recurrenceRule.create({ data, include: recurrenceRuleInclude });
  });
}

/**
 * DELETE /api/recurrence/rules?id=...
 *
 * Sólo se borra una regla VACÍA: sin ocurrencias y sin movimientos. Una regla
 * que ya generó algo se archiva (`PATCH` con `status: "ARCHIVED"`), por el
 * mismo motivo por el que una cuenta no se borra: los movimientos que posteó
 * son parte de tu historial, y sin la regla que los explica dejan de ser
 * auditables. La base lo impone igual (`onDelete: Restrict` en `Movement`); el
 * chequeo previo existe para dar el mensaje claro antes del error de Postgres.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id de la regla.");

  try {
    const rule = await prisma.recurrenceRule.findUnique({
      where: { id },
      select: {
        id: true,
        _count: { select: { occurrences: true, movements: true } },
      },
    });

    if (!rule) {
      return NextResponse.json({ error: "Esa regla no existe." }, { status: 404 });
    }

    if (rule._count.occurrences > 0 || rule._count.movements > 0) {
      return NextResponse.json(
        {
          error:
            "La regla ya generó ocurrencias o movimientos. Archivala en vez de borrarla: el historial es el producto.",
        },
        { status: 409 },
      );
    }

    await prisma.recurrenceRule.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error(error);

    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Esa regla ya no existe." },
        { status: 404 },
      );
    }

    const described =
      describeRecurrenceError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo borrar la regla." },
      { status: 500 },
    );
  }
}
