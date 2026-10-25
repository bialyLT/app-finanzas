"use client";

import { useEffect, useMemo, useState } from "react";
import { Star } from "lucide-react";
import { findCategoryByName, searchCategories } from "@/lib/category-search";
import { movePaletteIndex } from "@/lib/command-palette";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { addDays, todayCalendar } from "@/lib/dates";
import type { DescriptionSuggestionDTO } from "@/lib/description-suggestions";
import {
  type AccountBalanceDTO,
  type CategoryDTO,
  type FavoriteDTO,
  type MovementDTO,
  type MovementKindDTO,
} from "@/lib/finance";
import { formatAmountInput, formatLiability, formatMoney } from "@/lib/format";
import {
  browserStorage,
  canBeSourceAccount,
  readLastAccountId,
  resolveSourceAccount,
  writeLastAccountId,
} from "@/lib/quick-entry";

interface Props {
  /** El tipo con el que abre el modal (después se puede cambiar adentro). */
  kind: MovementKindDTO;
  accounts: AccountBalanceDTO[];
  /** TODAS las categorías (de los dos tipos): el selector cambia de tipo solo. */
  categories: CategoryDTO[];
  /** Cuenta preseleccionada, si la pantalla viene de "cargar un gasto acá". */
  defaultAccountId?: string;
  /**
   * Plantilla desde la que se abrió el formulario, si la pantalla viene de un
   * favorito. Precarga el formulario; NO guarda nada hasta que la persona
   * confirma.
   */
  favorite?: FavoriteDTO | null;
  /** Se llama cuando se guarda una plantilla nueva desde el formulario. */
  onFavoriteSaved?: (favorite: FavoriteDTO) => void;
  onClose: () => void;
  /** Recibe el movimiento guardado: el panel lo usa para el "Deshacer". */
  onSaved: (movement: MovementDTO) => void;
}

/**
 * Cómo se ve cada tipo de movimiento.
 *
 * `TRANSFER` tiene su propio color (azul) y no comparte el verde ni el rojo a
 * propósito: una transferencia no es plata que entra ni plata que sale, y
 * pintarla como cualquiera de las dos sería comunicar lo contrario de lo que el
 * modelo dice.
 */
const KIND_STYLE: Record<
  MovementKindDTO,
  { title: string; accent: string; focus: string; badge: string; tab: string }
> = {
  INCOME: {
    title: "＋ Nuevo ingreso",
    accent: "text-success",
    focus: "focus:ring-focus",
    badge: "bg-success hover:bg-success/90",
    tab: "bg-success text-primary-fg",
  },
  EXPENSE: {
    title: "－ Nuevo gasto",
    accent: "text-danger",
    focus: "focus:ring-focus",
    badge: "bg-danger hover:bg-danger/90",
    tab: "bg-danger text-primary-fg",
  },
  TRANSFER: {
    title: "⇄ Nueva transferencia",
    accent: "text-transfer",
    focus: "focus:ring-focus",
    badge: "bg-transfer hover:bg-transfer/90",
    tab: "bg-transfer text-primary-fg",
  },
};

/**
 * Las tres pestañas del selector de tipo, con su `id` estable.
 *
 * El selector existe para la carga rápida: elegir "Ingreso" por error y no
 * poder corregirlo sin cerrar y volver a abrir era un toque de más en cada
 * carga. Los ids son los que usan los flows para elegir sin depender del texto
 * visible.
 */
const KIND_TABS: { kind: MovementKindDTO; id: string; label: string }[] = [
  { kind: "EXPENSE", id: "tx-kind-gasto", label: "Gasto" },
  { kind: "INCOME", id: "tx-kind-ingreso", label: "Ingreso" },
  { kind: "TRANSFER", id: "tx-kind-transferencia", label: "Transferencia" },
];

/** Etiqueta de una cuenta en el selector: nombre y cuánta plata tiene. */
function accountLabel(account: AccountBalanceDTO): string {
  // En una cuenta de deuda se muestra la deuda con su palabra: "debe
  // $ 50.000" cuando se debe y "a favor $ 50.000" cuando se pagó de más
  // (ver `formatLiability`). "Visa · −$ 50.000" se lee como un error.
  const amount = account.isLiability
    ? formatLiability(account.debt ?? "0.00")
    : formatMoney(account.balance);
  return `${account.name} · ${amount}`;
}

/**
 * Cuenta de destino por defecto: la primera que NO sea el origen.
 *
 * Devolver `""` no es una opción válida —el `<option>` vacío no existe— así que
 * si sólo hay una cuenta el resultado también es `""` y el formulario muestra el
 * aviso de que hacen falta dos cuentas para transferir.
 */
function pickDestinationAccount(
  accounts: AccountBalanceDTO[],
  sourceId: string,
): string {
  return accounts.find((account) => account.id !== sourceId)?.id ?? "";
}

/**
 * La cuenta de origen con la que abre el formulario.
 *
 * La plantilla gana sobre `defaultAccountId`: abrir un favorito es una acción
 * explícita y su cuenta es parte de lo guardado. `resolveSourceAccount` vuelve
 * a validar que la cuenta siga existiendo y sirva para el tipo, así que un
 * favorito viejo no puede dejar el select en un estado inválido.
 */
function resolveInitialSource(
  kind: MovementKindDTO,
  accounts: AccountBalanceDTO[],
  defaultAccountId: string | undefined,
  favorite: FavoriteDTO | null,
): string {
  return resolveSourceAccount(kind, accounts, {
    preferred: favorite?.account.id ?? defaultAccountId,
    lastUsedId: readLastAccountId(browserStorage(), kind),
  });
}

/** Cuenta de destino inicial de un favorito de transferencia, si sigue válida. */
function resolveInitialDestination(
  accounts: AccountBalanceDTO[],
  sourceId: string,
  favorite: FavoriteDTO | null,
): string {
  const saved = favorite?.toAccount
    ? accounts.find(
        (account) =>
          account.id === favorite.toAccount?.id && account.id !== sourceId,
      )
    : null;
  return saved?.id ?? pickDestinationAccount(accounts, sourceId);
}

