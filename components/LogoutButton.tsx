"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Botón de cerrar sesión. POSTea al endpoint y vuelve a /login. */
export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Aunque la request falle, volvemos a /login: el proxy va a cortar
      // cualquier acceso si la cookie sigue viva.
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      className="inline-flex items-center justify-center touch:min-h-11 px-4 py-2 rounded-full text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
    >
      {loading ? "Saliendo…" : "Salir"}
    </button>
  );
}
