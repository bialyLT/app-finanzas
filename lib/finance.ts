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

export interface AccountsResponse {
  accounts: AccountBalanceDTO[];
  netWorth: NetWorthDTO;
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
