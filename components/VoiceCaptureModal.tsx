"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, Image as ImageIcon, Mic, MicOff, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ResolvedBatch } from "@/lib/voice-capture/resolve";
import { useSpeechCapture } from "@/lib/voice-capture/use-speech-capture";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onParsed: (batch: ResolvedBatch) => void;
}

export function VoiceCaptureModal({ open, onOpenChange, onParsed }: Props) {
  const {
    status,
    transcript,
    interimTranscript,
    error: speechError,
    isSupported,
    startListening,
    stopListening,
    setTranscript,
    resetTranscript,
  } = useSpeechCapture();

  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [attachedFile, setAttachedFile] = useState<{
    base64: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reiniciar estado al abrir el diálogo
  useEffect(() => {
    if (open) {
      resetTranscript();
      setParseError(null);
      setIsParsing(false);
      setAttachedFile(null);
    } else {
      stopListening();
    }
  }, [open, resetTranscript, stopListening]);

  const displayedText = transcript + (interimTranscript ? ` ${interimTranscript}` : "");

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setParseError("El archivo supera el máximo permitido de 5 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const [header, base64] = result.split(",");
      const mimeType = header.match(/:(.*?);/)?.[1] || file.type;

      setAttachedFile({
        base64,
        mimeType,
        name: file.name,
      });
      setParseError(null);
    };
    reader.readAsDataURL(file);
  }

  async function handleParse() {
    const textToParse = transcript.trim();
    if (!textToParse && !attachedFile) return;

    stopListening();
    setIsParsing(true);
    setParseError(null);

    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToParse || "Interpretar comprobante adjunto",
          image: attachedFile
            ? { base64: attachedFile.base64, mimeType: attachedFile.mimeType }
            : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "No se pudo interpretar el mensaje.");
      }

      onParsed(data as ResolvedBatch);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Error inesperado al conectar con el servidor.";
      setParseError(msg);
    } finally {
      setIsParsing(false);
    }
  }

  function toggleListening() {
    if (status === "listening") {
      stopListening();
    } else {
      setParseError(null);
      startListening();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <DialogTitle>Carga por voz o texto</DialogTitle>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <p className="text-sm text-fg-muted">
            Dictá o escribí tus movimientos como hablás cotidianamente. Por
            ejemplo:{" "}
            <span className="italic text-fg">
              &quot;gasté 15 lucas en la verdulería en efectivo y 40 en el súper con
              Galicia&quot;
            </span>
            .
          </p>

          <div className="space-y-2">
            <div className="relative">
              <textarea
                value={displayedText}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder={
                  isSupported
                    ? "Presioná el micrófono para dictar o escribí acá..."
                    : "Escribí acá tus movimientos en lenguaje natural..."
                }
                disabled={isParsing}
                className="w-full min-h-[120px] rounded-md border border-border bg-surface-2 p-3 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 resize-y"
              />
            </div>

            {/* Archivo adjunto */}
            {attachedFile ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-3 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-fg truncate">
                  <FileText className="h-4 w-4 shrink-0 text-accent" />
                  <span className="truncate">{attachedFile.name}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setAttachedFile(null)}
                  className="h-6 w-6 text-fg-muted hover:text-danger"
                  title="Quitar archivo"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isParsing}
                  className="gap-2 text-xs min-h-[44px]"
                >
                  <ImageIcon className="h-4 w-4" />
                  <span>Adjuntar foto de ticket o PDF</span>
                </Button>
              </div>
            )}

            {speechError && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs text-warning">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{speechError}</span>
              </div>
            )}

            {parseError && (
              <div className="flex items-start gap-2 rounded-md bg-danger/10 p-2 text-xs text-danger">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{parseError}</span>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <div>
            {isSupported && (
              <Button
                type="button"
                variant={status === "listening" ? "destructive" : "outline"}
                size="default"
                onClick={toggleListening}
                disabled={isParsing}
                className="gap-2 min-h-[44px]"
              >
                {status === "listening" ? (
                  <>
                    <MicOff className="h-4 w-4 animate-pulse" />
                    <span>Detener dictado</span>
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4" />
                    <span>Hablar</span>
                  </>
                )}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => onOpenChange(false)}
              disabled={isParsing}
              className="min-h-[44px]"
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="default"
              size="default"
              onClick={handleParse}
              disabled={isParsing || (!transcript.trim() && !attachedFile)}
              className="gap-2 min-h-[44px]"
            >
              {isParsing ? (
                <span>Interpretando...</span>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Interpretar</span>
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
