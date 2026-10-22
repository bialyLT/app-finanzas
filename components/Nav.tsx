"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoutButton from "./LogoutButton";
import { RefreshCw, CreditCard, Handshake, ChartColumn, Menu, X, type LucideIcon } from "lucide-react";

/**
 * Destinos de la navegación.
 *
 * ── POR QUÉ ES UN COMPONENTE CLIENTE ──────────────────────────────────────
 * En 375 px los seis destinos del nav NO entran: medidos, ocupan 532 px. Un
 * nav que no envuelve empuja el documento a 664 px y rompe TODAS las vistas
 * con scroll horizontal (era el defecto que arrastraba a la app entera en el
 * teléfono). En el teléfono el nav es un botón «Menú» que abre un panel de
 * dos columnas; en pantalla ancha sigue siendo la fila de siempre.
 *
 * ── POR QUÉ HAY UN SOLO CONJUNTO DE DESTINOS EN EL DOM ────────────────────
 * El panel del teléfono y la fila del escritorio renderizan los MISMOS
 * enlaces: una sola lista (`LINKS`), dos presentaciones. Si fueran dos
 * markup distintos, el `id` de un destino existiría dos veces y el
 * `querySelector` del primer match apuntaría al que está oculto — el
 * `tapOn` de un flow se iría a un elemento invisible y el fallo del flow
 * describiría el síntoma equivocado.
 *
 * El texto de cada destino es EXACTO (emoji + espacio + nombre) porque los
 * flows de Maestro lo matchean por texto completo: «Inicio» no puede
 * convertirse en «🏠 Inicio» sin romperlos.
 *
 * ── EL CORTE ES UNO SOLO Y EL RESTO ES FLUIDO ──────────────────────────────
 * El paso de «menú» a «fila» ocurre en `md` (768 px), que es donde la fila
 * entra entera: los destinos miden ~530 px y con la marca al lado necesitan
 * un poco más de 700. Entre 768 y el final, la fila ENVUELVE (`flex-wrap`)
 * antes que empujar el documento: si la ventana se angosta, los destinos
 * pasan a la línea de abajo en vez de romper el ancho de la página. El
 * arreglo es fluido, no una lista de anchos.
 */
type NavDestination = {
  href: string;
  label: string;
  icon: LucideIcon | null;
  id?: string;
  /** El destino "de entrada" va destacado (pastilla oscura). */
  highlighted?: boolean;
};

const LINKS: NavDestination[] = [
  { href: "/", label: "Inicio", icon: null, id: undefined },
  { href: "/recurrencia", label: "Recurrencia", icon: RefreshCw, id: "nav-recurrence" },
  { href: "/tarjetas", label: "Tarjetas", icon: CreditCard, id: "nav-cards" },
  { href: "/prestamos", label: "Préstamos", icon: Handshake, id: "nav-loans" },
  {
    href: "/analisis",
    label: "Análisis",
    icon: ChartColumn,
    id: undefined,
    highlighted: true,
  },
];

export default function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Navegar con el menú abierto lo deja abierto: el panel taparía la vista
  // nueva sin que nadie lo pidiera.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        id="nav-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="nav-destinos"
        className="md:hidden inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-3 "
      >
        {open ? (
          <>
            <X className="size-4" aria-hidden />
            Cerrar
          </>
        ) : (
          <>
            <Menu className="size-4" aria-hidden />
            Menú
          </>
        )}
      </button>

      {/* Los destinos. En pantalla ancha: una fila a la derecha de la marca
          (y si no entran, envuelven). En teléfono: ocultos hasta que se
          abre el menú, y entonces un panel de dos columnas debajo de la
          marca. */}
      <div
        id="nav-destinos"
        className={
          open
            ? "w-full mt-2 grid grid-cols-2 gap-2 md:w-auto md:mt-0 md:flex md:flex-wrap md:items-center md:justify-end md:gap-2"
            : "hidden md:flex md:flex-wrap md:items-center md:justify-end md:gap-2"
        }
      >
        {LINKS.map((link) => (
          <Link
            key={link.href}
            id={link.id}
            href={link.href}
            className={
              link.highlighted
                ? "inline-flex items-center justify-center gap-2 touch:min-h-11 px-4 py-2 rounded-full text-sm font-medium bg-primary text-primary-fg hover:opacity-90"
                : "inline-flex items-center justify-center gap-2 touch:min-h-11 px-4 py-2 rounded-full text-sm font-medium hover:bg-surface-3 "
            }
          >
            {link.icon ? (
              <>
                <link.icon className="size-4" aria-hidden />
                <span>{link.label}</span>
              </>
            ) : (
              link.label
            )}
          </Link>
        ))}
        <LogoutButton />
      </div>
    </>
  );
}
