#!/usr/bin/env node
/**
 * Limpieza de residuos de la batería del tester DB (prefijo `T42DB-`).
 *
 * Existe porque un script que revienta a mitad de camino no puede confiar en su
 * propio `finally` (por ejemplo, si el proceso muere por un error del motor).
 * Se corre antes y después de la ronda; exige 0 residuos.
 *
 * SÓLO borra filas cuyo nombre/descripción empieza con `T42DB-`: son de esta
 * batería. No toca datos de la app ni de otras suites.
 */

import { cleanupTag, db, mask, DB_URL, residueOf } from "./helpers.mjs";

const PREFIX = "T42DB-";

console.log(`Base: ${mask(DB_URL)}`);
console.log(`Limpiando residuos con prefijo ${PREFIX}…`);

await cleanupTag(PREFIX);

const residue = await residueOf(PREFIX);
console.log(
  `residuos: ${residue.accounts} cuentas · ${residue.categories} categorías · ${residue.movements} movimientos`,
);
await db.$disconnect();

const limpio = residue.accounts === 0 && residue.categories === 0 && residue.movements === 0;
console.log(limpio ? "  base limpia" : "  FALLA: quedaron residuos");
process.exit(limpio ? 0 : 1);
