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

        // ApexCharts no necesita registro global ni plugins.
        // Los defaults (colors, tooltip, font) se configuran por chart
        // en su opciones via this.apexCommon(). Ver helper más abajo.

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

        // Upload collapse / expand toggle
        document.getElementById('upload-expand-btn')?.addEventListener('click', () => this.expandUploadSection());

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

        // Context strip (FBA/Prime text links also behave as filters)
        document.querySelectorAll('.context-item.clickable-text').forEach(el => {
            el.addEventListener('click', () => this.toggleKpiFilter(el.dataset.filter));
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
            document.getElementById('np-section').style.display = '';
            document.getElementById('table-section').style.display = '';
            document.getElementById('export-btn').disabled = false;

            // Colapsar upload section a barra compacta
            this.collapseUploadSection();

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
        // Inbound = unidades en tránsito al almacén de Amazon (columna N del restock report)
        let colInbound = FbaAnalyzer.detectColStrict(amzHeaders, ['Inbound', 'inbound']);
        if (!colInbound) colInbound = FbaAnalyzer.detectCol(amzHeaders, ['afn-inbound-shipped-quantity', 'Inbound quantity', 'Inbound Units', 'inbound_shipped_quantity']);
        if (!colInbound && amzHeaders[13]) colInbound = amzHeaders[13]; // fallback: 14ta columna (index 13)
        if (!colSold30 && amzHeaders[11]) colSold30 = amzHeaders[11];
        if (!colTotalUnit && amzHeaders[12]) colTotalUnit = amzHeaders[12];
        if (!colMerchantSKU && !colSupplier) throw new Error("Amazon: no se encontró 'Merchant SKU' ni 'Supplier'.");
        if (!colSold30) throw new Error("Amazon: no se encontró columna Units Sold 30d.");
        if (!colTotalUnit) throw new Error("Amazon: no se encontró columna Total Units.");

        const amzUnitsSold = {}, amzInventory = {}, amzAvailable = {}, amzInbound = {};
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
            if (colInbound) {
                amzInbound[partNumber] = (amzInbound[partNumber] || 0) + FbaAnalyzer.toInt(r[colInbound]);
            }
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
                inventory_amazon_inbound: amzInbound[sku] || 0,
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
            inventory_amazon_inbound: Number(item.inventory_amazon_inbound ?? 0),
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
            if (kpi === 'inbound') return item.inventory_amazon_inbound > 0;
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
            if (item.inventory_amazon_inbound > 0) inbound++;
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
        // ApexCharts tiene .destroy() simple, sin animation races como Chart.js
        ['chartHealth', 'chartTopSellers', 'chartCategories', 'chartCoverageDist', 'chartNpDays'].forEach(name => {
            if (this[name]) {
                try { this[name].destroy(); } catch (e) { /* ignore */ }
                this[name] = null;
            }
        });
    }

    // ---- ApexCharts theme helpers ----
    apexTheme() {
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
        return {
            isDark,
            mode: isDark ? 'dark' : 'light',
            textPrimary: isDark ? '#e6edf3' : '#1f2328',
            textSecondary: isDark ? '#8b949e' : '#59636e',
            border: isDark ? 'rgba(48,54,61,0.5)' : 'rgba(0,0,0,0.08)',
            bg: isDark ? 'transparent' : 'transparent',
            tooltip: isDark ? 'dark' : 'light',
            // Palette semántica (OOS / critical / healthy / overstocked)
            palette: isDark
                ? { oos: '#f85149', low: '#d29922', healthy: '#3fb950', overstock: '#e3b341', accent: '#58a6ff', muted: '#6e7681' }
                : { oos: '#cf222e', low: '#9a6700', healthy: '#1a7f37', overstock: '#bf8700', accent: '#0969da', muted: '#8c959f' }
        };
    }

    // Opciones comunes de ApexCharts (fonts, tooltip style, animations, toolbar off)
    apexCommon() {
        const t = this.apexTheme();
        return {
            chart: {
                background: 'transparent',
                fontFamily: "'DM Sans', sans-serif",
                toolbar: { show: false },
                zoom: { enabled: false },
                animations: {
                    enabled: true,
                    easing: 'easeinout',
                    speed: 500,
                    animateGradually: { enabled: true, delay: 80 },
                    dynamicAnimation: { enabled: true, speed: 300 },
                },
            },
            theme: { mode: t.mode },
            grid: {
                borderColor: t.border,
                strokeDashArray: 3,
                xaxis: { lines: { show: false } },
                yaxis: { lines: { show: true } },
                padding: { left: 20, right: 30, top: 10, bottom: 10 },
            },
            tooltip: {
                theme: t.tooltip,
                style: { fontFamily: "'DM Sans', sans-serif", fontSize: '12px' },
            },
        };
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
        const total = oos + low + healthy + overstock;
        // Convertir conteos absolutos a porcentajes (radialBar usa % 0-100)
        const pct = (n) => total ? +((n / total) * 100).toFixed(1) : 0;
        // Guardamos los counts absolutos para usar en tooltip/labels
        const counts = [oos, low, healthy, overstock];
        const series = [pct(oos), pct(low), pct(healthy), pct(overstock)];
        const labels = ['Out of stock', 'Critical (<30d)', 'Healthy', 'Overstocked (>120d)'];

        // Update in-place si ya existe
        if (this.chartHealth) {
            this.chartHealth.updateSeries(series);
            this.chartHealth._counts = counts;
            this.chartHealth._total = total;
            return;
        }

        const el = document.getElementById('chart-health');
        if (!el) return;
        const t = this.apexTheme();
        const kpiMap = ['oos', 'low', 'healthy', 'overstock'];

        const options = {
            ...this.apexCommon(),
            series,
            chart: {
                ...this.apexCommon().chart,
                type: 'radialBar',
                height: 260,
                events: {
                    dataPointSelection: (event, ctx, config) => {
                        const idx = config.dataPointIndex ?? config.seriesIndex;
                        if (idx != null && kpiMap[idx]) this.toggleKpiFilter(kpiMap[idx]);
                    },
                },
            },
            plotOptions: {
                radialBar: {
                    offsetY: 0,
                    hollow: { size: '38%', background: 'transparent' },
                    track: {
                        background: t.isDark ? 'rgba(110, 118, 129, 0.15)' : 'rgba(0, 0, 0, 0.05)',
                        strokeWidth: '100%',
                        margin: 8,
                    },
                    dataLabels: {
                        name: { show: true, offsetY: -4, fontSize: '12px', color: t.textSecondary, fontFamily: "'DM Sans', sans-serif" },
                        value: { show: true, offsetY: 4, fontSize: '28px', fontWeight: 700, color: t.textPrimary, formatter: () => String(total) },
                        total: {
                            show: true,
                            label: 'Total SKUs',
                            color: t.textSecondary,
                            fontSize: '11px',
                            fontFamily: "'DM Sans', sans-serif",
                            fontWeight: 500,
                            formatter: () => String(total),
                        },
                    },
                },
            },
            colors: [t.palette.oos, t.palette.low, t.palette.healthy, t.palette.overstock],
            labels,
            stroke: { lineCap: 'round' },
            legend: {
                show: true,
                position: 'bottom',
                horizontalAlign: 'center',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '11px',
                labels: { colors: t.textSecondary, useSeriesColors: false },
                markers: { width: 10, height: 10, radius: 5 },
                itemMargin: { horizontal: 8, vertical: 3 },
                formatter: (seriesName, opts) => {
                    const i = opts.seriesIndex;
                    const c = counts[i];
                    const p = series[i];
                    return `${seriesName}: ${c} (${p}%)`;
                },
            },
            tooltip: {
                ...this.apexCommon().tooltip,
                enabled: true,
                custom: ({ seriesIndex }) => {
                    const c = counts[seriesIndex];
                    const p = series[seriesIndex];
                    return `<div class="apex-tt">
                        <div class="apex-tt-title">${labels[seriesIndex]}</div>
                        <div class="apex-tt-body">${c} SKUs (${p}%)</div>
                        <div class="apex-tt-hint">↳ click to filter table</div>
                    </div>`;
                },
            },
        };

        this.chartHealth = new ApexCharts(el, options);
        this.chartHealth.render();
        this.chartHealth._counts = counts;
        this.chartHealth._total = total;
    }

    renderTopSellersChart(data) {
        const top = [...data].sort((a, b) => b.units_sold - a.units_sold).slice(0, 10);
        // ApexCharts horizontal bar: categories = labels, y-axis data = values
        const categories = top.map(i => i.sku);
        const values = top.map(i => i.units_sold);
        const t = this.apexTheme();

        // Clasificación por SKU → color por estado de salud
        const healthColorFor = (item) => {
            const cls = this.classify(item);
            return t.palette[cls] || t.palette.healthy;
        };
        const colors = top.map(i => healthColorFor(i));

        // Update in-place (el dataset + colors + categorías cambian al filtrar)
        if (this.chartTopSellers) {
            this.chartTopSellers.updateOptions({
                series: [{ name: 'Units sold', data: values }],
                xaxis: { categories },
                colors,
            });
            this.chartTopSellers._items = top;
            return;
        }

        const el = document.getElementById('chart-top-sellers');
        if (!el) return;

        const options = {
            ...this.apexCommon(),
            series: [{ name: 'Units sold', data: values }],
            chart: {
                ...this.apexCommon().chart,
                type: 'bar',
                height: 260,
                events: {
                    dataPointSelection: (event, ctx, config) => {
                        const idx = config.dataPointIndex;
                        if (idx == null) return;
                        const sku = this.chartTopSellers?._items?.[idx]?.sku;
                        if (sku) {
                            const input = document.getElementById('filter-sku');
                            if (input) {
                                input.value = sku;
                                this.applyFilters();
                            }
                        }
                    },
                },
            },
            plotOptions: {
                bar: {
                    horizontal: true,
                    barHeight: '65%',
                    borderRadius: 4,
                    borderRadiusApplication: 'end',
                    distributed: true, // colores individuales por barra
                    dataLabels: { position: 'top' },
                },
            },
            grid: {
                ...this.apexCommon().grid,
                padding: { left: 20, right: 60, top: 10, bottom: 10 },  // + espacio derecho para los numeros
            },
            colors,
            dataLabels: {
                enabled: true,
                offsetX: 32,
                style: {
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '11px',
                    fontWeight: 600,
                    colors: [t.textPrimary],
                },
                formatter: (v) => v.toLocaleString('en-US'),
            },
            legend: { show: false },
            xaxis: {
                categories,
                labels: { style: { colors: t.textSecondary, fontSize: '11px' } },
                axisBorder: { show: false },
                axisTicks: { show: false },
            },
            yaxis: {
                labels: {
                    style: {
                        colors: t.textPrimary,
                        fontSize: '11px',
                        fontFamily: "'JetBrains Mono', monospace",
                    },
                },
            },
            tooltip: {
                ...this.apexCommon().tooltip,
                custom: ({ dataPointIndex }) => {
                    const it = this.chartTopSellers?._items?.[dataPointIndex] || top[dataPointIndex];
                    if (!it) return '';
                    const cls = this.classify(it);
                    const statusLabel = { oos: '🔴 Out of stock', low: '🟡 Critical (<30d)', healthy: '🟢 Healthy', overstock: '🟠 Overstocked' }[cls];
                    const cov = it.coverage_days >= 999 ? '∞' : `${it.coverage_days}d`;
                    const sendLine = it.qty_to_send > 0
                        ? `<div class="apex-tt-line"><span class="apex-tt-k">Need to send</span><span class="apex-tt-v apex-tt-warn">${it.qty_to_send.toLocaleString()}</span></div>` : '';
                    return `<div class="apex-tt">
                        <div class="apex-tt-title">${this.esc(it.sku)} · ${this.esc(it.category || 'Sin categoría')}</div>
                        <div class="apex-tt-line"><span class="apex-tt-k">Sold 30d</span><span class="apex-tt-v">${it.units_sold.toLocaleString()}</span></div>
                        <div class="apex-tt-line"><span class="apex-tt-k">Amazon inv</span><span class="apex-tt-v">${it.inventory_amazon.toLocaleString()}</span></div>
                        <div class="apex-tt-line"><span class="apex-tt-k">Coverage</span><span class="apex-tt-v">${cov}</span></div>
                        <div class="apex-tt-line"><span class="apex-tt-k">Status</span><span class="apex-tt-v">${statusLabel}</span></div>
                        ${sendLine}
                        <div class="apex-tt-hint">↳ click to filter by this SKU</div>
                    </div>`;
                },
            },
            states: {
                hover: { filter: { type: 'lighten', value: 0.1 } },
                active: { filter: { type: 'darken', value: 0.15 } },
            },
        };

        this.chartTopSellers = new ApexCharts(el, options);
        this.chartTopSellers.render();
        this.chartTopSellers._items = top;
    }

    renderCategoriesChart(data) {
        // Agrupamos por categoría Y clasificamos cada SKU por estado de salud
        const catMap = {};
        data.forEach(i => {
            const cat = i.category || 'Other';
            if (!catMap[cat]) catMap[cat] = { oos: 0, low: 0, healthy: 0, overstock: 0, total: 0 };
            const cls = this.classify(i);
            catMap[cat][cls]++;
            catMap[cat].total++;
        });
        const sorted = Object.entries(catMap).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
        const categories = sorted.map(s => s[0]);
        const totals = sorted.map(s => s[1].total);
        const seriesData = {
            oos:       sorted.map(s => s[1].oos),
            low:       sorted.map(s => s[1].low),
            healthy:   sorted.map(s => s[1].healthy),
            overstock: sorted.map(s => s[1].overstock),
        };

        // Update in-place (ApexCharts maneja stack nativamente)
        if (this.chartCategories) {
            this.chartCategories.updateOptions({
                series: [
                    { name: 'Out of stock', data: seriesData.oos },
                    { name: 'Critical',     data: seriesData.low },
                    { name: 'Healthy',      data: seriesData.healthy },
                    { name: 'Overstocked',  data: seriesData.overstock },
                ],
                xaxis: { categories },
            });
            this.chartCategories._totals = totals;
            this.chartCategories._categories = categories;
            return;
        }

        const el = document.getElementById('chart-categories');
        if (!el) return;
        const t = this.apexTheme();

        const options = {
            ...this.apexCommon(),
            series: [
                { name: 'Out of stock', data: seriesData.oos },
                { name: 'Critical',     data: seriesData.low },
                { name: 'Healthy',      data: seriesData.healthy },
                { name: 'Overstocked',  data: seriesData.overstock },
            ],
            chart: {
                ...this.apexCommon().chart,
                type: 'bar',
                height: 260,
                stacked: true,
                events: {
                    dataPointSelection: (event, ctx, config) => {
                        const idx = config.dataPointIndex;
                        if (idx == null) return;
                        const category = this.chartCategories?._categories?.[idx] || categories[idx];
                        const sel = document.getElementById('filter-category');
                        if (sel && category) {
                            sel.value = category;
                            this.applyFilters();
                        }
                    },
                },
            },
            plotOptions: {
                bar: {
                    horizontal: false,
                    borderRadius: 2,
                    borderRadiusApplication: 'end',
                    borderRadiusWhenStacked: 'last',
                    columnWidth: '55%',
                    dataLabels: { total: {
                        enabled: true,
                        offsetY: -8,
                        style: {
                            fontFamily: "'DM Sans', sans-serif",
                            fontSize: '11px',
                            fontWeight: 700,
                            color: t.textPrimary,
                        },
                    } },
                },
            },
            colors: [t.palette.oos, t.palette.low, t.palette.healthy, t.palette.overstock],
            dataLabels: { enabled: false }, // solo labels de totales (configurado arriba)
            grid: {
                ...this.apexCommon().grid,
                padding: { left: 20, right: 20, top: 20, bottom: 10 },  // + espacio arriba para los labels de totales
            },
            legend: {
                show: true,
                position: 'bottom',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '11px',
                labels: { colors: t.textSecondary },
                markers: { width: 10, height: 10, radius: 5 },
                itemMargin: { horizontal: 8, vertical: 3 },
            },
            xaxis: {
                categories,
                labels: {
                    style: { colors: t.textSecondary, fontSize: '10px' },
                    rotate: -35, rotateAlways: categories.length > 5, hideOverlappingLabels: true,
                },
                axisBorder: { show: false },
                axisTicks: { show: false },
            },
            yaxis: {
                labels: { style: { colors: t.textSecondary, fontSize: '11px' } },
                forceNiceScale: true,
            },
            tooltip: {
                ...this.apexCommon().tooltip,
                custom: ({ dataPointIndex }) => {
                    const cat = this.chartCategories?._categories?.[dataPointIndex] || categories[dataPointIndex];
                    const tot = this.chartCategories?._totals?.[dataPointIndex] ?? totals[dataPointIndex];
                    const s = sorted[dataPointIndex]?.[1] || { oos: 0, low: 0, healthy: 0, overstock: 0 };
                    const line = (label, v, color) => {
                        if (!v) return '';
                        const pct = tot ? ((v / tot) * 100).toFixed(0) : 0;
                        return `<div class="apex-tt-line"><span class="apex-tt-dot" style="background:${color}"></span><span class="apex-tt-k">${label}</span><span class="apex-tt-v">${v} (${pct}%)</span></div>`;
                    };
                    return `<div class="apex-tt">
                        <div class="apex-tt-title">${this.esc(cat)} · ${tot} SKUs</div>
                        ${line('Out of stock', s.oos, t.palette.oos)}
                        ${line('Critical', s.low, t.palette.low)}
                        ${line('Healthy', s.healthy, t.palette.healthy)}
                        ${line('Overstocked', s.overstock, t.palette.overstock)}
                        <div class="apex-tt-hint">↳ click to filter by category</div>
                    </div>`;
                },
            },
            states: {
                hover: { filter: { type: 'lighten', value: 0.08 } },
                active: { filter: { type: 'darken', value: 0.15 } },
            },
        };

        this.chartCategories = new ApexCharts(el, options);
        this.chartCategories.render();
        this.chartCategories._totals = totals;
        this.chartCategories._categories = categories;
    }

    renderCoverageDistChart(data) {
        const t = this.apexTheme();
        // Cada bucket tiene un filtro KPI asociado (click → activa ese filtro)
        const buckets = [
            { label: '0d (OOS)',     min: 0,   max: 0,   color: t.palette.oos,       kpi: 'oos' },
            { label: '1–15d',        min: 1,   max: 15,  color: t.palette.oos,       kpi: 'low' },
            { label: '16–30d',       min: 16,  max: 30,  color: t.palette.low,       kpi: 'low' },
            { label: '31–60d',       min: 31,  max: 60,  color: t.palette.healthy,   kpi: 'healthy' },
            { label: '61–90d',       min: 61,  max: 90,  color: t.palette.healthy,   kpi: 'healthy' },
            { label: '91–120d',      min: 91,  max: 120, color: t.palette.healthy,   kpi: 'healthy' },
            { label: '120+ (over)',  min: 121, max: 998, color: t.palette.overstock, kpi: 'overstock' },
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
        const categories = buckets.map(b => b.label);
        const colors = buckets.map(b => b.color);

        // Update in-place
        if (this.chartCoverageDist) {
            this.chartCoverageDist.updateOptions({
                series: [{ name: 'SKUs', data: counts }],
                xaxis: { categories },
                colors,
            });
            this.chartCoverageDist._cumulative = cumulative;
            this.chartCoverageDist._buckets = buckets;
            return;
        }

        const el = document.getElementById('chart-coverage-dist');
        if (!el) return;

        const options = {
            ...this.apexCommon(),
            series: [{ name: 'SKUs', data: counts }],
            chart: {
                ...this.apexCommon().chart,
                type: 'bar',
                height: 260,
                events: {
                    dataPointSelection: (event, ctx, config) => {
                        const idx = config.dataPointIndex;
                        if (idx == null) return;
                        const bucket = this.chartCoverageDist?._buckets?.[idx] || buckets[idx];
                        if (bucket?.kpi) this.toggleKpiFilter(bucket.kpi);
                    },
                },
            },
            plotOptions: {
                bar: {
                    horizontal: false,
                    borderRadius: 4,
                    borderRadiusApplication: 'end',
                    columnWidth: '60%',
                    distributed: true,
                },
            },
            grid: {
                ...this.apexCommon().grid,
                padding: { left: 20, right: 20, top: 30, bottom: 10 },  // + espacio arriba para los numeros
            },
            colors,
            dataLabels: {
                enabled: true,
                offsetY: -20,
                style: {
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '12px',
                    fontWeight: 700,
                    colors: [t.textPrimary],
                },
                formatter: (v) => v > 0 ? v : '',
            },
            legend: { show: false },
            xaxis: {
                categories,
                labels: { style: { colors: t.textSecondary, fontSize: '11px' } },
                axisBorder: { show: false },
                axisTicks: { show: false },
            },
            yaxis: {
                labels: { style: { colors: t.textSecondary, fontSize: '11px' } },
                forceNiceScale: true,
            },
            tooltip: {
                ...this.apexCommon().tooltip,
                custom: ({ dataPointIndex }) => {
                    const bucket = this.chartCoverageDist?._buckets?.[dataPointIndex] || buckets[dataPointIndex];
                    const v = counts[dataPointIndex];
                    const tot = counts.reduce((a, b) => a + b, 0);
                    const pct = tot ? ((v / tot) * 100).toFixed(1) : 0;
                    const cum = (this.chartCoverageDist?._cumulative ?? cumulative)[dataPointIndex];
                    const cumPct = tot ? ((cum / tot) * 100).toFixed(0) : 0;
                    return `<div class="apex-tt">
                        <div class="apex-tt-title">${bucket.label}</div>
                        <div class="apex-tt-line"><span class="apex-tt-k">En este rango</span><span class="apex-tt-v">${v} SKUs (${pct}%)</span></div>
                        <div class="apex-tt-line"><span class="apex-tt-k">Acumulado</span><span class="apex-tt-v">${cum} SKUs (${cumPct}%)</span></div>
                        <div class="apex-tt-hint">↳ click to filter by status</div>
                    </div>`;
                },
            },
            states: {
                hover: { filter: { type: 'lighten', value: 0.08 } },
                active: { filter: { type: 'darken', value: 0.15 } },
            },
        };

        this.chartCoverageDist = new ApexCharts(el, options);
        this.chartCoverageDist.render();
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
        el.className = 'np-status-bar'; // nueva clase standalone (era np-sync-status dentro de .np-hint)
        if (kind === 'ok') el.classList.add('sync-ok');
        else if (kind === 'err') el.classList.add('sync-err');
        else if (kind === 'off') el.classList.add('sync-off');
        const icon = { ok: 'fa-cloud-arrow-up', err: 'fa-triangle-exclamation', off: 'fa-cloud-xmark', loading: 'fa-circle-notch fa-spin' }[kind] || 'fa-info-circle';
        el.innerHTML = `<i class="fas ${icon} me-1"></i>${message}`;
    }

    // ---- Upload collapse/expand ----
    collapseUploadSection() {
        const full = document.getElementById('upload-section');
        const bar = document.getElementById('upload-collapsed');
        if (!full || !bar) return;
        full.style.display = 'none';
        bar.style.display = '';
        // Poblar resumen con los nombres de archivos subidos
        const names = [];
        ['amazon', 'cin7', 'stylish'].forEach(type => {
            if (this.files[type]?.name) names.push(this.files[type].name);
        });
        const text = document.getElementById('upload-collapsed-text');
        const time = document.getElementById('upload-collapsed-time');
        if (text) text.textContent = names.length ? names.join(' · ') : 'Files loaded';
        if (time) time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    expandUploadSection() {
        const full = document.getElementById('upload-section');
        const bar = document.getElementById('upload-collapsed');
        if (!full || !bar) return;
        full.style.display = '';
        bar.style.display = 'none';
        full.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ===============================================================
    // Histograma de días sin Prime (distribución en buckets)
    // ===============================================================
    renderNpDaysChart(notPrimeItems) {
        const hasData = notPrimeItems.length > 0 && Object.keys(this.notPrimeDays).length > 0;
        const card = document.getElementById('np-histogram-card');
        const emptyCard = document.getElementById('np-empty-card');
        if (!card) return;
        if (!hasData) {
            if (this.chartNpDays) {
                try { this.chartNpDays.destroy(); } catch (e) {}
                this.chartNpDays = null;
            }
            card.style.display = 'none';
            if (emptyCard) emptyCard.style.display = '';
            return;
        }
        card.style.display = '';
        if (emptyCard) emptyCard.style.display = 'none';

        const t = this.apexTheme();
        const buckets = [
            { label: '0–4',   min: 0,   max: 4,   color: t.palette.accent,    kind: 'new' },
            { label: '5–14',  min: 5,   max: 14,  color: t.palette.healthy,   kind: 'ok' },
            { label: '15–30', min: 15,  max: 30,  color: t.palette.low,       kind: 'warn' },
            { label: '31–60', min: 31,  max: 60,  color: t.palette.oos,       kind: 'bad' },
            { label: '61–120',min: 61,  max: 120, color: t.palette.oos,       kind: 'bad' },
            { label: '120+',  min: 121, max: 99999, color: t.isDark ? '#ff6b64' : '#a40e26', kind: 'bad' },
        ];

        const counts = buckets.map(b => notPrimeItems.filter(i => {
            const d = this.notPrimeDays[i.sku];
            if (d == null) return false;
            return d >= b.min && d <= b.max;
        }).length);
        const categories = buckets.map(b => b.label + ' d');
        const colors = buckets.map(b => b.color);

        // Update in-place
        if (this.chartNpDays) {
            this.chartNpDays.updateOptions({
                series: [{ name: 'SKUs', data: counts }],
                xaxis: { categories },
                colors,
            });
            this.chartNpDays._buckets = buckets;
            return;
        }

        const el = document.getElementById('chart-np-days');
        if (!el) return;

        const options = {
            ...this.apexCommon(),
            series: [{ name: 'SKUs', data: counts }],
            chart: {
                ...this.apexCommon().chart,
                type: 'bar',
                height: 200,
                events: {
                    dataPointSelection: (event, ctx, config) => {
                        const idx = config.dataPointIndex;
                        if (idx == null) return;
                        const bucket = this.chartNpDays?._buckets?.[idx] || buckets[idx];
                        const mdInput = document.getElementById('np-filter-mindays');
                        if (mdInput && bucket) {
                            mdInput.value = bucket.min;
                            this.renderNotPrime();
                        }
                    },
                },
            },
            plotOptions: {
                bar: {
                    horizontal: false,
                    borderRadius: 3,
                    borderRadiusApplication: 'end',
                    columnWidth: '60%',
                    distributed: true,
                },
            },
            grid: {
                ...this.apexCommon().grid,
                padding: { left: 15, right: 15, top: 25, bottom: 5 },
            },
            colors,
            dataLabels: {
                enabled: true,
                offsetY: -18,
                style: {
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '11px',
                    fontWeight: 700,
                    colors: [t.textPrimary],
                },
                formatter: (v) => v > 0 ? v : '',
            },
            legend: { show: false },
            xaxis: {
                categories,
                labels: { style: { colors: t.textSecondary, fontSize: '10px' } },
                axisBorder: { show: false },
                axisTicks: { show: false },
            },
            yaxis: {
                labels: { style: { colors: t.textSecondary, fontSize: '10px' } },
                forceNiceScale: true,
            },
            tooltip: {
                ...this.apexCommon().tooltip,
                custom: ({ dataPointIndex }) => {
                    const v = counts[dataPointIndex];
                    const bucket = buckets[dataPointIndex];
                    return `<div class="apex-tt">
                        <div class="apex-tt-title">${bucket.label} days</div>
                        <div class="apex-tt-body">${v} SKU${v === 1 ? '' : 's'}</div>
                        <div class="apex-tt-hint">↳ click to filter by min days</div>
                    </div>`;
                },
            },
            states: {
                hover: { filter: { type: 'lighten', value: 0.08 } },
                active: { filter: { type: 'darken', value: 0.15 } },
            },
        };

        this.chartNpDays = new ApexCharts(el, options);
        this.chartNpDays.render();
        this.chartNpDays._buckets = buckets;
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
        document.documentElement.setAttribute('data-theme', theme);
        const icon = document.getElementById('theme-icon');
        if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';

        if (this.allData?.length > 0) {
            // ApexCharts puede recrearse limpiamente sin race conditions
            this.destroyAllCharts();
            this.updateDashboard();
            this.renderNotPrime();
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
