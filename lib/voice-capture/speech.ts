/**
 * Motor de captura de voz basado en Web Speech API con soporte continuo
 * e interactivo para transcripción en vivo.
 */

export type SpeechCaptureStatus =
  | "idle"
  | "listening"
  | "processing"
  | "error"
  | "unsupported";

export interface SpeechCaptureState {
  status: SpeechCaptureStatus;
  transcript: string;
  interimTranscript: string;
  error: string | null;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export class SpeechCaptureEngine {
  private recognition: SpeechRecognitionLike | null = null;
  private state: SpeechCaptureState = {
    status: "idle",
    transcript: "",
    interimTranscript: "",
    error: null,
  };
  private listeners: Set<(state: SpeechCaptureState) => void> = new Set();
  public readonly isSupported: boolean;

  constructor(
    customFactory?: (() => SpeechRecognitionLike) | null,
  ) {
    if (customFactory !== undefined) {
      if (customFactory === null) {
        this.isSupported = false;
        this.state.status = "unsupported";
      } else {
        this.isSupported = true;
        this.initRecognition(customFactory);
      }
    } else if (typeof window !== "undefined") {
      const SpeechRecognitionClass =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;

      if (SpeechRecognitionClass) {
        this.isSupported = true;
        this.initRecognition(() => new SpeechRecognitionClass());
      } else {
        this.isSupported = false;
        this.state.status = "unsupported";
      }
    } else {
      this.isSupported = false;
      this.state.status = "unsupported";
    }
  }

  private initRecognition(factory: () => SpeechRecognitionLike) {
    try {
      this.recognition = factory();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = "es-AR";

      this.recognition.onstart = () => {
        this.updateState({ status: "listening", error: null });
      };

      this.recognition.onresult = (event: any) => {
        let finalChunk = "";
        let currentInterim = "";

        const startIndex = event.resultIndex ?? 0;
        for (let i = startIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          const text = item[0]?.transcript ?? "";
          if (item.isFinal) {
            finalChunk += text;
          } else {
            currentInterim += text;
          }
        }

        const newTranscript = finalChunk
          ? (this.state.transcript ? `${this.state.transcript} ${finalChunk.trim()}` : finalChunk.trim())
          : this.state.transcript;

        this.updateState({
          transcript: newTranscript,
          interimTranscript: currentInterim.trim(),
        });
      };

      this.recognition.onerror = (event: any) => {
        const errorKey = event.error;
        let errorMessage = "Ocurrió un error al capturar el audio.";

        if (errorKey === "not-allowed" || errorKey === "service-not-allowed") {
          errorMessage =
            "Permiso de micrófono denegado. Podés escribir el texto directamente en el cuadro.";
        } else if (errorKey === "no-speech") {
          // No emitimos error bloqueante ante silencio
          return;
        } else if (errorKey === "network") {
          errorMessage = "Error de red al procesar el dictado de voz.";
        }

        this.updateState({
          status: "error",
          error: errorMessage,
        });
      };

      this.recognition.onend = () => {
        if (this.state.status === "listening") {
          this.updateState({ status: "idle", interimTranscript: "" });
        }
      };
    } catch {
      this.isSupported = false;
      this.updateState({ status: "unsupported" });
    }
  }

  start(): void {
    if (!this.isSupported || !this.recognition) return;
    try {
      this.updateState({ error: null });
      this.recognition.start();
    } catch {
      // Si ya estaba corriendo, ignoramos el fallo de llamada concurrente
    }
  }

  stop(): void {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      // Ignoramos error si ya estaba detenida
    }
    this.updateState({ status: "idle", interimTranscript: "" });
  }

  setTranscript(text: string): void {
    this.updateState({ transcript: text, interimTranscript: "" });
  }

  reset(): void {
    this.stop();
    this.updateState({
      status: this.isSupported ? "idle" : "unsupported",
      transcript: "",
      interimTranscript: "",
      error: null,
    });
  }

  getState(): SpeechCaptureState {
    return this.state;
  }

  subscribe(listener: (state: SpeechCaptureState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateState(partial: Partial<SpeechCaptureState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
