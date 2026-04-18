// js/app.js — FBA Analyzer v3.0 (static) — Partes 1+2+3
// 100% estático: parseo, procesamiento y dashboard corren en el browser.
// Sin backend PHP, sin servidor.

class FbaAnalyzer {
    constructor() {
        // Archivos subidos
        this.files = { amazon: null, cin7: null, stylish: null };
        // Archivos parseados (raw)
        this.parsed = { amazon: null, cin7: null, stylish: null };
        // Config bundleada (se carga al arranque)
        this.config = {
            info: null, fbaCA: null, fbaUSA: null,
            skuMapCA: null, skuMapUSA: null,
        };
        // Resultados del procesamiento (Parte 2)
        this.processedData = [];
        this.processedMeta = {};

        // Dashboard state (Parte 3)
        this.allData = [];          // resultado + calcs (target, qty_to_send, coverage, pallets, method)
        this.filteredData = [];
        this.categories = new Set();
        this.selectedDays = 45;
        this.activeKpiFilter = null;

        // Marketplace
        this.isAmazonUSA = false;

        // Charts
        this.chartHealth = null;
        this.chartTopSellers = null;
        this.chartCategories = null;
        this.chartCoverageDist = null;

        // Chart.js defaults
        Chart.defaults.color = '#8b949e';
        Chart.defaults.borderColor = 'rgba(48,54,61,0.5)';
        Chart.defaults.font.family = "'DM Sans', sans-serif";
        Chart.defaults.font.size = 12;
        Chart.defaults.animation = { duration: 300, easing: 'easeOutQuart' };
        Chart.defaults.plugins.tooltip = {
            ...Chart.defaults.plugins.tooltip,
            backgroundColor: 'rgba(13, 17, 23, 0.95)',
            titleColor: '#e6edf3',
            bodyColor: '#c9d1d9',
            borderColor: 'rgba(88, 166, 255, 0.3)',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            titleFont: { size: 13, weight: '600', family: "'DM Sans', sans-serif" },
            bodyFont: { size: 12, family: "'DM Sans', sans-serif" },
            displayColors: true,
            boxPadding: 6,
            caretPadding: 8,
        };

        // Registrar plugin datalabels globalmente. Por default NO muestra labels (opt-in
        // por chart) para no ensuciar los charts que no los necesitan.
        if (window.ChartDataLabels) {
            Chart.register(ChartDataLabels);
            Chart.defaults.plugins.datalabels = { display: false };
        }

        // Plugin custom para texto en el centro del doughnut (total SKUs)
        this.centerTextPlugin = {
            id: 'centerText',
            afterDraw: (chart) => {
                if (!chart.config.options?.plugins?.centerText?.display) return;
                const { ctx, chartArea } = chart;
                if (!chartArea) return;
                const cfg = chart.config.options.plugins.centerText;
                const cx = (chartArea.left + chartArea.right) / 2;
                const cy = (chartArea.top + chartArea.bottom) / 2;
                const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
                const colorPrimary = isDark ? '#e6edf3' : '#1f2328';
                const colorSecondary = isDark ? '#8b949e' : '#59636e';

                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = `700 30px 'DM Sans', sans-serif`;
                ctx.fillStyle = colorPrimary;
                ctx.fillText(cfg.value ?? '', cx, cy - 10);
                ctx.font = `500 11px 'DM Sans', sans-serif`;
                ctx.fillStyle = colorSecondary;
                ctx.fillText(cfg.label ?? '', cx, cy + 14);
                ctx.restore();
            }
        };
        Chart.register(this.centerTextPlugin);

        // Chart instance placeholder for the new histogram
        this.chartNpDays = null;
        // Tracking data from Supabase: { sku: days_unavailable }
        this.notPrimeDays = {};
        // Timestamp of last successful sync (for the "last sync" indicator)
        this.lastSyncAt = null;

        // Supabase client init (gracefully no-op if credentials are missing)
        this.supabase = this.initSupabase();

        try {
            const el = document.getElementById('loadingModal');
            this.loadingModal = el ? new bootstrap.Modal(el, { keyboard: false, backdrop: 'static' }) : null;
        } catch (e) { this.loadingModal = null; }

        this.init();
    }

