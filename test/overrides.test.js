// Tests de applyOverrides(): SKUs discontinuados y pack density editado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const ctx = { document: { addEventListener() {} }, window: {}, console };
vm.createContext(ctx);
const FbaAnalyzer = vm.runInContext(src + '\n;FbaAnalyzer;', ctx);

const rows = () => [
    { sku: 'P-201', fba: 'Yes', category: 'PORCELAIN SINK', units_sold: 3, inventory_amazon: 0, pack_density: 28 },
    { sku: 'S-401', fba: 'Yes', category: 'ASSY SINK', units_sold: 22, inventory_amazon: 0, pack_density: 14 },
    { sku: 'K-100', fba: 'Pending', category: 'FAUCET', units_sold: 1, inventory_amazon: 5, pack_density: 0 },
];

test('sin overrides no cambia nada', () => {
    const input = rows();
    const out = FbaAnalyzer.applyOverrides(input, {});
    assert.deepEqual(out.map(r => r.sku), ['P-201', 'S-401', 'K-100']);
    assert.equal(out[1], input[1]);
});

test('SKU discontinuado no aparece en el resultado', () => {
    const out = FbaAnalyzer.applyOverrides(rows(), { 'P-201': { discontinued: true, pack_density: null } });
    assert.deepEqual(out.map(r => r.sku), ['S-401', 'K-100']);
});

test('pack density editado reemplaza al maestro sin mutar la fila original', () => {
    const input = rows();
    const out = FbaAnalyzer.applyOverrides(input, { 'S-401': { discontinued: false, pack_density: 12 } });
    const s401 = out.find(r => r.sku === 'S-401');
    assert.equal(s401.pack_density, 12);
    assert.equal(s401.pack_density_master, 14);
    assert.equal(input[1].pack_density, 14);
    assert.equal(out.find(r => r.sku === 'P-201').pack_density_master, undefined);
});

test('pack density editado cambia los pallets', () => {
    // 22 a enviar: 22/14 = 1.57 -> 1 pallet; 22/12 = 1.83 -> 2 pallets
    const [master] = FbaAnalyzer.applyOverrides([rows()[1]], {});
    const [custom] = FbaAnalyzer.applyOverrides([rows()[1]], { 'S-401': { pack_density: 12 } });
    assert.equal(FbaAnalyzer.computeReplenishment(master, 30).qty_pallets, 1);
    assert.equal(FbaAnalyzer.computeReplenishment(custom, 30).qty_pallets, 2);
});
