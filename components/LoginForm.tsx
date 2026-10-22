"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

/**
 * Formulario de login.
 *
 * Es un client component porque necesita estado local (contraseña, error,
 * "cargando"). La página que lo envuelve es server component y es la que valida
 * el parámetro `next` — ver app/login/page.tsx.
 */
export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        // El servidor devuelve un mensaje pensado para mostrar. Si no vino
        // cuerpo JSON (proxy caído, 502, etc.) usamos un genérico.
        const data: { error?: string } = await response.json().catch(() => ({}));
        setError(data.error ?? "No se pudo iniciar sesión. Reintentá.");
        return;
      }

      // `replace` y no `push`: no queremos que el botón "atrás" devuelva al
      // usuario a la pantalla de login.
      router.replace(next);
      // Refresca los server components para que el header vea la sesión nueva.
      router.refresh();
    } catch {
      setError("Error de red. Revisá tu conexión y reintentá.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium mb-2 text-fg-muted "
        >
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-md border border-line-strong bg-surface-2 px-4 py-3 text-base outline-none focus:ring-2 focus:ring-focus focus:border-transparent"
          placeholder="••••••••••••"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger "
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || password.length === 0}
        className="w-full rounded-lg bg-success px-4 py-3 font-semibold text-primary-fg hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
