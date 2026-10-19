/**
 * Tests de la lógica pura de la carga rápida (Fase 7).
 *
 * Tres bloques, y cada uno cubre algo que desde el formulario sólo se podría
 * verificar con un navegador:
 *
 *   1. El recordatorio de la última cuenta usada, con TODAS las formas en que
 *      `localStorage` puede fallar (no existir, lanzar, devolver basura).
 *   2. La resolución de la cuenta por defecto: prioridad, tolerancia a ids
 *      inexistentes o inválidos para el tipo.
 *   3. El atajo T/I y sus guardas: escribir "tomate" en una nota no puede
 *      abrir el modal de gasto.
 */

import { describe, expect, it } from "vitest";
import type { AccountBalanceDTO, MovementKindDTO } from "./finance";
import {
  LAST_ACCOUNT_KEY_PREFIX,
  browserStorage,
  canBeSourceAccount,
  lastAccountStorageKey,
  readLastAccountId,
  resolveSourceAccount,
  shortcutMovementKind,
  writeLastAccountId,
  type StorageLike,
} from "./quick-entry";

/** Una cuenta de prueba; `isLiability` es lo único que decide las reglas. */
function account(
  id: string,
  isLiability = false,
  kind: AccountBalanceDTO["kind"] = isLiability ? "CREDIT_CARD" : "BANK",
): AccountBalanceDTO {
  return {
    id,
    name: `Cuenta ${id}`,
    kind,
    archived: false,
    openingBalance: "0.00",
    closingDay: null,
    dueDay: null,
    creditLimit: null,
    amortizationSystem: null,
    balance: "0.00",
    debt: isLiability ? "0.00" : null,
    isLiability,
    inflow: "0.00",
    outflow: "0.00",
  };
}

