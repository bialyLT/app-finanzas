"use client";

import { useEffect, useState } from "react";
import { cardDaysError } from "@/lib/card-form";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { todayCalendar } from "@/lib/dates";
import {
  ACCOUNT_KIND_LABEL,
  type AccountBalanceDTO,
  type AccountKindDTO,
  type CurrencyDTO,
  type LoanPreviewDTO,
} from "@/lib/finance";
import { formatPercent } from "@/lib/format";
import { formatAmountInput, formatMoney, toCents } from "@/lib/format";
import { CreditCard, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Props {
  onClose: () => void;
  onSaved: () => void;
  /**
   * La cuenta a editar, o `null` para crear una nueva.
   *
   * En edición el formulario sólo toca lo que el PATCH de cuentas acepta:
   * nombre y moneda. El resto de la ficha (saldo inicial, parámetros de
   * tarjeta y de préstamo) tiene sus propios caminos y no se reescribe acá.
   */
  account?: AccountBalanceDTO | null;
}

/**
 * ¿La cuenta ya tiene historia?
 *
 * `inflow`/`outflow` son la suma de TODO lo que entró y salió (en valores
 * absolutos), así que un movimiento alcanza para que una de las dos no sea
 * cero. Es la señal que la UI puede ver sin una consulta extra; el candado de
 * verdad —movimientos, reglas, planes de tarjeta, cuotas— vive en la base y
 * responde 409. Acá se usa sólo para no OFRECER un cambio que la otra capa va
 * a rechazar en el caso más común.
 */
function hasHistory(account: AccountBalanceDTO): boolean {
  // Un préstamo nace con su cronograma materializado: aunque todavía no tenga
  // movimientos, la moneda ya está atada a las cuotas.
  if (account.kind === "LOAN" || account.kind === "RECEIVABLE") return true;

  return toCents(account.inflow) > 0 || toCents(account.outflow) > 0;
}

const KIND_ORDER: AccountKindDTO[] = ["CASH", "BANK", "CREDIT_CARD", "LOAN"];

/** Explicación de cada tipo, para que elegir no sea adivinar. */
const KIND_HELP: Record<AccountKindDTO, string> = {
  CASH: "Plata que tenés encima: efectivo, billetera, caja de ahorro.",
  BANK: "Cuenta bancaria o billetera virtual (Mercado Pago, Ualá).",
  CREDIT_CARD:
    "Es deuda, no plata. Lo que gastás con la tarjeta se suma a lo que debés.",
  LOAN: "Plata que te prestaron y tenés que devolver con interés.",
  RECEIVABLE:
    "Plata que prestaste y te tienen que devolver: es un activo, no una deuda.",
};

export default function AccountForm({ onClose, onSaved, account = null }: Props) {
  const editing = account !== null;

  const [name, setName] = useState(account?.name ?? "");
  const [kind, setKind] = useState<AccountKindDTO>(account?.kind ?? "BANK");
  const [currency, setCurrency] = useState<CurrencyDTO>(
    account?.currency ?? "ARS",
  );
  const [openingBalance, setOpeningBalance] = useState(
    account?.openingBalance ?? "",
  );

  // ── La banderita: «contar este saldo como ingreso de este mes» ───────────
  //
  // El saldo inicial sigue siendo un STOCK (la plata que ya tenías). La
  // banderita no cambia el modelo: dice en qué MES esa plata cuenta como
  // ingreso. Apagada (el default) es el comportamiento de siempre.
  const [declareIncome, setDeclareIncome] = useState(false);
  const [incomeMonth, setIncomeMonth] = useState(() => todayCalendar().slice(0, 7));

  // Parámetros del préstamo.
  const [principal, setPrincipal] = useState("");
  const [tnaPercent, setTnaPercent] = useState("");
  const [installmentCount, setInstallmentCount] = useState("");
  const [firstInstallmentDate, setFirstInstallmentDate] = useState("");

  // Parámetros de la tarjeta (sólo si kind = CREDIT_CARD).
  const [closingDay, setClosingDay] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [creditLimit, setCreditLimit] = useState("");

  const [preview, setPreview] = useState<LoanPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /**
   * Los campos a los que pertenece el error de validación. Se usa para
   * `aria-invalid` + `aria-describedby`: el error se muestra al pie, pero el
   * campo que lo causó tiene que poder encontrarse (y anunciarse) sin recorrer
   * el modal entero.
   */
  const [errorFields, setErrorFields] = useState<string[]>([]);

  const isLoan = kind === "LOAN";
  const isCard = kind === "CREDIT_CARD";
  // La banderita sólo existe en las cuentas de DINERO: en una tarjeta o un
  // préstamo ese saldo es una deuda, y una deuda no es un ingreso.
  const isMoney = kind === "CASH" || kind === "BANK";

  // En edición, la moneda de una cuenta con historia es INMUTABLE: cambiarla
  // reescribiría el significado de todos sus movimientos sin tocar una fila.
  // La base lo hace cumplir con un trigger; la UI no ofrece el cambio.
  const currencyLocked = account !== null && hasHistory(account);

  // ── Vista previa del préstamo ──────────────────────────────────────────────
  // Se pide al servidor DESPUÉS de que la persona deja de escribir (300 ms), no
  // en cada tecla. Cada consulta es un viaje de ida y vuelta, y disparar una por
  // carácter ("5", "50", "500", "5000"…) es castigar al servidor con tres
  // consultas que ya no le importan a nadie.
  //
  // El cálculo NO se hace acá. Ver app/api/loans/preview/route.ts: si el
  // formulario reimplementara la fórmula, podría mostrar una cuota distinta a la
  // que después guarda la app.
  const previewReady =
    isLoan &&
    principal.trim() !== "" &&
    tnaPercent.trim() !== "" &&
    installmentCount.trim() !== "";

  // Si el formulario deja de tener los datos completos, la vista previa se
  // descarta EN EL MISMO render (patrón de la doc de React: «adjusting some
  // state when a prop changes»). Antes lo hacía el efecto, y ese `setState`
  // síncrono encadenaba un render (regla `react-hooks/set-state-in-effect`).
  const [wasPreviewReady, setWasPreviewReady] = useState(previewReady);
  if (wasPreviewReady !== previewReady) {
    setWasPreviewReady(previewReady);
    if (!previewReady) {
      setPreview(null);
      setPreviewError("");
    }
  }

  useEffect(() => {
    if (!previewReady) return;

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          principal,
          tnaPercent,
          installmentCount,
        });
        const response = await fetch(`/api/loans/preview?${params}`);

        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          setPreviewError(body.error ?? "No se pudo calcular la cuota.");
          setPreview(null);
          return;
        }

        setPreview((await response.json()) as LoanPreviewDTO);
        setPreviewError("");
      } catch {
        setPreviewError("No se pudo calcular la cuota.");
        setPreview(null);
      }
    }, 300);

    // Cancelar el envío pendiente si el componente se desmonta o los valores
    // cambian antes de que se cumpla el tiempo. Sin esto, una respuesta lenta de
    // una consulta vieja puede llegar DESPUÉS de una nueva y sobrescribirla con
    // datos obsoletos.
    return () => clearTimeout(timer);
  }, [previewReady, principal, tnaPercent, installmentCount]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setErrorFields([]);

    if (!name.trim()) {
      setError("Poné un nombre para reconocer la cuenta.");
      setErrorFields(["acc-name"]);
      return;
    }

    // En edición el formulario no muestra los campos de préstamo ni de tarjeta:
    // no hay nada que validar de ellos.
    if (!editing && isLoan) {
      const missing: string[] = [];
      const fields: string[] = [];
      if (!principal.trim()) {
        missing.push("el monto prestado");
        fields.push("loan-principal");
      }
      if (!tnaPercent.trim()) {
        missing.push("la tasa (TNA)");
        fields.push("loan-tna");
      }
      if (!installmentCount.trim()) {
        missing.push("la cantidad de cuotas");
        fields.push("loan-count");
      }
      // La fecha dejó de ser opcional con la Fase 4: sin ella no se puede
      // materializar el cronograma (la API la exige con un 400).
      if (!firstInstallmentDate.trim()) {
        missing.push("la fecha de la primera cuota");
        fields.push("loan-first");
      }
      if (missing.length > 0) {
        setError(`Falta ${missing.join(", ")}.`);
        setErrorFields(fields);
        return;
      }
    }

    if (!editing && isCard) {
      const daysError = cardDaysError(closingDay, dueDay);
      if (daysError) {
        setError(daysError);
        setErrorFields(["acc-card-closing", "acc-card-due"]);
        return;
      }
    }

    setSaving(true);
    try {
      // Edición: sólo nombre y moneda (lo que acepta el PATCH). El saldo
      // inicial no se reescribe —cambiarlo reescribiría el patrimonio— y la
      // moneda bloqueada no se manda: la base la rechazaría con 409.
      const payload = editing
        ? {
            id: account!.id,
            name: name.trim(),
            ...(currencyLocked ? {} : { currency }),
          }
        : {
            name: name.trim(),
            kind,
            currency,
            openingBalance: openingBalance.trim() || "0",
            ...(isLoan
              ? {
                  principal,
                  tnaPercent,
                  installmentCount,
                  firstInstallmentDate,
                }
              : {}),
            // Sólo si la tarjeta tiene los dos días: la API exige el par completo
            // (o ninguno). El límite viaja solo y es opcional.
            ...(isCard && closingDay.trim() && dueDay.trim()
              ? { closingDay: Number(closingDay), dueDay: Number(dueDay) }
              : {}),
            ...(isCard && creditLimit.trim() ? { creditLimit } : {}),
            // La banderita: el mes en el que este saldo cuenta como ingreso.
            // Apagada no se manda nada (la cuenta queda con la bandera apagada,
            // que es su comportamiento de siempre).
            ...(isMoney && declareIncome && incomeMonth
              ? { openingIncomeMonth: incomeMonth }
              : {}),
          };

      const response = await fetch("/api/accounts", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ??
            (editing ? "No se pudo guardar la cuenta." : "No se pudo crear la cuenta."),
        );
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : editing
            ? "No se pudo guardar la cuenta."
            : "No se pudo crear la cuenta.",
      );
    } finally {
      setSaving(false);
    }
  }

  const openingPreview = formatAmountInput(openingBalance, currency);
  const limitPreview = formatAmountInput(creditLimit, currency);

  /**
   * Los atributos que ligan un campo con el error de validación del pie.
   * `aria-invalid` marca el campo y `aria-describedby` lo apunta al mensaje:
   * juntos, el lector de pantalla anuncia el motivo al llegar al campo (y no
   * sólo cuando el foco está en el pie).
   */
  const fieldProps = (id: string) => ({
    "aria-invalid": errorFields.includes(id) ? true : undefined,
    "aria-describedby": errorFields.includes(id) ? "acc-error" : undefined,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Editar cuenta" : "Nueva cuenta"}
        className="w-full sm:max-w-md max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* El panel es una columna: el encabezado y el pie son `flex-none` y
            el área del formulario scrollea con su límite EXACTO en el borde
            superior del pie. Antes el pie era `sticky` dentro del área que
            scrolleaba y los campos passaban por debajo (trampa 15): un tap
            en un campo tapado caía en el pie. */}
        <div className="flex-none px-6 pt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">
            {editing ? "Editar cuenta" : "Nueva cuenta"}
          </h2>
          <Button
            id="acc-close"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-xl leading-none text-fg-subtle hover:text-fg-muted px-2 h-auto w-auto"
            aria-label="Cerrar"
          >
            ×
          </Button>
        </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        <form id="acc-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="acc-name" className="text-sm font-medium">
              Nombre *
            </Label>
            <Input
              id="acc-name"
              autoFocus
              autoComplete="off"
              {...fieldProps("acc-name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Banco Galicia, Efectivo, Visa Santander"
              maxLength={60}
              className="mt-1 w-full rounded-md border-line-strong bg-transparent px-4 py-3 text-base"
            />
          </div>

          <div>
            <Label htmlFor="acc-kind" className="text-sm font-medium">
              Qué tipo de cuenta es *
            </Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as AccountKindDTO)}
              disabled={editing}
            >
              <SelectTrigger id="acc-kind" className="mt-1 w-full py-3">
                <SelectValue placeholder="Tipo de cuenta" />
              </SelectTrigger>
              <SelectContent>
                {KIND_ORDER.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ACCOUNT_KIND_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-fg-muted">
              {editing
                ? "El tipo de una cuenta no cambia después de crearla."
                : KIND_HELP[kind]}
            </p>
          </div>

          {/* ── La moneda ─────────────────────────────────────────────────── */}
          {/*
            La moneda es parte del SIGNIFICADO del saldo, no una etiqueta: "$
            10.000" y "US$ 10.000" son dos patrimonios distintos. Se elige al
            crear. En una cuenta con historia no se puede cambiar —la base lo
            rechaza con 409— así que el selector se bloquea y se explica por
            qué, en vez de ofrecer un camino que termina en error.
          */}
          <div>
            <Label htmlFor="acc-currency" className="text-sm font-medium">
              Moneda *
            </Label>
            <Select
              value={currency}
              onValueChange={(value) => setCurrency(value as CurrencyDTO)}
              disabled={currencyLocked}
            >
              <SelectTrigger id="acc-currency" className="mt-1 w-full py-3">
                <SelectValue placeholder="Moneda de la cuenta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                <SelectItem value="USD">Dólares (USD)</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-fg-muted">
              {currencyLocked
                ? "Esta cuenta ya tiene movimientos: la moneda no se puede cambiar. Si necesitás la otra moneda, creá una cuenta nueva."
                : "Todos los montos de esta cuenta se muestran en la moneda elegida."}
            </p>
          </div>

          {/* ── Parámetros del préstamo ──────────────────────────────────── */}
          {!editing && (isLoan ? (
            <>
              <div>
                <Label htmlFor="loan-principal" className="text-sm font-medium">
                  Cuánto te prestaron *
                </Label>
                <Input
                  id="loan-principal"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  {...fieldProps("loan-principal")}
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  placeholder="500.000"
                  className="mt-1 w-full rounded-md border-line-strong bg-transparent px-4 py-3 text-base"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="loan-tna" className="text-sm font-medium">
                    TNA % *
                  </Label>
                  <Input
                    id="loan-tna"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    {...fieldProps("loan-tna")}
                    value={tnaPercent}
                    onChange={(e) => setTnaPercent(e.target.value)}
                    placeholder="60"
                    className="mt-1 w-full rounded-md border-line-strong bg-transparent px-3 py-2.5 text-base"
                  />
                </div>
                <div>
                  <Label htmlFor="loan-count" className="text-sm font-medium">
                    Cuotas *
                  </Label>
                  <Input
                    id="loan-count"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    {...fieldProps("loan-count")}
                    value={installmentCount}
                    onChange={(e) => setInstallmentCount(e.target.value)}
                    placeholder="12"
                    className="mt-1 w-full rounded-md border-line-strong bg-transparent px-3 py-2.5 text-base"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="loan-first" className="text-sm font-medium">
                  Primera cuota *
                </Label>
                <Input
                  id="loan-first"
                  type="date"
                  {...fieldProps("loan-first")}
                  value={firstInstallmentDate}
                  onChange={(e) => {
                    setFirstInstallmentDate(e.target.value);
                    clearDateInputIfEmptied(e.target);
                  }}
                  className="mt-1 w-full rounded-md border-line-strong bg-transparent px-3 py-2.5 text-base"
                />
              </div>

              {/* ── La vista previa: acá es donde el usuario entiende ─────── */}
              {previewError && (
                <p className="text-sm rounded-lg bg-warning/10 text-warning px-3 py-2">
                  {previewError}
                </p>
              )}

              {preview && (
                <div className="rounded-md bg-transfer/10 px-4 py-3 text-sm">
                  <p className="font-bold text-transfer ">
                    {installmentCount} cuotas de{" "}
                    {formatMoney(preview.payment, { currency })}
                  </p>
                  <p className="mt-1 text-transfer ">
                    Vas a pagar en total{" "}
                    <b>{formatMoney(preview.totalPaid, { currency })}</b>.
                  </p>
                  <p className="mt-1 text-transfer ">
                    De eso,{" "}
                    <b>{formatMoney(preview.totalInterest, { currency })}</b>{" "}
                    son intereses: es lo que te cuesta el préstamo.
                  </p>
                  <p className="mt-1 text-transfer text-xs">
                    De cada 100 {currency === "USD" ? "dólares" : "pesos"} que
                    pagues,{" "}
                    <b>
                      {formatMoney(preview.interestSharePercent, {
                        withSymbol: false,
                      })}
                    </b>{" "}
                    se los queda el banco ({formatPercent(preview.interestSharePercent)}).
                    El resto baja tu deuda.
                  </p>
                </div>
              )}

              <p className="text-xs rounded-lg bg-surface-3 px-3 py-2 text-fg-muted ">
                Cuando te desembolsen la plata, se registra como una{" "}
                <b>transferencia</b> desde esta cuenta hacia tu banco. Cobrar un
                préstamo no es un ingreso: te endeudaste, no ganaste.
              </p>
            </>
          ) : (
            <>
              {/* ── Parámetros de la tarjeta ─────────────────────────────── */}
              {/* Cierre y vencimiento viajan JUNTOS (contrato de la API). El
                  límite es opcional y puede llegar después: la tarjeta puede
                  existir sin límite cargado (la utilización dice "no se sabe"
                  en vez de inventar un 0%). */}
              {isCard && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="acc-card-closing" className="text-sm font-medium">
                        Día de cierre
                      </Label>
                      <Input
                        id="acc-card-closing"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        {...fieldProps("acc-card-closing")}
                        value={closingDay}
                        onChange={(e) => setClosingDay(e.target.value)}
                        placeholder="15"
                        className="mt-1 w-full rounded-md border-line-strong bg-transparent px-3 py-2.5 text-base"
                      />
                    </div>
                    <div>
                      <Label htmlFor="acc-card-due" className="text-sm font-medium">
                        Día de vencimiento
                      </Label>
                      <Input
                        id="acc-card-due"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        {...fieldProps("acc-card-due")}
                        value={dueDay}
                        onChange={(e) => setDueDay(e.target.value)}
                        placeholder="5"
                        className="mt-1 w-full rounded-md border-line-strong bg-transparent px-3 py-2.5 text-base"
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="acc-card-limit" className="text-sm font-medium">
                      Límite de la tarjeta{" "}
                      <span className="font-normal text-fg-muted">(opcional)</span>
                    </Label>
                    <Input
                      id="acc-card-limit"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={creditLimit}
                      onChange={(e) => setCreditLimit(e.target.value)}
                      placeholder="500.000"
                      className="mt-1 w-full rounded-md border-line-strong bg-transparent px-4 py-3 text-base"
                    />
                    {limitPreview && (
                      <p className="mt-1 text-xs text-fg-muted">
                        Hasta <b>{limitPreview}</b>.
                      </p>
                    )}
                  </div>

                  <p className="text-xs rounded-lg bg-surface-3 px-3 py-2 text-fg-muted ">
                    Con el cierre y el vencimiento cargados, la app puede emitir
                    resúmenes y repartir las cuotas. Si los dejás vacíos, la
                    tarjeta existe pero no se pueden correr resúmenes — los
                    podés cargar después desde <b><CreditCard className="size-4 inline-block align-[-2px]" aria-hidden /> Tarjetas</b>.
                  </p>
                </>
              )}

              <div>
                <Label htmlFor="acc-opening" className="text-sm font-medium">
                  {isCard ? "Saldo inicial" : "Cuánta plata tiene hoy"}{" "}
                  <span className="font-normal text-fg-muted">(opcional)</span>
                </Label>
                <Input
                  id="acc-opening"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                  placeholder="0,00"
                  className="mt-1 w-full rounded-md border-line-strong bg-transparent px-4 py-3 text-base"
                />
                <p className="mt-1 text-xs text-fg-muted">
                  {openingPreview ? (
                    <>
                      Arranca con <b>{openingPreview}</b>.
                    </>
                  ) : isCard ? (
                    `Ojo: en una tarjeta el saldo negativo es deuda. Si ya debés ${formatMoney("50000", { currency })}, escribí -50.000.`
                  ) : (
                    "Sirve para empezar hoy sin cargar meses de movimientos viejos."
                  )}
                </p>
              </div>

              {/* ── La banderita ─────────────────────────────────────────── */}
              {/*
                Un botón con `role="checkbox"`, no un `<input type="checkbox">`:
                el input nativo mide 13×13 px y la regla de ergonomía del
                proyecto pide 44×44 en cualquier pantalla que se opere con el
                dedo. El botón es el control, con la fila entera de área de
                toque.
              */}
              {isMoney && (
                <div className="rounded-md border border-line border-line-strong p-3">
                  <button
                    type="button"
                    id="acc-declare-income"
                    role="checkbox"
                    aria-checked={declareIncome}
                    onClick={() => setDeclareIncome((valor) => !valor)}
                    className="flex w-full items-center gap-3 min-h-11 text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg border-2 ${
                        declareIncome
                          ? "border-transfer bg-transfer text-primary-fg"
                          : "border-line-strong text-fg-subtle"
                      }`}
                    >
                      <Check className="size-4" aria-hidden />
                    </span>
                    <span className="text-sm font-medium">
                      Contar este saldo como ingreso de este mes
                    </span>
                  </button>

                  <p className="mt-2 text-xs text-fg-muted">
                    Sirve cuando cargás una cuenta con la plata que ya tenías y no
                    querés que el mes te quede en rojo. El saldo NO cambia: sólo
                    se dice en qué mes esa plata cuenta como ingreso.
                  </p>

                  {declareIncome && (
                    <div className="mt-3">
                      <label
                        htmlFor="acc-income-month"
                        className="text-sm font-medium"
                      >
                        Mes en el que cuenta como ingreso
                      </label>
                      <input
                        id="acc-income-month"
                        type="month"
                        value={incomeMonth}
                        onChange={(e) => setIncomeMonth(e.target.value)}
                        className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-3 outline-none focus:ring-2 focus:ring-focus"
                      />
                      <p className="mt-1 text-xs text-fg-muted">
                        Por defecto, el mes en que creás la cuenta. Si la plata es
                        de un mes anterior, elegí ese mes.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ))}

        </form>
        </div>

        {/* Pie: hermano del área que scrollea (no `sticky` dentro de
            ella). Es `flex-none`: su altura es la suya y el botón de
            guardar nunca se pierde. El botón referencia al formulario
            (`#acc-form`) con `form=`, así el pie puede vivir fuera del
            `<form>`. */}
        <div className="flex-none px-6 pb-6 pt-4 space-y-3 bg-surface-2 ">
            {error && (
              <p
                id="acc-error"
                role="alert"
                aria-live="polite"
                className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <Button
                id="acc-cancel"
                variant="outline"
                onClick={onClose}
                className="flex-1 py-3"
              >
                Cancelar
              </Button>
              <Button
                id="acc-submit"
                type="submit"
                form="acc-form"
                variant="secondary"
                disabled={saving}
                className="flex-1 py-3 bg-transfer hover:bg-transfer/90 text-primary-fg"
              >
                {saving
                  ? editing
                    ? "Guardando…"
                    : "Creando…"
                  : editing
                    ? "Guardar cambios"
                    : "Crear cuenta"}
              </Button>
            </div>
          </div>
      </div>
    </div>
  );
}
