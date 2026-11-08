import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("Falta DATABASE_URL_TEST.");

const name = new URL(url).pathname.replace("/", "");
if (name !== "finanzas_test") throw new Error(`Se negó: la base es «${name}».`);

const db = new PrismaClient({ datasourceUrl: url });

// Corta conexiones colgadas de corridas abortadas: si no, el DROP se queda esperando.
const matadas = await db.$queryRawUnsafe(
  `SELECT count(pg_terminate_backend(pid))::int AS n
     FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`,
);
console.log("conexiones cortadas:", JSON.stringify(matadas));

await db.$executeRawUnsafe(`DROP SCHEMA public CASCADE`);
await db.$executeRawUnsafe(`CREATE SCHEMA public`);
await db.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO public`);
console.log(`Schema public de «${name}» recreado.`);

await db.$disconnect();