/** Un almacenamiento en memoria, para los caminos felices. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("el recordatorio de la última cuenta usada", () => {
  it("la clave es una POR TIPO: cargar un ingreso no cambia el origen del próximo gasto", () => {
    expect(lastAccountStorageKey("EXPENSE")).toBe(
      `${LAST_ACCOUNT_KEY_PREFIX}EXPENSE`,
    );
    expect(lastAccountStorageKey("INCOME")).toBe(
      `${LAST_ACCOUNT_KEY_PREFIX}INCOME`,
    );
    expect(lastAccountStorageKey("TRANSFER")).toBe(
      `${LAST_ACCOUNT_KEY_PREFIX}TRANSFER`,
    );
    expect(lastAccountStorageKey("EXPENSE")).not.toBe(
      lastAccountStorageKey("INCOME"),
    );
  });

  it("guarda y lee el id tal cual, por tipo", () => {
    const storage = fakeStorage();
    writeLastAccountId(storage, "EXPENSE", "cuenta-banco");
    writeLastAccountId(storage, "INCOME", "cuenta-efectivo");

    expect(readLastAccountId(storage, "EXPENSE")).toBe("cuenta-banco");
    expect(readLastAccountId(storage, "INCOME")).toBe("cuenta-efectivo");
    // El tipo que nunca se usó no tiene recordatorio.
    expect(readLastAccountId(storage, "TRANSFER")).toBeNull();
  });

  it("recorta los espacios al guardar y al leer", () => {
    const storage = fakeStorage();
    writeLastAccountId(storage, "EXPENSE", "  cuenta-banco  ");
    expect(readLastAccountId(storage, "EXPENSE")).toBe("cuenta-banco");
  });

  it("un id vacío no se guarda: no hay nada que recordar", () => {
    const storage = fakeStorage();
    writeLastAccountId(storage, "EXPENSE", "");
    writeLastAccountId(storage, "EXPENSE", "   ");
    expect(readLastAccountId(storage, "EXPENSE")).toBeNull();
  });

  it("sin almacenamiento (SSR, o localStorage bloqueado) todo es no-op", () => {
    expect(readLastAccountId(null, "EXPENSE")).toBeNull();
    expect(readLastAccountId(undefined, "EXPENSE")).toBeNull();
    // No lanza: un recordatorio de comodidad no puede romper un guardado.
    expect(() => writeLastAccountId(null, "EXPENSE", "cuenta")).not.toThrow();
  });

  it("un almacenamiento que LANZA al leer o al escribir se degrada a null / no-op", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("acceso bloqueado");
      },
      setItem: () => {
        throw new Error("almacenamiento lleno");
      },
    };

    expect(readLastAccountId(throwing, "EXPENSE")).toBeNull();
    expect(() => writeLastAccountId(throwing, "EXPENSE", "cuenta")).not.toThrow();
  });

  it("un valor con basura se devuelve como está: la validación es contra las cuentas", () => {
    // El recordatorio no valida ids a propósito: si la cuenta se borró, el id
    // viejo simplemente no matchea contra la lista y `resolveSourceAccount`
    // cae al siguiente candidato. Guardar un id "válido" acá sería duplicar
    // una regla que ya vive en un solo lugar.
    const storage = fakeStorage({ [lastAccountStorageKey("EXPENSE")]: "borrada-123" });
    expect(readLastAccountId(storage, "EXPENSE")).toBe("borrada-123");
  });

  it("un valor vacío en el almacenamiento cuenta como ausente", () => {
    const storage = fakeStorage({ [lastAccountStorageKey("EXPENSE")]: "   " });
    expect(readLastAccountId(storage, "EXPENSE")).toBeNull();
  });
});

describe("la cuenta de origen por defecto", () => {
  const banco = account("banco");
  const efectivo = account("efectivo");
  const visa = account("visa", true);

  it("un INGRESO no puede entrar a una cuenta de deuda; un gasto o transferencia sí pueden salir de cualquiera", () => {
    expect(canBeSourceAccount("INCOME", banco)).toBe(true);
    expect(canBeSourceAccount("INCOME", visa)).toBe(false);
    expect(canBeSourceAccount("EXPENSE", visa)).toBe(true);
    expect(canBeSourceAccount("TRANSFER", visa)).toBe(true);
  });

  it("preferred (la pantalla dijo 'cargá un gasto acá') tiene la prioridad más alta", () => {
    expect(
      resolveSourceAccount("EXPENSE", [banco, efectivo], {
        preferred: efectivo.id,
        lastUsedId: banco.id,
      }),
    ).toBe(efectivo.id);
  });

  it("un preferred inválido para el tipo se ignora", () => {
    // La pantalla puede pedir "cargá un gasto acá" sobre una cuenta cualquiera,
    // pero un ingreso jamás puede entrar a la tarjeta: cae a la última usada.
    expect(
      resolveSourceAccount("INCOME", [banco, visa], {
        preferred: visa.id,
        lastUsedId: banco.id,
      }),
    ).toBe(banco.id);
  });

  it("sin preferred, gana la última cuenta usada para ese tipo", () => {
    expect(
      resolveSourceAccount("EXPENSE", [banco, efectivo], {
        lastUsedId: efectivo.id,
      }),
    ).toBe(efectivo.id);
  });

  it("un id inexistente (cuenta borrada) se ignora y se cae al siguiente candidato", () => {
    expect(
      resolveSourceAccount("EXPENSE", [banco, efectivo], {
        lastUsedId: "cuenta-borrada",
      }),
    ).toBe(banco.id);
  });

  it("una última cuenta usada inválida para el tipo se ignora", () => {
    // Pudo quedar recordada de otro contexto; para un ingreso, la tarjeta no
    // es una opción válida y no hay que mostrar un estado que la base rechaza.
    expect(
      resolveSourceAccount("INCOME", [visa, banco], {
        lastUsedId: visa.id,
      }),
    ).toBe(banco.id);
  });

  it("sin nada recordado, la primera cuenta válida para el tipo", () => {
    expect(resolveSourceAccount("INCOME", [visa, banco], {})).toBe(banco.id);
    expect(resolveSourceAccount("EXPENSE", [banco, efectivo], {})).toBe(
      banco.id,
    );
  });

  it("sin cuentas válidas devuelve vacío: el formulario tiene su pantalla para ese caso", () => {
    expect(resolveSourceAccount("EXPENSE", [], {})).toBe("");
    // Para un ingreso con SÓLO tarjetas no hay ninguna cuenta válida.
    expect(resolveSourceAccount("INCOME", [visa], {})).toBe("");
  });
});

describe("los atajos T / I", () => {
  const open = { modalOpen: false };

  it("t abre gasto y i abre ingreso (mayúscula o minúscula)", () => {
    expect(shortcutMovementKind({ key: "t" }, open)).toBe("EXPENSE");
    expect(shortcutMovementKind({ key: "T" }, open)).toBe("EXPENSE");
    expect(shortcutMovementKind({ key: "i" }, open)).toBe("INCOME");
    expect(shortcutMovementKind({ key: "I" }, open)).toBe("INCOME");
  });

  it("con un modal abierto, la tecla no hace nada", () => {
    expect(shortcutMovementKind({ key: "t" }, { modalOpen: true })).toBeNull();
    expect(shortcutMovementKind({ key: "i" }, { modalOpen: true })).toBeNull();
  });

  it("escribiendo en un campo, la tecla es DATO: 'tomate' o 'internet' no abren nada", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(
        shortcutMovementKind({ key: "t", target: { tagName } }, open),
      ).toBeNull();
      expect(
        shortcutMovementKind({ key: "i", target: { tagName } }, open),
      ).toBeNull();
    }
    // La etiqueta llega en mayúsculas desde el DOM, pero no se asume.
    expect(
      shortcutMovementKind({ key: "t", target: { tagName: "input" } }, open),
    ).toBeNull();
  });

  it("en contenido editable (un div editable) tampoco", () => {
    expect(
      shortcutMovementKind(
        { key: "t", target: { tagName: "DIV", isContentEditable: true } },
        open,
      ),
    ).toBeNull();
  });

  it("con Ctrl/Alt/Meta la tecla pertenece al navegador: Ctrl+T abre una pestaña, no el modal", () => {
    expect(shortcutMovementKind({ key: "t", ctrlKey: true }, open)).toBeNull();
    expect(shortcutMovementKind({ key: "t", metaKey: true }, open)).toBeNull();
    expect(shortcutMovementKind({ key: "i", altKey: true }, open)).toBeNull();
  });

  it("cualquier otra tecla no es un atajo", () => {
    expect(shortcutMovementKind({ key: "g" }, open)).toBeNull();
    expect(shortcutMovementKind({ key: "Enter" }, open)).toBeNull();
    expect(shortcutMovementKind({ key: "Escape" }, open)).toBeNull();
  });

  it("afuera de un campo (focus en un botón o en el body) el atajo SÍ funciona", () => {
    expect(
      shortcutMovementKind(
        { key: "t", target: { tagName: "BODY", isContentEditable: false } },
        open,
      ),
    ).toBe("EXPENSE");
    // Sin foco conocido (target null) tampoco se bloquea: es el caso de un
    // evento sintético, y la guarda que importa es la del campo de texto.
    expect(shortcutMovementKind({ key: "t" }, open)).toBe("EXPENSE");
  });
});

describe("browserStorage", () => {
  it("sin window (SSR) devuelve null", () => {
    expect(browserStorage()).toBeNull();
  });
});
