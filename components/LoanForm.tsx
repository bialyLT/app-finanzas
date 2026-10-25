"use client";

import { useEffect, useRef, useState } from "react";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { addMonths, todayCalendar } from "@/lib/dates";
import type { AccountBalanceDTO, LoanPreviewDTO } from "@/lib/finance";
import { AMORTIZATION_SYSTEM_LABEL } from "@/lib/finance";
import { formatAmountInput, formatMoney, formatPercent } from "@/lib/format";
import { Handshake, ArrowUpRight, ArrowDownLeft } from "lucide-react";

interface Props {
  /** Cuentas de dinero (no archivadas, CASH o BANK) para el desembolso. */
  cashAccounts: AccountBalanceDTO[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

type Direction = "I_OWE" | "OWED_TO_ME";
type SystemOption = "FRENCH" | "GERMAN" | "AMERICAN" | "INTEREST_ONLY";

/**
 * Los tres modos de carga: lo que la persona REALMENTE sabe.
 *
 * · `PAYMENT`: la cuota que va a pagar por mes (el modo por defecto: nadie
 *   calcula un porcentaje).
 * · `TOTAL`: lo que va a devolver en total.
 * · `RATE`: la tasa, para quien ya la tiene (el modo de siempre, en avanzado).
 */
type TermsMode = "PAYMENT" | "TOTAL" | "RATE";

const MODES: { value: TermsMode; label: string; id: string }[] = [
  { value: "PAYMENT", label: "Por mes", id: "loanalta-mode-PAYMENT" },
  { value: "TOTAL", label: "En total", id: "loanalta-mode-TOTAL" },
  { value: "RATE", label: "Por %", id: "loanalta-mode-RATE" },
];

const SYSTEMS: { value: SystemOption; label: string }[] = [
  { value: "FRENCH", label: "Francés" },
  { value: "GERMAN", label: "Alemán" },
  { value: "AMERICAN", label: "Americano" },
  { value: "INTEREST_ONLY", label: "Solo interés" },
];

/** El préstamo recién creado, a la espera de su desembolso. */
interface CreatedLoan {
  id: string;
  name: string;
  kind: "LOAN" | "RECEIVABLE";
  principal: string;
}

/**
 * Alta guiada de un préstamo (lo debo / me lo deben) con su DESEMBOLSO como
 * paso explícito.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL DESEMBOLSO ES UN SEGUNDO PASO Y NO UN CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 * La deuda viva de un préstamo ES el saldo de su cuenta (ronda 1): sin una
 * transferencia de desembolso registrada, la deuda "aparece de la nada" y el
 * saldo miente. El check opt-in se saltea por definición; un segundo paso que
 * ya tiene todo cargado (monto, cuenta, fecha) se contesta en un toque — y si
 * la persona elige "Ahora no", la tarjeta del préstamo queda con el aviso y el
 * botón para arreglarlo después.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL ALTA NO ES IDEMPOTENTE (y por eso el botón se bloquea)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dos POST a `/api/accounts` = dos cuentas con dos cronogramas. El botón se
 * deshabilita mientras el alta está en vuelo (mismo candado que el alta de
 * compras en cuotas de `/tarjetas`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOS COLUMNAS, SIN SCROLL INTERNO (trampas 9/15 de `flows/README.md`)
 * ─────────────────────────────────────────────────────────────────────────────
 * El pie es `sticky bottom-0`: los campos que se TIPEAN van a la izquierda,
 * arriba del pie; la columna derecha (dirección, cuenta, sistema, vista previa)
 * usa selects y botones, que un tap los alcanza sin pelear con el pie.
 */
export default function LoanForm({ cashAccounts, onClose, onSaved }: Props) {
  const [step, setStep] = useState<"form" | "disburse">("form");

  const [direction, setDirection] = useState<Direction>("I_OWE");
  const [name, setName] = useState("");
  const [cashId, setCashId] = useState(
    () =>
      cashAccounts.find((account) => account.kind === "BANK")?.id ??
      cashAccounts[0]?.id ??
      "",
  );
  const [principal, setPrincipal] = useState("");
  const [system, setSystem] = useState<SystemOption>("FRENCH");
  const [tna, setTna] = useState("");
  const [count, setCount] = useState("");
  const [firstDate, setFirstDate] = useState(() => addMonths(todayCalendar(), 1));

  /**
   * El modo de carga: por defecto, lo que la persona sabe (la cuota).
   *
   * La tasa NO se pide: se deriva. El modo `RATE` (la tasa a mano) queda
   * disponible para quien ya la tiene — y el campo de la tasa, en los otros
   * modos, es de SOLO LECTURA: muestra la tasa que la app derivó.
   */
  const [mode, setMode] = useState<TermsMode>("PAYMENT");
  /** La cuota mensual (modo PAYMENT). */
  const [payment, setPayment] = useState("");
  /** El total a devolver (modo TOTAL). */
  const [total, setTotal] = useState("");
  /** El campo de la tasa (para seleccionarlo al cambiar de modo). */
  const tnaRef = useRef<HTMLInputElement>(null);
  /** Hay que seleccionar el texto del campo de la tasa (tras cambiar de modo). */
  const [seleccionarTna, setSeleccionarTna] = useState(false);
  /**
   * El número de pedido de la vista previa.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * POR QUÉ
   * ─────────────────────────────────────────────────────────────────────────────
   * La respuesta de un pedido VIEJO no puede pisar la de uno nuevo.
   *
   * La petición sale 300 ms después de la última tecla (el debounce), pero
   * puede tardar en volver: con 600 cuotas en el sistema alemán la vista
   * previa tarda MÁS DE UN SEGUNDO (medido: 1.422 ms). Si en ese rato la
   * persona borra lo que escribió (o cambia de modo), cuando la respuesta llega
   * la app pondría en pantalla los números de un dato que YA NO ESTÁ en el
   * formulario: la vista previa mostraría la cuota de un pago que ya no
   * existe.
   *
   * El contador hace que cada respuesta se descarte si mientras tanto cambió
   * algo (o si ya llegó otra más nueva).
   */
  const previewSeq = useRef(0);

  const [preview, setPreview] = useState<LoanPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /**
   * Aviso de descarte: «Cancelar» no cierra en silencio.
   *
   * El pie de este modal es la zona donde puede caer un tap perdido (el
   * contenido scrolleaba POR DEBAJO del pie): un toque ahí aterrizaba en
   * «Cancelar» y cerraba el formulario con todo lo cargado. Desde que el
   * área que scrollea termina donde empieza el pie, el tap perdido es un
   * tap en un botón que la persona VE — y ese botón no puede descartar en
   * silencio: primero pregunta, en línea, en dos pasos.
   */
  const [discardWarning, setDiscardWarning] = useState(false);

  /** El préstamo creado, cuando ya se pasó al paso del desembolso. */
  const [created, setCreated] = useState<CreatedLoan | null>(null);
  const [disburseDate, setDisburseDate] = useState(() => todayCalendar());

  const principalRaw = principal.trim();
  const principalPreview = formatAmountInput(principal);
  /** El eco formateado de lo que se está escribiendo (cuota o total). */
  const paymentPreview = formatAmountInput(payment);
  const totalPreview = formatAmountInput(total);

  /**
   * La tasa que muestra el formulario.
   *
   * En los modos derivados sale de la vista previa (la calculó el servidor);
   * en el modo RATE es la que escribió la persona.
   */
  const tnaDerivada = mode === "RATE" ? null : (preview?.tnaPercent ?? null);

  // ── Vista previa ───────────────────────────────────────────────────────────
  // Se pide al servidor DESPUÉS de que la persona deja de escribir (300 ms).
  // El cálculo NO se hace acá: si el formulario reimplementara la fórmula,
  // podría mostrar una cuota distinta a la que después guarda la app (ver
  // `app/api/loans/preview/route.ts`).
  useEffect(() => {
    if (step !== "form") return;

    // Cada modo necesita su propio dato: la tasa, la cuota o el total.
    const faltaElDato =
      mode === "RATE"
        ? !tna.trim()
        : mode === "PAYMENT"
          ? !payment.trim()
          : !total.trim();

    if (!principalRaw || faltaElDato || !count.trim()) {
      setPreview(null);
      setPreviewError("");
      return;
    }

    const timer = setTimeout(async () => {
      // El número de ESTE pedido: si mientras tanto los datos cambiaron (o
      // llegó otra respuesta más nueva), esta se descarta.
      const seq = ++previewSeq.current;
      try {
        const params = new URLSearchParams({
          principal: principalRaw,
          installmentCount: count.trim(),
          system,
          mode,
        });
        if (mode === "RATE") params.set("tnaPercent", tna.trim());
        if (mode === "PAYMENT") params.set("payment", payment.trim());
        if (mode === "TOTAL") params.set("total", total.trim());
        if (firstDate !== "") params.set("firstInstallmentDate", firstDate);

        const response = await fetch(`/api/loans/preview?${params}`);

        if (seq !== previewSeq.current) return; // llegó una respuesta vieja

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setPreviewError(body.error ?? "No se pudo calcular la cuota.");
          setPreview(null);
          return;
        }

        const data = (await response.json()) as LoanPreviewDTO;
        if (seq !== previewSeq.current) return; // llegó una respuesta vieja
        setPreview(data);
        setPreviewError("");
      } catch {
        if (seq !== previewSeq.current) return; // llegó una respuesta vieja
        setPreviewError("No se pudo calcular la cuota.");
        setPreview(null);
      }
    }, 300);

    // Cancelar el envío pendiente si los valores cambian antes de que se cumpla
    // el tiempo: una respuesta lenta de una consulta vieja no debe pisar a una
    // nueva. Y, además, INVALIDAR lo que esté en vuelo: si los datos ya
    // cambiaron, la respuesta que llegue de ese pedido viejo no se muestra.
    return () => {
      clearTimeout(timer);
      previewSeq.current += 1;
    };
  }, [
    step,
    principalRaw,
    mode,
    tna,
    payment,
    total,
    count,
    system,
    firstDate,
  ]);

  /**
   * Pasar al modo «la tasa a mano».
   *
   * En los modos derivados el campo de la tasa es de SOLO LECTURA: muestra la
   * tasa que la app derivó. Tocarlo es la forma de decir «la tasa la sé yo»:
   * el campo pasa a ser editable y arranca con el valor derivado, para que
   * ajustar un número no signifique reescribirlo.
   *
   * El texto derivado queda SELECCIONADO: si la persona escribe, reemplaza el
   * número en vez de pegarse al final («60.000060» no es una tasa: es un
   * mistake de un dedo).
   */
  function activarModoTasa() {
    if (mode === "RATE") return;
    if (tna.trim() === "" && tnaDerivada !== null) {
      setTna(tnaDerivada);
    }
    setMode("RATE");
    setSeleccionarTna(true);
  }

  /** Cambiar de modo (el botón del selector): mismo criterio que el campo. */
  function cambiarModo(nuevo: TermsMode) {
    if (nuevo === mode) return;
    setMode(nuevo);
    if (nuevo === "RATE") setSeleccionarTna(true);
  }

  // El texto del campo de la tasa queda seleccionado al cambiar de modo: lo
  // que se escriba después REEMPLAZA el número, no se le pega al final.
  useEffect(() => {
    if (!seleccionarTna) return;
    const campo = tnaRef.current;
    if (campo) {
      campo.focus();
      campo.select();
    }
    setSeleccionarTna(false);
  }, [seleccionarTna]);

  const kind: "LOAN" | "RECEIVABLE" = direction === "I_OWE" ? "LOAN" : "RECEIVABLE";
  const verb = direction === "I_OWE" ? "pagar" : "cobrar";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const missing: string[] = [];
    if (!name.trim()) missing.push("el nombre");
    if (!principalRaw) missing.push("el monto");
    if (mode === "RATE" && !tna.trim()) missing.push("la tasa (TNA)");
    if (mode === "PAYMENT" && !payment.trim()) missing.push("la cuota");
    if (mode === "TOTAL" && !total.trim()) missing.push("el total a devolver");
    if (!count.trim()) missing.push("la cantidad de cuotas");
    if (!firstDate.trim()) missing.push("la fecha de la primera cuota");
    if (missing.length > 0) {
      setError(`Faltan datos: ${missing.join(", ")}.`);
      return;
    }
    if (formatAmountInput(principal) === null) {
      setError("El monto tiene que ser un número mayor a cero.");
      return;
    }
    if (mode === "PAYMENT" && formatAmountInput(payment) === null) {
      setError("La cuota tiene que ser un número mayor a cero.");
      return;
    }
    if (mode === "TOTAL" && formatAmountInput(total) === null) {
      setError("El total a devolver tiene que ser un número mayor a cero.");
      return;
    }
    const countNumber = Number(count.trim());
    if (!Number.isInteger(countNumber) || countNumber < 1 || countNumber > 600) {
      setError("La cantidad de cuotas tiene que ser un entero entre 1 y 600.");
      return;
    }
    if (cashAccounts.length === 0 || !cashId) {
      setError(
        "Necesitás una cuenta de banco o efectivo (no archivada): el alta registra el desembolso entre cuentas.",
      );
      return;
    }

    setSaving(true);
    try {
      // El cuerpo lleva el MODO: la API no puede deducir si el número es la
      // cuota o el total, y en los modos derivados la tasa la calcula el
      // servidor (no se manda: se guarda la que él deriva).
      const terms: Record<string, string> =
        mode === "RATE"
          ? { tnaPercent: tna.trim() }
          : mode === "PAYMENT"
            ? { payment: payment.trim() }
            : { total: total.trim() };

      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          principal: principalRaw,
          installmentCount: countNumber,
          firstInstallmentDate: firstDate,
          amortizationSystem: system,
          mode,
          ...terms,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "No se pudo crear el préstamo.");
      }

