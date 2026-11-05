# Batería del tester de calidad — Fase 4.4b

Mide **salud estructural**, no estilo: tipos, lint, complejidad, duplicación,
código muerto, cobertura *útil* y los agujeros de concurrencia que un delta deja
abiertos. No reformatea nada y no commitea.

## Qué hay acá

| Archivo | Qué mide | Necesita base |
|---|---|---|
| `01-delta-f42.mjs` | Delta de F4.2: tsc, suite, lint de los tocados, las dos patas de la conversión, `?currency=` validado, `any` nuevo, costo documentado | sí (suite) |
| `02-lock-settings.mjs` | El `pg_advisory_xact_lock` de `PATCH /api/settings`: ¿toma?, ¿excluye?, ¿colisiona con el del CSV?, ¿se libera al commit y al rollback?, y la invariante "ninguna cuenta en una moneda apagada" (carrera modelada + camino determinista) | sí (`finanzas_test`) |
| `03-duplicacion-y-muertos.mjs` | Duplicación entre archivos del delta (8 y 12 líneas), exports agregados sin consumidor, `any` nuevo, dueño único de cada advisory lock | no |
| `settings.repro.ts` | Repro **contra la ruta real** de: PATCH idempotente, GET con la fila singleton ausente y el cambio de moneda de una cuenta a una moneda apagada | sí (`finanzas_test`) |
| `vitest.repro.config.mts` | Config propia para que los repros **no** entren en `npm test` (dos archivos de integración se pelearían por la base) | — |

## Cómo se corre

```powershell
# Base local de tests + migraciones (si no está levantada)
npm run db:local:start
npm run db:test:setup

# Estático (1 s, sin base)
node scripts/tester-quality/03-duplicacion-y-muertos.mjs

# Con base: lock, carrera e invariante
node scripts/tester-quality/02-lock-settings.mjs

# Repro contra la ruta real
npx vitest run --config scripts/tester-quality/vitest.repro.config.mts
```

Todas imprimen `RESULT ok=N fail=M` y salen con ≠0 si alguna falla.

## Reglas de estos scripts

- **Sólo `finanzas_test`.** `02` aborta si `DATABASE_URL_TEST` no nombra esa base;
  el repro aborta si el DSN no la contiene. El DSN se lee de la variable, nunca se
  deduce con un regex sobre `.env` (lección D17).
- **Dejan la base como la encontraron.** `02` guarda `enabledCurrencies`, borra
  las cuentas que crea **por id** y restaura la fila; imprime la restauración y
  se marca `REVISAR` si no coincide.
- **Los FAIL pueden ser hallazgos.** Los checks que miden una invariante
  deseada ("la invariante se sostiene…") fallan mientras el agujero exista: es la
  deuda, escrita una vez, que se pone verde sola cuando alguien la cierra.
- **El repro no entra en `npm test`**: el `include` del proyecto es
  `**/*.test.ts` y dos archivos de integración se pelearían por la base
  (`resetDatabase`), que es justo lo que el proyecto documenta que no hay que
  hacer. Por eso la config separada y el sufijo `.repro.ts`.
