"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SpeechCaptureEngine, type SpeechCaptureState } from "./speech";

/**
 * Estado inicial, también usado como snapshot del servidor.
 *
 * En SSR no hay `window`, así que el motor se construye igual (reporta
 * `unsupported`) pero el HTML se renderiza con este estado neutro. Evita
 * diferencias de hidratación entre servidor y cliente.
 */
const INITIAL_STATE: SpeechCaptureState = {
  status: "idle",
  transcript: "",
  interimTranscript: "",
  error: null,
};

export function useSpeechCapture() {
  // `useState` con inicializador perezoso: una sola instancia por componente.
  const [engine] = useState(() => new SpeechCaptureEngine());

  const subscribe = useCallback(
    (onStoreChange: () => void) => engine.subscribe(onStoreChange),
    [engine],
  );

  const getSnapshot = useCallback(() => engine.getState(), [engine]);
  const getServerSnapshot = useCallback(() => INITIAL_STATE, []);

  // Suscripción directa al motor: sin `setState` dentro de un efecto, así que
  // no hay renders en cascada al montar.
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // El micrófono queda abierto si no se cierra: se libera al desmontar.
  useEffect(() => () => engine.stop(), [engine]);

  const startListening = useCallback(() => engine.start(), [engine]);

  const stopListening = useCallback(() => engine.stop(), [engine]);

  const setTranscript = useCallback(
    (text: string) => engine.setTranscript(text),
    [engine],
  );

  const resetTranscript = useCallback(() => engine.reset(), [engine]);

  return {
    ...state,
    isSupported: engine.isSupported,
    startListening,
    stopListening,
    setTranscript,
    resetTranscript,
  };
}
