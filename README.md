# FBA Analyzer v5.2

App 100% estática para análisis de inventario FBA. Todo el procesamiento corre en el browser; Supabase guarda el tracking histórico y snapshots.

## Stack

- **Frontend**: HTML + JS vanilla + Chart.js + Bootstrap 5
- **Parseo**: SheetJS (XLSX) + PapaParse (CSV)
- **Persistencia**: Supabase (Postgres + RLS)
- **Hosting**: Vercel (frontend estático)
- **Keep-alive**: GitHub Actions cron

## Desarrollo local

```bash
cd fba-static

# 1. Copiar el template de config y pegar credenciales
cp js/config.example.js js/config.js
# Editar js/config.js con tu URL y anon key de Supabase

# 2. Servidor local
python3 -m http.server 8080

# 3. Abrir http://localhost:8080
```

## Deploy a Vercel

Ver `DEPLOY.md` para instrucciones paso a paso.

## Estructura

```
fba-static/
├── index.html              # UI principal
├── css/style.css           # Estilos (dark/light themes)
├── js/
│   ├── app.js              # Lógica completa (1800+ líneas)
│   ├── config.js           # Credenciales Supabase (gitignored)
│   └── config.example.js   # Template committeado
├── data/                   # Config bundleada (SKUs master, mappings)
├── build.js                # Generador de config.js en deploy
├── package.json            # Solo script de build
├── vercel.json             # Config de Vercel
└── .github/workflows/
    └── keep-alive.yml      # Cron diario a Supabase
```

## Schema Supabase

- `not_prime_tracking` (marketplace, sku, first_unavailable, last_seen_unavailable)
- `snapshots` (full JSONB dump de cada análisis)
- Function `reconcile_not_prime(mp, skus)` - upsert atómico + compute days

## Reglas de reposición

- `target = round(units_sold_30d × días / 30)`
- Todo SKU con **FBA = YES** tiene un stock mínimo de **2 unidades** en Amazon (USA y CA), aunque no tenga ventas: `target = max(target, 2)`.
- `qty_to_send = max(0, target − inventario en Amazon)`
- Pallets = `qty_to_send / pack density` (redondea arriba desde 0.70). Sinks van en Pallet, el resto en Carton; sin pallet completo va Loose. Si el SKU no tiene pack density en el maestro, siempre sale Loose y la fila lo avisa.
- Un SKU **FBA = YES que no aparece en el reporte de Amazon** no se descarta: entra con 0 ventas / 0 inventario, marcado "Not in Amazon", cuenta como OOS y Not Prime, y se lista en un aviso sobre la tabla. Los SKUs no-FBA ausentes sí se excluyen.
- La tarjeta **Overstocked** muestra aparte cuántos de esos SKUs tienen 0 ventas en 30 días (cobertura indefinida, no exceso real); el sub-conteo es clickeable para aislarlos.

Tests: `npm test`

## Seguridad

La `anon key` de Supabase es pública por diseño. Las Row Level Security policies en la DB permiten lectura/escritura a cualquiera con la anon key (policies permisivas, OK para herramienta interna). Si en el futuro se quiere restringir, agregar Supabase Auth.
