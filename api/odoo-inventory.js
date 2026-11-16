// api/odoo-inventory.js
// ============================================================
// Función serverless de Vercel: inventario de Odoo por marketplace.
//
//   GET /api/odoo-inventory?mp=ca   → almacén CBG
//   GET /api/odoo-inventory?mp=usa  → almacén ATL
//
// Devuelve la columna "Available for Use" del reporte de Odoo
// Inventory → Reporting → Calculated Inventory, filtrado por almacén
// (mismo contexto `warehouse_id` que aplica el panel de almacenes del
// reporte), solo para los SKUs de data/info.csv:
//
//   { marketplace, warehouse, fetched_at, count, stock: { SKU: qty } }
//
// Las credenciales viven en las env vars de Vercel (ODOO_URL, ODOO_DB,
// ODOO_USER, ODOO_API_KEY) y nunca llegan al browser. Solo hace lecturas.
// ============================================================

const fs = require('fs');
const path = require('path');

// Almacén de Odoo (stock.warehouse.code) por marketplace.
const WAREHOUSE = { ca: 'CBG', usa: 'ATL' };
const ODOO_TIMEOUT_MS = 25000;

// Mismo criterio que FbaAnalyzer.normalizeSku en js/app.js.
function normalizeSku(s) {
    if (s == null) return '';
    return String(s).replace(/[ ​‌‍]/g, '').trim().toUpperCase();
}

// SKUs del maestro (data/info.csv): lo único que se consulta y se expone.
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

async function fetchInventory(marketplace, env = process.env) {
    const { ODOO_URL: url, ODOO_DB: db, ODOO_USER: user, ODOO_API_KEY: key } = env;
    const code = WAREHOUSE[marketplace];

    const uid = await odooRpc(url, 'common', 'authenticate', [db, user, key, {}]);
    if (!uid) throw new Error('Odoo rechazó las credenciales (revisar ODOO_USER / ODOO_API_KEY)');
    const call = (model, method, args, kwargs = {}) =>
        odooRpc(url, 'object', 'execute_kw', [db, uid, key, model, method, args, kwargs]);

    const warehouses = await call('stock.warehouse', 'search_read', [[['code', '=', code]]], { fields: ['code'], limit: 1 });
    if (!warehouses.length) throw new Error(`Odoo no tiene un almacén con código ${code}`);

    const products = await call('product.product', 'search_read', [[['default_code', 'in', masterSkus()]]], {
        fields: ['default_code', 'available_for_use'],
        context: { is_production_capacity_report: true, warehouse_id: warehouses[0].id },
    });

    const stock = {};
    for (const p of products) {
        const sku = normalizeSku(p.default_code);
        if (sku) stock[sku] = (stock[sku] || 0) + toQty(p.available_for_use);
    }
    return {
        marketplace,
        warehouse: code,
        fetched_at: new Date().toISOString(),
        count: Object.keys(stock).length,
        stock,
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
module.exports.WAREHOUSE = WAREHOUSE;
