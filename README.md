# FBA Analyzer v5.4

App estática para análisis de inventario FBA. Todo el procesamiento corre en el browser; Supabase guarda el tracking histórico y snapshots, y una función serverless de Vercel trae el inventario en vivo desde Odoo.

## Stack

- **Frontend**: HTML + JS vanilla + Chart.js + Bootstrap 5
- **Parseo**: SheetJS (XLSX) + PapaParse (CSV)
- **Persistencia**: Supabase (Postgres + RLS)
- **Hosting**: Vercel (frontend estático + 1 función serverless)
- **Inventario**: Odoo 18 vía JSON-RPC (`api/odoo-inventory.js`)
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

En local no existe `/api/odoo-inventory` (es una función de Vercel), así que la app usa el flujo de 2 archivos. Para probar Odoo en local: `vercel dev` con las env vars `ODOO_*` cargadas.

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
├── api/
│   └── odoo-inventory.js   # Función de Vercel: inventario de Odoo (CBG / ATL)
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
- `sku_overrides` (sku, discontinued, pack_density, updated_at) — ajustes de "SKU settings". **Crear una vez** corriendo `supabase/sku_overrides.sql` en el SQL Editor de Supabase; hasta entonces el editor avisa y queda en solo lectura.

## Reglas de reposición

- `target = round(units_sold_30d × días / 30)`
- Todo SKU con **FBA = YES** tiene un stock mínimo de **2 unidades** en Amazon (USA y CA), aunque no tenga ventas: `target = max(target, 2)`.
- `qty_to_send = max(0, target − inventario en Amazon)`
- Pallets = `qty_to_send / pack density` (redondea arriba desde 0.70). Sinks van en Pallet, el resto en Carton; sin pallet completo va Loose. Si el SKU no tiene pack density en el maestro, siempre sale Loose y la fila lo avisa.
- Un SKU **FBA = YES que no aparece en el reporte de Amazon** no se descarta: entra con 0 ventas / 0 inventario, marcado "Not in Amazon", cuenta como OOS y Not Prime, y se lista en un aviso sobre la tabla. Los SKUs no-FBA ausentes sí se excluyen.
- La tarjeta **Overstocked** muestra aparte cuántos de esos SKUs tienen 0 ventas en 30 días (cobertura indefinida, no exceso real); el sub-conteo es clickeable para aislarlos.

## Inventario desde Odoo

El inventario de almacén ya no necesita archivo: sale de Odoo, del reporte **Inventory → Reporting → Calculated Inventory**, columna **Available for Use**, filtrado por almacén:

| Marketplace | Almacén Odoo | Columna en la app |
|-------------|--------------|-------------------|
| CA | `CBG` | Stylish inv. |
| USA | `ATL` | Warehouse (Flowery Branch) |

- La app llama a `GET /api/odoo-inventory?mp=ca|usa` (función de Vercel). La función se autentica con las env vars `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY`, lee `available_for_use` con el mismo contexto `warehouse_id` que usa el panel de almacenes del reporte, y devuelve `{ SKU: qty }` solo para los SKUs de `data/info.csv`. Solo hace lecturas; la respuesta se cachea 60 s en el CDN.
- Con Odoo conectado alcanza con subir el reporte de Amazon. En CA el archivo Stylish queda opcional: si se sube, solo aporta el **ETA** (la cantidad sale de Odoo).
- Bajo las tarjetas de upload se ve la fuente activa. **Use a file instead** vuelve al flujo de 2 archivos; si la función no responde (o corriendo en local, donde no existe) la app cae sola a ese flujo.
- SKUs del maestro que no existen en Odoo quedan en 0.

## SKU settings

Botón **SKU settings** en la barra superior (también se abre clickeando el pack density de una fila, un SKU del aviso "not in the Amazon restock report" o el contador de descontinuados). Los cambios se guardan en `sku_overrides`, son compartidos y aplican a USA y CA:

- **Discontinued**: el SKU desaparece de todo (KPIs, charts, tabla, Not Prime, aviso de ausentes, exports, conteos del snapshot). Es reversible: el snapshot guarda la data cruda y los overrides se aplican al mostrarla.
- **Pack density**: reemplaza el valor de `data/info.csv` (vacío o igual al maestro = usar el maestro). En la tabla, un lápiz marca los valores editados.

## Matching del reporte de Amazon

Cada fila del Restock report se asocia a un SKU del maestro probando, en orden: Merchant SKU (USA directo, CA vía `can-sku.csv`), **Supplier part no.** y Supplier. Esto cubre ofertas FBA con Merchant SKU autogenerado por Amazon (ej. `RS-HRI7-BSCJ` → `S-832WN` en CA), que antes quedaban fuera y hacían que el SKU apareciera como "Not in Amazon" sin su inbound. El detalle de procesamiento lista esos alias y las filas que no matchearon.

Tests: `npm test`

## Seguridad

La `anon key` de Supabase es pública por diseño. Las Row Level Security policies en la DB permiten lectura/escritura a cualquiera con la anon key (policies permisivas, OK para herramienta interna). Si en el futuro se quiere restringir, agregar Supabase Auth.
