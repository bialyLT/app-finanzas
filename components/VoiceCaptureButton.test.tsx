import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceCaptureButton } from "@/components/VoiceCaptureButton";

describe("VoiceCaptureButton component", () => {
  it("renderiza correctamente sin errores y con touch target adecuado", () => {
    const html = renderToStaticMarkup(
      <VoiceCaptureButton onClick={() => {}} />,
    );

    expect(html).toContain("Carga por voz");
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("text-accent");
    // No debe contener colores de fábrica (zinc, blue, etc.)
    expect(html).not.toMatch(/\b(?:blue|zinc|slate|gray|neutral|emerald|red|green|amber)-(?:50|[1-9]00)\b/);
  });
});
