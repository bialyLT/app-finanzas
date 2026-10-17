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

/**
 * La reconciliación de un mes: la variación del patrimonio contra el ahorro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE NÚMERO EXISTE (y por qué se muestra aunque no cuadre)
 * ─────────────────────────────────────────────────────────────────────────────
 * `ΔPatrimonio = Ahorro` es la red de seguridad del modelo de dinero, y es el
 * ÚNICO control que detecta un error que no se ve en ningún número por separado:
 * compara dos caminos independientes al mismo resultado.
 *
 *   · Camino A — los SALDOS: la variación del patrimonio entre el cierre del
 *     mes anterior y el cierre del mes (o el día del corte, si está en curso).
 *   · Camino B — los MOVIMIENTOS: el ahorro del §5.2 del ROADMAP, que es
 *     "ingreso ganado − gasto consumido" y deja afuera, por construcción, todo
 *     lo que no es ninguna de las dos cosas: los desembolsos de préstamos y las
 *     transferencias entre cuentas propias mueven saldos sin ser ahorro, pero se
 *     cancelan solos (una transferencia sube una cuenta y baja la otra; el
 *     capital de la cuota baja el banco y la deuda por el mismo monto).
 *
 * Con datos consistentes los dos caminos dan EXACTAMENTE el mismo número — la
 * identidad es un teorema del modelo, no una coincidencia. Cuando no da, hay
 * algo que revisar (un error en una consulta, una escritura por afuera de la
 * app, un cambio de esquema que dejó un camino atrás). Y la regla es UNA: se
 * muestra la diferencia, no se esconde. Un control de integridad que redondea
 * para que cierre no controla nada.
 *
 * Por eso este DTO viaja con los tres números y la comparación ya hecha por el
 * servidor: la pantalla no deriva nada.
 */
export interface ReconciliationDTO {
  /** Mes calendario `"YYYY-MM"`. */
  month: string;
  /** Patrimonio neto al cierre del mes ANTERIOR. */
  netStart: string;
  /** Patrimonio neto al cierre del mes (o al día del corte, si está en curso). */
  netEnd: string;
  /** `netEnd − netStart`. La variación del patrimonio del mes. */
  netDelta: string;
  /** Ingreso ganado − gasto consumido del mes (§5.2 del ROADMAP). */
  saving: string;
  /** `netDelta − saving`. Exactamente `"0.00"` cuando cuadra al centavo. */
  difference: string;
  /** `true` si `difference` es exactamente cero. */
  balanced: boolean;
  /**
   * `true` si la foto del mes se cortó ANTES de su último día: el mes está en
   * curso y las DOS puntas de la comparación usan el mismo corte. Comparar una
   * variación parcial contra un ahorro de mes completo sería comparar ventanas
   * distintas — y ese control mentiría.
   */
  partial: boolean;
  /** El día hasta el que se contaron los movimientos del mes (`YYYY-MM-DD`). */
  cutAt: string;
}

/**
 * El plan de cuotas de un préstamo, con el progreso al día del corte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DEFINICIONES (§5.2 del ROADMAP), ESCRITAS UNA VEZ
 * ─────────────────────────────────────────────────────────────────────────────
 *   · Cuota mensual → la cuota fija del sistema francés (`installmentPayment`).
 *   · Cuotas cubiertas → se camina el cronograma acumulando la amortización de
 *     cada cuota y se cuentan las que quedan enteras por debajo del capital
 *     pagado. Un pago parcial no cubre la próxima cuota.
 *   · Cuotas restantes → `installmentCount − paidCount`.
 *
 * El progreso NO se estima con el tiempo transcurrido ("ya pasaron 3 meses"):
 * se mide con la PLATA efectivamente amortizada, que es lo único que consta.
 */
export interface DebtPlanDTO {
  /** La cuota fija que se paga todos los meses. */
  payment: string;
  /** El total del préstamo (el capital original). */
  principal: string;
  /** Cuántas cuotas tiene el plan en total. */
  installmentCount: number;
  /** Cuántas cuotas quedan cubiertas por el capital ya amortizado. */
  paidCount: number;
  /** Cuántas cuotas faltan pagar. */
  remainingCount: number;
}

