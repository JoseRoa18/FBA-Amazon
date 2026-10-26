-- sku_overrides — ajustes por SKU editables desde la app ("SKU settings").
-- Correr una vez en Supabase → SQL Editor. Se puede volver a correr sin problema.
--
--   discontinued  → el SKU no aparece en ningún reporte (USA y CA)
--   pack_density  → reemplaza el Pack Density de data/info.csv (null = usar el maestro)
--
-- La app borra la fila cuando el SKU queda sin ningún ajuste.

create table if not exists public.sku_overrides (
    sku           text primary key,
    discontinued  boolean not null default false,
    pack_density  integer check (pack_density is null or pack_density > 0),
    updated_at    timestamptz not null default now()
);

-- Mismo criterio que el resto de las tablas: policies permisivas para la anon key
-- (herramienta interna, ver "Seguridad" en README.md).
alter table public.sku_overrides enable row level security;

drop policy if exists "sku_overrides anon select" on public.sku_overrides;
drop policy if exists "sku_overrides anon insert" on public.sku_overrides;
drop policy if exists "sku_overrides anon update" on public.sku_overrides;
drop policy if exists "sku_overrides anon delete" on public.sku_overrides;

create policy "sku_overrides anon select" on public.sku_overrides for select to anon using (true);
create policy "sku_overrides anon insert" on public.sku_overrides for insert to anon with check (true);
create policy "sku_overrides anon update" on public.sku_overrides for update to anon using (true) with check (true);
create policy "sku_overrides anon delete" on public.sku_overrides for delete to anon using (true);

grant select, insert, update, delete on public.sku_overrides to anon;
