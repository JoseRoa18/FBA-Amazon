// api/odoo-inventory.js
// ============================================================
// Función serverless de Vercel: inventario de Odoo por marketplace.
//
//   GET /api/odoo-inventory?mp=ca   → almacén CBG
//   GET /api/odoo-inventory?mp=usa  → almacén ATL
//
// stock: columna "Available for Use" del reporte de Odoo
//   Inventory → Reporting → Calculated Inventory, filtrado por almacén
//   (mismo contexto `warehouse_id` que aplica el panel de almacenes del
//   reporte).
// eta:   próxima llegada al almacén. Los contenedores en tránsito son
//   transferencias internas abiertas hacia el almacén (Scheduled Date =
//   llegada) y traen sobre todo componentes, así que el ETA de un SKU es
//   la primera fecha en que su Available for Use aumenta (ver "Modelo de
//   capacidad" abajo).
//
// Solo se exponen los SKUs de data/info.csv:
//
//   { marketplace, warehouse, fetched_at, count,
//     stock: { SKU: qty }, eta: { SKU: { date: 'YYYY-MM-DD', qty } } }
//
// Las credenciales viven en las env vars de Vercel (ODOO_URL, ODOO_DB,
// ODOO_USER, ODOO_API_KEY) y nunca llegan al browser. Solo hace lecturas.
// ============================================================

const fs = require('fs');
const path = require('path');

// Almacén de Odoo (stock.warehouse.code) por marketplace.
const WAREHOUSE = { ca: 'CBG', usa: 'ATL' };
const ODOO_TIMEOUT_MS = 25000;
const OPEN_MOVE_STATES = ['waiting', 'confirmed', 'assigned', 'partially_available'];
const CAPACITY_FIELDS = ['default_code', 'available_for_use', 'free_qty', 'capacity_bom_id', 'capacity_bom_type'];
// CBG (Cambridge, ON) y ATL (Atlanta) están en hora del Este.
const WAREHOUSE_TZ = 'America/Toronto';

// Mismo criterio que FbaAnalyzer.normalizeSku en js/app.js.
function normalizeSku(s) {
    if (s == null) return '';
    return String(s).replace(/[ ​‌‍]/g, '').trim().toUpperCase();
}

