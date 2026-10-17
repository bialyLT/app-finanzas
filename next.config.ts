import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * ───────────────────────────────────────────────────────────────────────────
   * allowedDevOrigins
   * ───────────────────────────────────────────────────────────────────────────
   * Next.js trata a `localhost` y a `127.0.0.1` como ORÍGENES DISTINTOS, aunque
   * apunten a la misma máquina. Por defecto sólo confía en el origen con el que
   * arrancó el dev server, y bloquea los recursos internos de desarrollo
   * (`/_next/hmr`, el runtime del cliente) cuando llegan desde el otro:
   *
   *     ⨯ Blocked cross-origin request to Next.js dev resource /_next/hmr
   *       from "127.0.0.1".
   *
   * El síntoma es MUY engañoso: la página se ve bien, el HTML llega, pero React
   * NUNCA HIDRATA. El formulario queda como HTML inerte — se puede escribir en
   * los campos, pero los botones no hacen nada porque no hay ningún handler de
   * React atado. En los tests parece "la app está rota" cuando en realidad es
   * esta validación de origen.
   *
   * Por qué hace falta 127.0.0.1 y no alcanza con localhost:
   * los flows de Maestro navegan a 127.0.0.1 porque Chrome reescribe
   * `http://localhost` a `https://localhost` (modo HTTPS-First) y la navegación
   * muere esperando un handshake TLS contra un servidor que habla HTTP plano.
   * `127.0.0.1` está exento de esa reescritura — pero entonces es Next quien
   * bloquea el origen. De ahí las dos entradas.
   *
   * Esto sólo afecta al servidor de DESARROLLO. En producción no aplica.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "100.67.117.77"],

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * Cabeceras de seguridad
   * ───────────────────────────────────────────────────────────────────────────
   * Next no las agrega solo. Son defensa en profundidad, barata y sin estado:
   *
   *   · X-Content-Type-Options: nosniff
   *     El navegador deja de "adivinar" el tipo de un recurso y respeta el
   *     Content-Type. Evita que un cuerpo servido como algo inofensivo se
   *     interprete como script.
   *
   *   · X-Frame-Options: DENY
   *     Nadie puede embeber la app en un <iframe>. Corta el clickjacking sobre
   *     el formulario de login. (CSP `frame-ancestors` es el reemplazo moderno,
   *     pero una CSP completa en Next necesita cuidar los scripts inline; acá
   *     alcanza con esto, que no rompe nada.)
   *
   *   · Referrer-Policy: strict-origin-when-cross-origin
   *     Al navegar a otro sitio no se filtra la URL completa (que podría incluir
   *     rutas con datos); sólo el origen, y sólo si el destino es https.
   *
   * NO se manda Strict-Transport-Security: sobre http el navegador la ignora, y
   * en local forzar https rompería el acceso. En producción, servida por https,
   * conviene agregarla (ver recomendaciones del informe).
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