    // ===============================================================
    // SUPABASE INIT
    // Si no hay credenciales en window.FBA_CONFIG, devuelve null y
    // la app sigue funcionando sin persistencia (graceful degradation).
    // ===============================================================
    initSupabase() {
        const cfg = window.FBA_CONFIG?.supabase;
        if (!cfg?.url || !cfg?.anonKey) {
            console.warn('[FBA] Supabase no configurado. La persistencia de days-unavailable estará deshabilitada.');
            return null;
        }
        if (!window.supabase?.createClient) {
            console.error('[FBA] Supabase SDK no cargado.');
            return null;
        }
        try {
            const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
                auth: { persistSession: false },
            });
            console.log('%c[FBA] Supabase conectado', 'color:#3fb950;font-weight:bold', cfg.url);
            return client;
        } catch (e) {
            console.error('[FBA] Error inicializando Supabase:', e);
            return null;
        }
    }

    async init() {
        this.initTheme();
        document.getElementById('theme-toggle')?.addEventListener('click', () => this.toggleTheme());

        const sw = document.getElementById('amazon-marketplace-switch');
        if (sw) sw.addEventListener('change', (e) => this.handleMarketplaceChange(e));
        this.updateMarketplaceUI();

        ['amazon', 'cin7', 'stylish'].forEach(type => {
            const zone = document.getElementById(`${type}-upload`);
            const input = document.getElementById(`${type}-file`);
            if (!zone || !input) return;
            zone.addEventListener('click', () => input.click());
            zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('active'); });
            zone.addEventListener('dragleave', () => zone.classList.remove('active'));
            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('active');
                if (e.dataTransfer?.files?.length) this.setFile(type, e.dataTransfer.files[0]);
            });
            input.addEventListener('change', (e) => { if (e.target.files?.length) this.setFile(type, e.target.files[0]); });
        });

        document.getElementById('process-btn')?.addEventListener('click', () => this.runAnalysis());

        // Dashboard — days selector
        document.querySelectorAll('.day-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.selectedDays = parseInt(btn.dataset.days);
                document.getElementById('th-target').textContent = `Target ${this.selectedDays}d`;
                this.recalculate();
            });
        });

        // KPI click filters
        document.querySelectorAll('.kpi-card.clickable').forEach(card => {
            card.addEventListener('click', () => this.toggleKpiFilter(card.dataset.filter));
        });

        // Standard filters
        document.getElementById('filter-fba')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('filter-sku')?.addEventListener('input', () => this.applyFilters());
        document.getElementById('filter-category')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('filter-send-method')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('filter-qty-to-send')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('clear-filters')?.addEventListener('click', () => this.clearFilters());
        document.getElementById('export-btn')?.addEventListener('click', () => this.exportCSV());

        // Not-in-Prime (compact) table listeners
        document.getElementById('np-filter-sku')?.addEventListener('input', () => this.renderNotPrime());
        document.getElementById('np-filter-mindays')?.addEventListener('input', () => this.renderNotPrime());
        document.getElementById('np-clear-filters')?.addEventListener('click', () => {
            const sku = document.getElementById('np-filter-sku');
            const md = document.getElementById('np-filter-mindays');
            if (sku) sku.value = '';
            if (md) md.value = '0';
            this.renderNotPrime();
        });
        document.getElementById('np-export-btn')?.addEventListener('click', () => this.exportNotPrime());

        // Debug toggle
        document.getElementById('toggle-debug')?.addEventListener('click', (e) => {
            e.preventDefault();
            const dbg = document.getElementById('debug-section');
            const link = document.getElementById('toggle-debug');
            const hidden = dbg.style.display === 'none' || dbg.style.display === '';
            dbg.style.display = hidden ? '' : 'none';
            link.innerHTML = hidden
                ? '<i class="fas fa-times me-1"></i>Hide processing details'
                : '<i class="fas fa-terminal me-1"></i>Show processing details';
            if (hidden) dbg.scrollIntoView({ behavior: 'smooth' });
        });

        // Download JSON (debug)
        document.getElementById('download-json')?.addEventListener('click', () => this.downloadRawJSON());

        // Cargar config bundleada
        await this.loadConfig();
    }

    // ===============================================================
    // CONFIG LOADING
    // ===============================================================
    async loadConfig() {
        this.showStatus('loading', 'Cargando datos de configuración...');
        try {
            const [info, fbaCA, fbaUSA, skuMapCA, skuMapUSA] = await Promise.all([
                this.fetchCSV('data/info.csv'),
                this.fetchCSV('data/fba-yes.csv', false),
                this.fetchCSV('data/fba-yes-usa.csv', false),
                this.fetchCSV('data/can-sku.csv'),
                this.fetchXLSX('data/usa-sku.xlsx', { asArrays: true }),
            ]);

            this.config.info = info;
            this.config.fbaCA = fbaCA;
            this.config.fbaUSA = fbaUSA;
            this.config.skuMapCA = skuMapCA;
            this.config.skuMapUSA = skuMapUSA;

            this.hideStatus();

            console.group('%c[FBA] Config cargada OK', 'color:#3fb950;font-weight:bold');
            console.log('info.csv:', info.length, 'filas');
            console.log('fba-yes.csv:', fbaCA.length, 'filas');
            console.log('fba-yes-usa.csv:', fbaUSA.length, 'filas');
            console.log('can-sku.csv:', skuMapCA.length, 'filas');
            console.log('usa-sku.xlsx:', skuMapUSA.length, 'filas');
            console.groupEnd();
        } catch (e) {
            console.error('Error cargando config:', e);
            this.showStatus('error', `Error cargando config: ${e.message}`);
        }
    }

    async fetchCSV(url, header = true) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${resp.status})`);
        const text = await resp.text();
        return new Promise((resolve, reject) => {
            Papa.parse(text, {
                header,
                skipEmptyLines: true,
                transformHeader: h => String(h || '').trim().toLowerCase(),
                complete: (r) => resolve(r.data),
                error: reject,
            });
        });
    }

    async fetchXLSX(url, { asArrays = false } = {}) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${resp.status})`);
        const buffer = await resp.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (asArrays) {
            return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        }
        const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        return rawRows.map(row => {
            const norm = {};
            for (const k in row) norm[String(k).trim().toLowerCase()] = row[k];
            return norm;
        });
    }

    // ===============================================================
    // FILE HANDLING
    // ===============================================================
    setFile(type, file) {
        this.files[type] = file;
        const zone = document.getElementById(`${type}-upload`);
        const status = document.getElementById(`${type}-status`);
        if (zone) {
            zone.classList.add('has-file');
            const h6 = zone.querySelector('h6');
            if (h6) h6.textContent = file.name;
        }
        if (status) status.innerHTML = '<i class="fas fa-check me-1"></i>Ready';
        this.checkProcessBtn();
    }

    checkProcessBtn() {
        const btn = document.getElementById('process-btn');
        if (btn) btn.disabled = !(this.files.amazon && this.files.cin7 && this.files.stylish);
    }

    async parseUploadedFile(file, opts = {}) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const buffer = await file.arrayBuffer();

        if (ext === 'csv') {
            const text = new TextDecoder('utf-8').decode(buffer);
            return new Promise((resolve, reject) => {
                Papa.parse(text, {
                    header: false,
                    skipEmptyLines: true,
                    complete: (r) => {
                        const raw = r.data;
                        if (raw.length === 0) return reject(new Error('CSV vacío'));
                        const headers = raw[0].map(h => String(h || '').trim().toLowerCase());
                        const rows = raw.slice(1).map(arr => {
                            const obj = {};
                            headers.forEach((h, i) => { obj[h || `col${i}`] = String(arr[i] ?? '').trim(); });
                            return obj;
                        }).filter(o => Object.values(o).some(v => v !== ''));
                        resolve({ headers, rows, raw });
                    },
                    error: reject,
                });
            });
        }

        const wb = XLSX.read(buffer, { type: 'array' });
        const sheetName = opts.sheetName || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) throw new Error(`Hoja "${sheetName}" no encontrada en ${file.name}`);

        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        if (raw.length === 0) throw new Error('XLSX vacío');

        let headerRow = opts.headerRow ?? 0;
        if (opts.detectStylish) {
            for (let i = 0; i < Math.min(5, raw.length); i++) {
                if (raw[i].some(v => String(v || '').trim().toUpperCase() === 'PART NUMBER')) {
                    headerRow = i;
                    break;
                }
            }
        }

        const headers = (raw[headerRow] || []).map(h => String(h || '').trim().toLowerCase());
        const rows = raw.slice(headerRow + 1).map(arr => {
            const obj = {};
            headers.forEach((h, i) => {
                let v = arr[i];
                if (typeof v === 'string' && v.startsWith('=')) v = '';
                obj[h || `col${i}`] = String(v ?? '').trim();
            });
            return obj;
        }).filter(o => Object.values(o).some(v => v !== ''));

        return { headers, rows, raw, sheetName };
    }

    // ===============================================================
    // RUN ANALYSIS — orquesta Partes 1 + 2 + 3
    // ===============================================================
    async runAnalysis() {
        if (!this.files.amazon || !this.files.cin7 || !this.files.stylish) return;
        if (!this.config.info) {
            alert('La config todavía no terminó de cargar. Espera un segundo y vuelve a intentar.');
            return;
        }

        this.loadingModal?.show();
        const dbg = [];
        const log = (line, cls) => dbg.push(cls ? `<span class="dbg-${cls}">${this.esc(line)}</span>` : this.esc(line));

        try {
            log('═══════════════════════════════════════════════════════════', 'info');
            log(` FBA ANALYZER v3.0 · Marketplace: ${this.isAmazonUSA ? 'USA' : 'CA'}`, 'info');
            log(`  ${new Date().toISOString()}`, 'info');
            log('═══════════════════════════════════════════════════════════', 'info');
            log('');

            // Parseo
            log('[Parseo]', 'label');
            log(`  Config: info=${this.config.info.length}, fbaCA=${this.config.fbaCA.length}, fbaUSA=${this.config.fbaUSA.length}, skuMapCA=${this.config.skuMapCA.length}, skuMapUSA=${this.config.skuMapUSA.length}`, 'ok');
            const amazon = await this.parseUploadedFile(this.files.amazon);
            this.parsed.amazon = amazon;
            log(`  Amazon: ${amazon.rows.length} filas · ${amazon.headers.length} columnas`, 'ok');
            const cin7 = await this.parseUploadedFile(this.files.cin7);
            this.parsed.cin7 = cin7;
            log(`  CIN7:   ${cin7.rows.length} filas · ${cin7.headers.length} columnas`, 'ok');
            const stylish = await this.parseUploadedFile(this.files.stylish, { detectStylish: true });
            this.parsed.stylish = stylish;
            log(`  Stylish: ${stylish.rows.length} filas · ${stylish.headers.length} columnas`, 'ok');
            log('');

            // Procesamiento
            log('[Procesamiento]', 'label');
            const result = this.process(log);
            this.processedData = result.data;
            this.processedMeta = result.meta;
            log(`  ✓ Output: ${result.data.length} filas`, 'ok');
            log('');

            // Dashboard
            log('[Dashboard]', 'label');
            this.allData = result.data.map(r => this.normalizeForDashboard(r));
            this.recalculate(false);
            this.filteredData = [...this.allData];
            this.extractCategories();

            // IMPORTANTE: mostrar las secciones ANTES de renderizar los charts.
            // Chart.js mide el canvas al momento de crear el chart; si el canvas está en
            // un contenedor display:none, lo mide con 0x0 y el chart queda vacío.
            document.getElementById('kpi-section').style.display = '';
            document.getElementById('table-section').style.display = '';
            document.getElementById('export-btn').disabled = false;

            // Un doble requestAnimationFrame garantiza que el browser ya hizo layout
            // de las secciones recién mostradas antes de renderizar los charts.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            this.render();
            this.renderNotPrime();
            this.updateDashboard();
            log(`  ✓ ${this.allData.length} SKUs renderizados`, 'ok');
            log('');

            // Sincronización con Supabase: reconcilia not-Prime tracking y guarda snapshot.
            // Non-blocking: la UI ya se mostró, esto corre en paralelo y actualiza cuando responde.
            if (this.supabase) {
                log('[Supabase] Sincronizando tracking y snapshot...', 'label');
                this.syncWithSupabase()
                    .then(result => {
                        if (result.ok) {
                            log(`  ✓ Tracking: ${result.tracked} SKUs reconciliados`, 'ok');
                            log(`  ✓ Snapshot guardado (id: ${result.snapshotId?.substring(0, 8) || '—'})`, 'ok');
                        } else {
                            log(`  ⚠ Sync falló: ${result.error}`, 'err');
                        }
                    })
                    .catch(err => {
                        console.error('[FBA] Sync error:', err);
                        log(`  ✗ Sync error: ${err.message}`, 'err');
                        this.setSyncStatus('err', `Sync failed: ${err.message}`);
                    });
            } else {
                this.setSyncStatus('off', 'Local mode · no history (set credentials in config.js)');
            }

            log('═══════════════════════════════════════════════════════════', 'info');
            log(' ✓ Análisis completo. Revisa el dashboard arriba.', 'ok');
            log('═══════════════════════════════════════════════════════════', 'info');

            // Scroll al dashboard
            document.getElementById('kpi-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

            console.log('%c[FBA] Análisis completo', 'color:#3fb950;font-weight:bold');
            console.log('Processed:', result);
            console.log('Dashboard data:', this.allData);
        } catch (err) {
            console.error(err);
            log('');
            log(`✗ ERROR: ${err.message}`, 'err');
            if (err.stack) log(err.stack, 'err');
            // Mostrar debug automáticamente si hubo error
            document.getElementById('debug-section').style.display = '';
            alert('Error durante el análisis: ' + err.message + '\n\nRevisa los detalles de procesamiento abajo.');
        } finally {
            document.getElementById('debug-output').innerHTML = dbg.join('\n');
            this.hideModal();
        }
    }

    // ===============================================================
    // PROCESS — lógica core (port de procesar.php)
    // ===============================================================
    process(log) {
        const marketplace = this.isAmazonUSA ? 'usa' : 'ca';

        // Step 1: master
        const master = {};
        const skuSet = new Set();
        const infoSkuKey = this.pickKey(this.config.info[0] || {}, ['product sku', 'sku']);
        const infoCatKey = this.pickKey(this.config.info[0] || {}, ['category']);
        const infoPackKey = this.pickKey(this.config.info[0] || {}, ['pack density', 'packdensity']);
        if (!infoSkuKey) throw new Error("info.csv: no se encontró columna SKU.");
        if (!infoCatKey) throw new Error("info.csv: no se encontró columna Category.");
        if (!infoPackKey) throw new Error("info.csv: no se encontró columna Pack Density.");

        for (const row of this.config.info) {
            const sku = FbaAnalyzer.normalizeSku(row[infoSkuKey]);
            if (!sku) continue;
            skuSet.add(sku);
            master[sku] = {
                category: String(row[infoCatKey] || '').trim(),
                pack_density: FbaAnalyzer.toInt(row[infoPackKey]),
            };
        }

        // Step 2: FBA
        const fbaRows = marketplace === 'usa' ? this.config.fbaUSA : this.config.fbaCA;
        const fbaMap = {};
        for (const row of fbaRows) {
            const vals = Array.isArray(row) ? row : Object.values(row);
            const sku = FbaAnalyzer.normalizeSku(vals[0]);
            const val = String(vals[1] || '').trim();
            if (sku) fbaMap[sku] = val || 'YES';
        }

        // Step 3: SKU mapping
        const skuMapping = {};
        if (marketplace === 'ca') {
            const sample = this.config.skuMapCA[0] || {};
            const mskuKey = this.pickKey(sample, ['sku', 'merchant sku', 'amazon sku']);
            const partKey = this.pickKey(sample, ['part #', 'part', 'part number', 'partnumber']);
            if (mskuKey && partKey) {
                for (const row of this.config.skuMapCA) {
                    const msku = FbaAnalyzer.normalizeSku(row[mskuKey]);
                    const part = FbaAnalyzer.normalizeSku(row[partKey]);
                    if (msku && part) skuMapping[msku] = part;
                }
            }
        } else {
            for (let i = 1; i < this.config.skuMapUSA.length; i++) {
                const row = this.config.skuMapUSA[i] || [];
                const rawPart = String(row[2] ?? '');
                if (rawPart.startsWith('=')) continue;
                const msku = FbaAnalyzer.normalizeSku(row[1]);
                const part = FbaAnalyzer.normalizeSku(rawPart);
                if (msku && part) skuMapping[msku] = part;
            }
        }

        // Step 4: Amazon
        const amzHeaders = this.parsed.amazon.headers;
        const colMerchantSKU = FbaAnalyzer.detectCol(amzHeaders, ['Merchant SKU', 'merchant sku', 'Seller SKU']);
        const colSupplier    = FbaAnalyzer.detectCol(amzHeaders, ['Supplier', 'Supplier SKU', 'Supplier Code', 'Vendor SKU', 'Supplier part no.', 'Supplier part no']);
        let colSold30 = FbaAnalyzer.detectColStrict(amzHeaders, ['Units Sold Last 30 Days', 'Units sold last 30 days']);
        if (!colSold30) colSold30 = FbaAnalyzer.detectCol(amzHeaders, ['Units Sold (30 days)', 'Units ordered (last 30 days)', 'Units ordered - last 30 days', 'units_sold_30d']);
        let colTotalUnit = FbaAnalyzer.detectColStrict(amzHeaders, ['Total Units', 'total units']);
        if (!colTotalUnit) colTotalUnit = FbaAnalyzer.detectCol(amzHeaders, ['Inventory at Amazon', 'FBA sellable']);
        let colAvailable = FbaAnalyzer.detectColStrict(amzHeaders, ['Available', 'available']);
        if (!colAvailable) colAvailable = FbaAnalyzer.detectCol(amzHeaders, ['afn-fulfillable-quantity', 'Inv - Available', 'Available Units', 'Fulfillable Quantity', 'afn fulfillable quantity']);
        if (!colSold30 && amzHeaders[11]) colSold30 = amzHeaders[11];
        if (!colTotalUnit && amzHeaders[12]) colTotalUnit = amzHeaders[12];
        if (!colMerchantSKU && !colSupplier) throw new Error("Amazon: no se encontró 'Merchant SKU' ni 'Supplier'.");
        if (!colSold30) throw new Error("Amazon: no se encontró columna Units Sold 30d.");
        if (!colTotalUnit) throw new Error("Amazon: no se encontró columna Total Units.");

        const amzUnitsSold = {}, amzInventory = {}, amzAvailable = {};
        const skusInAmazonFile = new Set();
        const unmappedSkus = new Set();

        for (const r of this.parsed.amazon.rows) {
            let partNumber = '';
            if (colMerchantSKU) {
                const msku = FbaAnalyzer.normalizeSku(r[colMerchantSKU]);
                if (msku && skuMapping[msku]) partNumber = skuMapping[msku];
            }
            if (!partNumber && colSupplier) {
                const sup = FbaAnalyzer.normalizeSku(r[colSupplier]);
                if (sup && sup !== 'UNASSIGNED') partNumber = sup;
            }
            if (!partNumber || !skuSet.has(partNumber)) {
                if (partNumber) unmappedSkus.add(partNumber);
                continue;
            }
            skusInAmazonFile.add(partNumber);
            amzUnitsSold[partNumber] = (amzUnitsSold[partNumber] || 0) + FbaAnalyzer.toInt(r[colSold30]);
            amzInventory[partNumber] = (amzInventory[partNumber] || 0) + FbaAnalyzer.toInt(r[colTotalUnit]);
            amzAvailable[partNumber] = (amzAvailable[partNumber] || 0) + FbaAnalyzer.toInt(r[colAvailable || colTotalUnit]);
        }

        // Step 5: CIN7
        const cin7Headers = this.parsed.cin7.headers;
        const colSkuCin7 = FbaAnalyzer.detectCol(cin7Headers, ['SKU', 'Product Code', 'Item Code', 'sku', 'code', 'pn']);
        const colOnHand  = FbaAnalyzer.detectCol(cin7Headers, ['OnHand', 'on hand', 'onhand']);
        const colLoc     = FbaAnalyzer.detectCol(cin7Headers, ['Location', 'Warehouse', 'Site', 'location']);
        if (!colSkuCin7) throw new Error("CIN7: no se encontró columna SKU.");
        if (!colOnHand) throw new Error("CIN7: no se encontró columna OnHand.");
        if (!colLoc) throw new Error("CIN7: no se encontró columna Location.");

        const locationFilter = marketplace === 'usa' ? 'charlotte' : 'cambridge';
        const cin7WH = {};
        for (const r of this.parsed.cin7.rows) {
            const sku = FbaAnalyzer.normalizeSku(r[colSkuCin7]);
            if (!sku || !skuSet.has(sku)) continue;
            const loc = FbaAnalyzer.normalize(r[colLoc]);
            if (!loc || !loc.includes(locationFilter)) continue;
            cin7WH[sku] = (cin7WH[sku] || 0) + FbaAnalyzer.toInt(r[colOnHand]);
        }

        // Step 6: Stylish
        const qtyCol = marketplace === 'usa' ? 'quantity in stock united states' : 'quantity in stock canada';
        const etaCol = marketplace === 'usa' ? 'eta usa' : 'eta can';
        const etaFallback = 'eta';
        const stylishQty = {}, stylishETA = {};
        for (const r of this.parsed.stylish.rows) {
            let sku = '';
            for (const cand of ['part number', 'sku', 'product sku']) {
                if (r[cand] != null && String(r[cand]).trim() !== '') {
                    sku = FbaAnalyzer.normalizeSku(r[cand]);
                    break;
                }
            }
            if (!sku || !skuSet.has(sku)) continue;
            const qty = r[qtyCol] != null ? FbaAnalyzer.toInt(r[qtyCol]) : 0;
            stylishQty[sku] = (stylishQty[sku] || 0) + qty;
            let eta = '';
            if (r[etaCol] != null) eta = FbaAnalyzer.cleanEta(r[etaCol]);
            else if (r[etaFallback] != null) eta = FbaAnalyzer.cleanEta(r[etaFallback]);
            if (eta) stylishETA[sku] = eta;
        }

        // Step 7: output
        const out = [];
        let excludedNotInAmazon = 0, excludedNoActivity = 0, fbaNotInAmazon = 0;
        for (const sku of skuSet) {
            const isFbaYes = fbaMap[sku] && String(fbaMap[sku]).trim().toUpperCase() === 'YES';
            const inAmazon = skusInAmazonFile.has(sku);
            const invAmazon = amzInventory[sku] || 0;
            const unitsSold = amzUnitsSold[sku] || 0;
            if (!inAmazon) { excludedNotInAmazon++; continue; }
            if (!isFbaYes && invAmazon === 0 && unitsSold === 0) { excludedNoActivity++; continue; }
            out.push({
                sku,
                fba: fbaMap[sku] || 'Pending',
                category: master[sku]?.category || '',
                units_sold: unitsSold,
                inventory_amazon: invAmazon,
                inventory_amazon_available: amzAvailable[sku] || 0,
                pack_density: master[sku]?.pack_density || 0,
                inventory_warehouse: cin7WH[sku] || 0,
                inventory_stylish: stylishQty[sku] || 0,
                eta: stylishETA[sku] || '',
            });
        }
        for (const fsku of Object.keys(fbaMap)) {
            if (!skusInAmazonFile.has(fsku)) fbaNotInAmazon++;
        }
        out.sort((a, b) => a.sku.localeCompare(b.sku));

        return {
            data: out,
            meta: {
                marketplace,
                amazon_merchant_col: colMerchantSKU,
                amazon_supplier_col: colSupplier,
                amazon_sold30_col: colSold30,
                amazon_inventory_col: colTotalUnit,
                amazon_available_col: colAvailable,
                sku_mapping_entries: Object.keys(skuMapping).length,
                amazon_rows_total: this.parsed.amazon.rows.length,
                skus_matched: skusInAmazonFile.size,
                total_master_skus: skuSet.size,
                total_fba_yes: Object.keys(fbaMap).length,
                fba_yes_in_amazon: Object.keys(fbaMap).length - fbaNotInAmazon,
                fba_yes_not_in_amazon: fbaNotInAmazon,
                unmapped_skus_count: unmappedSkus.size,
                excluded_not_in_amazon: excludedNotInAmazon,
                excluded_no_activity: excludedNoActivity,
                total_output: out.length,
                generated_at: new Date().toISOString(),
            },
        };
    }

    // ===============================================================
    // DASHBOARD — Parte 3
    // ===============================================================
    normalizeForDashboard(item) {
        return {
            sku: item.sku ?? '',
            fba: item.fba ?? 'Pending',
            category: item.category ?? '',
            units_sold: Number(item.units_sold ?? 0),
            inventory_amazon: Number(item.inventory_amazon ?? 0),
            inventory_amazon_available: Number(item.inventory_amazon_available ?? 0),
            pack_density: Number(item.pack_density ?? 0),
            inventory_warehouse: Number(item.inventory_warehouse ?? 0),
            inventory_stylish: Number(item.inventory_stylish ?? 0),
            eta: item.eta ?? '',
            target: 0, qty_to_send: 0, qty_pallets: 0,
            how_to_send: 'Loose', coverage_days: 0,
        };
    }

    recalculate(reRender = true) {
        const days = this.selectedDays;
        this.allData.forEach(item => {
            const dailySales = item.units_sold / 30;
            item.target = Math.max(0, Math.round(item.units_sold * (days / 30)));
            item.qty_to_send = Math.max(0, item.target - item.inventory_amazon);
            item.coverage_days = dailySales > 0 ? Math.round(item.inventory_amazon / dailySales) : 999;

            if (item.pack_density > 0 && item.qty_to_send > 0) {
                const raw = item.qty_to_send / item.pack_density;
                item.qty_pallets = raw - Math.floor(raw) >= 0.70 ? Math.ceil(raw) : Math.floor(raw);
            } else {
                item.qty_pallets = 0;
            }

            const cat = (item.category || '').toLowerCase();
            const isSink = ['sink', 'assy sink', 'azuni sink', 'porcelain sink'].some(s => cat.includes(s));
            if (item.qty_pallets === 0) item.how_to_send = 'Loose';
            else if (item.qty_pallets >= 1 && isSink) item.how_to_send = 'Pallet';
            else if (item.qty_pallets >= 1) item.how_to_send = 'Carton';
            else item.how_to_send = 'Loose';
        });
        if (reRender) this.applyFilters();
    }

    classify(item) {
        if (item.inventory_amazon === 0) return 'oos';
        if (item.coverage_days < 30) return 'low';
        if (item.coverage_days > 120) return 'overstock';
        return 'healthy';
    }

    extractCategories() {
        this.categories.clear();
        this.allData.forEach(i => { if (i.category) this.categories.add(i.category); });
        const sel = document.getElementById('filter-category');
        if (!sel) return;
        sel.innerHTML = '<option value="">All categories</option>';
        [...this.categories].sort().forEach(c => {
            sel.innerHTML += `<option value="${this.esc(c)}">${this.esc(c)}</option>`;
        });
    }

    toggleKpiFilter(type) {
        this.activeKpiFilter = this.activeKpiFilter === type ? null : type;
        document.querySelectorAll('.kpi-card.clickable').forEach(c => {
            c.classList.toggle('active-filter', c.dataset.filter === this.activeKpiFilter);
        });
        this.applyFilters();
    }

    applyFilters() {
        const fba = (document.getElementById('filter-fba')?.value || '').toLowerCase();
        const sku = (document.getElementById('filter-sku')?.value || '').toLowerCase();
        const cat = document.getElementById('filter-category')?.value || '';
        const method = document.getElementById('filter-send-method')?.value || '';
        const onlyQty = document.getElementById('filter-qty-to-send')?.checked || false;
        const kpi = this.activeKpiFilter;

        this.filteredData = this.allData.filter(item => {
            if (fba && item.fba.toLowerCase() !== fba) return false;
            if (sku && !item.sku.toLowerCase().includes(sku)) return false;
            if (cat && item.category !== cat) return false;
            if (method && item.how_to_send !== method) return false;
            if (onlyQty && item.qty_to_send <= 0) return false;

            if (kpi === 'oos') return item.inventory_amazon === 0;
            if (kpi === 'low') return item.inventory_amazon > 0 && item.coverage_days < 30;
            if (kpi === 'healthy') return item.coverage_days >= 30 && item.coverage_days <= 120;
            if (kpi === 'tosend') return item.qty_to_send > 0;
            if (kpi === 'inbound') return item.eta !== '';
            if (kpi === 'nowarehouse') return item.inventory_stylish === 0;
            if (kpi === 'overstock') return item.coverage_days > 120;
            if (kpi === 'infba') return item.inventory_amazon > 0;
            if (kpi === 'inprime') return item.inventory_amazon_available > 0;
            return true;
        });

        this.render();
        this.updateDashboard();
        this.updateFilterCount();
    }

    clearFilters() {
        document.getElementById('filter-fba').value = '';
        document.getElementById('filter-sku').value = '';
        document.getElementById('filter-category').value = '';
        document.getElementById('filter-send-method').value = '';
        document.getElementById('filter-qty-to-send').checked = false;
        this.activeKpiFilter = null;
        document.querySelectorAll('.kpi-card.clickable').forEach(c => c.classList.remove('active-filter'));
        this.filteredData = [...this.allData];
        this.render();
        this.updateDashboard();
        this.updateFilterCount();
    }

    updateFilterCount() {
        const el = document.getElementById('filter-count');
        if (!el) return;
        const f = this.filteredData.length, t = this.allData.length;
        el.textContent = f === t ? `${t} items` : `${f} / ${t} items`;
    }

    updateDashboard() {
        const data = this.allData;
        let oos = 0, low = 0, healthy = 0, overstock = 0;
        let totalSend = 0, inbound = 0, noWarehouse = 0, inFba = 0, inPrime = 0;

        data.forEach(item => {
            const cls = this.classify(item);
            if (cls === 'oos') oos++;
            else if (cls === 'low') low++;
            else if (cls === 'overstock') overstock++;
            else healthy++;
            totalSend += item.qty_to_send;
            if (item.eta !== '') inbound++;
            if (item.inventory_stylish === 0) noWarehouse++;
            if (item.inventory_amazon > 0) inFba++;
            if (item.inventory_amazon_available > 0) inPrime++;
        });

        this.setText('kpi-total-skus', data.length);
        this.setText('kpi-oos', oos);
        this.setText('kpi-low', low);
        this.setText('kpi-healthy', healthy);
        this.setText('kpi-tosend', this.fmtNum(totalSend));
        this.setText('kpi-inbound', inbound);
        this.setText('kpi-nowarehouse', noWarehouse);
        this.setText('kpi-overstock', overstock);
        this.setText('kpi-infba', inFba);
        this.setText('kpi-inprime', inPrime);

        // Coalescar llamadas rápidas (el usuario tipeando en el filtro) en un solo render.
        if (this._chartRaf) cancelAnimationFrame(this._chartRaf);
        this._chartRaf = requestAnimationFrame(() => {
            this._chartRaf = null;
            try {
                this.renderHealthChart(oos, low, healthy, overstock);
                this.renderTopSellersChart(this.filteredData);
                this.renderCategoriesChart(this.filteredData);
                this.renderCoverageDistChart(this.filteredData);
            } catch (e) {
                console.error('[FBA] Error renderizando charts:', e);
            }
        });
    }

    // Forzar recrear charts (ej. al cambiar tema claro/oscuro).
    destroyAllCharts() {
        // Chart.js puede tirar "this._fn is not a function" si se destruye
        // un chart mientras tiene animaciones pendientes. stop() cancela
        // la cola de animaciones antes de destroy.
        ['chartHealth', 'chartTopSellers', 'chartCategories', 'chartCoverageDist', 'chartNpDays'].forEach(name => {
            if (this[name]) {
                try {
                    this[name].stop();
                    this[name].destroy();
                } catch (e) { /* ignore */ }
                this[name] = null;
            }
        });
    }

    // ---- Chart helpers ----
    makeGradient(ctx, hexColor, a1 = 0.6, a2 = 0.08) {
        const area = ctx.chart?.chartArea;
        const canvasCtx = ctx.chart?.ctx;
        if (!area || !canvasCtx) return hexColor;
        const grad = canvasCtx.createLinearGradient(0, area.top, 0, area.bottom);
        grad.addColorStop(0, this.hexAlpha(hexColor, a1));
        grad.addColorStop(1, this.hexAlpha(hexColor, a2));
        return grad;
    }
    hexAlpha(hex, a) {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${a})`;
    }

    renderHealthChart(oos, low, healthy, overstock) {
        const newData = [oos, low, healthy, overstock];
        const total = oos + low + healthy + overstock;

        if (this.chartHealth) {
            this.chartHealth.data.datasets[0].data = newData;
            // Actualizar el texto central con el total activo
            if (this.chartHealth.options.plugins.centerText) {
                this.chartHealth.options.plugins.centerText.value = total;
            }
            this.chartHealth.update('none');
            return;
        }

        const ctx = document.getElementById('chart-health');
        if (!ctx) return;
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
        // Filtros KPI asociados a cada segmento (click → activa ese filtro)
        const kpiMap = ['oos', 'low', 'healthy', 'overstock'];

        this.chartHealth = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Out of stock', 'Critical (<30d)', 'Healthy', 'Overstocked (>120d)'],
                datasets: [{
                    data: newData,
                    backgroundColor: isDark ? ['#f85149','#d29922','#3fb950','#e3b341'] : ['#cf222e','#9a6700','#1a7f37','#bf8700'],
                    hoverBackgroundColor: isDark ? ['#ff6b64','#e0a832','#52c962','#f2c34b'] : ['#e03742','#ad7500','#2a8f47','#cc9100'],
                    borderWidth: 0, spacing: 3, borderRadius: 6, hoverOffset: 12,
                    borderColor: isDark ? '#0d1117' : '#ffffff',
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '72%',
                onHover: (evt, elements) => {
                    evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const idx = elements[0].index;
                    this.toggleKpiFilter(kpiMap[idx]);
                },
                plugins: {
                    centerText: { display: true, value: total, label: 'Total SKUs' },
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 16, usePointStyle: true, pointStyleWidth: 10, font: { size: 11 },
                            generateLabels: (chart) => {
                                const data = chart.data.datasets[0].data;
                                const tot = data.reduce((a, b) => a + b, 0);
                                return chart.data.labels.map((label, i) => {
                                    const pct = tot ? ((data[i] / tot) * 100).toFixed(0) : 0;
                                    return {
                                        text: `${label}: ${data[i]} (${pct}%)`,
                                        fillStyle: chart.data.datasets[0].backgroundColor[i],
                                        strokeStyle: chart.data.datasets[0].backgroundColor[i],
                                        pointStyle: 'circle',
                                        hidden: chart.getDatasetMeta(0).data[i]?.hidden,
                                        index: i,
                                    };
                                });
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (c) => {
                                const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = tot ? ((c.parsed / tot) * 100).toFixed(1) : 0;
                                return ` ${c.label}: ${c.parsed} SKUs (${pct}%)`;
                            },
                            afterLabel: () => '  ↳ click to filter table'
                        }
                    },
                    datalabels: {
                        display: (context) => {
                            // Solo muestra el % si el segmento es >= 5% (para que no se encimen)
                            const tot = context.dataset.data.reduce((a, b) => a + b, 0);
                            return tot > 0 && (context.dataset.data[context.dataIndex] / tot) >= 0.05;
                        },
                        color: '#fff',
                        font: { weight: '700', size: 12, family: "'DM Sans', sans-serif" },
                        formatter: (value, context) => {
                            const tot = context.dataset.data.reduce((a, b) => a + b, 0);
                            return tot ? `${((value / tot) * 100).toFixed(0)}%` : '';
                        },
                        textStrokeColor: 'rgba(0,0,0,0.4)',
                        textStrokeWidth: 2,
                    }
                }
            }
        });
    }

    renderTopSellersChart(data) {
        const top = [...data].sort((a, b) => b.units_sold - a.units_sold).slice(0, 10);
        const labels = top.map(i => i.sku);
        const values = top.map(i => i.units_sold);
        // Guardamos el item completo por bar para tooltip rico + click handler
        const items = top.slice();

        if (this.chartTopSellers) {
            this.chartTopSellers.data.labels = labels;
            this.chartTopSellers.data.datasets[0].data = values;
            this.chartTopSellers.data.datasets[0].items = items;
            this.chartTopSellers.update('none');
            return;
        }

        const ctx = document.getElementById('chart-top-sellers');
        if (!ctx) return;
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
        const gridC = isDark ? 'rgba(48,54,61,0.3)' : 'rgba(0,0,0,0.06)';

        // Color por estado de salud (clasifica el SKU → mapea a color)
        const healthColorFor = (item) => {
            const cls = this.classify(item);
            const palette = isDark
                ? { oos: '#f85149', low: '#d29922', healthy: '#3fb950', overstock: '#e3b341' }
                : { oos: '#cf222e', low: '#9a6700', healthy: '#1a7f37', overstock: '#bf8700' };
            return palette[cls] || palette.healthy;
        };

        this.chartTopSellers = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    items,
                    backgroundColor: (c) => {
                        const it = c.dataset.items?.[c.dataIndex];
                        if (!it) return isDark ? '#58a6ff' : '#0969da';
                        return this.makeGradient(c, healthColorFor(it), 0.95, 0.3);
                    },
                    hoverBackgroundColor: (c) => {
                        const it = c.dataset.items?.[c.dataIndex];
                        return it ? healthColorFor(it) : (isDark ? '#58a6ff' : '#0969da');
                    },
                    borderRadius: 6, barThickness: 18,
                }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                layout: { padding: { right: 50 } }, // espacio para data labels al final
                onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const idx = elements[0].index;
                    const sku = this.chartTopSellers.data.labels[idx];
                    const input = document.getElementById('filter-sku');
                    if (input) {
                        input.value = sku;
                        this.applyFilters();
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        padding: 14,
                        callbacks: {
                            title: (ctx) => {
                                const it = ctx[0].dataset.items?.[ctx[0].dataIndex];
                                return it ? `${it.sku} · ${it.category || 'Sin categoría'}` : ctx[0].label;
                            },
                            label: (c) => {
                                const it = c.dataset.items?.[c.dataIndex];
                                if (!it) return ` ${c.parsed.x} units sold`;
                                const cls = this.classify(it);
                                const statusLabel = { oos: '🔴 Out of stock', low: '🟡 Critical (<30d)', healthy: '🟢 Healthy', overstock: '🟠 Overstocked' }[cls];
                                const cov = it.coverage_days >= 999 ? '∞' : `${it.coverage_days}d`;
                                return [
                                    ` ${it.units_sold.toLocaleString()} units sold (30d)`,
                                    ` Amazon inv: ${it.inventory_amazon.toLocaleString()}`,
                                    ` Coverage: ${cov}`,
                                    ` Status: ${statusLabel}`,
                                    it.qty_to_send > 0 ? ` → Need to send: ${it.qty_to_send.toLocaleString()} units` : null,
                                ].filter(Boolean);
                            },
                            afterBody: () => ['', '  ↳ click to filter by this SKU']
                        }
                    },
                    datalabels: {
                        display: true,
                        anchor: 'end', align: 'end',
                        color: isDark ? '#c9d1d9' : '#1f2328',
                        font: { weight: '600', size: 11, family: "'JetBrains Mono', monospace" },
                        formatter: (v) => v.toLocaleString('en-US'),
                        padding: { left: 6 },
                    }
                },
                scales: {
                    x: { beginAtZero: true, grid: { color: gridC, drawBorder: false } },
                    y: { grid: { display: false, drawBorder: false }, ticks: { font: { family: "'JetBrains Mono'", size: 10 } } }
                }
            }
        });
    }

    renderCategoriesChart(data) {
        // Agrupamos por categoría Y además clasificamos cada SKU por estado de salud
        // para tener composición (no solo conteo) en stacked bars
        const catMap = {};
        data.forEach(i => {
            const cat = i.category || 'Other';
            if (!catMap[cat]) catMap[cat] = { oos: 0, low: 0, healthy: 0, overstock: 0, total: 0 };
            const cls = this.classify(i);
            catMap[cat][cls]++;
            catMap[cat].total++;
        });
        const sorted = Object.entries(catMap).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
        const labels = sorted.map(s => s[0]);
        const oosData = sorted.map(s => s[1].oos);
        const lowData = sorted.map(s => s[1].low);
        const healthyData = sorted.map(s => s[1].healthy);
        const overData = sorted.map(s => s[1].overstock);
        const totals = sorted.map(s => s[1].total);

        if (this.chartCategories) {
            this.chartCategories.data.labels = labels;
            this.chartCategories.data.datasets[0].data = oosData;
            this.chartCategories.data.datasets[1].data = lowData;
            this.chartCategories.data.datasets[2].data = healthyData;
            this.chartCategories.data.datasets[3].data = overData;
            this.chartCategories._totals = totals;
            this.chartCategories.update('none');
            return;
        }

        const ctx = document.getElementById('chart-categories');
        if (!ctx) return;
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
        const gridC = isDark ? 'rgba(48,54,61,0.3)' : 'rgba(0,0,0,0.06)';
        const palette = isDark
            ? { oos: '#f85149', low: '#d29922', healthy: '#3fb950', overstock: '#e3b341' }
            : { oos: '#cf222e', low: '#9a6700', healthy: '#1a7f37', overstock: '#bf8700' };

        const mkDataset = (label, arr, color, kpiKey) => ({
            label, data: arr, kpiKey,
            backgroundColor: color,
            hoverBackgroundColor: this.hexAlpha(color, 1),
            borderRadius: 4, borderWidth: 0, barThickness: 28,
            stack: 'health',
        });

        this.chartCategories = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    mkDataset('Out of stock',  oosData,     palette.oos,       'oos'),
                    mkDataset('Critical',      lowData,     palette.low,       'low'),
                    mkDataset('Healthy',       healthyData, palette.healthy,   'healthy'),
                    mkDataset('Overstocked',   overData,    palette.overstock, 'overstock'),
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const el = elements[0];
                    const category = this.chartCategories.data.labels[el.index];
                    const sel = document.getElementById('filter-category');
                    if (sel) {
                        sel.value = category;
                        this.applyFilters();
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 12, boxWidth: 10, boxHeight: 10, font: { size: 11 }, usePointStyle: true, pointStyleWidth: 10 }
                    },
                    tooltip: {
                        padding: 14,
                        callbacks: {
                            title: (ctx) => {
                                const idx = ctx[0].dataIndex;
                                const tot = this.chartCategories?._totals?.[idx] ?? totals[idx];
                                return `${ctx[0].label} · ${tot} SKUs`;
                            },
                            label: (c) => {
                                const v = c.parsed.y;
                                const tot = this.chartCategories?._totals?.[c.dataIndex] ?? totals[c.dataIndex];
                                const pct = tot ? ((v / tot) * 100).toFixed(0) : 0;
                                return ` ${c.dataset.label}: ${v} (${pct}%)`;
                            },
                            afterBody: () => ['', '  ↳ click to filter by category']
                        }
                    },
                    datalabels: {
                        display: (ctx) => {
                            // Solo mostrar el total en el TOP de la pila (sobre el último dataset)
                            // con valor > 0 para cada categoría
                            if (ctx.datasetIndex !== 3) return false;
                            const idx = ctx.dataIndex;
                            const tot = this.chartCategories?._totals?.[idx] ?? totals[idx];
                            return tot > 0;
                        },
                        anchor: 'end', align: 'end', offset: 2,
                        color: isDark ? '#c9d1d9' : '#1f2328',
                        font: { weight: '700', size: 11, family: "'DM Sans', sans-serif" },
                        formatter: (value, ctx) => {
                            const idx = ctx.dataIndex;
                            return this.chartCategories?._totals?.[idx] ?? totals[idx];
                        },
                    }
                },
                scales: {
                    x: { stacked: true, grid: { display: false, drawBorder: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
                    y: { stacked: true, beginAtZero: true, grid: { color: gridC, drawBorder: false } }
                }
            }
        });
        this.chartCategories._totals = totals;
    }

    renderCoverageDistChart(data) {
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
        // Cada bucket tiene un filtro KPI asociado (click → activa ese filtro)
        const buckets = [
            { label: '0d (OOS)',     min: 0,   max: 0,   color: isDark ? '#f85149' : '#cf222e', kpi: 'oos' },
            { label: '1–15d',        min: 1,   max: 15,  color: isDark ? '#f85149' : '#cf222e', kpi: 'low' },
            { label: '16–30d',       min: 16,  max: 30,  color: isDark ? '#d29922' : '#9a6700', kpi: 'low' },
            { label: '31–60d',       min: 31,  max: 60,  color: isDark ? '#3fb950' : '#1a7f37', kpi: 'healthy' },
            { label: '61–90d',       min: 61,  max: 90,  color: isDark ? '#3fb950' : '#1a7f37', kpi: 'healthy' },
            { label: '91–120d',      min: 91,  max: 120, color: isDark ? '#3fb950' : '#1a7f37', kpi: 'healthy' },
            { label: '120+ (over)',  min: 121, max: 998, color: isDark ? '#e3b341' : '#bf8700', kpi: 'overstock' },
        ];
        const counts = buckets.map(b => data.filter(i => {
            const c = i.coverage_days;
            if (c >= 999) return false;
            return c >= b.min && c <= b.max;
        }).length);
        // Acumulados: # SKUs con cobertura ≤ tope de cada bucket
        const cumulative = [];
        let running = 0;
        counts.forEach(n => { running += n; cumulative.push(running); });

        if (this.chartCoverageDist) {
            this.chartCoverageDist.data.datasets[0].data = counts;
            this.chartCoverageDist._cumulative = cumulative;
            this.chartCoverageDist._buckets = buckets;
            this.chartCoverageDist.update('none');
            return;
        }

        const ctx = document.getElementById('chart-coverage-dist');
        if (!ctx) return;
        const gridC = isDark ? 'rgba(48,54,61,0.3)' : 'rgba(0,0,0,0.06)';

        this.chartCoverageDist = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: buckets.map(b => b.label),
                datasets: [{
                    data: counts,
                    backgroundColor: (c) => this.makeGradient(c, buckets[c.dataIndex]?.color || '#888', 0.85, 0.2),
                    borderRadius: 8, barPercentage: 0.85,
                    hoverBackgroundColor: (c) => buckets[c.dataIndex]?.color || '#888',
                    borderWidth: 0,
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { top: 20 } },
                onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const idx = elements[0].index;
                    const bucket = this.chartCoverageDist._buckets?.[idx] || buckets[idx];
                    if (bucket?.kpi) this.toggleKpiFilter(bucket.kpi);
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        padding: 14,
                        callbacks: {
                            title: (ctx) => `${ctx[0].label}`,
                            label: (c) => {
                                const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = tot ? ((c.parsed.y / tot) * 100).toFixed(1) : 0;
                                const cum = (this.chartCoverageDist?._cumulative ?? cumulative)[c.dataIndex];
                                const cumPct = tot ? ((cum / tot) * 100).toFixed(0) : 0;
                                return [
                                    ` ${c.parsed.y} SKUs en este rango (${pct}%)`,
                                    ` ${cum} SKUs acumulados (${cumPct}%)`,
                                ];
                            },
                            afterBody: () => ['', '  ↳ click to filter by status']
                        }
                    },
                    datalabels: {
                        display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0,
                        anchor: 'end', align: 'end', offset: 2,
                        color: isDark ? '#c9d1d9' : '#1f2328',
                        font: { weight: '700', size: 12, family: "'DM Sans', sans-serif" },
                        formatter: (v) => v,
                    }
                },
                scales: {
                    x: { grid: { display: false, drawBorder: false }, ticks: { font: { size: 11 } } },
                    y: { beginAtZero: true, grid: { color: gridC, drawBorder: false } }
                }
            }
        });
        this.chartCoverageDist._cumulative = cumulative;
        this.chartCoverageDist._buckets = buckets;
    }

    // ---- TABLE ----
    render() {
        const tbody = document.getElementById('results-body');
        if (!tbody) return;

        if (!this.filteredData.length) {
            tbody.innerHTML = '<tr><td colspan="14" class="empty-state"><i class="fas fa-filter-circle-xmark"></i><span>No results match filters</span></td></tr>';
            return;
        }

        let html = '';
        this.filteredData.forEach(item => {
            const cls = this.classify(item);
            const rowClass = cls === 'oos' ? 'row-oos' : cls === 'low' ? 'row-low' : '';
            const fbaClass = item.fba.toLowerCase() === 'yes' ? 'badge-fba-yes' : 'badge-fba-no';
            const methodClass = item.how_to_send === 'Pallet' ? 'badge-pallet' : item.how_to_send === 'Carton' ? 'badge-carton' : item.how_to_send === 'Loose' ? 'badge-loose' : 'badge-method';

            const covPct = Math.min(100, Math.max(0, (item.coverage_days / 90) * 100));
            const covColor = item.coverage_days === 0 ? '#f85149' : item.coverage_days < 30 ? '#d29922' : item.coverage_days > 120 ? '#e3b341' : '#3fb950';
            const covLabel = item.coverage_days >= 999 ? '∞' : item.coverage_days + 'd';

            html += `<tr class="${rowClass}">
                <td class="sku-cell">${this.esc(item.sku)}</td>
                <td><span class="badge-sm ${fbaClass}">${this.esc(item.fba)}</span></td>
                <td>${this.esc(item.category)}</td>
                <td class="text-end value-mono">${this.fmtNum(item.units_sold)}</td>
                <td class="text-end value-mono">${this.fmtNum(item.target)}</td>
                <td class="text-end value-mono ${item.inventory_amazon === 0 ? 'value-danger' : ''}">${this.fmtNum(item.inventory_amazon)}</td>
                <td class="text-end"><span class="coverage-bar"><span class="bar"><span class="bar-fill" style="width:${covPct}%;background:${covColor}"></span></span><span class="value-mono" style="color:${covColor}">${covLabel}</span></span></td>
                <td class="text-end value-mono ${item.pack_density === 0 ? 'value-muted' : ''}">${item.pack_density || '—'}</td>
                <td class="text-end value-mono">${this.fmtNum(item.inventory_warehouse)}</td>
                <td class="text-end value-mono ${item.inventory_stylish === 0 ? 'value-muted' : ''}">${this.fmtNum(item.inventory_stylish)}</td>
                <td class="text-end value-mono ${item.qty_to_send > 0 ? 'value-danger' : 'value-muted'}">${this.fmtNum(item.qty_to_send)}</td>
                <td><span class="badge-sm ${methodClass}">${item.how_to_send}</span></td>
                <td class="text-end value-mono">${item.qty_pallets || '—'}</td>
                <td>${item.eta ? '<span class="badge-sm badge-inbound"><i class="fas fa-plane-arrival me-1"></i>' + this.esc(item.eta) + '</span>' : '<span class="value-muted">—</span>'}</td>
            </tr>`;
        });
        tbody.innerHTML = html;
    }

    // ---- EXPORT ----
    exportCSV() {
        if (!this.filteredData.length) return;
        const wh = this.isAmazonUSA ? 'Inventory Charlotte' : 'Inventory Cambridge';
        const headers = ['SKU','FBA','Category','Units Sold 30d',`Target ${this.selectedDays}d`,'Inventory Amazon (Total)','Inventory Amazon (Available)','Coverage Days','Pack Density',wh,'Stylish Inventory','Qty to Send','Method','Pallets','Inbound ETA'];
        const keys = ['sku','fba','category','units_sold','target','inventory_amazon','inventory_amazon_available','coverage_days','pack_density','inventory_warehouse','inventory_stylish','qty_to_send','how_to_send','qty_pallets','eta'];
        const csvCell = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
        const rows = [headers.join(',')];
        this.filteredData.forEach(i => rows.push(keys.map(k => csvCell(i[k])).join(',')));
        const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `fba_${this.isAmazonUSA ? 'usa' : 'ca'}_${this.selectedDays}d_${new Date().toISOString().substring(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // ===============================================================
    // NOT IN PRIME — productos con stock en FBA (total_units > 0)
    // pero NO disponibles para Prime (available === 0)
    // ===============================================================
    computeNotPrime() {
        return this.allData
            .filter(i => i.inventory_amazon > 0 && i.inventory_amazon_available === 0)
            .sort((a, b) => b.inventory_amazon - a.inventory_amazon);
    }

    renderNotPrime() {
        const base = this.computeNotPrime();
        const search = (document.getElementById('np-filter-sku')?.value || '').toLowerCase().trim();
        const minDays = parseInt(document.getElementById('np-filter-mindays')?.value) || 0;

        let filtered = search
            ? base.filter(i =>
                i.sku.toLowerCase().includes(search) ||
                (i.category || '').toLowerCase().includes(search))
            : base;

        // Filtro por días mínimos sin Prime (solo aplica si tenemos data de Supabase)
        if (minDays > 0) {
            filtered = filtered.filter(i => {
                const d = this.notPrimeDays[i.sku];
                return d != null && d >= minDays;
            });
        }

        // Counter
        const countEl = document.getElementById('np-count');
        if (countEl) {
            countEl.textContent = filtered.length === base.length
                ? `${base.length} items`
                : `${filtered.length} / ${base.length} items`;
        }

        // Export button state
        const exportBtn = document.getElementById('np-export-btn');
        if (exportBtn) exportBtn.disabled = base.length === 0;

        // Render body
        const tbody = document.getElementById('np-body');
        if (!tbody) return;

        if (!filtered.length) {
            const msg = base.length === 0
                ? '✓ All FBA stock is Prime-available'
                : 'No SKUs match filters';
            const icon = base.length === 0 ? 'fa-circle-check' : 'fa-filter-circle-xmark';
            tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><i class="fas ${icon}"></i><span>${msg}</span></td></tr>`;
            // Igual intentamos refrescar el histograma (mostrará vacío si no hay data)
            this.renderNpDaysChart(filtered);
            this._notPrimeFiltered = filtered;
            return;
        }

        let html = '';
        filtered.forEach(item => {
            const days = this.notPrimeDays[item.sku];
            html += `<tr>
                <td class="sku-cell">${this.esc(item.sku)}</td>
                <td class="cat-truncate" title="${this.esc(item.category)}">${this.esc(item.category)}</td>
                <td class="text-end value-mono value-warning">${this.fmtNum(item.inventory_amazon)}</td>
                <td class="text-end">${this.renderDaysPill(days)}</td>
            </tr>`;
        });
        tbody.innerHTML = html;

        // Histograma debajo de la tabla
        this.renderNpDaysChart(filtered);

        // Guardamos la lista filtrada para que export la use
        this._notPrimeFiltered = filtered;
    }

    // Pill coloreada según severidad de días sin Prime
    renderDaysPill(days) {
        if (days == null) {
            return '<span class="days-pill days-unknown" title="Not tracked yet">—</span>';
        }
        let cls = 'days-new';
        if (days >= 31) cls = 'days-bad';
        else if (days >= 15) cls = 'days-warn';
        else if (days >= 5) cls = 'days-ok';
        else cls = 'days-new';
        return `<span class="days-pill ${cls}" title="${days} day${days === 1 ? '' : 's'} unavailable for Prime">${days}d</span>`;
    }

    exportNotPrime() {
        const data = this._notPrimeFiltered || this.computeNotPrime();
        if (!data.length) return;
        const wh = this.isAmazonUSA ? 'Inventory Charlotte' : 'Inventory Cambridge';
        const headers = ['SKU','Category','FBA Total Units','Available for Prime','Days Unavailable','Units Sold 30d',wh,'Stylish Inventory','Inbound ETA'];
        const keys = ['sku','category','inventory_amazon','inventory_amazon_available','days_unavailable','units_sold','inventory_warehouse','inventory_stylish','eta'];
        const csvCell = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
        const rows = [headers.join(',')];
        data.forEach(i => {
            const withDays = { ...i, days_unavailable: this.notPrimeDays[i.sku] ?? '' };
            rows.push(keys.map(k => csvCell(withDays[k])).join(','));
        });
        const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `fba_not_prime_${this.isAmazonUSA ? 'usa' : 'ca'}_${new Date().toISOString().substring(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // ===============================================================
    // SUPABASE SYNC — reconcilia tracking de not-Prime y guarda snapshot
    // ===============================================================
    async syncWithSupabase() {
        if (!this.supabase) return { ok: false, error: 'Supabase no configurado' };

        const mp = this.isAmazonUSA ? 'usa' : 'ca';
        const notPrimeSkus = this.computeNotPrime().map(i => i.sku);

        this.setSyncStatus('loading', 'Sincronizando...');

        try {
            // 1) Reconciliar tracking y obtener days por SKU (llamada RPC atómica)
            const { data: trackingData, error: rpcError } = await this.supabase.rpc(
                'reconcile_not_prime',
                { p_mp: mp, p_skus: notPrimeSkus }
            );
            if (rpcError) throw new Error(`RPC reconcile: ${rpcError.message}`);

            // Mapa sku → days para uso en renderNotPrime
            this.notPrimeDays = {};
            (trackingData || []).forEach(row => {
                this.notPrimeDays[row.sku] = row.days ?? 0;
            });

            // 2) Guardar snapshot (metadata + data completa como JSONB)
            const summary = this.computeSummary();
            const { data: snapData, error: snapError } = await this.supabase
                .from('snapshots')
                .insert({
                    marketplace: mp,
                    days_target: this.selectedDays,
                    total_skus: this.allData.length,
                    oos: summary.oos,
                    critical: summary.low,
                    healthy: summary.healthy,
                    overstocked: summary.overstock,
                    not_prime: notPrimeSkus.length,
                    total_units_to_send: summary.totalSend,
                    data: this.processedData, // array crudo del process()
                })
                .select('id')
                .single();
            if (snapError) throw new Error(`Insert snapshot: ${snapError.message}`);

            this.lastSyncAt = new Date();
            this.setSyncStatus('ok', `Synced just now · ${notPrimeSkus.length} tracked`);

            // Re-renderizar tabla y histograma con los días actualizados
            this.renderNotPrime();

            return {
                ok: true,
                tracked: notPrimeSkus.length,
                snapshotId: snapData?.id,
            };
        } catch (err) {
            this.setSyncStatus('err', `Sync failed: ${err.message}`);
            return { ok: false, error: err.message };
        }
    }

    // Pequeño helper para computar los counts que guardamos en el snapshot
    computeSummary() {
        let oos = 0, low = 0, healthy = 0, overstock = 0, totalSend = 0;
        this.allData.forEach(item => {
            const cls = this.classify(item);
            if (cls === 'oos') oos++;
            else if (cls === 'low') low++;
            else if (cls === 'overstock') overstock++;
            else healthy++;
            totalSend += item.qty_to_send;
        });
        return { oos, low, healthy, overstock, totalSend };
    }

    setSyncStatus(kind, message) {
        const el = document.getElementById('np-sync-status');
        if (!el) return;
        el.className = 'np-sync-status';
        if (kind === 'ok') el.classList.add('sync-ok');
        else if (kind === 'err') el.classList.add('sync-err');
        else if (kind === 'off') el.classList.add('sync-off');
        const icon = { ok: 'fa-cloud-arrow-up', err: 'fa-triangle-exclamation', off: 'fa-cloud-xmark', loading: 'fa-circle-notch fa-spin' }[kind] || 'fa-info-circle';
        el.innerHTML = `<i class="fas ${icon} me-1"></i>${message}`;
    }

    // ===============================================================
    // Histograma de días sin Prime (distribución en buckets)
    // ===============================================================
    renderNpDaysChart(notPrimeItems) {
        const hasData = notPrimeItems.length > 0 && Object.keys(this.notPrimeDays).length > 0;
        const card = document.getElementById('np-histogram-card');
        if (!card) return;
        if (!hasData) {
            // Si no hay data, limpiamos chart previo y escondemos card
            if (this.chartNpDays) {
                try { this.chartNpDays.destroy(); } catch (e) {}
                this.chartNpDays = null;
            }
            card.style.display = 'none';
            return;
        }
        card.style.display = '';

        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';

        // Buckets configurables y alineados con el Power BI original
        const buckets = [
            { label: '0–4',   min: 0,   max: 4,   color: isDark ? '#58a6ff' : '#0969da', kind: 'new' },
            { label: '5–14',  min: 5,   max: 14,  color: isDark ? '#3fb950' : '#1a7f37', kind: 'ok' },
            { label: '15–30', min: 15,  max: 30,  color: isDark ? '#d29922' : '#9a6700', kind: 'warn' },
            { label: '31–60', min: 31,  max: 60,  color: isDark ? '#f85149' : '#cf222e', kind: 'bad' },
            { label: '61–120',min: 61,  max: 120, color: isDark ? '#f85149' : '#cf222e', kind: 'bad' },
            { label: '120+',  min: 121, max: 99999, color: isDark ? '#ff6b64' : '#a40e26', kind: 'bad' },
        ];

        // Contar cada SKU not-Prime en su bucket usando notPrimeDays
        const counts = buckets.map(b => notPrimeItems.filter(i => {
            const d = this.notPrimeDays[i.sku];
            if (d == null) return false;
            return d >= b.min && d <= b.max;
        }).length);

        // Update in-place si ya existe
        if (this.chartNpDays) {
            this.chartNpDays.data.datasets[0].data = counts;
            this.chartNpDays._buckets = buckets;
            this.chartNpDays.update('none');
            return;
        }

        // Creación inicial: el card recién pasó de display:none a visible.
        // Chart.js necesita que el browser haya hecho layout para medir bien el canvas.
        // Doble requestAnimationFrame = espera 2 frames = layout garantizado.
        const createChart = () => {
            const ctx = document.getElementById('chart-np-days');
            if (!ctx) return;
            const gridC = isDark ? 'rgba(48,54,61,0.3)' : 'rgba(0,0,0,0.06)';

            this.chartNpDays = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: buckets.map(b => b.label + ' d'),
                    datasets: [{
                        data: counts,
                        backgroundColor: (c) => this.makeGradient(c, buckets[c.dataIndex]?.color || '#888', 0.85, 0.2),
                        hoverBackgroundColor: (c) => buckets[c.dataIndex]?.color || '#888',
                        borderRadius: 6, barPercentage: 0.85, borderWidth: 0,
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    layout: { padding: { top: 18 } },
                    onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
                    onClick: (evt, elements) => {
                        if (!elements.length) return;
                        const idx = elements[0].index;
                        const bucket = this.chartNpDays._buckets?.[idx] || buckets[idx];
                        const mdInput = document.getElementById('np-filter-mindays');
                        if (mdInput) {
                            mdInput.value = bucket.min;
                            this.renderNotPrime();
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            padding: 12,
                            callbacks: {
                                title: (ctx) => `${ctx[0].label}`,
                                label: (c) => ` ${c.parsed.y} SKU${c.parsed.y === 1 ? '' : 's'}`,
                                afterBody: () => ['  ↳ click to filter by min days']
                            }
                        },
                        datalabels: {
                            display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0,
                            anchor: 'end', align: 'end', offset: 2,
                            color: isDark ? '#c9d1d9' : '#1f2328',
                            font: { weight: '700', size: 11, family: "'DM Sans', sans-serif" },
                            formatter: (v) => v,
                        }
                    },
                    scales: {
                        x: { grid: { display: false, drawBorder: false }, ticks: { font: { size: 10 } } },
                        y: { beginAtZero: true, grid: { color: gridC, drawBorder: false }, ticks: { precision: 0 } }
                    }
                }
            });
            this.chartNpDays._buckets = buckets;
        };

        // Doble rAF para garantizar que el browser hizo layout del card
        // después de hacerlo visible. Sin esto, Chart.js mide el canvas a 0x0.
        requestAnimationFrame(() => requestAnimationFrame(createChart));
    }

    downloadRawJSON() {
        if (!this.processedData.length) return;
        const payload = JSON.stringify({ data: this.processedData, meta: this.processedMeta }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `fba_raw_${this.processedMeta.marketplace}_${new Date().toISOString().substring(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // ===============================================================
    // Utilities
    // ===============================================================
    pickKey(obj, candidates) {
        if (!obj) return null;
        const keys = Object.keys(obj);
        for (const cand of candidates) {
            const t = String(cand).toLowerCase().trim();
            const f = keys.find(k => String(k).toLowerCase().trim() === t);
            if (f) return f;
        }
        for (const cand of candidates) {
            const t = String(cand).toLowerCase().trim();
            const f = keys.find(k => String(k).toLowerCase().trim().includes(t));
            if (f) return f;
        }
        return null;
    }

    // Helpers (equivalentes a las funciones PHP)
    static normalize(s) {
        if (s == null) return '';
        let r = String(s);
        r = r.replace(/[\u00A0\u200B\u200C\u200D]/g, ' ');
        r = r.replace(/[\u2013\u2014]/g, '-');
        r = r.toLowerCase().trim();
        r = r.replace(/\s+/g, ' ');
        return r;
    }
    static normalizeSku(s) {
        if (s == null) return '';
        return String(s).replace(/[\u00A0\u200B\u200C\u200D]/g, '').trim().toUpperCase();
    }
    static toInt(v) {
        if (v == null) return 0;
        let s = String(v).replace(/,/g, '').replace(/\s/g, '');
        if (s.startsWith('=')) return 0;
        const n = parseFloat(s);
        return isNaN(n) ? 0 : Math.round(n);
    }
    static cleanEta(v) {
        if (v == null) return '';
        let s = String(v).replace(/[\u00A0\u200B]/g, '').trim();
        return (s === '' || s === '0' || s === '-') ? '' : s;
    }
    static detectCol(headers, candidates) {
        const norm = headers.map(h => FbaAnalyzer.normalize(h));
        for (const cand of candidates) {
            const n = FbaAnalyzer.normalize(cand);
            if (norm.includes(n)) return norm[norm.indexOf(n)];
        }
        for (const cand of candidates) {
            const n = FbaAnalyzer.normalize(cand);
            const idx = norm.findIndex(h => h.includes(n));
            if (idx >= 0) return norm[idx];
        }
        return null;
    }
    static detectColStrict(headers, candidates) {
        const norm = headers.map(h => FbaAnalyzer.normalize(h));
        for (const cand of candidates) {
            const n = FbaAnalyzer.normalize(cand);
            if (norm.includes(n)) return norm[norm.indexOf(n)];
        }
        return null;
    }

    // UI/theme
    initTheme() {
        const saved = localStorage.getItem('fba-theme');
        this.applyTheme(saved || 'dark');
    }
    toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        this.applyTheme(next);
        localStorage.setItem('fba-theme', next);
    }
    applyTheme(theme) {
        console.log(`[FBA Theme] → ${theme}`);
        document.documentElement.setAttribute('data-theme', theme);
        const icon = document.getElementById('theme-icon');
        if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        const textColor = theme === 'light' ? '#59636e' : '#8b949e';
        const gridColor = theme === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(48,54,61,0.5)';
        Chart.defaults.color = textColor;
        Chart.defaults.borderColor = gridColor;

        if (this.allData?.length > 0) {
            // Los colores de cada chart están cacheados al crearse → destruir + recrear
            this.destroyAllCharts();
            console.log('[FBA Theme] charts destroyed, scheduling re-render');

            // UN rAF para dar al browser un tick de CSS recalc. updateDashboard
            // y renderNotPrime tienen sus propios rAF internos para el chart create.
            requestAnimationFrame(() => {
                this.updateDashboard();
                this.renderNotPrime();
                // Verificar en consola que los refs se recrearon
                setTimeout(() => {
                    console.log('[FBA Theme] chart refs after recreate:', {
                        health: !!this.chartHealth,
                        topSellers: !!this.chartTopSellers,
                        categories: !!this.chartCategories,
                        coverage: !!this.chartCoverageDist,
                        npDays: !!this.chartNpDays,
                    });
                }, 200);
            });
        }
    }

    handleMarketplaceChange(e) {
        this.isAmazonUSA = e.target.checked;
        this.updateMarketplaceUI();
    }
    updateMarketplaceUI() {
        const labelCA = document.getElementById('mp-label-ca');
        const labelUS = document.getElementById('mp-label-us');
        const title = document.getElementById('amazon-report-title');
        const thWH = document.getElementById('th-warehouse');
        if (labelCA) labelCA.classList.toggle('active', !this.isAmazonUSA);
        if (labelUS) labelUS.classList.toggle('active', this.isAmazonUSA);
        if (title) title.textContent = this.isAmazonUSA ? 'Amazon USA Restock' : 'Amazon CA Restock';
        if (thWH) thWH.textContent = this.isAmazonUSA ? 'Warehouse (Charlotte)' : 'Warehouse (Cambridge)';
    }

    showStatus(type, msg) {
        const bar = document.getElementById('config-status-bar');
        const txt = document.getElementById('config-status-text');
        if (!bar || !txt) return;
        bar.className = 'config-status-bar ' + (type === 'loading' ? 'loading' : '');
        txt.textContent = msg;
        bar.style.display = '';
    }
    hideStatus() {
        const bar = document.getElementById('config-status-bar');
        if (bar) bar.style.display = 'none';
    }

    hideModal() {
        try { this.loadingModal?.hide(); } catch {}
        setTimeout(() => {
            const el = document.getElementById('loadingModal');
            if (el) { el.classList.remove('show'); el.style.display = 'none'; }
            document.querySelector('.modal-backdrop')?.remove();
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
        }, 200);
    }

    setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
    fmtNum(n) { return Number(n).toLocaleString('en-US'); }
    esc(s) { if (s == null) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
}

document.addEventListener('DOMContentLoaded', () => {
    try { window.fbaApp = new FbaAnalyzer(); }
    catch (e) { console.error('Init error:', e); }
});
