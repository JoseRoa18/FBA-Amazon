# Deploy Guide — FBA Analyzer

Pasos para deployar la app a Vercel conectada a GitHub con Supabase como backend.

**Duración total:** ~20 minutos.

---

## Paso 1 — Cuenta de GitHub (si aún no tenés)

Si ya tenés cuenta, pasá al Paso 2.

1. Ir a [github.com](https://github.com) → **Sign up**
2. Username, email, password → seguir los pasos
3. Verificar el email

---

## Paso 2 — Crear un repo privado

1. Ir a [github.com/new](https://github.com/new)
2. **Repository name**: `fba-analyzer` (o lo que quieras)
3. Seleccionar **Private** (privacidad para código de empresa)
4. **NO** marques "Add a README", "Add .gitignore", ni "Choose a license" (vas a pushear un proyecto que ya los tiene)
5. Click **Create repository**

Te va a mostrar una pantalla con comandos git. Dejala abierta, la vas a usar en el próximo paso.

---

## Paso 3 — Subir el código al repo

Tenés dos opciones. Elegí la que te resulte más cómoda:

### Opción A — Git por línea de comandos (recomendada)

Abrí una terminal en la carpeta `fba-static/` y ejecutá:

```bash
git init
git add .
git commit -m "Initial commit: FBA Analyzer v3.4"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/fba-analyzer.git
git push -u origin main
```

Reemplazá `TU_USUARIO` por tu username de GitHub. La primera vez te va a pedir usuario y password (o un Personal Access Token — GitHub te guía).

### Opción B — Upload drag-and-drop (no necesita git)

1. En tu repo recién creado, click **uploading an existing file** (link en la pantalla inicial)
2. Arrastrá todos los archivos de `fba-static/` al navegador
3. **IMPORTANTE**: NO subas la carpeta `node_modules/` si existe, ni el archivo `js/config.js` (tiene tus credenciales)
4. Scroll abajo, mensaje de commit: `Initial commit`
5. Click **Commit changes**

Cuando termines, vas a ver todos los archivos en el repo.

---

## Paso 4 — Crear cuenta en Vercel

1. Ir a [vercel.com/signup](https://vercel.com/signup)
2. Click **Continue with GitHub**
3. Autorizar Vercel en tu cuenta GitHub
4. Elegir el plan **Hobby** (gratis)

---

## Paso 5 — Importar el repo en Vercel

1. En el dashboard de Vercel → **Add New...** → **Project**
2. Si es tu primera vez, te va a pedir permisos a tus repos. Click **Adjust GitHub App Permissions** y elegí acceso al repo `fba-analyzer` (o a todos, como prefieras)
3. Volver a Vercel, ahora vas a ver tu repo en la lista → click **Import**

En la pantalla de configuración del proyecto:

- **Project Name**: `fba-analyzer` (o el que quieras — esto define tu URL)
- **Framework Preset**: `Other` (debería auto-detectarse)
- **Root Directory**: `./` (déjalo así)
- **Build and Output Settings**: déjalo en default (ya está configurado en `vercel.json`)

**NO hagas click en "Deploy" todavía.** Abrí la sección **Environment Variables** y agregá estas dos:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://xnnwmgphmkerjxlqnekl.supabase.co` (tu URL real) |
| `SUPABASE_ANON_KEY` | `eyJhbGci...` (tu anon key completa) |

Confirmá que ambas estén marcadas para **Production**, **Preview** y **Development**.

**Ahora sí** → click **Deploy**.

Vercel va a:
1. Clonar tu repo
2. Ejecutar `node build.js` (que genera `js/config.js` con las env vars)
3. Publicar el sitio estático

Duración: 30-60 segundos.

---

## Paso 6 — Probar tu app deployada

Cuando termine el deploy vas a ver una pantalla con confetti 🎉 y tu URL pública, algo como:

```
https://fba-analyzer-TU_USUARIO.vercel.app
```

1. Click en la URL
2. Subí los 3 archivos de siempre (Amazon, CIN7, Stylish)
3. Click **Run Analysis**
4. Verificá:
   - ✅ El análisis corre sin errores
   - ✅ En la sección "FBA · Not Prime" aparece `Synced just now · N tracked`
   - ✅ Las pills de días se llenan correctamente

**Si ves "Local mode · no history"** → las env vars no se aplicaron. Volvé a Vercel → tu proyecto → Settings → Environment Variables → confirmá que estén cargadas. Después **Deployments** → último deploy → `...` → **Redeploy**.

---

## Paso 7 — Keep-alive para Supabase (evita auto-pause)

Supabase pausa proyectos del free tier tras 7 días sin actividad. El workflow de GitHub Actions que ya está en el repo (`.github/workflows/keep-alive.yml`) hace una query mínima cada día para mantenerlo activo.

Para que funcione, tenés que configurar los secrets en GitHub:

1. En tu repo de GitHub → **Settings** (pestaña arriba) → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Crear estos dos secrets:

| Name | Value |
|------|-------|
| `SUPABASE_URL` | Tu Project URL de Supabase |
| `SUPABASE_ANON_KEY` | Tu anon public key |

4. Verificar que el workflow esté activo: **Actions** (pestaña arriba) → debería ver "Supabase Keep-Alive" en la lista
5. **Run it manually the first time**: click el workflow → **Run workflow** → **Run workflow** (botón verde)
6. Después de ~20 segundos, refresh → debería aparecer una ✓ verde

De ahí en más corre solo cada día a las 08:00 UTC.

---

## Paso 8 — Compartir con tu equipo

Tu URL pública (`https://fba-analyzer-TU_USUARIO.vercel.app`) ya está lista para compartir. Cualquier persona con el link puede:
- Subir los 3 archivos
- Correr el análisis
- Ver los datos trackeados compartidos (todos ven lo mismo desde Supabase)

No necesitan instalar nada, ni tener cuentas.

---

## Actualizar el código

Cualquier cambio que hagas al código, después de commitear y pushear a `main`, Vercel lo re-deploya automáticamente en ~30 segundos. El auto-deploy ya quedó configurado en el Paso 5.

```bash
# Hiciste cambios → commit + push
git add .
git commit -m "descripción del cambio"
git push
```

Vercel te manda un email cuando termina el redeploy.

---

## Troubleshooting

**"Local mode · no history" en producción**
→ Las env vars no se inyectaron. Vercel → Settings → Environment Variables → verificar. Redeploy.

**Supabase dashboard muestra proyecto pausado**
→ Click **Restore project**. Hacé el keep-alive (Paso 7) para que no vuelva a pasar.

**GitHub Actions falla con "unauthorized"**
→ Secrets mal configurados. Verificá Name exacto: `SUPABASE_URL` y `SUPABASE_ANON_KEY` (case-sensitive).

**Deploy falla en Vercel con "Cannot find module ..."**
→ Probablemente subiste `node_modules/`. Borralo del repo: `git rm -rf node_modules && git commit -m "remove node_modules" && git push`.

**Los usuarios ven "Sync failed" en la UI**
→ Supabase pausado o RLS policies borradas. Revisá el dashboard de Supabase y la consola del browser (F12) para ver el error exacto.
