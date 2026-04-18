# FBA Analyzer v3.4

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

- `not_prime_tracking` (marketplace, sku, first_unavailable, last_seen)
- `snapshots` (full JSONB dump de cada análisis)
- Function `reconcile_not_prime(mp, skus)` - upsert atómico + compute days

## Seguridad

La `anon key` de Supabase es pública por diseño. Las Row Level Security policies en la DB permiten lectura/escritura a cualquiera con la anon key (policies permisivas, OK para herramienta interna). Si en el futuro se quiere restringir, agregar Supabase Auth.
