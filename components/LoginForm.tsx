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
          className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300"
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
          className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-base outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          placeholder="••••••••••••"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || password.length === 0}
        className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
