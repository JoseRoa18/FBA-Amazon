// Tests de la regla de reposición (target / qty_to_send / pallets / método).
// Carga js/app.js en Node con un stub mínimo del DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const ctx = { document: { addEventListener() {} }, window: {}, console };
vm.createContext(ctx);
const FbaAnalyzer = vm.runInContext(src + '\n;FbaAnalyzer;', ctx);

const item = (o) => ({ fba: 'Yes', category: 'PORCELAIN SINK', units_sold: 0, inventory_amazon: 0, pack_density: 28, ...o });

test('FBA=YES sin ventas ni stock: target mínimo 2, enviar 2', () => {
    const r = FbaAnalyzer.computeReplenishment(item({}), 45);
    assert.equal(r.target, 2);
    assert.equal(r.qty_to_send, 2);
});

test('FBA=YES sin ventas con 1 en Amazon: enviar 1', () => {
    const r = FbaAnalyzer.computeReplenishment(item({ inventory_amazon: 1 }), 45);
    assert.equal(r.target, 2);
    assert.equal(r.qty_to_send, 1);
});

test('FBA=YES sin ventas con 5 en Amazon: no enviar', () => {
    const r = FbaAnalyzer.computeReplenishment(item({ inventory_amazon: 5 }), 45);
    assert.equal(r.qty_to_send, 0);
});

test('FBA=YES con ventas: el mínimo no baja un target mayor', () => {
    const r = FbaAnalyzer.computeReplenishment(item({ units_sold: 30, inventory_amazon: 10 }), 45);
    assert.equal(r.target, 45);
    assert.equal(r.qty_to_send, 35);
});

test('FBA=YES con target calculado menor a 2 sube a 2', () => {
    const r = FbaAnalyzer.computeReplenishment(item({ units_sold: 1 }), 30);
    assert.equal(r.target, 2);
});

test('FBA=Pending o No: sin mínimo', () => {
    for (const fba of ['Pending', 'No', '']) {
        const r = FbaAnalyzer.computeReplenishment(item({ fba }), 45);
        assert.equal(r.target, 0, `fba=${fba}`);
        assert.equal(r.qty_to_send, 0, `fba=${fba}`);
    }
});

test('coverage_days: 999 sin ventas, redondeo con ventas', () => {
    assert.equal(FbaAnalyzer.computeReplenishment(item({}), 45).coverage_days, 999);
    assert.equal(FbaAnalyzer.computeReplenishment(item({ units_sold: 30, inventory_amazon: 60 }), 45).coverage_days, 60);
});

test('pallets y método de envío', () => {
    // 2 unidades / pack 28 = 0.07 pallets → 0 → Loose
    assert.equal(FbaAnalyzer.computeReplenishment(item({}), 45).how_to_send, 'Loose');
    // 30 ventas, 45d → target 45, /28 = 1.6 → 1 pallet, sink → Pallet
    const sink = FbaAnalyzer.computeReplenishment(item({ units_sold: 30 }), 45);
    assert.equal(sink.qty_pallets, 1);
    assert.equal(sink.how_to_send, 'Pallet');
    // misma cantidad, categoría no-sink → Carton
    const faucet = FbaAnalyzer.computeReplenishment(item({ units_sold: 30, category: 'FAUCET' }), 45);
    assert.equal(faucet.how_to_send, 'Carton');
    // 0.75 de pallet redondea hacia arriba (umbral 0.70)
    const up = FbaAnalyzer.computeReplenishment(item({ units_sold: 21, pack_density: 28 }), 30); // 21/28 = 0.75
    assert.equal(up.qty_pallets, 1);
});
