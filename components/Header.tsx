import Link from "next/link";
import { getSession } from "@/lib/auth/dal";
import LogoutButton from "./LogoutButton";

/**
 * Barra de navegación del layout raíz.
 *
 * Es server component y consulta la sesión para dos cosas:
 *   1. No mostrar "Análisis" ni "Salir" a un visitante anónimo (que sólo puede
 *      estar viendo /login).
 *   2. Mostrar el botón de cerrar sesión sólo cuando hay una sesión real.
 *
 * Nota de arquitectura: leer `cookies()` acá vuelve dinámico el layout raíz.
 * Es lo correcto en una app privada — no hay nada que se pueda pre-renderizar
 * de forma segura sin saber quién pregunta.
 */
export default async function Header() {
  const session = await getSession();

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-black/90 backdrop-blur">
      <nav className="mx-auto max-w-5xl flex items-center justify-between px-4 py-3">
        <Link href="/" className="font-extrabold text-lg tracking-tight">
          💰 <span className="text-emerald-600">Mis</span>Finanzas
        </Link>

        {session && (
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Inicio
            </Link>
            <Link
              id="nav-recurrence"
              href="/recurrencia"
              className="px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              🔁 Recurrencia
            </Link>
            <Link
              id="nav-cards"
              href="/tarjetas"
              className="px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              💳 Tarjetas
            </Link>
            <Link
              id="nav-loans"
              href="/prestamos"
              className="px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              🤝 Préstamos
            </Link>
            <Link
              href="/analisis"
              className="px-4 py-2 rounded-full text-sm font-medium bg-zinc-900 text-white dark:bg-white dark:text-black hover:opacity-90"
            >
              📊 Análisis
            </Link>
            <LogoutButton />
          </div>
        )}
      </nav>
    </header>
  );
}
