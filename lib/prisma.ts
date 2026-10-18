import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Cuánto espera una transacción interactiva por una conexión del pool.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL DEFAULT (2 s) NO ALCANZA
 * ─────────────────────────────────────────────────────────────────────────────
 * Prisma espera 2 s (`maxWait` por defecto) y después tira P2028 («Unable to
 * start a transaction in the given time»). El hallazgo fue real, con repro: el
 * alta de un préstamo —una transacción interactiva— murió con ese P2028 durante
 * un pico de pedidos, y la persona vio un 500 que la mandaba a revisar datos
 * que estaban perfectos.
 *
 * El pool tiene 2×núcleos+1 conexiones (9 en esta máquina) y cada pedido tarda
 * decenas de milisegundos: un pico que las ocupe más de 2 s no es raro cuando
 * el servidor comparte la máquina con el navegador y el runner de los tests.
 *
 * 15 s convierten un fallo silencioso en, a lo sumo, un click más lento.
 * `timeout` (20 s) acota la transacción ENTERA: las de esta app tardan
 * milisegundos, así que 20 s es solo una red de seguridad.
 *
 * La exportamos porque el cliente de los tests de integración tiene que
 * configurarse IGUAL que el del server: si no, los tests del pool probarían
 * una configuración que la app no usa.
 */
export const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ transactionOptions: TRANSACTION_OPTIONS });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
