// Tests de api/odoo-inventory.js con un Odoo simulado (sin red).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/odoo-inventory.js');

const ENV = { ODOO_URL: 'https://odoo.test/', ODOO_DB: 'db', ODOO_USER: 'user', ODOO_API_KEY: 'key' };
const realFetch = global.fetch;
const realError = console.error;

beforeEach(() => { Object.assign(process.env, ENV); console.error = () => {}; });
afterEach(() => {
    global.fetch = realFetch;
    console.error = realError;
    Object.keys(ENV).forEach(k => delete process.env[k]);
});

// Responde según el servicio/modelo pedido y registra cada llamada JSON-RPC.
function mockOdoo({ uid = 7, warehouses = [{ id: 3, code: 'CBG' }], products = [], error = null } = {}) {
    const calls = [];
    global.fetch = async (url, opts) => {
        const { params } = JSON.parse(opts.body);
        calls.push({ url, ...params });
        if (error) return { ok: true, status: 200, json: async () => ({ error }) };
        let result = uid;
        if (params.service === 'object') result = params.args[3] === 'stock.warehouse' ? warehouses : products;
        return { ok: true, status: 200, json: async () => ({ result }) };
    };
    return calls;
}

async function invoke(query, method = 'GET') {
    const res = {
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(c) { this.code = c; return this; },
        json(b) { this.body = b; return this; },
    };
    await handler({ method, query }, res);
    return res;
}

test('mp inválido → 400, método distinto de GET → 405', async () => {
    mockOdoo();
    assert.equal((await invoke({ mp: 'mx' })).code, 400);
    assert.equal((await invoke({})).code, 400);
    assert.equal((await invoke({ mp: 'ca' }, 'POST')).code, 405);
});

test('sin env vars → 503 sin llamar a Odoo', async () => {
    const calls = mockOdoo();
    delete process.env.ODOO_API_KEY;
    const res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 503);
    assert.match(res.body.error, /ODOO_API_KEY/);
    assert.equal(calls.length, 0);
});

test('ca → almacén CBG, Available for Use con contexto warehouse_id, solo SKUs del maestro', async () => {
    const calls = mockOdoo({
        warehouses: [{ id: 3, code: 'CBG' }],
        products: [
            { default_code: ' s-401 ', available_for_use: 72.0 },
            { default_code: 'S-401', available_for_use: 1.9 },
            { default_code: 'S-832WN', available_for_use: -3 },
        ],
    });
    const res = await invoke({ mp: 'CA' });
    assert.equal(res.code, 200);
    assert.equal(res.body.warehouse, 'CBG');
    // mismo SKU en dos productos se suma; decimales hacia abajo; negativos a 0
    assert.deepEqual(res.body.stock, { 'S-401': 73, 'S-832WN': 0 });
    assert.equal(res.body.count, 2);
    assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=60');

    assert.equal(calls[0].url, 'https://odoo.test/jsonrpc');
    assert.equal(calls[0].method, 'authenticate');
    const [, , , whModel, , whArgs] = calls[1].args;
    assert.equal(whModel, 'stock.warehouse');
    assert.deepEqual(whArgs, [[['code', '=', 'CBG']]]);
    const [, uid, , model, method, args, kwargs] = calls[2].args;
    assert.equal(uid, 7);
    assert.equal(model, 'product.product');
    assert.equal(method, 'search_read');
    assert.deepEqual(kwargs.fields, ['default_code', 'available_for_use']);
    assert.deepEqual(kwargs.context, { is_production_capacity_report: true, warehouse_id: 3 });
    const [[field, op, skus]] = args[0];
    assert.deepEqual([field, op], ['default_code', 'in']);
    assert.ok(skus.includes('S-401') && skus.length > 300, 'el dominio usa los SKUs de data/info.csv');
});

test('usa → almacén ATL', async () => {
    const calls = mockOdoo({ warehouses: [{ id: 12, code: 'ATL' }], products: [{ default_code: 'S-401', available_for_use: 111 }] });
    const res = await invoke({ mp: 'usa' });
    assert.equal(res.body.warehouse, 'ATL');
    assert.deepEqual(calls[1].args[5], [[['code', '=', 'ATL']]]);
    assert.equal(calls[2].args[6].context.warehouse_id, 12);
    assert.equal(res.body.stock['S-401'], 111);
});

test('credenciales rechazadas, almacén inexistente o error de Odoo → 502 sin caché', async () => {
    mockOdoo({ uid: false });
    let res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 502);
    assert.match(res.body.error, /credenciales/);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    mockOdoo({ warehouses: [] });
    res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 502);
    assert.match(res.body.error, /CBG/);

    mockOdoo({ error: { message: 'Odoo Server Error', data: { message: 'Access Denied' } } });
    res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 502);
    assert.equal(res.body.error, 'Access Denied');
});
