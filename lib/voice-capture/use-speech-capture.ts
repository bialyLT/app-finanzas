"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SpeechCaptureEngine, type SpeechCaptureState } from "./speech";

export function useSpeechCapture() {
  const engineRef = useRef<SpeechCaptureEngine | null>(null);

  const [state, setState] = useState<SpeechCaptureState>({
    status: "idle",
    transcript: "",
    interimTranscript: "",
    error: null,
  });

  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    const engine = new SpeechCaptureEngine();
    engineRef.current = engine;
    setIsSupported(engine.isSupported);
    setState(engine.getState());

    const unsubscribe = engine.subscribe((nextState) => {
      setState(nextState);
    });

    return () => {
      unsubscribe();
      engine.stop();
    };
  }, []);

  const startListening = useCallback(() => {
    engineRef.current?.start();
  }, []);

  const stopListening = useCallback(() => {
    engineRef.current?.stop();
  }, []);

  const setTranscript = useCallback((text: string) => {
    engineRef.current?.setTranscript(text);
  }, []);

  const resetTranscript = useCallback(() => {
    engineRef.current?.reset();
  }, []);

  return {
    ...state,
    isSupported,
    startListening,
    stopListening,
    setTranscript,
    resetTranscript,
  };
}
