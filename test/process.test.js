// Tests de process(): cruce maestro + FBA + reporte Amazon.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const ctx = { document: { addEventListener() {} }, window: {}, console };
vm.createContext(ctx);
const FbaAnalyzer = vm.runInContext(src + '\n;FbaAnalyzer;', ctx);

// Instancia sin constructor (el constructor toca el DOM).
function makeApp({ amazonRows }) {
    const app = Object.create(FbaAnalyzer.prototype);
    app.isAmazonUSA = true;
    app.config = {
        info: [
            { 'SKU': 'P-201', 'Category': 'PORCELAIN SINK', 'Pack Density': '28' },
            { 'SKU': 'P-202', 'Category': 'PORCELAIN SINK', 'Pack Density': '28' },
            { 'SKU': 'K-100', 'Category': 'FAUCET', 'Pack Density': '12' },
        ],
        fbaUSA: [['P-201', 'Yes'], ['P-202', 'Yes']],
        fbaCA: [],
        skuMapCA: [],
    };
    const headers = ['merchant sku', 'units sold last 30 days', 'total units', 'inbound', 'available'];
    app.parsed = {
        amazon: { headers, rows: amazonRows },
        cin7: { headers: [], rows: [] },
        stylish: { headers: [], rows: [] },
    };
    return app;
}

const amzRow = (sku, sold, total, inbound, avail) => ({
    'merchant sku': sku, 'units sold last 30 days': String(sold), 'total units': String(total), 'inbound': String(inbound), 'available': String(avail),
});

test('FBA=YES presente en Amazon sale normal, sin marca', () => {
    const app = makeApp({ amazonRows: [amzRow('P-201', 3, 10, 2, 8), amzRow('P-202', 0, 0, 0, 0)] });
    const { data } = app.process(() => {});
    const p201 = data.find(d => d.sku === 'P-201');
    assert.equal(p201.units_sold, 3);
    assert.equal(p201.inventory_amazon, 10);
    assert.equal(p201.not_in_amazon, false);
});

test('FBA=YES ausente del reporte Amazon entra con ceros y marcado', () => {
    const app = makeApp({ amazonRows: [amzRow('P-201', 3, 10, 2, 8)] }); // P-202 no viene
    const { data, meta } = app.process(() => {});
    const p202 = data.find(d => d.sku === 'P-202');
    assert.ok(p202, 'P-202 debe estar en el output');
    assert.equal(p202.fba, 'Yes');
    assert.equal(p202.units_sold, 0);
    assert.equal(p202.inventory_amazon, 0);
    assert.equal(p202.inventory_amazon_available, 0);
    assert.equal(p202.inventory_amazon_inbound, 0);
    assert.equal(p202.category, 'PORCELAIN SINK');
    assert.equal(p202.not_in_amazon, true);
    assert.equal(meta.fba_yes_not_in_amazon, 1);
});

test('SKU no-FBA ausente del reporte Amazon sigue excluido', () => {
    const app = makeApp({ amazonRows: [amzRow('P-201', 3, 10, 2, 8)] });
    const { data } = app.process(() => {});
    assert.equal(data.find(d => d.sku === 'K-100'), undefined);
});

test('FBA=YES ausente recibe mínimo 2 y clasifica como OOS / Not Prime', () => {
    const app = makeApp({ amazonRows: [amzRow('P-201', 3, 10, 2, 8)] });
    const { data } = app.process(() => {});
    const p202 = data.find(d => d.sku === 'P-202');
    const r = FbaAnalyzer.computeReplenishment(p202, 45);
    assert.equal(r.qty_to_send, 2);
    assert.equal(app.classify({ ...p202, ...r }), 'oos');
});