/**
 * Una cuenta de deuda dentro del reporte: deuda viva, plan y progreso.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY CASOS "NO SE SABE" Y NO CEROS
 * ─────────────────────────────────────────────────────────────────────────────
 * Una tarjeta de crédito es deuda viva, pero no tiene plan de amortización: no
 * existe —el modelo todavía no tiene `CardPlan`— la cuota fija, el total ni las
 * cuotas restantes. Inventar un plan de 12 cuotas para una tarjeta daría
 * números de aspecto confiable sobre algo que nadie pactó. Por eso `plan`,
 * `capitalPaid`, `interestPaid` y `progressPercent` viajan `null` y la pantalla
 * muestra "sin plan".
 *
 * Lo mismo para un préstamo al que le falten parámetros (caso defensivo: la
 * base lo prohíbe con el CHECK `loan_has_parameters`).
 *
 * `debt` viaja en POSITIVO cuando se debe y en NEGATIVO cuando la cuenta quedó
 * con saldo a favor (se pagó de más). La palabra ("debe" / "a favor") la elige
 * la interfaz con `formatLiability`.
 */
export interface DebtReportRowDTO {
  accountId: string;
  name: string;
  /** Sólo cuentas de deuda: préstamos y tarjetas. */
  kind: "LOAN" | "CREDIT_CARD";
  /** Una cuenta archivada con deuda viva se muestra marcada, no se esconde. */
  archived: boolean;
  /** Deuda viva al corte del mes mostrado. */
  debt: string;
  /** El plan del préstamo, con su progreso. `null` en tarjetas y sin datos. */
  plan: DebtPlanDTO | null;
  /** Σ del capital amortizado al corte, clampeado al principal. `null` sin plan. */
  capitalPaid: string | null;
  /** Σ del interés de las cuotas cubiertas. `null` sin plan. */
  interestPaid: string | null;
  /** `capitalPaid / principal × 100` con dos decimales. `null` sin plan. */
  progressPercent: string | null;
}

/**
 * El DTI: cuánto de tu ingreso mensual está comprometido con cuotas de deuda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DEFINICIÓN (§5.2) Y SUS DOS LÍMITES HONESTOS
 * ─────────────────────────────────────────────────────────────────────────────
 *   DTI = Σ cuota mensual de los planes CON cuotas pendientes ÷ ingreso del mes
 *
 * El numerador mira el PRESENTE (el corte del mes mostrado): un plan terminado
 * libera su cuota y no suma más. El denominador es el ingreso ganado del mes
 * mostrado, sobre la MISMA ventana que los demás reportes (`movementTotals`).
 *
 *   · Sin ingreso (mes vacío o consulta por gastos), `percent` es `null`: una
 *     división por cero no es "0% de compromiso", es "no se puede calcular". La
 *     UI lo dice con palabras en vez de mostrar un número falso.
 *   · El DTI es un indicador, no una regla: describe, no dictamina.
 */
export interface DebtDtiDTO {
  /** Σ de la cuota mensual de los planes con cuotas pendientes al corte. */
  monthlyCommitment: string;
  /** Ingreso ganado del mes mostrado (misma ventana que el resto de reportes). */
  income: string;
  /** `monthlyCommitment / income × 100` con dos decimales. `null` sin ingreso. */
  percent: string | null;
  /** Cuántos planes con cuotas pendientes suman al compromiso. */
  planCount: number;
}

/**
 * El reporte de deudas de UN mes: deuda viva, progreso, interés pagado, cuotas
 * restantes y DTI — todo calculado en el servidor.
 *
 * Igual que la reconciliación, es un reporte del mes MOSTRADO (el del selector
 * del panel), no del mes de hoy: navegar meses es viajar en el tiempo con las
 * deudas, y el corte de cada mes usa la misma convención (`monthCut`): mes
 * cerrado → fin de mes; mes en curso → el ancla (hoy); mes futuro → fin de mes.
 */
