import { describe, expect, it, vi } from "vitest";
import { SpeechCaptureEngine, type SpeechRecognitionLike } from "./speech";

class MockSpeechRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  start = vi.fn(() => {
    this.onstart?.();
  });
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn(() => {
    this.onend?.();
  });
}

describe("voice-capture / SpeechCaptureEngine", () => {
  it("reporta unsupported si no se provee SpeechRecognition", () => {
    const engine = new SpeechCaptureEngine(null);
    expect(engine.isSupported).toBe(false);
    expect(engine.getState().status).toBe("unsupported");
  });

  it("configura idioma es-AR y modo continuo", () => {
    const mock = new MockSpeechRecognition();
    const engine = new SpeechCaptureEngine(() => mock);
    expect(engine.isSupported).toBe(true);
    expect(engine.getState().status).toBe("idle");

    engine.start();
    expect(mock.continuous).toBe(true);
    expect(mock.interimResults).toBe(true);
    expect(mock.lang).toBe("es-AR");
    expect(mock.start).toHaveBeenCalled();
    expect(engine.getState().status).toBe("listening");
  });

  it("acumula transcripciones finales y expone resultados intermedios", () => {
    const mock = new MockSpeechRecognition();
    const engine = new SpeechCaptureEngine(() => mock);
    engine.start();

    // Evento con resultado parcial intermedio
    mock.onresult?.({
      resultIndex: 0,
      results: [
        {
          0: { transcript: "gasté 4500" },
          isFinal: false,
          length: 1,
        },
      ],
    });

    expect(engine.getState().interimTranscript).toBe("gasté 4500");
    expect(engine.getState().transcript).toBe("");

    // Evento con resultado final
    mock.onresult?.({
      resultIndex: 0,
      results: [
        {
          0: { transcript: "gasté 4500 en el súper" },
          isFinal: true,
          length: 1,
        },
      ],
    });

    expect(engine.getState().interimTranscript).toBe("");
    expect(engine.getState().transcript).toBe("gasté 4500 en el súper");
  });

  it("maneja error de permiso denegado con mensaje en español", () => {
    const mock = new MockSpeechRecognition();
    const engine = new SpeechCaptureEngine(() => mock);
    engine.start();

    mock.onerror?.({ error: "not-allowed" });

    const state = engine.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("Permiso de micrófono denegado");
  });

  it("permite editar o limpiar la transcripción manualmente", () => {
    const mock = new MockSpeechRecognition();
    const engine = new SpeechCaptureEngine(() => mock);

    engine.setTranscript("Texto corregido a mano");
    expect(engine.getState().transcript).toBe("Texto corregido a mano");

    engine.reset();
    expect(engine.getState().transcript).toBe("");
    expect(engine.getState().interimTranscript).toBe("");
    expect(engine.getState().status).toBe("idle");
  });
});
