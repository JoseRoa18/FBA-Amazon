// Tests de api/odoo-inventory.js con un Odoo simulado (sin red).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/odoo-inventory.js');
const { capacity, etaByProduct, localDate } = handler;

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
// `fail` es un modelo cuyas llamadas devuelven error (o true para todas).
function mockOdoo({ uid = 7, warehouses = [{ id: 3, code: 'CBG' }], products = [], moves = [], lines = [], archived = [], fail = null } = {}) {
    const calls = [];
    global.fetch = async (url, opts) => {
        const { params } = JSON.parse(opts.body);
        const [, , , model, method] = params.args;
        calls.push({ url, service: params.service, rpc: params.method, model, method, args: params.args });
        if (fail === true || (fail && fail === model)) {
            return { ok: true, status: 200, json: async () => ({ error: { message: 'Odoo Server Error', data: { message: 'Access Denied' } } }) };
        }
        let result = uid;
        if (params.service === 'object') {
            result = { 'stock.warehouse': warehouses, 'stock.move': moves, 'mrp.bom.line': lines }[model]
                ?? (method === 'read' ? archived : products);
        }
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

const product = (id, default_code, free_qty, available_for_use = free_qty, capacity_bom_type = 'no_bom', bom = false) =>
    ({ id, default_code, free_qty, available_for_use, capacity_bom_type, capacity_bom_id: bom ? [bom, default_code] : false });
const line = (bom, productId, product_qty = 1) => ({ bom_id: [bom, ''], product_id: [productId, ''], product_qty });
const move = (productId, qty, date) => ({ product_id: [productId, ''], product_uom_qty: qty, date });

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
        products: [
            product(1, ' s-401 ', 72, 72.0),
            product(2, 'S-401', 1, 1.9),
            product(3, 'S-832WN', -3, -3),
            product(4, 'A401', 64),            // componente: no está en data/info.csv
            product(5, false, 9),
        ],
    });
    const res = await invoke({ mp: 'CA' });
    assert.equal(res.code, 200);
    assert.equal(res.body.warehouse, 'CBG');
    // mismo SKU en dos productos se suma; decimales hacia abajo; negativos a 0; fuera del maestro no sale
    assert.deepEqual(res.body.stock, { 'S-401': 73, 'S-832WN': 0 });
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.eta, {});
    assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=60');

    assert.equal(calls[0].url, 'https://odoo.test/jsonrpc');
    assert.equal(calls[0].rpc, 'authenticate');
    assert.equal(calls[1].model, 'stock.warehouse');
    assert.deepEqual(calls[1].args[5], [[['code', '=', 'CBG']]]);
    const prod = calls.find(c => c.model === 'product.product');
    assert.equal(prod.args[1], 7);
    assert.equal(prod.method, 'search_read');
    assert.ok(prod.args[6].fields.includes('available_for_use'));
    assert.deepEqual(prod.args[6].context, { is_production_capacity_report: true, warehouse_id: 3 });
    // tránsito: transferencias internas abiertas que entran al almacén desde afuera
    const mv = calls.find(c => c.model === 'stock.move');
    assert.deepEqual(mv.args[5][0], [
        ['state', 'in', ['waiting', 'confirmed', 'assigned', 'partially_available']],
        ['picking_type_id.code', '=', 'internal'],
        ['location_dest_id.warehouse_id', '=', 3],
        ['location_id.warehouse_id', '!=', 3],
    ]);
    // sin nada en tránsito no hace falta leer los BoM
    assert.equal(calls.some(c => c.model === 'mrp.bom.line'), false);
});

test('usa → almacén ATL', async () => {
    const calls = mockOdoo({ warehouses: [{ id: 12, code: 'ATL' }], products: [product(1, 'S-401', 111)] });
    const res = await invoke({ mp: 'usa' });
    assert.equal(res.body.warehouse, 'ATL');
    assert.deepEqual(calls[1].args[5], [[['code', '=', 'ATL']]]);
    assert.equal(calls.find(c => c.model === 'product.product').args[6].context.warehouse_id, 12);
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

    mockOdoo({ fail: true });
    res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 502);
    assert.equal(res.body.error, 'Access Denied');
});

test('ETA: SKU armado toma la fecha en que llegan sus componentes; SKU sin BoM, su propia llegada', async () => {
    mockOdoo({
        products: [
            product(1, 'S-401', 8, 72, 'manufacture', 10),   // 8 terminados + 64 armables
            product(2, 'A401', 64),
            product(3, 'BX-401', 70),
            product(4, 'L401', 0),                            // etiqueta: no limita
            product(5, 'S-300XG', 2),
            product(6, 'S-832WN', 25),                        // nada en camino
        ],
        lines: [line(10, 2), line(10, 3), line(10, 4)],
        moves: [
            move(3, 100, '2026-11-10 15:00:00'),              // cajas llegan antes: no alcanza, el tazón limita
            move(2, 172, '2026-11-22 18:29:04'),
            move(5, 11, '2026-12-31 18:09:30'),
        ],
    });
    const res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 200);
    // el 22-nov: min(64+172, 70+100) = 170 armables → +106 sobre los 64 de hoy
    assert.deepEqual(res.body.eta, {
        'S-401': { date: '2026-11-22', qty: 106 },
        'S-300XG': { date: '2026-12-31', qty: 11 },
    });
    assert.equal(res.body.stock['S-401'], 72);
});

