/**
 * Tipos compartidos entre el servidor y el cliente, y normalización de nombres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS MONTOS VIAJAN COMO STRING Y NO COMO NUMBER
 * ─────────────────────────────────────────────────────────────────────────────
 * `JSON` no tiene tipo decimal: sólo `number` (IEEE-754) y `string`. Si un monto
 * de $ 1.234,56 viajara como `number`, al llegar al cliente ya tendría el error
 * binario incorporado — y si el cliente lo vuelve a mandar, el error se duplica.
 *
 * Los `Decimal` de Prisma serializan a string automáticamente (`toJSON`), así
 * que la decisión correcta es no pelear con eso: el monto es un string en todo
 * el transporte y se convierte a `Decimal` sólo para calcular. El tipo `string`
 * en el DTO es lo que hace que nadie escriba `movement.amount * 2` sin darse
 * cuenta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LAS FECHAS TAMBIÉN SON STRING
 * ─────────────────────────────────────────────────────────────────────────────
 * Una fecha de calendario no es un instante. Si viajara como `Date`, JSON la
 * convertiría a ISO en UTC y `"2026-10-15"` volvería como
 * `"2026-10-15T00:00:00.000Z"` — que al leerse en Buenos Aires es el 14 de
 * octubre. El string `YYYY-MM-DD` es la representación que no se corrompe.
 */

export type MovementKindDTO = "INCOME" | "EXPENSE" | "TRANSFER";
export type CategoryKindDTO = "INCOME" | "EXPENSE";
export type AccountKindDTO = "CASH" | "BANK" | "CREDIT_CARD" | "LOAN";

export interface AccountDTO {
  id: string;
  name: string;
  kind: AccountKindDTO;
  archived: boolean;
  /** Monto como string decimal exacto. Ver la nota de arriba. */
  openingBalance: string;
}

export interface CategoryDTO {
  id: string;
  name: string;
  kind: CategoryKindDTO;
}

export interface MovementDTO {
  id: string;
  kind: MovementKindDTO;
  /** Monto SIEMPRE positivo. El signo lo da `kind`. */
  amount: string;
  /** Fecha de calendario `YYYY-MM-DD`. */
  date: string;
  description: string;

