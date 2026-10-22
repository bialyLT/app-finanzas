import Link from "next/link";
import { getSession } from "@/lib/auth/dal";
import Nav from "./Nav";
import { Wallet } from "lucide-react";

/**
 * Barra de navegación del layout raíz.
 *
 * Es server component y consulta la sesión para dos cosas:
 *   1. No mostrar la navegación a un visitante anónimo (que sólo puede
 *      estar viendo /login).
 *   2. Mostrar el botón de cerrar sesión sólo cuando hay una sesión real.
 *
 * Nota de arquitectura: leer `cookies()` acá vuelve dinámico el layout raíz.
 * Es lo correcto en una app privada — no hay nada que se pueda pre-renderizar
 * de forma segura sin saber quién pregunta.
 *
 * La navegación en sí (la fila de destinos y el menú del teléfono) vive en
 * `components/Nav.tsx`, que es client component porque el menú del teléfono
 * necesita estado. El `header` es sólo la envoltura sticky.
 */
export default async function Header() {
  const session = await getSession();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
      <nav className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:flex-nowrap sm:py-3">
        <Link
          href="/"
          className="shrink-0 inline-flex items-center gap-1.5 touch:min-h-11 font-extrabold text-lg tracking-tight"
        >
          <Wallet className="size-5 inline-block align-[-2px]" aria-hidden />
          <span>
            <span className="text-success">Mis</span>Finanzas
          </span>
        </Link>

        {session && <Nav />}
      </nav>
    </header>
  );
}