// SKUs del maestro (data/info.csv): lo único que se expone.
function masterSkus() {
    const text = fs.readFileSync(path.join(__dirname, '..', 'data', 'info.csv'), 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const header = (lines[0] || '').split(',').map(h => h.trim().toLowerCase());
    let col = header.findIndex(h => h === 'product sku' || h === 'sku');
    if (col < 0) col = 0;
    return [...new Set(lines.slice(1).map(l => normalizeSku(l.split(',')[col])).filter(Boolean))];
}

async function odooRpc(url, service, method, args) {
    const resp = await fetch(url.replace(/\/+$/, '') + '/jsonrpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
        signal: AbortSignal.timeout(ODOO_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Odoo respondió HTTP ${resp.status}`);
    const body = await resp.json();
    if (body.error) throw new Error(body.error.data?.message || body.error.message || 'Error de Odoo');
    return body.result;
}

// Odoo devuelve float y puede dar negativos si hay más reservado que stock.
function toQty(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Fecha local del almacén a partir de un datetime UTC de Odoo ('YYYY-MM-DD HH:MM:SS').
function localDate(utc) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: WAREHOUSE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(String(utc).replace(' ', 'T') + 'Z'));
}

// ============================================================
// Modelo de capacidad — réplica del cálculo del reporte Calculated
// Inventory (módulo replenishment_report), validada contra Odoo:
//   Available for Use = terminado libre (F) + armable (B)
//   no_bom          F = stock libre                       B = 0
//   manufacture     F = stock libre                       B = min(libre del componente ÷ qty)
//                   (los componentes "L…" —etiquetas— no cuentan)
//   kit_split       F = F del componente ÷ qty            B = B del componente ÷ qty
//   kit_bottleneck  F = min(F de cada componente ÷ qty)   B = min(B de cada componente ÷ qty)
// Sirve para simular qué pasa con el Available for Use cuando llega un
// contenedor; el stock que se reporta es siempre el número de Odoo.
// ============================================================
const isLabel = p => /^L/i.test(p.default_code || '');

// products: { id: producto } · linesByBom: { bomId: [líneas] } · free: { id: stock libre }
function capacity(products, linesByBom, free) {
    const memo = {};
    const components = (p) => {
        const qty = new Map();   // el mismo componente puede venir en varias líneas
        for (const l of linesByBom[p.capacity_bom_id?.[0]] || []) qty.set(l.product_id[0], (qty.get(l.product_id[0]) || 0) + l.product_qty);
        return [...qty].map(([id, q]) => ({ c: products[id], q })).filter(x => x.c && x.q > 0);
    };
    const calc = (p) => {
        if (memo[p.id]) return memo[p.id];
        memo[p.id] = { F: 0, B: 0, afu: 0 };   // corta ciclos de BoM
        const cs = components(p);
        let F = toQty(free[p.id]), B = 0;
        if (p.capacity_bom_type === 'manufacture') {
            const used = cs.filter(({ c }) => !isLabel(c));
            B = used.length ? Math.min(...used.map(({ c, q }) => Math.floor(toQty(free[c.id]) / q))) : 0;
        } else if (p.capacity_bom_type === 'kit_split' && cs.length) {
            const r = calc(cs[0].c);
            F = Math.floor(r.F / cs[0].q);
            B = Math.floor(r.B / cs[0].q);
        } else if (p.capacity_bom_type === 'kit_bottleneck' && cs.length) {
            const rs = cs.map(({ c, q }) => ({ r: calc(c), q }));
            F = Math.min(...rs.map(({ r, q }) => Math.floor(r.F / q)));
            B = Math.min(...rs.map(({ r, q }) => Math.floor(r.B / q)));
        }
        return (memo[p.id] = { F, B, afu: F + B });
    };
    const out = {};
    for (const p of Object.values(products)) out[p.id] = calc(p);
    return out;
}

// arrivals: [{ id, qty, date: 'YYYY-MM-DD' }]. Devuelve la capacidad de hoy y, por producto,
// la primera fecha en que el Available for Use supera al de hoy (y cuánto sube ese día).
function etaByProduct(products, linesByBom, free, arrivals) {
    const now = capacity(products, linesByBom, free);
    const eta = {};
    const acc = { ...free };
    for (const date of [...new Set(arrivals.map(a => a.date))].sort()) {
        for (const a of arrivals) if (a.date === date) acc[a.id] = (acc[a.id] ?? 0) + a.qty;
        const then = capacity(products, linesByBom, acc);
        for (const id of Object.keys(products)) {
            if (!eta[id] && then[id].afu > now[id].afu) eta[id] = { date, qty: then[id].afu - now[id].afu };
        }
    }
    return { now, eta };
}

async function computeEta(call, context, all, moves, master) {
    if (!moves.length) return {};
    const products = Object.fromEntries(all.map(p => [p.id, p]));
    const bomIds = [...new Set(all.map(p => p.capacity_bom_id?.[0]).filter(Boolean))];
    const lines = bomIds.length
        ? await call('mrp.bom.line', 'search_read', [[['bom_id', 'in', bomIds]]], { fields: ['bom_id', 'product_id', 'product_qty'] })
        : [];
    // Componentes archivados: no vienen en la búsqueda pero siguen en el BoM.
    const missing = [...new Set(lines.map(l => l.product_id[0]).filter(id => !products[id]))];
    if (missing.length) {
        (await call('product.product', 'read', [missing], { fields: CAPACITY_FIELDS, context })).forEach(p => { products[p.id] = p; });
    }
    const linesByBom = {};
    for (const l of lines) (linesByBom[l.bom_id[0]] = linesByBom[l.bom_id[0]] || []).push(l);
    const free = Object.fromEntries(Object.values(products).map(p => [p.id, p.free_qty]));
    const arrivals = moves
        .filter(m => products[m.product_id[0]])
        .map(m => ({ id: m.product_id[0], qty: m.product_uom_qty, date: localDate(m.date) }));

    const { now, eta } = etaByProduct(products, linesByBom, free, arrivals);
    const out = {};
    for (const p of all) {
        const sku = normalizeSku(p.default_code);
        if (!master.has(sku) || !eta[p.id]) continue;
        // Solo se informa ETA si el modelo reproduce el Available for Use de hoy de Odoo.
        if (now[p.id].afu !== toQty(p.available_for_use)) continue;
        if (!out[sku] || eta[p.id].date < out[sku].date) out[sku] = eta[p.id];
    }
    return out;
}

async function fetchInventory(marketplace, env = process.env) {
    const { ODOO_URL: url, ODOO_DB: db, ODOO_USER: user, ODOO_API_KEY: key } = env;
    const code = WAREHOUSE[marketplace];

    const uid = await odooRpc(url, 'common', 'authenticate', [db, user, key, {}]);
    if (!uid) throw new Error('Odoo rechazó las credenciales (revisar ODOO_USER / ODOO_API_KEY)');
    const call = (model, method, args, kwargs = {}) =>
        odooRpc(url, 'object', 'execute_kw', [db, uid, key, model, method, args, kwargs]);

    const warehouses = await call('stock.warehouse', 'search_read', [[['code', '=', code]]], { fields: ['code'], limit: 1 });
    if (!warehouses.length) throw new Error(`Odoo no tiene un almacén con código ${code}`);
    const warehouseId = warehouses[0].id;
    const context = { is_production_capacity_report: true, warehouse_id: warehouseId };

    // Todo el catálogo (hace falta para seguir los BoM) + lo que viene en tránsito al almacén.
    const [all, moves] = await Promise.all([
        call('product.product', 'search_read', [[]], { fields: CAPACITY_FIELDS, context }),
        call('stock.move', 'search_read', [[
            ['state', 'in', OPEN_MOVE_STATES],
            ['picking_type_id.code', '=', 'internal'],
            ['location_dest_id.warehouse_id', '=', warehouseId],
            ['location_id.warehouse_id', '!=', warehouseId],
        ]], { fields: ['product_id', 'product_uom_qty', 'date'] }),
    ]);

    const master = new Set(masterSkus());
    const stock = {};
    for (const p of all) {
        const sku = normalizeSku(p.default_code);
        if (master.has(sku)) stock[sku] = (stock[sku] || 0) + toQty(p.available_for_use);
    }

    // El ETA es un extra: si su cálculo falla, el stock igual se devuelve.
    let eta = {}, etaError;
    try {
        eta = await computeEta(call, context, all, moves, master);
    } catch (err) {
        console.error('[odoo-inventory] ETA:', err);
        etaError = err.message;
    }

    return {
        marketplace,
        warehouse: code,
        fetched_at: new Date().toISOString(),
        count: Object.keys(stock).length,
        stock,
        eta,
        ...(etaError ? { eta_error: etaError } : {}),
    };
}

module.exports = async function handler(req, res) {
    // Los errores nunca se cachean; solo la respuesta OK (ver abajo).
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Solo GET' });
    }
    const marketplace = String(req.query?.mp || '').toLowerCase();
    if (!WAREHOUSE[marketplace]) return res.status(400).json({ error: "Parámetro mp inválido: usar 'ca' o 'usa'" });

    const missing = ['ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_API_KEY'].filter(k => !process.env[k]);
    if (missing.length) return res.status(503).json({ error: `Odoo no configurado: faltan ${missing.join(', ')} en las env vars` });

    try {
        const data = await fetchInventory(marketplace);
        // 60s de caché en el CDN de Vercel: el análisis sigue siendo "en vivo" y
        // un refresh repetido (o un abuso del endpoint) no le pega a Odoo cada vez.
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
        return res.status(200).json(data);
    } catch (err) {
        console.error('[odoo-inventory]', err);
        return res.status(502).json({ error: err.name === 'TimeoutError' ? 'Odoo no respondió a tiempo' : err.message });
    }
};

module.exports.fetchInventory = fetchInventory;
module.exports.masterSkus = masterSkus;
module.exports.capacity = capacity;
module.exports.etaByProduct = etaByProduct;
module.exports.localDate = localDate;
module.exports.WAREHOUSE = WAREHOUSE;
