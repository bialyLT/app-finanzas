# 💰 Mis Finanzas — Control de Ingresos y Gastos

App web fullstack en **Next.js** para registrar tus ingresos y gastos diarios y analizarlos por **semana, mes y año**.

## Funcionalidades

- **Vista principal (`/`)**: balance del mes, botones grandes **＋ Ingreso** y **－ Gasto**, lista de movimientos con filtros y borrado.
- **Formulario**: monto, fecha, nota, checkbox de **fijo / variable** y **tipo**.
  - Los **tipos no se repiten**: la primera vez que escribes uno (ej: "Sueldo", "Alquiler") se guarda; después lo eliges de la lista de sugerencias o del desplegable.
- **Análisis (`/analisis`)**: cambia entre **Semana / Mes / Año**, gráfico de barras Ingresos vs Gastos, gráficos de torta por tipo, resumen de fijos y detalle de movimientos.
- Base de datos **Postgres en la nube (Neon o Supabase) + Prisma**.

## Requisitos

- Node.js 20+ (ya instalado en esta máquina vía winget)
- Una base Postgres gratis: **Neon** (recomendado, más simple) o **Supabase**

## Uso local

```bash
npm install        # instalar dependencias
# 1. Pega tu connection string en .env (ver .env.example)
npm run db:push    # crear las tablas en la nube (solo la primera vez)
npm run dev        # arrancar en desarrollo -> http://localhost:3000
```

## Subirlo a internet (Vercel + Neon/Supabase)

1. **Base de datos**: crea un proyecto gratis en [Neon](https://neon.tech) o [Supabase](https://supabase.com)
   y copia el connection string (pooler: en Neon termina en `-pooler…`, en Supabase usa el
   "Session pooler" puerto 6543).
2. **Tablas**: con ese string en tu `.env` local, corre `npm run db:push` una vez.
3. **Código a GitHub**: `git init`, commit y súbelo a un repo.
4. **Vercel**: en [vercel.com](https://vercel.com) → Add New → Project → importa el repo.
   En *Environment Variables* agrega `DATABASE_URL` con el mismo connection string.
5. Deploy. El `build` ya incluye `prisma generate`, no hay que configurar nada más.

Para producción:

```bash
npm run build
npm run start
```

## Estructura

```
app/page.tsx              -> vista principal (registro)
app/analisis/page.tsx     -> vista de análisis con gráficos
app/api/categories/       -> GET/POST de tipos (evita duplicados por nombre+kind)
app/api/transactions/     -> GET/POST de movimientos (crea el tipo si no existe)
app/api/transactions/[id] -> DELETE de un movimiento
components/TransactionForm.tsx -> formulario Ingreso/Gasto con sugerencias de tipos
prisma/schema.prisma      -> modelos Category y Movement
lib/finance.ts            -> tipos y formato de moneda
```

## Modelos

- **Category**: `name` + `kind` (INCOME/EXPENSE) únicos → un tipo nunca se repite dentro de ingresos o gastos.
- **Movement**: `kind`, `amount`, `date`, `isFixed` (fijo o puntual), `description`, `categoryId`.
