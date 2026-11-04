# Batería del tester de base de datos — Fase 4.2 (monedas)

Verifica con datos reales que **ninguna consulta sume pesos con dólares**, que la
base haga cumplir los invariantes de la migración `20261104120000_fase4_monedas`
y que las reconciliaciones cuadren **al centavo**.

Sólo corre contra `finanzas_test` (`localhost:5433`). `finanzas_dev` y Neon están
prohibidas: `helpers.mjs` verifica el DSN **antes de abrir una conexión** y aborta
si no es la base local de tests. Nunca deduce el DSN con un regex sobre `.env`
(lección D17): lee `DATABASE_URL_TEST` y lo compara.

## Cómo se corre

```powershell
# 1. Base local + migraciones en finanzas_test
npm run db:local:start
npm run db:test:setup

# 2. Build fresco (el runner aborta si es más viejo que lib/ o app/)
npm run build

# 3. Batería completa (levanta la app en :3101 contra finanzas_test y la baja)
powershell -ExecutionPolicy Bypass -File scripts/tester-db/run.ps1

# Una sola batería
powershell -ExecutionPolicy Bypass -File scripts/tester-db/run.ps1 -Only 05
```

También se pueden correr sueltas, con la app ya levantada en
`http://127.0.0.1:3101` apuntando a `finanzas_test`:

```powershell
node scripts/tester-db/01-transferencias-moneda.mjs
```

## Qué prueba cada una

| # | Batería | Qué ataca |
|---|---|---|
| 00 | `00-limpieza.mjs` | Borra residuos `T42DB-` y exige 0. Se corre antes y después. |
| 01 | `01-transferencias-moneda.mjs` | ARS→USD y USD→ARS: saldo destino por `toAmount`, flujo de caja, patrimonio por moneda, totales/conteos, torta, barras, burn, reconciliación al centavo. |
| 02 | `02-invariantes-base.mjs` | Intenta guardar lo imposible: `toAmount` faltante/sobrante/≤0, moneda inmutable con historia, único por (nombre, moneda), presupuesto por moneda, singleton de `AppSettings`, NUL, 20 dígitos. Verifica que cada candado esté en la migración que lo creó. |
| 03 | `03-concurrencia.mjs` | Carrera cambio-de-moneda vs movimiento entrante (la FK serializa), dos altas del mismo nombre, 10 transferencias en paralelo, doble submit, sin deadlocks. |
| 04 | `04-endpoints-borde.mjs` | Los 5 endpoints con `?currency=EUR`, vacío, `usd`, `%20ARS`, `%00`, `Usd` → 400; sin parámetro === ARS; USD da números de dólares. |
| 05 | `05-deudas-cross-currency.mjs` | Préstamo USD pagado con pesos: `/api/debts` y `/api/loans` tienen que dar el MISMO capital pagado (`toAmount`), y el préstamo/ingreso USD no entra en `totalDebt` ni en el DTI en ARS. |
| 06 | `06-plata-declarada.mjs` | La banderita suma sólo en la moneda de su cuenta; la reconciliación ajusta `Δ = Ahorro − Declarada` en las dos monedas. |
| 07 | `07-volumen-explain.mjs` | 20.200 movimientos: el tope de 500 filas no recorta los totales ni los conteos; latencias y `EXPLAIN` de las consultas críticas. |

## Reglas del arnés

- Los números esperados se calculan **a mano** o con **SQL propio** escrito desde
  la definición del dominio (`sqlBalance`, `sqlCashFlow`, `sqlKindTotals`,
  `sqlTransferNet`), nunca llamando a la función que se está probando.
- Datos con prefijo único por corrida (`T42DB-…`) y limpieza **por id**, incluso
  si la batería revienta. Al cerrar se cuentan y se exige 0.
- El patrimonio se mide como **delta** contra una línea base capturada antes de
  sembrar: la base de tests puede tener residuos de otras suites y la batería no
  depende de eso.
- Los meses de prueba son lejanos a "hoy" (2031/2032) para que el período no
  tenga datos de otras corridas.