test('ETA: no se informa si el modelo no reproduce el Available for Use de Odoo', async () => {
    mockOdoo({
        products: [product(1, 'S-401', 8, 99, 'manufacture', 10), product(2, 'A401', 64)],   // Odoo dice 99, el modelo 72
        lines: [line(10, 2)],
        moves: [move(2, 172, '2026-11-22 18:29:04')],
    });
    const res = await invoke({ mp: 'ca' });
    assert.deepEqual(res.body.eta, {});
    assert.equal(res.body.stock['S-401'], 99);
});

test('ETA: componente archivado se lee aparte y cuenta en el BoM', async () => {
    const calls = mockOdoo({
        products: [product(1, 'S-401', 0, 5, 'manufacture', 10), product(2, 'A401', 64)],
        archived: [product(9, 'BX-401', 5)],                  // no viene en la búsqueda de activos
        lines: [line(10, 2), line(10, 9)],
        moves: [move(2, 100, '2026-11-22 18:29:04')],         // llegan tazones, pero limitan las cajas
    });
    const res = await invoke({ mp: 'ca' });
    assert.deepEqual(calls.find(c => c.method === 'read').args[5], [[9]]);
    assert.deepEqual(res.body.eta, {});
});

test('ETA: si su cálculo falla, el stock se devuelve igual', async () => {
    mockOdoo({
        products: [product(1, 'S-401', 8, 72, 'manufacture', 10), product(2, 'A401', 64)],
        moves: [move(2, 172, '2026-11-22 18:29:04')],
        fail: 'mrp.bom.line',
    });
    const res = await invoke({ mp: 'ca' });
    assert.equal(res.code, 200);
    assert.equal(res.body.stock['S-401'], 72);
    assert.deepEqual(res.body.eta, {});
    assert.equal(res.body.eta_error, 'Access Denied');
});

test('capacity: tipos de BoM como en el reporte de Odoo', () => {
    const P = Object.fromEntries([
        product(1, 'S-601W', 24, 0, 'manufacture', 10),       // A-919KIT + etiqueta + S-601
        product(2, 'A-919KIT', 101),
        product(3, 'L601W', 0),
        product(4, 'S-601', 12),
        product(5, 'D-700B', 199),
        product(6, 'D-700B2', 0, 0, 'kit_split', 20),         // 1 kit = 2 × D-700B
        product(7, 'D-702H', 21),
        product(8, 'D-702H-2', 0, 0, 'kit_bottleneck', 30),   // D-702H en dos líneas
        product(9, 'S-01N', 48),
        product(10, 'K131NS01N', 0, 0, 'kit_bottleneck', 40), // K-131N + S-01N
        product(11, 'K-131N', 88),
        product(12, 'A-02', -5),
    ].map(p => [p.id, p]));
    const L = { 10: [line(10, 2), line(10, 3), line(10, 4)], 20: [line(20, 5, 2)], 30: [line(30, 7), line(30, 7)], 40: [line(40, 11), line(40, 9)] };
    const free = Object.fromEntries(Object.values(P).map(p => [p.id, p.free_qty]));
    const r = capacity(P, L, free);
    assert.deepEqual(r[1], { F: 24, B: 12, afu: 36 });   // la etiqueta en 0 no limita
    assert.deepEqual(r[6], { F: 99, B: 0, afu: 99 });    // 199 ÷ 2
    assert.deepEqual(r[8], { F: 10, B: 0, afu: 10 });    // 21 ÷ (1+1)
    assert.deepEqual(r[10], { F: 48, B: 0, afu: 48 });   // min(88, 48)
    assert.deepEqual(r[12], { F: 0, B: 0, afu: 0 });     // libre negativo → 0
});

test('etaByProduct: primera fecha en que sube el disponible, acumulando llegadas', () => {
    const P = { 1: product(1, 'KIT', 0, 0, 'manufacture', 10), 2: product(2, 'A', 0), 3: product(3, 'B', 0) };
    const L = { 10: [line(10, 2), line(10, 3)] };
    const { now, eta } = etaByProduct(P, L, { 1: 0, 2: 0, 3: 0 }, [
        { id: 2, qty: 50, date: '2026-11-22' },   // llega A, falta B: todavía no se puede armar
        { id: 3, qty: 30, date: '2026-12-31' },   // llega B: ahora sí, 30
    ]);
    assert.equal(now[1].afu, 0);
    assert.deepEqual(eta[1], { date: '2026-12-31', qty: 30 });
    assert.deepEqual(eta[2], { date: '2026-11-22', qty: 50 });
});

test('localDate: la Scheduled Date (UTC) se pasa a fecha local del almacén', () => {
    assert.equal(localDate('2026-11-22 18:29:04'), '2026-11-22');
    assert.equal(localDate('2026-12-01 03:30:00'), '2026-11-30');   // 22:30 del día anterior en el Este
});
