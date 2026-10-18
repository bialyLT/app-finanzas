/**
 * Validación del par cierre/vencimiento del formulario de tarjeta (Fase 5, r2).
 *
 * Es el contrato que comparten los DOS formularios que editan la configuración
 * de una tarjeta (el alta de cuenta y el modal de `/tarjetas`) y también la API
 * (`parseDayOfMonth` en `app/api/accounts/route.ts`): los días van juntos,
 * enteros entre 1 y 31. Estos tests fijan el borde para que las tres copias no
 * puedan divergir sin que algo se ponga rojo.
 */

import { describe, expect, it } from "vitest";
import { cardDaysError } from "./card-form";

const JUNTOS = "El día de cierre y el de vencimiento van juntos: cargá los dos (o ninguno de los dos).";
const RANGO = "El día de cierre y el de vencimiento tienen que ser números enteros entre 1 y 31.";

describe("cardDaysError · par cierre/vencimiento", () => {
  it("acepta el par completo dentro de rango", () => {
    expect(cardDaysError("15", "5")).toBe("");
    expect(cardDaysError("1", "1")).toBe("");
    expect(cardDaysError("31", "31")).toBe("");
  });

  it("acepta los dos vacíos: no configurar es una opción válida", () => {
    expect(cardDaysError("", "")).toBe("");
    expect(cardDaysError("   ", "  ")).toBe("");
  });

  it("rechaza un solo día: van juntos o no van", () => {
    expect(cardDaysError("15", "")).toBe(JUNTOS);
    expect(cardDaysError("", "5")).toBe(JUNTOS);
    expect(cardDaysError("15", "   ")).toBe(JUNTOS);
  });

  it("rechaza fuera de rango y no enteros", () => {
    expect(cardDaysError("0", "5")).toBe(RANGO);
    expect(cardDaysError("32", "5")).toBe(RANGO);
    expect(cardDaysError("15", "0")).toBe(RANGO);
    expect(cardDaysError("abc", "5")).toBe(RANGO);
    expect(cardDaysError("15.5", "5")).toBe(RANGO);
    expect(cardDaysError("-1", "5")).toBe(RANGO);
    expect(cardDaysError("100", "5")).toBe(RANGO);
  });

  it("tolera espacios alrededor del número", () => {
    expect(cardDaysError(" 15 ", " 5 ")).toBe("");
  });
});
