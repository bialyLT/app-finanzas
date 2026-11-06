"use client";

import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Id estable del disparador: el modal de voz lo usa para devolver el foco. */
export const VOICE_CAPTURE_TRIGGER_ID = "btn-voice-capture";

interface Props {
  onClick: () => void;
  className?: string;
}

export function VoiceCaptureButton({ onClick, className }: Props) {
  return (
    <Button
      id={VOICE_CAPTURE_TRIGGER_ID}
      type="button"
      variant="outline"
      onClick={onClick}
      className={`min-h-[44px] min-w-[44px] gap-2 border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 hover:text-accent focus-visible:ring-accent ${
        className ?? ""
      }`}
      aria-label="Cargar movimientos por voz o texto"
      title="Cargar movimientos por voz o texto"
    >
      <Mic className="h-4 w-4" />
      <span className="hidden sm:inline">Carga por voz</span>
    </Button>
  );
}
