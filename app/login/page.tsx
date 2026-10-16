import type { Metadata } from "next";
import LoginForm from "@/components/LoginForm";

export const metadata: Metadata = {
  title: "Entrar — Mis Finanzas",
};

/**
 * Normaliza el parámetro `next`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE USA DIRECTO
 * ─────────────────────────────────────────────────────────────────────────────
 * `?next=` es un parámetro que el atacante controla. Si se pasara tal cual a
 * `router.replace(next)`, un link como
 *
 *     https://mi-app/login?next=https://sitio-malicioso.com
 *
 * llevaría al usuario a un sitio externo DESPUÉS de un login exitoso — el
 * usuario ve un login legítimo y termina en otro sitio. Es un open redirect, y
 * es el vector clásico de phishing con "dominio correcto".
 *
 * Regla: sólo se aceptan rutas internas. Tiene que empezar con "/" y NO puede
 * empezar con "//" ni "/\", que son las dos formas de escribir una URL
 * protocolo-relativa (`//evil.com` es una URL absoluta sin esquema).
 */
function safeRedirectTarget(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // En Next 16 `searchParams` es una Promise: hay que await-earla.
  const params = await searchParams;
  const next = safeRedirectTarget(params.next);

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8 shadow-sm">
        <h1 className="text-2xl font-extrabold tracking-tight mb-1">Mis Finanzas</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Esta aplicación es privada. Ingresá tu contraseña para continuar.
        </p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
