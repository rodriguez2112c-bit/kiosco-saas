import test from "node:test";
import assert from "node:assert/strict";
import { asignarFEFO, partidasFiado, calcularArqueo, precioLiquidacion, uuidv7, saldoCliente } from "./index.ts";

const L = (id: string, rest: number, venc: string | null, ing: string, costo = 100) =>
  ({ id, restante_cache: rest, fecha_vencimiento: venc, fecha_ingreso: ing, costo_unitario: costo });

test("FEFO consume primero el lote que vence antes y reparte", () => {
  const r = asignarFEFO([L("b", 5, "2026-12-01", "2026-10-01"), L("a", 3, "2026-11-20", "2026-10-05")], 6);
  assert.deepEqual(r.map((x) => [x.lote_id, x.cantidad]), [["a", 3], ["b", 3]]);
});
test("FEFO sin stock suficiente deja remanente sin lote", () => {
  const r = asignarFEFO([L("a", 1, null, "2026-10-01", 50)], 3);
  assert.deepEqual(r.map((x) => [x.lote_id, x.cantidad, x.costo_unitario]), [["a", 1, 50], [null, 2, 50]]);
});
test("partidas FIFO: pago parcial", () => {
  const m = (id: string, tipo: "cargo" | "pago", monto: number, f: string) =>
    ({ id, cliente_id: "c", tipo, monto, medio_pago: null, venta_id: id, caja_sesion_id: null, creado_cliente_at: f });
  const p = partidasFiado([m("1", "cargo", 1000, "2026-11-01"), m("2", "cargo", 500, "2026-11-02"), m("3", "pago", 1200, "2026-11-03")]);
  assert.deepEqual(p.map((x) => x.estado), ["Pagado", "Parcial"]);
  assert.equal(saldoCliente([{ tipo: "cargo", monto: 1500 }, { tipo: "pago", monto: 1200 }]), 300);
});
test("arqueo", () => {
  const r = calcularArqueo({ monto_inicial: 5000, ventas_efectivo: 20000, pagos_fiado_efectivo: 1000, ingresos: 0, egresos: 2000, contado: 23900 });
  assert.equal(r.teorico, 24000); assert.equal(r.diferencia, -100);
});
test("liquidación y uuidv7", () => {
  const hoy = new Date(2026, 10, 9);
  assert.equal(precioLiquidacion(1000, "2026-11-20", 20, 15, hoy).precio, 800);
  assert.equal(precioLiquidacion(1000, "2027-01-01", 20, 15, hoy).precio, 1000);
  assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
