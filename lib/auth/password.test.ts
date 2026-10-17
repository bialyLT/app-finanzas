/**
 * Tests del limitador de intentos de login (defensa anti fuerza bruta).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ CAPTURAN
 * ─────────────────────────────────────────────────────────────────────────────
 * El limitador original contaba por IP, y la IP salía de `x-forwarded-for`, un
 * header que el cliente elige. Rotando ese header, cada intento caía en una IP
 * "nueva" y el límite nunca se llenaba: fuerza bruta sin freno (reproducido:
 * 8 intentos fallidos con 8 X-Forwarded-For distintos → todos 401, ninguno 429).
 *
 * El arreglo agrega una cubeta GLOBAL, con el mismo umbral y la misma ventana,
 * que suma los fallos de todas las IP. Estos tests fijan esa propiedad: rotar el
 * header ya no evade el límite, pero el comportamiento por IP y la liberación
 * tras un login exitoso se conservan.
 *
 * No se usa HTTP ni delays: se ejercita la lógica del módulo directamente.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clearFailures, clientIp, failedAttempts, isRateLimited, registerFailure } from "./password";

// IPs tocadas por cada test, para limpiar el estado entre uno y otro.
const touched = new Set<string>();

function fail(ip: string): void {
  touched.add(ip);
  registerFailure(ip);
}

afterEach(() => {
  // `clearFailures` resetea la cubeta global además de la de la IP, así que una
  // sola llamada ya deja todo limpio; el resto ordena el mapa por IP.
  for (const ip of touched) clearFailures(ip);
  touched.clear();
});

describe("limitador de intentos de login", () => {
  it("frena a un atacante que ROTA X-Forwarded-For (cubeta global)", () => {
    // 8 IPs distintas, un único fallo cada una: ninguna llega al máximo por sí
    // sola, así que un límite puramente por IP no las vería.
    for (let i = 1; i <= 8; i += 1) fail(`198.51.100.${i}`);

    // Una IP que nunca intentó nada. Con la cubeta global, el total ya superó el
    // máximo y el login tiene que estar frenado igual.
    expect(isRateLimited("203.0.113.250")).toBe(true);
  });

  it("sigue frenando por IP (la cubeta por IP no se perdió)", () => {
    for (let i = 0; i < 5; i += 1) fail("192.0.2.10");
    expect(failedAttempts("192.0.2.10")).toBe(5);
    expect(isRateLimited("192.0.2.10")).toBe(true);
  });

  it("un login exitoso libera el login (resetea la IP y la global)", () => {
    for (let i = 0; i < 5; i += 1) fail("192.0.2.20");
    expect(isRateLimited("192.0.2.20")).toBe(true);

    clearFailures("192.0.2.20");

    expect(isRateLimited("192.0.2.20")).toBe(false);
    // Y tampoco queda un bloqueo global pegado por culpa de esa IP.
    expect(isRateLimited("203.0.113.251")).toBe(false);
  });

  it("clientIp toma la primera entrada de x-forwarded-for (el motivo del arreglo)", () => {
    // Documenta por qué hizo falta la cubeta global: la IP es un dato de entrada
    // que el cliente controla.
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIp(headers)).toBe("203.0.113.9");
  });
});