  /** Cuenta de origen (o donde entra el ingreso). */
  account: AccountDTO;
  /** Sólo en TRANSFER: cuenta de destino. */
  toAccount: AccountDTO | null;
  /** Sólo en INCOME y EXPENSE. */
  category: CategoryDTO | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Respuestas de la API
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Cuenta con su saldo ya calculado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY DOS NÚMEROS DE SALDO Y NO UNO
 * ─────────────────────────────────────────────────────────────────────────────
 * En una cuenta de deuda, "el saldo" es ambiguo:
 *
 *   · `balance`: el saldo CONTABLE. Deber 500.000 es −500.000. Es el número que
 *     necesita la aritmética del patrimonio (activos + pasivos = neto).
 *   · `debt`: la deuda MOSTRADA, en positivo. Es lo que la persona espera leer.
 *
 * La interfaz necesita los dos, y mezclarlos produce el clásico "−$ 500.000" en
 * rojo que todo el mundo lee como un error de la app. Teniendo los dos campos
 * separados, cada pantalla elige el correcto sin tener que acordarse de
 * invertir el signo.
 */
export interface AccountBalanceDTO extends AccountDTO {
  /** Saldo contable. Negativo si es una cuenta de deuda. */
  balance: string;
  /** Deuda en positivo. `null` en las cuentas de dinero. */
  debt: string | null;
  isLiability: boolean;
  /** Todo lo que entró a la cuenta en el período consultado. */
  inflow: string;
  /** Todo lo que salió. */
  outflow: string;
}

export interface NetWorthDTO {
  /** Suma de las cuentas de dinero. */
  assets: string;
  /** Suma de las deudas, en positivo. */
  liabilities: string;
  /** `assets − liabilities`. Puede ser negativo, y eso es un dato válido. */
  net: string;
}

/**
 * Un punto de la serie mensual del patrimonio: la foto al cierre de un mes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIAJAN LOS TRES NÚMEROS Y NO SÓLO EL NETO
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque el neto solo esconde la historia más importante del modelo. En el
 * escenario del proyecto, agosto y septiembre terminan los dos en $ 100.000
 * —el mismo número— pero por motivos opuestos: en septiembre entró un préstamo
 * de $ 500.000 que subió los activos Y las deudas en la misma medida. Mirando
 * sólo `net` esa foto parecería "no pasó nada"; con `assets` y `liabilities`
 * se ve que pasó todo. Es la ley del panel aplicada al tiempo: el desembolso
 * no es ganancia.
 *
 * `partial` marca el mes en curso: su foto es "a hoy", no a fin de mes, porque
 * el mes todavía no terminó. Viaja en el DTO para que el cliente no tenga que
 * adivinar CUÁL es el mes en curso con su propio reloj.
 */
export interface NetWorthPointDTO {
  /** Mes calendario `"YYYY-MM"`. Ni día ni instante: acá la unidad es el mes. */
  month: string;
  /** Activos (efectivo + banco) a la fecha de la foto, como string decimal. */
  assets: string;
  /** Deudas en positivo a esa misma fecha. */
  liabilities: string;
  /** `assets − liabilities`. Puede ser negativo. */
  net: string;
  /** `true` sólo en el mes en curso: la foto se corta a hoy, no a fin de mes. */
  partial: boolean;
}

export interface AccountsResponse {
  accounts: AccountBalanceDTO[];
  netWorth: NetWorthDTO;
  /**
   * La evolución del patrimonio: la foto al cierre de cada uno de los últimos
   * 12 meses calendario, del más viejo al más nuevo (el último es el mes en
   * curso). La calcula `getNetWorthSeries` en el servidor — el cliente no suma
   * movimientos en ningún caso.
   */
  netWorthSeries: NetWorthPointDTO[];
}

/**
 * Tope de filas por consulta de movimientos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE, Y POR QUÉ ES VISIBLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Una consulta sin límite es un problema de memoria: el navegador se queda con
 * todas las filas en RAM. El tope tiene que existir.
 *
 * Lo que no puede existir es un tope MUDO. La versión anterior hacía `take:
 * 2000` y devolvía un array pelado: si tenías más movimientos, los últimos
 * desaparecían sin aviso, la lista incompleta se veía idéntica a una completa y
 * los totales del panel —que se sumaban de esa lista— quedaban subestimados.
 *
 * Vive acá, y no en la ruta, porque lo necesitan los dos lados: el servidor para
 * cortar y las pantallas para poder decir cuántos movimientos están mostrando.
 */
export const MOVEMENTS_MAX_ROWS = 500;

/**
 * Totales de un período, calculados en el SERVIDOR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE SUMAN EN EL CLIENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque `movements` está topeado en 500 filas. Un mes con más movimientos que
 * eso mostraba "Ingresos", "Gastos", "Te quedó" y la tasa de ahorro calculados
 * sobre una **lista incompleta**: los cuatro números quedaban subestimados, y el
 * aviso de truncado aparecía abajo del pliegue mientras los números equivocados
 * estaban arriba y bien grandes.
 *
 * Es el peor tipo de error posible en una app de plata: un número mal que se ve
 * tan confiable como uno bien. Con los totales agregados en la base, la lista
 * puede truncarse para mostrar y los totales no.
 *
 * Los `count` viajan por separado de los montos por el mismo motivo: contar los
 * elementos de una lista truncada da un número incompleto.
 */
export interface PeriodTotalsDTO {
  /** Suma de los INCOME del período. */
  income: string;
  /** Suma de los EXPENSE del período. */
  expenses: string;
  /** Suma de los TRANSFER. Se informa, pero NO entra en ingresos ni gastos. */
  transfers: string;
  /**
   * Flujo de caja (liquidez): Σ entradas a cuentas de dinero − Σ salidas.
   *
   * ────────────────────────────────────────────────────────────────────────────
   * POR QUÉ NO ES "INGRESOS − GASTOS"
   * ────────────────────────────────────────────────────────────────────────────
   * Porque ese número es el AHORRO, y los dos se separan apenas hay deuda de por
   * medio — que es el caso normal:
   *
   *   · El desembolso de un préstamo SUMA acá: entra plata a tu cuenta. Como es
   *     una TRANSFER, no toca `income` — te endeudaste, no ganaste.
   *   · El capital de cada cuota RESTA acá: sale plata de tu cuenta. Tampoco es
   *     un gasto: estás devolviendo lo que pediste.
   *   · Una compra con tarjeta NO toca este número: la deuda sube, pero ningún
   *     peso salió de tus cuentas de dinero. El pago del resumen (TRANSFER del
   *     banco a la tarjeta) es el que sí sale.
   *   · Una transferencia entre dos cuentas de dinero suma como entrada Y como
   *     salida: su neto es cero, que es lo que pasa de verdad.
   *
   * Puede ser NEGATIVO (salió más de lo que entró) y el signo viaja en el
   * string. Etiquetarlo siempre "flujo de caja", nunca "ahorro": confundirlos es
   * el error que todo el rediseño existe para evitar (ROADMAP §5.2).
   */
  cashFlow: string;
  incomeCount: number;
  expenseCount: number;
  transferCount: number;
}

export interface MovementsResponse {
  movements: MovementDTO[];
  /**
   * `true` si quedaron movimientos afuera por el tope de filas.
   *
   * La versión anterior truncaba en 2000 filas SIN avisar, así que una lista
   * incompleta se veía idéntica a una completa. Con este campo, la interfaz
   * puede decir "mostrando los primeros 500" en vez de mentir.
   */
  truncated: boolean;
  /**
   * Totales del período **completo**, no de `movements`.
   *
   * Si algún día alguien los recalcula a partir de la lista, el bug de los
   * totales truncados vuelve sin hacer ruido.
   */
  totals: PeriodTotalsDTO;
}

/**
 * Una porción de la torta: cuánto se gastó en una categoría en el período.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO LO CALCULA EL SERVIDOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Es la misma razón que la de `PeriodTotalsDTO`, aplicada a la torta de
 * `/analisis`: el gráfico se armaba filtrando la lista de movimientos —topeada
 * en `MOVEMENTS_MAX_ROWS`—, así que un período con más movimientos que el tope
 * mostraba categorías con montos recortados. Una porción más chica de lo real
 * se ve igual de convincente que una correcta.
 *
 * Array de filas y no un objeto `{ [categoría]: monto }` a propósito: el orden
 * de inserción de un objeto no es parte del contrato de JSON, y acá el orden
 * (monto descendente) es información útil para la torta.
 */
export interface CategoryBreakdownDTO {
  /** `null` agrupa los movimientos sin categoría. Hoy la base los prohíbe en un EXPENSE, así que es defensivo. */
  categoryId: string | null;
  /** Nombre para mostrar. `"Sin categoría"` cuando `categoryId` es `null`. */
  name: string;
  /** Suma de los EXPENSE de esa categoría, como string decimal exacto. */
  amount: string;
}

/**
 * Un punto de las barras: cuánto entró o salió en un día del período.
 *
 * `kind` es sólo INCOME o EXPENSE porque las transferencias no están acá: una
 * transferencia entre bolsillos propios no es plata que entra ni que sale del
 * sistema, y si se sumara al gráfico mostraría un pico que no corresponde a
 * ninguna ganancia ni pérdida.
 */
export interface DateBreakdownDTO {
  /** Fecha de calendario `YYYY-MM-DD`. Nunca un ISO con hora: ver la nota de arriba. */
  date: string;
  kind: "INCOME" | "EXPENSE";
  /** Suma de ese día para ese tipo, como string decimal exacto. */
  amount: string;
}

/**
 * Respuesta de `/api/reports`: los tres agregados del período, calculados en la
 * base sobre el conjunto COMPLETO (sin el tope de la lista).
 *
 * El `where` del request —rango de fechas, categoría y texto— ya viene aplicado
 * a `totals`, `byCategory` y `byDate`: son los números del subconjunto que la
 * persona está mirando.
 *
 * `categories` es la excepción deliberada: viaja SIN los filtros de categoría y
 * texto, por el mismo motivo por el que el selector de un formulario no se
 * filtra a sí mismo — si eligieras "Alquiler" y la lista sólo pudiera mostrar
 * las categorías ya filtradas, quedarías encerrado en "Alquiler" sin forma de
 * volver a agrandar el período. Sólo respeta el rango de fechas: son las
 * categorías con al menos un movimiento en el período.
 */
export interface ReportsResponse {
  totals: PeriodTotalsDTO;
  /** Sólo EXPENSE: alimenta la torta "En qué se fue". */
  byCategory: CategoryBreakdownDTO[];
  /** INCOME y EXPENSE por día: alimentan las barras de "Evolución". */
  byDate: DateBreakdownDTO[];
  /** Para poblar el selector de categorías. No lleva los filtros de pantalla. */
  categories: CategoryDTO[];
}

export interface CategoriesResponse {
  categories: CategoryDTO[];
}

/**
 * Vista previa de un préstamo: lo que REALMENTE cuesta.
 *
 * Existe porque el cálculo de la cuota tiene que vivir en un solo lugar
 * (`lib/money.ts`, del servidor, con Decimal exacto). Si el formulario lo
 * replicara en el cliente para mostrar una vista previa, habría dos
 * implementaciones de la misma fórmula — y el día que difieran, el usuario vería
 * una cuota en el formulario y otra en la lista.
 */
export interface LoanPreviewDTO {
  /** La cuota que vas a pagar todos los meses. */
  payment: string;
  /** Total desembolsado a lo largo de todo el préstamo. */
  totalPaid: string;
  /** Lo que se queda el banco. Es el costo real. */
  totalInterest: string;
  /** De cada 100 pesos pagados, cuántos son del banco. */
  interestSharePercent: string;
  /** El plan de pagos completo, para poder mostrarlo en detalle. */
  schedule: {
    number: number;
    payment: string;
    /** La parte que es COSTO REAL. Es gasto. */
    interest: string;
    /** La parte que baja la deuda. NO es gasto. */
    principal: string;
    remainingBalance: string;
  }[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Etiquetas para la interfaz
 * ──────────────────────────────────────────────────────────────────────────── */

export const MOVEMENT_KIND_LABEL: Record<MovementKindDTO, string> = {
  INCOME: "Ingreso",
  EXPENSE: "Gasto",
  TRANSFER: "Transferencia",
};

export const ACCOUNT_KIND_LABEL: Record<AccountKindDTO, string> = {
  CASH: "Efectivo",
  BANK: "Cuenta bancaria",
  CREDIT_CARD: "Tarjeta de crédito",
  LOAN: "Préstamo",
};

/**
 * Las cuentas de pasivo son deuda: no reciben ingresos.
 *
 * Se expone como función y no como un `Set` porque el chequeo `LIABILITY_KINDS.has(k)`
 * con un Set requiere que el tipo esté ensanchado, y con TypeScript estricto
 * termina en un cast. La función no.
 */
export function isLiabilityKind(kind: AccountKindDTO): boolean {
  return kind === "LOAN" || kind === "CREDIT_CARD";
}

/**
 * Cuentas que pueden recibir un ingreso.
 *
 * Que un préstamo no aparezca acá es el punto del rediseño: cobrar un préstamo
 * no es ganar plata.
 */
export function canReceiveIncome(kind: AccountKindDTO): boolean {
  return !isLiabilityKind(kind);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalización de nombres
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Normaliza el nombre de una categoría para poder deduplicarla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL BUG QUE ESTO ARREGLA
 * ─────────────────────────────────────────────────────────────────────────────
 * El esquema viejo tenía `@@unique([name, kind])` sobre el nombre CRUDO, y
 * Postgres compara texto distinguiendo mayúsculas. Entonces:
 *
 *     "Comida"  → categoría A
 *     "comida"  → categoría B   ← ¡otra!
 *     "COMIDA"  → categoría C   ← ¡y otra!
 *
 * Las tres existen en la base, y el gráfico de gastos parte el mismo concepto en
 * tres porciones. El usuario ve su gasto real dividido en pedazos y no entiende
 * por qué el total no coincide con lo que gastó.
 *
 * Lo insidioso es que el usuario no puede arreglarlo: la categoría con el nombre
 * que él escribe no es la que ya existe, así que se crea una nueva cada vez.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ TAMBIÉN SE SACAN LOS ACENTOS
 * ─────────────────────────────────────────────────────────────────────────────
 * "Cafe" y "Café" son la misma cosa para cualquiera que escriba rápido en el
 * celular. Y en un teclado de teléfono, elegir la tilde es un accidente, no una
 * decisión. Normalizar los dos al mismo valor hace que sean una sola categoría.
 *
 * Se usa NFD (descomposición canónica) y después se borran los signos
 * diacríticos. Es el método estándar y no depende de un diccionario.
 *
 * El nombre ORIGINAL nunca se pierde: se guarda en `Category.name`. Esta función
 * sólo produce la clave de deduplicación.
 */
export function normalizeCategoryName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    // \u0300–\u036f es el rango de signos diacríticos combinantes.
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Limpia un nombre para mostrarlo: saca espacios de más y deja el resto como
 * lo escribió la persona.
 */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