      // Paso 2: el desembolso, con todo ya cargado.
      setCreated({
        id: data.id,
        name: name.trim(),
        kind,
        principal: principalRaw,
      });
      setDisburseDate(todayCalendar());
      setError("");
      setStep("disburse");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo crear el préstamo.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDisburse() {
    if (!created) return;
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "TRANSFER",
          amount: created.principal,
          date: disburseDate,
          // La dirección de la plata es la del desembolso: en un LOAN sale del
          // préstamo y entra a la cuenta de dinero; en un RECEIVABLE al revés.
          accountId: created.kind === "LOAN" ? created.id : cashId,
          toAccountId: created.kind === "LOAN" ? cashId : created.id,
          description: "Desembolso del préstamo",
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo registrar el desembolso.");
      }

      const cashName =
        cashAccounts.find((account) => account.id === cashId)?.name ??
        "la cuenta elegida";
      onSaved(
        created.kind === "LOAN"
          ? `Préstamo «${created.name}» creado: la plata entró a ${cashName} y la deuda ya está registrada.`
          : `Préstamo «${created.name}» creado: la plata salió de ${cashName} y ya figura que te la deben.`,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo registrar el desembolso.",
      );
    } finally {
      setSaving(false);
    }
  }

  function skipDisburse() {
    if (!created) return;
    onSaved(
      `Préstamo «${created.name}» creado. Faltó registrar el desembolso: podés hacerlo desde su tarjeta.`,
    );
    onClose();
  }

  /**
   * Cerrar el modal SIN completar el desembolso: si el préstamo ya se creó,
   * es un «Ahora no» implícito (la × y el fondo no pueden dejar la lista sin
   * refrescar y sin aviso: el préstamo YA existe en el servidor).
   */
  function closeOrSkip() {
    if (created) {
      skipDisburse();
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={closeOrSkip}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nuevo préstamo"
        className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* El panel es una columna: el encabezado y el pie son `flex-none` y
            el área que scrollea termina EXACTAMENTE donde empieza el pie.
            Antes el pie era `sticky` dentro del área que scrolleaba: los
            campos pasaban por debajo y un tap en un campo tapado caía en el
            pie (en este modal, en «Cancelar»: el formulario se cerraba y lo
            cargado se perdía — el BUG-3 de la ronda). */}
        <div className="flex-none px-6 pt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2"><Handshake className="size-5" aria-hidden />Nuevo préstamo</h2>
          <button
            id="loanalta-close"
            onClick={closeOrSkip}
            className="text-xl leading-none text-fg-subtle hover:text-fg-muted px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        </div>

        {step === "form" ? (
          <>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        <form id="loan-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px] gap-4 sm:gap-5">
              {/* ── Columna de campos ─────────────────────────────────────── */}
              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="loanalta-name" className="block text-sm font-medium">
                    Nombre *
                  </label>
                  <input
                    id="loanalta-name"
                    autoFocus
                    autoComplete="off"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej: Préstamo del banco"
                    maxLength={100}
                    className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-focus"
                  />
                </div>

                {/* ── ¿Cómo lo cargás? ────────────────────────────────────────
                    La persona no sabe la tasa: sabe la cuota o el total. El
                    modo por defecto es «Por mes». «Por %» es el modo de
                    siempre, para quien ya tiene la tasa. */}
                <div>
                  <p className="text-sm font-medium mb-1">¿Cómo lo cargás? *</p>
                  <div className="grid grid-cols-3 gap-2">
                    {MODES.map((option) => (
                      <button
                        key={option.value}
                        id={option.id}
                        type="button"
                        aria-pressed={mode === option.value}
                        onClick={() => cambiarModo(option.value)}
                        className={`min-h-11 rounded-md px-1 py-2 text-xs font-medium border ${
                          mode === option.value
                            ? "border-transparent bg-primary text-primary-fg "
                            : "border-line-strong hover:bg-surface-3 "
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {mode === "PAYMENT" &&
                      "Cargá la cuota que vas a pagar por mes: la app calcula la tasa."}
                    {mode === "TOTAL" &&
                      "Cargá cuánto vas a devolver en total: la app calcula la cuota y la tasa."}
                    {mode === "RATE" &&
                      "Si ya tenés la tasa, cargala acá. Tocá el campo de TNA para volver a editarlo."}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="loanalta-principal"
                      className="block text-sm font-medium"
                    >
                      Monto *
                    </label>
                    <input
                      id="loanalta-principal"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={principal}
                      onChange={(e) => setPrincipal(e.target.value)}
                      placeholder="500.000"
                      className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                    />
                    {principalPreview && (
                      <p className="mt-1 text-xs text-fg-muted">
                        {principalPreview}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="loanalta-tna" className="block text-sm font-medium">
                      {mode === "RATE" ? "TNA % *" : "TNA % (derivada)"}
                    </label>
                    <input
                      id="loanalta-tna"
                      ref={tnaRef}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={mode === "RATE" ? tna : (tnaDerivada ?? "")}
                      readOnly={mode !== "RATE"}
                      onFocus={activarModoTasa}
                      onClick={activarModoTasa}
                      onChange={(e) => setTna(e.target.value)}
                      placeholder="60"
                      aria-label={
                        mode === "RATE"
                          ? "Tasa anual (TNA) en porcentaje"
                          : "Tasa anual (TNA) en porcentaje: la calculó la app, tocá para cargarla a mano"
                      }
                      className={`mt-1 w-full rounded-md border px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus ${
                        mode === "RATE"
                          ? "border-line-strong bg-transparent"
                          : "border-line bg-surface-3 bg-surface-3/60 text-fg-muted "
                      }`}
                    />
                    {mode !== "RATE" && (
                      <p id="loanalta-tna-derived" className="mt-1 text-xs text-fg-muted">
                        {tnaDerivada === null
                          ? "La tasa sale de lo que vas a pagar."
                          : `Te sale al ${formatPercent(tnaDerivada)} anual`}
                      </p>
                    )}
                  </div>
                </div>

                {/* ── Lo que la persona sabe: la cuota o el total ─────────────── */}
                {mode !== "RATE" && (
                  <div>
                    <label
                      htmlFor={mode === "PAYMENT" ? "loanalta-payment" : "loanalta-total"}
                      className="block text-sm font-medium"
                    >
                      {mode === "PAYMENT"
                        ? "Cuota por mes *"
                        : "Total a devolver *"}
                    </label>
                    <input
                      id={mode === "PAYMENT" ? "loanalta-payment" : "loanalta-total"}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={mode === "PAYMENT" ? payment : total}
                      onChange={(e) =>
                        mode === "PAYMENT"
                          ? setPayment(e.target.value)
                          : setTotal(e.target.value)
                      }
                      placeholder={
                        // ─────────────────────────────────────────────────────
                        // EL EJEMPLO TIENE QUE SER UN VALOR QUE LA APP ACEPTE
                        // ─────────────────────────────────────────────────────
                        // El ejemplo es del mismo caso que el resto del
                        // formulario (500.000 · 12 cuotas · 60 %): la cuota
                        // 56.412,71 y el total 676.952,44.
                        //
                        // El ejemplo anterior de la cuota ("31.412,71") era la
                        // parte de CAPITAL de la primera cuota: la app lo
                        // RECHAZA ("esa cuota no alcanza para cubrir el
                        // capital: con 12 cuotas la mínima es 41666.67"). Un
                        // ejemplo que la propia app rechaza es una
                        // contradicción.
                        mode === "PAYMENT" ? "56.412,71" : "676.952,44"
                      }
                      className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                    />
                    {mode === "PAYMENT" && paymentPreview && (
                      <p className="mt-1 text-xs text-fg-muted">{paymentPreview}</p>
                    )}
                    {mode === "TOTAL" && totalPreview && (
                      <p className="mt-1 text-xs text-fg-muted">{totalPreview}</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="loanalta-count" className="block text-sm font-medium">
                      Cuotas *
                    </label>
                    <input
                      id="loanalta-count"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                      placeholder="12"
                      className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                    />
                  </div>
                  <div>
                    <label htmlFor="loanalta-first" className="block text-sm font-medium">
                      Primera cuota *
                    </label>
                    <input
                      id="loanalta-first"
                      type="date"
                      value={firstDate}
                      onChange={(e) => {
                        setFirstDate(e.target.value);
                        clearDateInputIfEmptied(e.target);
                      }}
                      className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                    />
                  </div>
                </div>
              </div>

              {/* ── Columna derecha: dirección, cuenta, sistema y vista previa ── */}
              <div className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-medium mb-1">¿Qué pasó? *</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      id="loan-dir-I_OWE"
                      type="button"
                      aria-pressed={direction === "I_OWE"}
                      onClick={() => setDirection("I_OWE")}
                      className={`rounded-md py-2.5 px-2 text-xs font-medium border ${
                        direction === "I_OWE"
                          ? "border-transparent bg-primary text-primary-fg "
                          : "border-line-strong hover:bg-surface-3 "
                      }`}
                    >
                      <ArrowDownLeft className="size-4 inline-block align-[-2px]" aria-hidden /> Recibí un préstamo
                    </button>
                    <button
                      id="loan-dir-OWED_TO_ME"
                      type="button"
                      aria-pressed={direction === "OWED_TO_ME"}
                      onClick={() => setDirection("OWED_TO_ME")}
                      className={`rounded-md py-2.5 px-2 text-xs font-medium border ${
                        direction === "OWED_TO_ME"
                          ? "border-transparent bg-primary text-primary-fg "
                          : "border-line-strong hover:bg-surface-3 "
                      }`}
                    >
                      <ArrowUpRight className="size-4 inline-block align-[-2px]" aria-hidden /> Presté plata
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="loanalta-cash" className="block text-sm font-medium">
                    {direction === "I_OWE"
                      ? "¿Dónde entró la plata? *"
                      : "¿De qué cuenta salió? *"}
                  </label>
                  {cashAccounts.length === 0 ? (
                    <p className="mt-1 text-xs rounded-md bg-warning/10 text-warning px-3 py-2">
                      No hay cuentas de banco o efectivo: creá una primero para
                      poder registrar el desembolso.
                    </p>
                  ) : (
                    <select
                      id="loanalta-cash"
                      value={cashId}
                      onChange={(e) => setCashId(e.target.value)}
                      className="mt-1 w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                    >
                      {cashAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <p className="text-sm font-medium mb-1">Sistema *</p>
                  <div className="grid grid-cols-2 gap-2">
                    {SYSTEMS.map((option) => (
                      <button
                        key={option.value}
                        id={`loanalta-system-${option.value}`}
                        type="button"
                        aria-pressed={system === option.value}
                        onClick={() => setSystem(option.value)}
                        className={`rounded-md py-2 text-xs font-medium border ${
                          system === option.value
                            ? "border-transparent bg-primary text-primary-fg "
                            : "border-line-strong hover:bg-surface-3 "
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {AMORTIZATION_SYSTEM_LABEL[system]}
                    {system === "INTEREST_ONLY" &&
                      ": el interés va mes a mes; el capital se cancela aparte."}
                  </p>
                </div>

                {preview ? (
                  <div
                    id="loanalta-preview"
                    className="rounded-md bg-transfer/10 px-4 py-3 text-sm"
                  >
                    <p className="font-bold text-transfer ">
                      {count.trim()}{" "}
                      {Number(count.trim()) === 1 ? "cuota" : "cuotas"} de{" "}
                      {formatMoney(preview.payment)}
                    </p>
                    <p className="mt-1 text-transfer ">
                      Total a {verb}: <b>{formatMoney(preview.totalPaid)}</b>
                    </p>
                    <p className="mt-1 text-transfer ">
                      Interés: {formatMoney(preview.totalInterest)} (
                      {formatPercent(preview.interestSharePercent)} del total)
                    </p>
                    {/* La tasa: DEDUCIDA en los modos por cuota y por total
                        (o sea, lo que la persona NO tuvo que calcular). */}
                    <p
                      id="loanalta-preview-rate"
                      className="mt-1 text-transfer "
                    >
                      {mode === "RATE" ? "Tasa" : "Te sale al"}{" "}
                      <b>{formatPercent(preview.tnaPercent)}</b> anual
                    </p>
                    {preview.exact === false && (
                      <p className="mt-1 text-xs text-transfer ">
                        Con esa tasa la cuota queda en{" "}
                        {formatMoney(preview.payment)}: es el valor más cercano
                        que la tasa guardada permite.
                      </p>
                    )}
                    {system === "AMERICAN" && (
                      <p className="mt-1 text-xs text-transfer ">
                        La primera cuota es sólo interés: el capital se paga en
                        el cierre.
                      </p>
                    )}
                  </div>
                ) : (
                  !previewError && (
                    <p className="text-xs text-fg-muted rounded-md border border-dashed border-line-strong px-3 py-3">
                      {mode === "RATE"
                        ? "La vista previa aparece cuando cargues el monto, la tasa y la cantidad de cuotas."
                        : "La vista previa aparece cuando cargues el monto, la cantidad de cuotas y lo que vas a pagar."}
                    </p>
                  )
                )}
              </div>
            </div>
          </form>
        </div>

        {/* Pie: hermano del área que scrollea (`flex-none`, no `sticky`).
            El botón de guardar referencia al formulario (`#loan-form`) con
            `form=`, así el pie puede vivir fuera del `<form>`. */}
        <div className="flex-none px-6 pb-6 pt-4 space-y-3 bg-surface-2 ">
              {/* El error de la VISTA PREVIA va en el PIE, no en la columna de
                  la derecha: el pie está SIEMPRE a la vista (aunque el
                  formulario scrollee) y el error de la cuota insuficiente es
                  justo el que la persona tiene que ver sin scrollear. La banda
                  crece con el aviso: no lo desborda. */}
              {previewError && (
                <p
                  id="loanalta-preview-error"
                  role="alert"
                  className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
                >
                  {previewError}
                </p>
              )}

              {error && (
                <p
                  id="loanalta-error"
                  role="alert"
                  className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
                >
                  {error}
                </p>
              )}

              {/* Aviso de descarte: «Cancelar» NUNCA descarta en silencio.
                  Es la confirmación en línea, en dos pasos —jamás un
                  `window.confirm`: el driver de los tests no tiene nodo que
                  conteste y el hilo de JS se bloquea (trampa 16). */}
              {discardWarning && (
                <div
                  id="loanalta-discard-warning"
                  role="alert"
                  className="text-sm rounded-lg bg-warning/10 text-warning px-3 py-2"
                >
                  <p>Si cerrás ahora se pierde lo que cargaste.</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      id="loanalta-discard-cancel"
                      type="button"
                      onClick={() => setDiscardWarning(false)}
                      className="rounded-lg border border-warning/40 px-3 py-1 text-xs font-medium"
                    >
                      Seguir editando
                    </button>
                    <button
                      id="loanalta-discard-confirm"
                      type="button"
                      onClick={onClose}
                      className="rounded-lg bg-danger hover:bg-danger/90 text-primary-fg px-3 py-1 text-xs font-bold"
                    >
                      Descartar
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  id="loanalta-cancel"
                  type="button"
                  onClick={() => setDiscardWarning(true)}
                  className="flex-1 rounded-md border border-line-strong py-3 font-medium"
                >
                  Cancelar
                </button>
                <button
                  id="loanalta-submit"
                  type="submit"
                  form="loan-form"
                  // ─────────────────────────────────────────────────────────────
                  // POR QUÉ NO SE APAGA EL BOTÓN SIN CUENTAS DE DINERO
                  // ─────────────────────────────────────────────────────────────
                  // Antes el botón quedaba DESHABILITADO cuando no había
                  // cuentas de banco o efectivo, y la única explicación («No
                  // hay cuentas de banco o efectivo: creá una primero…») vive
                  // en la columna de la derecha: a 320 px esa columna está
                  // DEBAJO del pliegue. El resultado era un botón muerto sin
                  // motivo a la vista.
                  //
                  // Ahora el botón valida y EXPLICA: el mensaje ya existe
                  // («Necesitás una cuenta de banco o efectivo…») y se muestra
                  // en el PIE, que está siempre a la vista (es el mismo
                  // criterio con el que el error de la vista previa vive en el
                  // pie y no en la columna). La regla NO cambia: sin cuentas de
                  // dinero no se crea el préstamo.
                  // ─────────────────────────────────────────────────────────────
                  disabled={saving}
                  className="flex-1 rounded-md py-3 font-bold text-primary-fg bg-transfer hover:bg-transfer/90 disabled:opacity-50"
                >
                  {saving ? "Creando…" : "Crear préstamo"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
          {/* ── Paso 2: el desembolso, explícito ─────────────────────────── */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
          <div className="flex flex-col gap-4">
            <div className="rounded-md bg-transfer/10 px-4 py-3 text-sm text-transfer ">
              <p className="font-bold">
                Un último paso: registrar el desembolso de{" "}
                {created
                  ? // `formatAmountInput` YA devuelve el monto formateado
                    // ("$ 500.000,00"): envolverlo en `formatMoney` lo
                    // reinterpretaría como número y mostraría NaN.
                    (formatAmountInput(created.principal) ?? created.principal)
                  : "0"}
              </p>
              <p className="mt-1">
                {direction === "I_OWE"
                  ? "El préstamo ya existe. La plata entró a tu cuenta: registrá esa transferencia para que la deuda viva no mienta."
                  : "El préstamo ya existe. La plata salió de tu cuenta: registrá esa transferencia para que conste lo que te deben."}
              </p>
              <p className="mt-1 text-xs">
                Es una transferencia entre tus cuentas: no es un gasto ni un
                ingreso.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="loanalta-disburse-date"
                  className="block text-sm font-medium"
                >
                  Fecha del desembolso
                </label>
                <input
                  id="loanalta-disburse-date"
                  type="date"
                  value={disburseDate}
                  onChange={(e) => {
                    setDisburseDate(e.target.value);
                    clearDateInputIfEmptied(e.target);
                  }}
                  className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                />
              </div>
              <div>
                <label htmlFor="loanalta-cash" className="block text-sm font-medium">
                  {direction === "I_OWE" ? "Cuenta que lo recibió" : "Cuenta que lo prestó"}
                </label>
                <select
                  id="loanalta-cash"
                  value={cashId}
                  onChange={(e) => setCashId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
                >
                  {cashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-none px-6 pb-6 pt-4 space-y-3 bg-surface-2 ">
              {error && (
                <p
                  id="loanalta-error"
                  role="alert"
                  className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  id="loanalta-disburse-skip"
                  type="button"
                  onClick={skipDisburse}
                  disabled={saving}
                  className="flex-1 rounded-md border border-line-strong py-3 font-medium disabled:opacity-50"
                >
                  Ahora no
                </button>
                <button
                  id="loanalta-disburse-go"
                  type="button"
                  onClick={handleDisburse}
                  disabled={saving}
                  className="flex-1 rounded-md py-3 font-bold text-primary-fg bg-success hover:bg-success/90 disabled:opacity-50"
                >
                  {saving ? "Registrando…" : "Registrar el desembolso"}
                </button>
              </div>
            </div>
          </div>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