export interface DebtReportDTO {
  /** Mes calendario `"YYYY-MM"`. */
  month: string;
  /** El día hasta el que se contaron las deudas (`YYYY-MM-DD`). */
  cutAt: string;
  /** `true` si el corte quedó antes del último día del mes. */
  partial: boolean;
  /** Σ de la deuda viva de las filas. */
  totalDebt: string;
  rows: DebtReportRowDTO[];
  dti: DebtDtiDTO;
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
 * Un gasto del período que puede elegirse para el burn mensualizado.
 *
 * La tarjeta de burn de `/analisis` ofrece elegir UN gasto y verlo entero al
 * lado de su versión repartida en 12. Éste es cada uno de los gastos que el
 * selector puede mostrar: viajan los campos que la opción necesita para
 * identificarse (fecha, monto y los dos textos posibles de etiqueta).
 */
export interface BurnCandidateDTO {
  id: string;
  /** Día del gasto, `YYYY-MM-DD`. */
  date: string;
  /** Monto íntegro del gasto, string decimal exacto. */
  amount: string;
  /** Descripción cargada por la persona, si hay. */
  description: string | null;
  /** Nombre de la categoría; `null` es defensivo (hoy un EXPENSE sin categoría no existe). */
  categoryName: string | null;
}

/**
 * El burn mensualizado de un gasto: las DOS vistas del período en números.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LAS DOS VISTAS
 * ─────────────────────────────────────────────────────────────────────────────
 * Un gasto anual puesto entero en un mes hace que ESE mes parezca catastrófico
 * (ROADMAP §5.3 #9). El "mes de caja" —lo que de verdad salió— es un hecho y no
 * se maquilla; el burn mensualizado es el mismo mes con el gasto repartido en
 * 12, para poder comparar meses entre sí. Las dos vistas conviven: mostrar sólo
 * el burn escondería que la plata salió de una vez, y mostrar sólo la caja deja
 * un mes que parece el fin del mundo cuando fue un gasto anual previsible.
 *
 * El servidor devuelve los CINCO números ya calculados (`income`, `expenses`,
 * `burnExpenses`, `cashResult`, `burnResult`) y la interfaz sólo los formatea:
 * si el cliente restara por su cuenta, la fórmula viviría en dos lugares y
 * podría divergir.
 */
export interface BurnReportDTO {
  /** El gasto elegido. */
  movementId: string;
  /** Su fecha (`YYYY-MM-DD`). */
  date: string;
  /** Su monto íntegro: es el gasto que el burn reparte. */
  amount: string;
  /** `amount ÷ 12`, redondeado half-even a 2 decimales. */
  monthlyShare: string;
  /** Ingresos del período COMPLETO: el burn no mira los filtros de pantalla. */
  income: string;
  /** Gastos del período completo, con el gasto anual ENTERO adentro (vista de caja). */
  expenses: string;
  /** `expenses − amount + monthlyShare`: los gastos con el gasto repartido. */
  burnExpenses: string;
  /** `income − expenses`: el "Te quedó" del mes de caja, el que se ve en el resumen. */
  cashResult: string;
  /** `income − burnExpenses`: el mismo resultado con el burn aplicado. */
  burnResult: string;
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
 *
 * `burnCandidates` sigue la MISMA regla que `categories` —un selector no se
 * filtra a sí mismo—: son los EXPENSE del período por rango de fechas, sin
 * categoría ni texto, ordenados por monto descendente. Y por coherencia, el
 * burn de `?burn=` se calcula contra esos mismos totales sin filtrar: restarle
 * al total un gasto que el filtro dejó afuera sería restar algo que nunca sumó.
 */
export interface ReportsResponse {
  totals: PeriodTotalsDTO;
  /** Sólo EXPENSE: alimenta la torta "En qué se fue". */
  byCategory: CategoryBreakdownDTO[];
  /** INCOME y EXPENSE por día: alimentan las barras de "Evolución". */
  byDate: DateBreakdownDTO[];
  /** Para poblar el selector de categorías. No lleva los filtros de pantalla. */
  categories: CategoryDTO[];
  /** Para poblar el selector de burn. No lleva los filtros de pantalla. */
  burnCandidates: BurnCandidateDTO[];
  /**
   * `true` si el período tenía más gastos que el tope de la lista de candidatos.
   *
   * El tope limita lo que se MUESTRA —la lista se corta en `MOVEMENTS_MAX_ROWS`
   * como toda lista— y se avisa; lo que se CALCULA no: el burn del gasto
   * elegido se recalcula contra el período completo, así que una lista topeada
   * no subestima ningún número.
   */
  burnCandidatesTruncated: boolean;
  /**
   * El burn mensualizado del gasto pedido con `?burn=<movementId>`, o `null`.
   *
   * `null` en todos los casos en que no hay una vista que mostrar: no se pidió
   * burn, el id no existe, el movimiento no es un EXPENSE, o es un gasto de
   * otro período. Es el mismo criterio permisivo que las fechas inválidas de
   * esta ruta: un parámetro que no se entiende no devuelve un 400 que dejaría
   * la pantalla en blanco — simplemente la vista de burn no aparece.
   */
  burn: BurnReportDTO | null;
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
 * Recurrencia
 * ──────────────────────────────────────────────────────────────────────────── */

export type RecurFreqDTO = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type PostingModeDTO = "AUTO" | "NOTIFY";
export type RecurrenceRuleStatusDTO = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type RecurrenceOccurrenceStatusDTO = "PENDING" | "POSTED" | "SKIPPED";

/**
 * Una regla de recurrencia tal como viaja al cliente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `upcoming` NO ES PLATA
 * ─────────────────────────────────────────────────────────────────────────────
 * `upcoming` son fechas del calendario de la regla, calculadas por el motor
 * puro (`lib/recurrence.ts`). No son ocurrencias materializadas y —sobre todo—
 * NO son movimientos: no entran en totales, patrimonio ni reconciliación. Se
 * llaman "proyección" y no "pendientes" a propósito: una pendiente es una fila
 * que existe en la base y espera resolución; esto es lo que el calendario dice
 * que va a pasar si nada cambia.
 *
 * La distinción es el criterio de aceptación 4 de la Fase 3: lo que todavía no
 * ocurrió puede mostrarse, pero jamás puede contarse como plata real.
 */
export interface RecurrenceRuleDTO {
  id: string;
  /** Nombre visible. Es también la descripción de los movimientos que postea. */
  title: string;
  kind: MovementKindDTO;
  /** Monto SIEMPRE positivo, string decimal exacto. El signo lo da `kind`. */
  amount: string;
  freq: RecurFreqDTO;
  /** Cada cuántas unidades de `freq`. Siempre >= 1. */
  interval: number;
  /** Ancla del día del mes (1..31). `null` = el día de `startDate`. */
  dayOfMonth: number | null;
  /** Primera fecha posible, `YYYY-MM-DD`. */
  startDate: string;
  /** Última fecha inclusive, o `null` si no termina nunca. */
  endDate: string | null;
  /** Cantidad máxima de ocurrencias, o `null` si no hay tope. */
  count: number | null;
  postingMode: PostingModeDTO;
  status: RecurrenceRuleStatusDTO;
  account: AccountDTO;
  toAccount: AccountDTO | null;
  category: CategoryDTO | null;
  /**
   * Las próximas `RECURRENCE_UPCOMING_LIMIT` fechas ESTRICTAMENTE posteriores a
   * hoy, como `YYYY-MM-DD`. Proyección: no son movimientos ni suman en ningún
   * lado. Ver la nota de arriba.
   */
  upcoming: string[];
}

/**
 * Una ocurrencia vencida esperando en la bandeja.
 *
 * Trae los datos de su regla ya resueltos (título, monto, cuentas, categoría)
 * para que la bandeja se pueda mostrar sin una consulta por fila. El monto es
 * el de la REGLA, no una copia: aceptar postea con los valores vigentes de la
 * regla (editar la promesa cambia lo que todavía no pasó; lo ya posteado son
 * movimientos y no se toca).
 */
export interface PendingOccurrenceDTO {
  id: string;
  ruleId: string;
  /** La fecha que vence, `YYYY-MM-DD`. */
  dueDate: string;
  /** El nombre de la regla, para mostrar. */
  title: string;
  kind: MovementKindDTO;
  amount: string;
  account: AccountDTO;
  toAccount: AccountDTO | null;
  category: CategoryDTO | null;
}

/** Una ocurrencia con su estado y, si se posteó, el movimiento que la cumplió. */
export interface OccurrenceDTO extends PendingOccurrenceDTO {
  status: RecurrenceOccurrenceStatusDTO;
  movementId: string | null;
  movement: MovementDTO | null;
}

/** Respuesta de aceptar o saltar una ocurrencia. */
export interface OccurrenceActionResponse {
  occurrence: OccurrenceDTO;
  /**
   * `true` sólo si ESTA petición creó el movimiento. Es `false` cuando la
   * ocurrencia ya estaba posteada (aceptar es idempotente) y siempre en un
   * salto.
   */
  created: boolean;
}

/** Lo que generó la corrida del generador, por regla. */
export interface RecurrenceRunRuleDTO {
  ruleId: string;
  title: string;
  /** Ocurrencias nuevas materializadas en esta corrida (posteadas o pendientes). */
  materialized: number;
  /** De esas, cuántas se postearon solas (AUTO). */
  posted: number;
  /** De esas, cuántas quedaron en la bandeja (NOTIFY, o AUTO sin categoría). */
  pending: number;
}

/**
 * El resultado de una corrida de "desde la última vez".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ REPORTA LO QUE REPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * `materialized === 0` es una respuesta normal, no un error: significa que no
 * había nada vencido desde la última corrida. `capped` dice que el tope por
 * corrida (`RECURRENCE_RUN_MAX_PER_RULE`) cortó la lista y que queda trabajo
 * para la próxima: preferimos decirlo antes que devolver un éxito que miente.
 * `blocked` nombra las reglas AUTO que no pudieron postear y cuyas ocurrencias
 * quedaron en la bandeja en vez de bloquear la corrida entera. Hoy es defensa
 * en profundidad —la base impide que una regla quede sin categoría—, pero el
 * generador no depende de eso para no romperse.
 */
export interface RecurrenceRunDTO {
  /** El "hoy" que usó la corrida, `YYYY-MM-DD`. */
  today: string;
  materialized: number;
  posted: number;
  pending: number;
  /** `true` si alguna regla quedó con fechas vencidas sin materializar. */
  capped: boolean;
  rules: RecurrenceRunRuleDTO[];
  blocked: { ruleId: string; title: string; reason: string }[];
}

/** Respuesta de `GET /api/recurrence`: las reglas y la bandeja de pendientes. */
export interface RecurrenceResponse {
  /** Reglas ACTIVE y PAUSED, activas primero. Las archivadas no se listan. */
  rules: RecurrenceRuleDTO[];
  /** Ocurrencias PENDING, de la más vieja a la más nueva. */
  pending: PendingOccurrenceDTO[];
  /** `true` si la bandeja quedó cortada por `MOVEMENTS_MAX_ROWS`. */
  truncated: boolean;
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

export const RECUR_FREQ_LABEL: Record<RecurFreqDTO, string> = {
  DAILY: "Todos los días",
  WEEKLY: "Todas las semanas",
  MONTHLY: "Todos los meses",
  YEARLY: "Todos los años",
};

export const POSTING_MODE_LABEL: Record<PostingModeDTO, string> = {
  AUTO: "Automático",
  NOTIFY: "Avisar y confirmar",
};

export const RECURRENCE_STATUS_LABEL: Record<RecurrenceRuleStatusDTO, string> = {
  ACTIVE: "Activa",
  PAUSED: "Pausada",
  ARCHIVED: "Archivada",
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