export default function TransactionForm({
  kind: initialKind,
  accounts,
  categories,
  defaultAccountId,
  favorite = null,
  onFavoriteSaved,
  onClose,
  onSaved,
}: Props) {
  // ── El tipo activo ─────────────────────────────────────────────────────────
  // Arranca con el del modal y se puede CAMBIAR acá adentro sin cerrar: los
  // datos ya escritos (monto, fecha, nota, categoría) no se pierden, y la
  // cuenta se conserva si sigue siendo válida para el tipo nuevo.
  const [kind, setKind] = useState<MovementKindDTO>(initialKind);
  const style = KIND_STYLE[kind];

  // ── "Hoy" y "Ayer" ─────────────────────────────────────────────────────────
  // `todayCalendar()` una sola vez al montar (no en cada render: el "hoy" de
  // un formulario abierto no cambia a medianoche). `addDays` hace la aritmética
  // de calendario — jamás `toISOString()`, que convierte a UTC y de noche
  // devuelve el día siguiente.
  const [today] = useState(() => todayCalendar());
  const yesterday = useMemo(() => addDays(today, -1), [today]);

  // ── Cuenta de origen por defecto ───────────────────────────────────────────
  // La última usada para este tipo (recordada en `localStorage`), y si no hay
  // ninguna válida, la primera cuenta válida. La resolución completa —con la
  // tolerancia a ids borrados o inválidos— vive en `resolveSourceAccount`
  // (lib/quick-entry.ts), que es pura y está testeada.
  const [accountId, setAccountId] = useState(() =>
    resolveInitialSource(initialKind, accounts, defaultAccountId, favorite),
  );

  // ── Cuenta de destino (sólo transferencias) ────────────────────────────────
  // Arranca con la primera cuenta que NO sea el origen.
  //
  // La primera versión dejaba el destino vacío ("Elegí una cuenta…") para forzar
  // una elección consciente. En la práctica sólo agrega un toque obligatorio al
  // caso más común —pasar plata del banco al efectivo— y deja el formulario en
  // un estado inválido que la validación tiene que rechazar después. Con un
  // destino válido preseleccionado, guardar funciona en un solo toque.
  const [toAccountId, setToAccountId] = useState(() => {
    const sourceId = resolveInitialSource(
      initialKind,
      accounts,
      defaultAccountId,
      favorite,
    );
    return resolveInitialDestination(accounts, sourceId, favorite);
  });

  const [date, setDate] = useState(() => todayCalendar());
  // La plantilla guarda el monto normalizado ("1234.56") y el campo muestra
  // coma decimal, igual que al tipear y que la precarga de sugerencias: un solo
  // formato visible para el mismo dato.
  const [amount, setAmount] = useState(() =>
    favorite?.amount ? favorite.amount.replace(".", ",") : "",
  );
  const [categoryName, setCategoryName] = useState(
    () => favorite?.category?.name ?? "",
  );
  /**
   * Si la persona ya tocó el campo de categoría.
   *
   * Las sugerencias de "últimas usadas" no se muestran hasta ese momento: son
   * una ayuda para cuando se está eligiendo categoría, y en reposo empujarían
   * la fecha y la nota ~38px hacia abajo — justo lo que hace que "Nota" quede
   * debajo del pie fijo en la pantalla de los tests (1018×597). Al enfocar el
   * campo (o al escribir, que ya implica foco) aparecen.
   */
  const [categoryTouched, setCategoryTouched] = useState(false);
  /**
   * Si la persona ya aceptó una sugerencia y la ayuda de categoría se colapsó.
   *
   * Con las sugerencias en pantalla, la fila de fecha y los chips "Hoy/Ayer"
   * bajan ~72px y caen en la banda del pie fijo, que se come esos toques; y aun
   * colapsando la lista, el aviso "✓/＋" que acompaña al nombre suma otros ~20px
   * — suficientes para dejarla dentro de la banda. Elegir una categoría y
   * después tocar "Ayer" era un no-op silencioso (la fecha no cambiaba). Al
   * aceptar una sugerencia la ayuda ya cumplió su función — y el aviso sería
   * redundante, porque toda sugerencia es una categoría existente —, así que se
   * colapsan los dos y el formulario vuelve a su geometría de reposo. Tipear de
   * nuevo la reabre (se está eligiendo otra vez).
   */
  const [categoryDismissed, setCategoryDismissed] = useState(false);
  const [description, setDescription] = useState(
    () => favorite?.description ?? "",
  );

  // ── Autocompletado de descripción ──────────────────────────────────────────
  // Las sugerencias se piden al servidor (ventana acotada, no el histórico) y
  // se dibujan en un desplegable ABSOLUTO: abrirlo no empuja ningún campo hacia
  // la banda del pie fijo (trampa 15). `dismissed` evita que el desplegable se
  // reabra solo justo después de aceptar una sugerencia: el texto aceptado
  // vuelve a matchear consigo mismo.
  const [descriptionSuggestions, setDescriptionSuggestions] = useState<
    DescriptionSuggestionDTO[]
  >([]);
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);

  // ── Plantilla desde la que se abrió, y "guardar como plantilla" ────────────
  const [favoriteId, setFavoriteId] = useState<string | null>(
    () => favorite?.id ?? null,
  );
  const [favoriteSourceName, setFavoriteSourceName] = useState(
    () => favorite?.name ?? "",
  );
  const [favoriteOpen, setFavoriteOpen] = useState(false);
  const [favoriteName, setFavoriteName] = useState("");
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteNotice, setFavoriteNotice] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ── Los dos avisos en línea (jamás `window.confirm`) ───────────────────────
  //
  // `discardWarning`: Escape con datos escritos no cierra de una; muestra el
  // aviso y recién el segundo Escape (o "Descartar") cierra.
  //
  // `duplicateWarning`: al guardar puede aparecer "ya hay un movimiento igual",
  // con "Guardar igual" / "Volver" en lugar de los botones normales.
  const [discardWarning, setDiscardWarning] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<MovementDTO[]>([]);

  const isTransfer = kind === "TRANSFER";
  const isIncome = kind === "INCOME";

  /**
   * ¿Hay algo escrito que se perdería al cerrar?
   *
   * Sólo cuenta el TEXTO tipeado (monto, categoría, nota): son los datos que
   * cuesta recuperar. Cambiar una fecha o elegir otra cuenta no marca sucio —
   * volver a abrir el formulario reproduce el mismo estado por defecto, y
   * advertir por eso entrenaría a la persona a ignorar el aviso.
   */
  const dirty =
    amount.trim() !== "" ||
    categoryName.trim() !== "" ||
    description.trim() !== "";

  useEffect(() => {
    if (suggestionDismissed) {
      setDescriptionSuggestions([]);
      setActiveSuggestion(-1);
      return;
    }

    const query = description.trim();
    if (query.length < 2) {
      setDescriptionSuggestions([]);
      setActiveSuggestion(-1);
      return;
    }

    // AbortController + debounce: tipear rápido no dispara un pedido por tecla
    // ni deja que una respuesta vieja pise a la nueva.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ kind, q: query, limit: "6" });
        const response = await fetch(
          `/api/transactions/suggestions?${params.toString()}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("suggestions");
        const data = (await response.json()) as {
          suggestions?: DescriptionSuggestionDTO[];
        };
        if (controller.signal.aborted) return;
        setDescriptionSuggestions(data.suggestions ?? []);
        setActiveSuggestion(-1);
      } catch {
        if (!controller.signal.aborted) {
          setDescriptionSuggestions([]);
          setActiveSuggestion(-1);
        }
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [description, kind, suggestionDismissed]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      // Un control de adentro que YA consumió el Escape lo marca con
      // `preventDefault` (el autocompletado de descripción cierra su
      // desplegable así). Acá se respeta: sin esta guarda, Escape con el
      // desplegable abierto abría el aviso de descarte y el formulario
      // parecía pedir "descartar" cuando sólo se cerró la lista.
      //
      // La guarda es por `defaultPrevented` y NO por `stopPropagation`: en
      // Next.js el contenedor raíz de React es el propio `document`, así que
      // este listener y el delegado de React viven en el MISMO nodo y
      // `stopPropagation` no detiene a los demás listeners del nodo. El flag
      // de `preventDefault`, en cambio, queda puesto para todos.
      if (event.defaultPrevented) return;

      if (!dirty || discardWarning) {
        onClose();
        return;
      }
      setDiscardWarning(true);
    }

    // Listener de documento y no `onKeyDown` del overlay: con el foco en el
    // botón de guardar (o en el body, después de un clic), el evento no
    // burbujea por el árbol del modal. Éste es el único camino que garantiza
    // que Escape SIEMPRE haga algo.
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dirty, discardWarning, onClose]);

  // Cuentas que pueden recibir el dinero en una transferencia: todas menos la de
  // origen. Ofrecer la misma cuenta obligaría a la base a rechazar el movimiento
  // y el usuario vería un error que podría haber evitado el formulario.
  const destinationOptions = useMemo(
    () => accounts.filter((a) => a.id !== accountId),
    [accounts, accountId],
  );

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const amountPreview = formatAmountInput(amount);

  // ── Categorías: del tipo activo, ordenadas por búsqueda + recencia ─────────
  const kindCategories = useMemo(
    () =>
      categories.filter((category) =>
        isIncome ? category.kind === "INCOME" : category.kind === "EXPENSE",
      ),
    [categories, isIncome],
  );

  const suggestions = useMemo(
    () => searchCategories(kindCategories, categoryName),
    [kindCategories, categoryName],
  );

  // El aviso de "existente"/"nueva" se compara contra TODAS las categorías y no
  // sólo las del tipo activo: el servidor deduplica por `normalizedName`, que es
  // único en toda la tabla — el aviso tiene que decir lo que va a pasar de
  // verdad (ver `findCategoryByName`).
  const categoryExists = useMemo(
    () => findCategoryByName(categories, categoryName) !== null,
    [categories, categoryName],
  );

  /** El chequeo de duplicados ya no aplica si cambió un dato del criterio. */
  function clearDuplicateWarning() {
    setDuplicateWarning((current) => (current.length > 0 ? [] : current));
  }

  /** ¿El desplegable de descripciones está visible ahora mismo? */
  const showDescriptionSuggestions =
    descriptionFocused &&
    !suggestionDismissed &&
    descriptionSuggestions.length > 0;

  /**
   * Acepta una sugerencia de descripción.
   *
   * Precarga categoría, cuenta y (sólo si el monto está vacío) el monto típico.
   * El monto se preserva si la persona ya escribió uno: una sugerencia es una
   * ayuda, no una decisión sobre la plata. Para TRANSFER también precarga el
   * destino. No guarda nada.
   */
  function acceptDescriptionSuggestion(suggestion: DescriptionSuggestionDTO) {
    if (suggestion.kind !== kind) return;

    setDescription(suggestion.description);
    setSuggestionDismissed(true);
    setDescriptionSuggestions([]);
    setActiveSuggestion(-1);

    if (amount.trim() === "") {
      // El servidor manda decimal exacto (1500.00). Se muestra con coma, sin
      // separador de miles, para que el parser lo lea como el mismo número.
      setAmount(suggestion.amount.replace(".", ","));
    }

    if (!isTransfer && suggestion.category) {
      setCategoryName(suggestion.category.name);
      // La ayuda de categoría ya cumplió: colapsarla mantiene la geometría de
      // reposo y evita la zona muerta del pie (trampa 15).
      setCategoryDismissed(true);
    }

    const source = accounts.find(
      (account) => account.id === suggestion.account.id,
    );
    if (source && canBeSourceAccount(kind, source)) {
      setAccountId(source.id);
      if (isTransfer) {
        const destination = suggestion.toAccount
          ? accounts.find(
              (account) =>
                account.id === suggestion.toAccount?.id &&
                account.id !== source.id,
            )
          : null;
        setToAccountId(
          destination?.id ?? pickDestinationAccount(accounts, source.id),
        );
      }
    }

    clearDuplicateWarning();
  }

  /**
   * Guarda el formulario actual como plantilla.
   *
   * Es una acción EXPLÍCITA y separada de "Guardar movimiento": la plantilla no
   * toca totales ni crea un movimiento. El servidor valida nombre único, tope y
   * referencias; acá sólo se cortan los errores obvios antes de viajar.
   */
  async function saveFavorite() {
    if (favoriteSaving) return;
    setFavoriteError("");
    setFavoriteNotice("");

    if (!favoriteName.trim()) {
      setFavoriteError("Poné un nombre para la plantilla.");
      return;
    }
    if (amount.trim() !== "" && !amountPreview) {
      setFavoriteError("El monto no se entiende. Corregilo o dejalo vacío.");
      return;
    }
    if (!accountId) {
      setFavoriteError("Elegí una cuenta.");
      return;
    }

    setFavoriteSaving(true);
    try {
      const response = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: favoriteName.trim(),
          kind,
          amount: amount.trim() === "" ? null : amount,
          description,
          categoryName: isTransfer ? null : categoryName.trim(),
          accountId,
          toAccountId: isTransfer ? toAccountId : null,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<FavoriteDTO> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo guardar la plantilla.");
      }

      setFavoriteNotice(`Plantilla “${favoriteName.trim()}” guardada.`);
      setFavoriteName("");
      setFavoriteOpen(false);
      onFavoriteSaved?.(data as FavoriteDTO);
    } catch (err) {
      setFavoriteError(
        err instanceof Error ? err.message : "No se pudo guardar la plantilla.",
      );
    } finally {
      setFavoriteSaving(false);
    }
  }

  /**
   * Cambiar de tipo sin cerrar el modal.
   *
   * Regla: NADA de lo escrito se pierde. El monto, la fecha, la nota y el texto
   * de la categoría quedan como estaban. La cuenta de origen se conserva si
   * sigue siendo un origen válido para el tipo nuevo (una tarjeta sirve para un
   * gasto, no para un ingreso) y, si no, se vuelve a resolver como al abrir:
   * última usada de ese tipo, o la primera válida.
   */
  function switchKind(next: MovementKindDTO) {
    if (next === kind) return;

    setKind(next);
    setError("");
    setDuplicateWarning([]);
    // La plantilla era de OTRO tipo: usarla para este movimiento ya no es
    // "usar la plantilla". Se limpia la marca (lastUsedAt no se toca).
    setFavoriteId(null);
    setFavoriteSourceName("");
    setSuggestionDismissed(true);
    setDescriptionSuggestions([]);

    const currentAccount = accounts.find((a) => a.id === accountId);
    const nextSource =
      currentAccount && canBeSourceAccount(next, currentAccount)
        ? accountId
        : resolveSourceAccount(next, accounts, {
            lastUsedId: readLastAccountId(browserStorage(), next),
          });
    setAccountId(nextSource);

    if (next === "TRANSFER") {
      // El destino tiene que existir y no ser el origen nuevo.
      setToAccountId((current) =>
        current && current !== nextSource && accounts.some((a) => a.id === current)
          ? current
          : pickDestinationAccount(accounts, nextSource),
      );
    }
  }

  /**
   * El guardado en sí (sin el chequeo de duplicados, que es un paso previo de
   * `handleSubmit` y se puede saltear con "Guardar igual").
   */
  async function postMovement() {
    const response = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        // El monto se manda TAL COMO SE ESCRIBIÓ. El servidor lo interpreta
        // con su propio parser (que conoce la convención argentina) y lo
        // convierte a decimal exacto. Mandar `Number(amount)` acá sería
        // reintroducir el error binario en el camino.
        amount,
        date,
        accountId,
        ...(isTransfer ? { toAccountId } : {}),
        // La categoría es opcional (Fase 7): vacía viaja como "" y el servidor
        // la normaliza a `null` — un movimiento sin clasificar, que los
        // reportes agrupan bajo "Sin categoría".
        ...(!isTransfer ? { categoryName: categoryName.trim() } : {}),
        description,
        // Sólo marca `lastUsedAt` en la plantilla. No altera el movimiento.
        ...(favoriteId ? { favoriteId } : {}),
      }),
    });

    const data = (await response.json().catch(() => ({}))) as Partial<MovementDTO> & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error ?? "No se pudo guardar el movimiento.");
    }

    // Recordar la cuenta para el PRÓXIMO movimiento de este tipo. Best-effort:
    // si `localStorage` no está disponible, se pierde la comodidad, no el
    // guardado (ver `writeLastAccountId`).
    writeLastAccountId(browserStorage(), kind, accountId);

    onSaved(data as MovementDTO);
    onClose();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Guarda contra el doble submit: el botón se deshabilita, pero Enter en un
    // campo puede disparar el submit igual.
    if (saving) return;
    setError("");

    if (!amountPreview) {
      setError("Escribí un monto mayor a cero.");
      return;
    }
    if (!accountId) {
      setError("Elegí una cuenta.");
      return;
    }
    if (isTransfer && !toAccountId) {
      setError("Elegí a qué cuenta va la plata.");
      return;
    }

    setSaving(true);
    try {
      // ── El chequeo de duplicados: best-effort, NUNCA un bloqueo ──────────
      //
      // Antes de guardar se pregunta si ya hay algo igual (misma cuenta, mismo
      // monto, mismo día y tipo). Si lo hay, se avisa; si el chequeo FALLA
      // —la ruta no responde, la red se cayó— se guarda igual: un chequeo de
      // comodidad no puede convertirse en "no se puede guardar".
      let duplicates: MovementDTO[] = [];
      try {
        const params = new URLSearchParams({ kind, accountId, amount, date });
        const response = await fetch(`/api/transactions/duplicates?${params}`);
        if (response.ok) {
          const data = (await response.json()) as { duplicates?: MovementDTO[] };
          duplicates = data.duplicates ?? [];
        }
      } catch {
        duplicates = [];
      }

      if (duplicates.length > 0) {
        setDuplicateWarning(duplicates);
        return;
      }

      await postMovement();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  /** "Guardar igual": saltea el chequeo y guarda lo que ya está en pantalla. */
  async function saveAnyway() {
    if (saving) return;
    setError("");
    setDuplicateWarning([]);
    setSaving(true);
    try {
      await postMovement();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  // ── Sin cuentas no se puede registrar nada ─────────────────────────────────
  // Es un estado real de una instalación nueva, y merece su propia pantalla en
  // vez de un formulario que falla al guardar.
  if (accounts.length === 0) {
    return (
      // El clic afuera NO cierra (en ninguna pantalla del modal): un toque al
      // costado con el monto ya escrito no puede tirar el trabajo. Se cierra
      // con Escape o con el botón; ambos caminos son deliberados.
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
        <div className="w-full sm:max-w-md bg-surface-2 rounded-t-md sm:rounded-md p-6 shadow-2xl">
          <h2 className="text-lg font-bold mb-3">Primero creá una cuenta</h2>
          <p className="text-sm text-fg-muted mb-4">
            Todo movimiento sale de una cuenta o entra a una. Sin al menos una
            cuenta creada no hay dónde registrar la plata.
          </p>
          <button
            onClick={onClose}
            className="w-full rounded-md bg-primary text-primary-fg py-3 font-bold"
          >
            Entendido
          </button>
        </div>
      </div>
    );
  }

  // ── El campo "Nota": su posición depende de lo que los flujos TOCAN ────────
  //
  // Medido en la ventana de los tests (557px de alto): el área tocable del
  // modal termina donde arranca el pie fijo (≈441px). Todo lo que queda debajo
  // lo tapa el pie y el tap aterriza en el pie o en el backdrop — sin error,
  // sin foco y sin texto. Así se perdía la nota de las transferencias de los
  // flujos 04 y 10: el nodo existía, el tap "completaba" y el texto nunca
  // llegaba al campo (quedaba description: "").
  //
  // En TRANSFERENCIA la nota va arriba de las cuentas (los flujos tocan nota,
  // no fecha); en gasto/ingreso va al final, porque ahí lo que se toca es la
  // categoría y la fecha, que quedan más arriba. Las cuentas y la fecha se
  // asertan (texto visible), no se tocan.
  const descriptionField = (
    <div>
      <label htmlFor="tx-description" className="text-sm font-medium">
        Nota <span className="font-normal text-fg-muted">(opcional)</span>
      </label>
      <div className="relative">
        <input
          id="tx-description"
          value={description}
          onChange={(e) => {
            const value = e.target.value;
            setDescription(value);
            // Tipear de nuevo reabre el autocompletado (se está eligiendo otra).
            setSuggestionDismissed(false);
            clearDuplicateWarning();
            // Prioridad: mientras el autocompletado de descripción está en
            // juego, la ayuda de categoría se colapsa. Tipear en categoría la
            // reabre (ver `onChange` de ese campo).
            if (value.trim().length >= 2) setCategoryDismissed(true);
          }}
          onFocus={() => setDescriptionFocused(true)}
          onBlur={() => setDescriptionFocused(false)}
          onKeyDown={(event) => {
            if (!showDescriptionSuggestions) return;

            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestion((current) =>
                movePaletteIndex(
                  current,
                  event.key === "ArrowDown" ? 1 : -1,
                  descriptionSuggestions.length,
                ),
              );
              return;
            }
            if (event.key === "Enter") {
              // Con el desplegable abierto, Enter ELIGE: guardar el movimiento
              // con una descripción a medio escribir sería un accidente.
              event.preventDefault();
              const chosen =
                descriptionSuggestions[activeSuggestion] ??
                descriptionSuggestions[0];
              if (chosen) acceptDescriptionSuggestion(chosen);
              return;
            }
            if (event.key === "Escape") {
              // Cierra SÓLO el desplegable: el listener de documento del modal
              // no debe ver este Escape (si no, pediría descartar el formulario).
              event.preventDefault();
              event.stopPropagation();
              setSuggestionDismissed(true);
              setDescriptionSuggestions([]);
              setActiveSuggestion(-1);
            }
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showDescriptionSuggestions}
          aria-controls="tx-description-suggestions"
          aria-activedescendant={
            showDescriptionSuggestions && activeSuggestion >= 0
              ? `tx-description-suggestion-${activeSuggestion}`
              : undefined
          }
          placeholder="Detalle…"
          maxLength={200}
          autoComplete="off"
          className={`mt-1 w-full rounded-md border border-line-strong bg-transparent px-4 py-2.5 outline-none focus:ring-2 ${style.focus}`}
        />

        {/* Desplegable ABSOLUTO: no empuja fecha/cuentas hacia el pie fijo. En
            gasto/ingreso la nota es el último campo, así que se abre hacia
            ARRIBA para no quedar debajo de la franja sticky. */}
        {showDescriptionSuggestions && (
          <div
            id="tx-description-suggestions"
            role="listbox"
            aria-label="Descripciones usadas antes"
            className={`absolute left-0 right-0 z-30 max-h-56 overflow-y-auto rounded-md border border-line border-line-strong bg-surface-2 shadow-2xl ${
              isTransfer ? "top-full mt-1" : "bottom-full mb-1"
            }`}
          >
            {descriptionSuggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.kind}-${suggestion.description}-${index}`}
                id={`tx-description-suggestion-${index}`}
                type="button"
                role="option"
                aria-selected={activeSuggestion === index}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => acceptDescriptionSuggestion(suggestion)}
                className={`w-full text-left px-3 py-2 border-b border-line last:border-b-0 ${
                  activeSuggestion === index
                    ? "bg-surface-3 "
                    : "hover:bg-surface-3 hover:bg-surface-3/60"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium truncate">
                    {suggestion.description}
                  </span>
                  <span className="text-xs text-fg-muted whitespace-nowrap">
                    {formatMoney(suggestion.amount)}
                  </span>
                </span>
                <span className="block text-xs text-fg-muted truncate">
                  {suggestion.category?.name ?? "Sin categoría"} ·{" "}
                  {suggestion.account.name}
                  {suggestion.kind === "TRANSFER" && suggestion.toAccount
                    ? ` → ${suggestion.toAccount.name}`
                    : ""}{" "}
                  · {suggestion.frequency}×
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      {/*
        EL PANEL ES UNA COLUMNA FLEX: LA ZONA DE SCROLL TERMINA DONDE
        EMPIEZA EL PIE
        ────────────────────────────────────────────────────────────────
        Antes el panel entero scrolleaba y el pie era `sticky` DENTRO de
        esa área: los campos pasaban POR DEBAJO del pie y quedaban tapados
        (la trampa 15). Un tap en un control tapado aterriza en el pie: si
        ese pie tiene un botón, el toque dispara ese botón.

        Ahora el panel es una columna: el encabezado y el pie son `flex-none`
        (altura propia, nunca se mueven) y el área del formulario es
        `flex-1 min-h-0 overflow-y-auto`: scrollea, pero TERMINA donde
        empieza el pie. No hay ni un píxel de formulario debajo del pie, y
        por lo tanto no hay zona muerta donde un tap pueda caer en un botón
        que no es el que la persona quiso tocar.
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={style.title}
        className="w-full sm:max-w-md max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
      >
        <div className="flex-none px-6 pt-6">
          <div className="flex items-center justify-between mb-2 gap-2">
          <h2 className={`text-lg font-bold min-w-0 ${style.accent}`}>
            {style.title}
            {favoriteSourceName && favoriteId && (
              <span
                id="tx-favorite-banner"
                className="ml-2 align-middle text-xs font-bold uppercase rounded-full bg-transfer/10 text-transfer px-1.5 py-0.5"
              >
                plantilla: {favoriteSourceName}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1 shrink-0">
            {/* Un enlace compacto en el encabezado, no una fila nueva: el
                formulario de gasto ya roza el pie fijo en la ventana de tests
                y 30 px de más empujaban los chips de fecha a la banda muerta
                de la trampa 15. Acá no agrega altura al camino típico. */}
            <button
              id="tx-save-favorite"
              type="button"
              onClick={() => {
                setFavoriteOpen((current) => !current);
                setFavoriteError("");
                setFavoriteNotice("");
              }}
              aria-expanded={favoriteOpen}
              className="text-xs underline text-fg-muted hover:text-fg hover:text-fg-muted px-1"
            >
              <Star
                className={`size-4 inline-block align-[-2px] mr-1 ${
                  favoriteOpen ? "fill-current" : ""
                }`}
                aria-hidden
              />
              Plantilla
            </button>
            <button
              id="tx-close"
              onClick={onClose}
              className="text-xl leading-none text-fg-subtle hover:text-fg-muted px-2"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
          </div>
        </div>

        {/*
          El área que scrollea. `flex-1 min-h-0` + `overflow-y-auto`: toma
          lo que sobra del panel y scrollea DENTRO, con su límite EXACTO en
          el borde superior del pie. Abajo, el pie es `flex-none`: su altura
          es la suya y no se mueve nunca.
        */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3">

        {favoriteNotice && (
          <p id="tx-favorite-notice" className="text-xs text-success mb-2">
            {favoriteNotice}
          </p>
        )}

        {/* ── Tipo de movimiento ───────────────────────────────────────── */}
        {/* Compacto a propósito: el modal tiene que seguir entrando en una
            pantalla de 1018×597, donde "Nota" queda al borde del pie fijo. */}
        <div
          role="group"
          aria-label="Tipo de movimiento"
          className="grid grid-cols-3 gap-1 rounded-md bg-surface-3 p-1 mb-3"
        >
          {KIND_TABS.map((tab) => (
            <button
              key={tab.kind}
              id={tab.id}
              type="button"
              onClick={() => switchKind(tab.kind)}
              aria-pressed={kind === tab.kind}
              className={`rounded-lg py-1.5 text-sm font-medium transition ${
                kind === tab.kind
                  ? KIND_STYLE[tab.kind].tab
                  : "text-fg-muted hover:bg-surface-3/70 hover:bg-surface-3"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Panel de plantilla ─────────────────────────────────────────── */}
        {/* Sólo se abre a pedido desde el enlace del encabezado. Cuando está
            abierto empuja el formulario, pero la persona está interactuando
            con este panel y el pie fijo sigue visible. */}
        {favoriteOpen && (
          <div
            id="tx-favorite-panel"
            className="rounded-md border border-line border-line-strong bg-surface bg-surface-3/50 p-3 space-y-2 mb-3"
          >
            <label htmlFor="tx-favorite-name" className="text-xs font-medium block">
              Nombre de la plantilla *
            </label>
            <input
              id="tx-favorite-name"
              value={favoriteName}
              onChange={(event) => setFavoriteName(event.target.value)}
              placeholder="Ej: Café de la mañana"
              maxLength={40}
              className={`w-full rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-sm outline-none focus:ring-2 ${style.focus}`}
            />
            <p className="text-xs text-fg-muted">
              Guarda tipo, monto, cuenta, categoría y nota. No crea un
              movimiento.
            </p>
            {favoriteError && (
              <p
                id="tx-favorite-error"
                role="alert"
                className="text-xs rounded-lg bg-danger/10 text-danger px-2 py-1.5"
              >
                {favoriteError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                id="tx-favorite-save"
                type="button"
                onClick={() => void saveFavorite()}
                disabled={favoriteSaving}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold text-primary-fg disabled:opacity-50 ${style.badge}`}
              >
                {favoriteSaving ? "Guardando…" : "Guardar plantilla"}
              </button>
              <button
                id="tx-favorite-cancel"
                type="button"
                onClick={() => setFavoriteOpen(false)}
                disabled={favoriteSaving}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        <form id="tx-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* ── Monto ─────────────────────────────────────────────────────── */}
          <div>
            <label htmlFor="tx-amount" className="text-sm font-medium">
              Monto *
            </label>
            <input
              id="tx-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                clearDuplicateWarning();
              }}
              placeholder="0,00"
              className={`mt-1 w-full text-xl font-bold rounded-lg border border-line-strong bg-transparent px-4 py-3 outline-none focus:ring-2 ${style.focus}`}
            />
            <p className="mt-1 text-xs text-fg-muted h-4">
              {amountPreview ? (
                <>
                  Se guarda como <b>{amountPreview}</b>
                </>
              ) : amount.trim() ? (
                <span className="text-warning">
                  No se entiende el monto. Probá con 1500 o 1.500,50
                </span>
              ) : (
                "Podés escribir 1500, 1.500,50 o 1,500.50"
              )}
            </p>
          </div>

          {/* En TRANSFERENCIA la nota va acá arriba, junto al monto — el
              porqué completo, en `descriptionField`. */}
          {isTransfer && descriptionField}

          {/* ── Cuenta de origen ──────────────────────────────────────────── */}
          <div>
            <label htmlFor="tx-account" className="text-sm font-medium">
              {isTransfer
                ? "Desde qué cuenta *"
                : isIncome
                  ? "A qué cuenta entra *"
                  : "De qué cuenta sale *"}
            </label>
            <select
              id="tx-account"
              value={accountId}
              onChange={(e) => {
                const nextSource = e.target.value;
                setAccountId(nextSource);
                clearDuplicateWarning();
                // Al cambiar el origen, el destino anterior puede ser el mismo.
                // Se re-elige el primero disponible en vez de vaciarlo: el
                // formulario nunca queda en un estado inválido.
                setToAccountId(pickDestinationAccount(accounts, nextSource));
              }}
              className={`mt-1 w-full rounded-md border border-line-strong bg-surface bg-surface-3 px-3 py-2.5 outline-none focus:ring-2 ${style.focus}`}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>

            {/* El aviso que evita el malentendido más común: comprar con
                tarjeta NO es "gastar la plata que tenés", es deberla. */}
            {!isTransfer && selectedAccount?.kind === "CREDIT_CARD" && (
              <p className="mt-1.5 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2">
                Es una tarjeta: este gasto se suma a la deuda. No baja el saldo
                de tu cuenta bancaria hasta que pagues el resumen, y ese pago va
                a ser una <b>transferencia</b>, no otro gasto.
              </p>
            )}
          </div>

          {/* ── Cuenta de destino (sólo transferencias) ───────────────────── */}
          {isTransfer && (
            <div>
              <label htmlFor="tx-to-account" className="text-sm font-medium">
                A qué cuenta va *
              </label>
              {destinationOptions.length === 0 ? (
                <p className="mt-1 text-sm rounded-lg bg-warning/10 text-warning px-3 py-2">
                  Necesitás al menos dos cuentas para transferir entre ellas.
                </p>
              ) : (
                <select
                  id="tx-to-account"
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className={`mt-1 w-full rounded-md border border-line-strong bg-surface bg-surface-3 px-3 py-2.5 outline-none focus:ring-2 ${style.focus}`}
                >
                  {destinationOptions.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                </select>
              )}
              <p className="mt-1.5 text-xs text-fg-muted">
                Mover plata entre tus propias cuentas no es un gasto ni un
                ingreso: tu patrimonio no cambia.
              </p>
            </div>
          )}

          {/* ── Categoría (sólo ingresos y gastos, y OPCIONAL) ────────────── */}
          {!isTransfer && (
            <div>
              <label htmlFor="tx-category" className="text-sm font-medium">
                {isIncome ? "De dónde viene" : "En qué se fue"}{" "}
                <span className="font-normal text-fg-muted">(opcional)</span>
              </label>
              <input
                id="tx-category"
                value={categoryName}
                onChange={(e) => {
                  setCategoryName(e.target.value);
                  setCategoryDismissed(false);
                }}
                onFocus={() => setCategoryTouched(true)}
                placeholder={
                  isIncome
                    ? "Ej: Sueldo, Freelance, Ventas…"
                    : "Ej: Comida, Alquiler, Transporte…"
                }
                list="tx-categories"
                autoComplete="off"
                className={`mt-1 w-full rounded-md border border-line-strong bg-transparent px-4 py-2.5 outline-none focus:ring-2 ${style.focus}`}
              />
              <datalist id="tx-categories">
                {kindCategories.map((category) => (
                  <option key={category.id} value={category.name} />
                ))}
              </datalist>

              {categoryName.trim() !== "" && !categoryDismissed && (
                <p className="mt-1 text-xs text-fg-muted">
                  {categoryExists ? (
                    <>
                      ✓ Se usa la categoría existente{" "}
                      <b>“{categoryName.trim()}”</b>
                    </>
                  ) : (
                    <>
                      ＋ Se crea la categoría <b>“{categoryName.trim()}”</b> para
                      los próximos movimientos
                    </>
                  )}
                </p>
              )}

              {/* Sugerencias: últimas usadas primero, y al escribir, las que
                  empiezan con lo escrito. La lógica vive en
                  `searchCategories` (lib/category-search.ts). En reposo no se
                  muestran para no empujar los campos de abajo (el porqué,
                  arriba de todo, en `categoryTouched`). */}
              {suggestions.length > 0 &&
                !categoryDismissed &&
                (categoryTouched || categoryName.trim() !== "") && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestions.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion.id}
                        onClick={() => {
                          setCategoryName(suggestion.name);
                          setCategoryDismissed(true);
                        }}
                        className="text-xs px-3 py-1.5 rounded-full bg-surface-3 hover:bg-surface-3 "
                      >
                        {suggestion.name}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

          {/* ── Fecha ─────────────────────────────────────────────────────── */}
          {/* Los chips "Hoy"/"Ayer" comparten la fila del label para no sumar
              una fila entera al modal (el porqué del espacio, en el pie). */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="tx-date" className="text-sm font-medium">
                Fecha *
              </label>
              <div className="flex gap-1">
                <button
                  id="tx-date-hoy"
                  type="button"
                  onClick={() => {
                    setDate(today);
                    clearDuplicateWarning();
                  }}
                  aria-pressed={date === today}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    date === today
                      ? "border-primary bg-primary text-primary-fg "
                      : "border-line-strong text-fg-muted hover:bg-surface-3 "
                  }`}
                >
                  Hoy
                </button>
                <button
                  id="tx-date-ayer"
                  type="button"
                  onClick={() => {
                    setDate(yesterday);
                    clearDuplicateWarning();
                  }}
                  aria-pressed={date === yesterday}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    date === yesterday
                      ? "border-primary bg-primary text-primary-fg "
                      : "border-line-strong text-fg-muted hover:bg-surface-3 "
                  }`}
                >
                  Ayer
                </button>
              </div>
            </div>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                clearDuplicateWarning();
                clearDateInputIfEmptied(e.target);
              }}
              className={`mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2 outline-none focus:ring-2 ${style.focus}`}
            />
          </div>

          {/* En gasto/ingreso la nota va al final — el porqué, en `descriptionField`. */}
          {!isTransfer && descriptionField}
        </form>
        </div>

        {/*
          PIE FIJO: EL BOTÓN DE GUARDAR NO PUEDE IRSE DE PANTALLA
          ────────────────────────────────────────────────────────────────
          El formulario no entra completo en una pantalla baja. Antes el pie
          era `sticky bottom-0` DENTRO del área que scrolleaba: los campos
          pasaban por debajo del pie y quedaban tapados, y un tap en un
          campo tapado caía en el pie (la trampa 15).

          Ahora el pie es un hermano del área que scrollea, no un hijo: la
          columna flex del panel los separa (encabezado `flex-none`, área
          `flex-1 min-h-0`, pie `flex-none`). El botón de guardar sigue
          siempre a la vista —de hecho, ahora está SIEMPRE a la vista, sin
          depender de que el área scrollee— y el formulario no tiene ni un
          píxel debajo del pie.

          El pie queda FUERA del `<form>` (el formulario es `#tx-form` y el
          botón lo referencia con `form="tx-form"`): así el panel de
          plantillas y los tabs de tipo —que NO son parte del formulario—
          siguen fuera de él y Enter en el nombre de una plantilla no
          guarda el movimiento por accidente.

          El mensaje de error va acá adentro y no entre los campos: un error
          que aparece fuera de la vista es un error que no se leyó. */}
        <div className="flex-none px-6 pb-3 pt-2 space-y-3 bg-surface-2 ">
            {error && (
              <p
                role="alert"
                className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            {/* Aviso de descarte: Escape con datos escritos entra acá. El
                segundo Escape (o "Descartar") cierra; "Seguir editando"
                vuelve. Nunca `window.confirm`: el driver de los tests no
                puede contestar diálogos nativos. */}
            {discardWarning && (
              <div
                id="tx-discard-warning"
                role="alert"
                className="text-sm rounded-lg bg-warning/10 text-warning px-3 py-2"
              >
                <p>Si cerrás ahora se pierde lo que cargaste.</p>
                <div className="mt-2 flex gap-2">
                  <button
                    id="tx-discard-cancel"
                    type="button"
                    onClick={() => setDiscardWarning(false)}
                    className="rounded-lg border border-warning/40 px-3 py-1 text-xs font-medium"
                  >
                    Seguir editando
                  </button>
                  <button
                    id="tx-discard-confirm"
                    type="button"
                    onClick={onClose}
                    className="rounded-lg bg-danger hover:bg-danger/90 text-primary-fg px-3 py-1 text-xs font-bold"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}

            {duplicateWarning.length > 0 ? (
              // El aviso de duplicado REEMPLAZA a los botones: con los botones
              // normales a la vista, "Guardar" volvería a chocar contra el
              // mismo chequeo o —peor— guardaría sin que se vea la decisión.
              <div
                id="tx-duplicate-warning"
                role="alert"
                className="text-sm rounded-lg bg-warning/10 text-warning px-3 py-2"
              >
                <p>
                  Ya{" "}
                  {duplicateWarning.length === 1
                    ? "hay un movimiento igual"
                    : `hay ${duplicateWarning.length} movimientos iguales`}
                  : misma cuenta, mismo monto y mismo día. Puede ser el mismo
                  gasto cargado dos veces.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    id="tx-duplicate-back"
                    type="button"
                    onClick={() => setDuplicateWarning([])}
                    className="rounded-lg border border-warning/40 px-3 py-1 text-xs font-medium"
                  >
                    Volver
                  </button>
                  <button
                    id="tx-duplicate-save"
                    type="button"
                    onClick={() => void saveAnyway()}
                    disabled={saving}
                    className="rounded-lg bg-warning hover:bg-warning/90 text-primary-fg px-3 py-1 text-xs font-bold disabled:opacity-50"
                  >
                    Guardar igual
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  id="tx-cancel"
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-md border border-line-strong py-3 font-medium"
                >
                  Cancelar
                </button>
                <button
                  id="tx-submit"
                  type="submit"
                  form="tx-form"
                  disabled={saving}
                  className={`flex-1 rounded-md py-3 font-bold text-primary-fg disabled:opacity-50 ${style.badge}`}
                >
                  {saving ? "Guardando…" : "Guardar"}
                </button>
              </div>
            )}
          </div>
      </div>
    </div>
  );
}
