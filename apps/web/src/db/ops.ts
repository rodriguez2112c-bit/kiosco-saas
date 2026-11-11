// Todas las escrituras del negocio: cambian la DB local Y encolan la operación, en UNA transacción.
import { asignarFEFO, calcularArqueo, precioLiquidacion, subtotal, uuidv7 } from "@kiosco/shared";
import type { CajaMov, CajaSesion, Cliente, Lote, MedioPago, MovCC, Producto, TipoOp, Venta, VentaItem, VentaPago } from "@kiosco/shared";
import { aplicarDeltas, db, getMeta, type Deltas } from "./db";
import { solicitarSync } from "../sync/syncManager";

const ahora = () => new Date().toISOString();
const sinDeltas = (): Deltas => ({ stock: [], saldo: [] });
const TODAS = () => db.tables;

async function encolar(tipo: TipoOp, payload: unknown, deltas: Deltas = sinDeltas()) {
  await aplicarDeltas(deltas);
  await db.outbox.add({ op_id: uuidv7(), tipo, payload, deltas, estado: "pendiente", intentos: 0, creado_at: ahora() });
}
async function conSync<T>(fn: () => Promise<T>): Promise<T> {
  const r = await db.transaction("rw", TODAS(), fn);
  solicitarSync();
  return r;
}

// ================= Inventario =================
export const guardarProducto = (p: Omit<Producto, "id" | "stock_cache" | "version" | "deleted_at"> & { id?: string }, eans: string[]) =>
  conSync(async () => {
    const id = p.id ?? uuidv7();
    const ant = await db.productos.get(id);
    await db.productos.put({ ...p, id, stock_cache: ant?.stock_cache ?? 0, version: (ant?.version ?? 0) + 1, deleted_at: null });
    for (const ean of eans) await db.codigos_barras.put({ ean, producto_id: id, deleted_at: null });
    await encolar("producto_upsert", { id, categoria_id: null, nombre: p.nombre, tipo: p.tipo, plu: p.plu || null,
      precio_venta: p.precio_venta, stock_minimo: p.stock_minimo, activo: p.activo, eans });
    return id;
  });

export const crearLote = (l: { producto_id: string; costo_unitario: number; cantidad: number; fecha_vencimiento: string | null }) =>
  conSync(async () => {
    const id = uuidv7();
    const row: Lote = { id, producto_id: l.producto_id, costo_unitario: l.costo_unitario, cantidad_inicial: l.cantidad, restante_cache: l.cantidad,
      fecha_ingreso: ahora().slice(0, 10), fecha_vencimiento: l.fecha_vencimiento || null, deleted_at: null };
    await db.lotes.put(row);
    // el lote ya nace con su restante; el delta solo toca el stock del producto
    await encolar("lote_crear", { id, producto_id: l.producto_id, costo_unitario: l.costo_unitario, cantidad: l.cantidad, fecha_vencimiento: row.fecha_vencimiento },
      { stock: [{ producto_id: l.producto_id, lote_id: null, delta: l.cantidad }], saldo: [] });
  });

export const ajustarStock = (a: { producto_id: string; lote_id: string | null; delta: number; motivo: "ajuste" | "merma"; nota?: string }) =>
  conSync(() => encolar("ajuste_stock", a, { stock: [{ producto_id: a.producto_id, lote_id: a.lote_id, delta: a.delta }], saldo: [] }));

// ================= Clientes y fiados =================
export const guardarCliente = (c: Omit<Cliente, "id" | "saldo_cache" | "deleted_at"> & { id?: string }) =>
  conSync(async () => {
    const id = c.id ?? uuidv7();
    const ant = await db.clientes.get(id);
    await db.clientes.put({ ...c, id, saldo_cache: ant?.saldo_cache ?? 0, deleted_at: null });
    await encolar("cliente_upsert", { id, nombre: c.nombre, apellido: c.apellido, celular: c.celular, direccion: c.direccion, limite_credito: c.limite_credito });
    return id;
  });

export const registrarPago = (p: { cliente_id: string; monto: number; medio_pago: "efectivo" | "transferencia" }) =>
  conSync(async () => {
    const caja = await cajaAbierta();
    const mov: MovCC = { id: uuidv7(), cliente_id: p.cliente_id, tipo: "pago", monto: p.monto, medio_pago: p.medio_pago,
      venta_id: null, caja_sesion_id: caja?.id ?? null, creado_cliente_at: ahora() };
    await db.cuenta_corriente_mov.put(mov);
    await encolar("pago_cliente", { id: mov.id, cliente_id: p.cliente_id, monto: p.monto, medio_pago: p.medio_pago, caja_sesion_id: mov.caja_sesion_id, creado_at: mov.creado_cliente_at },
      { stock: [], saldo: [{ cliente_id: p.cliente_id, delta: -p.monto }] });
  });

// ================= Ventas =================
export interface Linea { producto: Producto; cantidad: number }
export type ItemCotizado = Omit<VentaItem, "venta_id">;

/** Calcula los renglones: FEFO por lote + precio de liquidación automática si el lote vence en ≤15 días. */
export async function cotizar(lineas: Linea[]): Promise<{ items: ItemCotizado[]; total: number }> {
  const cfg = (await getMeta<{ descuento_liquidacion_pct?: number; dias_alerta_vencimiento?: number }>("config")) ?? {};
  const pct = cfg.descuento_liquidacion_pct ?? 20, dias = cfg.dias_alerta_vencimiento ?? 15;
  const items: ItemCotizado[] = [];
  for (const l of lineas) {
    const lotes = await db.lotes.where("producto_id").equals(l.producto.id).filter((x) => !x.deleted_at).toArray();
    for (const a of asignarFEFO(lotes, l.cantidad)) {
      const liq = precioLiquidacion(l.producto.precio_venta, a.fecha_vencimiento, pct, dias);
      items.push({ id: uuidv7(), producto_id: l.producto.id, lote_id: a.lote_id, cantidad: a.cantidad,
        precio_unitario: liq.precio, costo_unitario: a.costo_unitario, descuento: Math.round(liq.descuento * a.cantidad) });
    }
  }
  return { items, total: items.reduce((s, i) => s + subtotal(i.precio_unitario, i.cantidad), 0) };
}

export const crearVenta = (i: { items: ItemCotizado[]; total: number; cliente_id: string | null; pagos: Partial<Record<MedioPago, number>>; usuario_id: string }) =>
  conSync(async () => {
    const caja = await cajaAbierta();
    if (!caja) throw new Error("Abrí la caja antes de vender");
    const pagos = (Object.entries(i.pagos) as [MedioPago, number][]).filter(([, m]) => m > 0);
    if (pagos.reduce((s, [, m]) => s + m, 0) !== i.total) throw new Error("Los pagos no suman el total");
    const fiado = i.pagos.fiado ?? 0;
    if (fiado > 0 && !i.cliente_id) throw new Error("El fiado necesita un cliente");

    const venta: Venta = { id: uuidv7(), caja_sesion_id: caja.id, usuario_id: i.usuario_id, cliente_id: i.cliente_id, total: i.total, estado: "completada", creado_cliente_at: ahora() };
    const items: VentaItem[] = i.items.map((x) => ({ ...x, venta_id: venta.id }));
    const vp: VentaPago[] = pagos.map(([medio, monto]) => ({ id: uuidv7(), venta_id: venta.id, medio, monto }));
    await db.ventas.put(venta); await db.venta_items.bulkPut(items); await db.venta_pagos.bulkPut(vp);

    const deltas: Deltas = { stock: items.map((x) => ({ producto_id: x.producto_id, lote_id: x.lote_id, delta: -x.cantidad })), saldo: [] };
    if (fiado > 0) {
      // id del cargo = id de la venta (el servidor usa el mismo) => el pull no duplica el movimiento
      await db.cuenta_corriente_mov.put({ id: venta.id, cliente_id: i.cliente_id!, tipo: "cargo", monto: fiado, medio_pago: null, venta_id: venta.id, caja_sesion_id: null, creado_cliente_at: venta.creado_cliente_at });
      deltas.saldo.push({ cliente_id: i.cliente_id!, delta: fiado });
    }
    await encolar("venta", { id: venta.id, caja_sesion_id: caja.id, cliente_id: i.cliente_id, total: i.total,
      items: items.map(({ venta_id, ...r }) => r), pagos: vp.map(({ venta_id, ...r }) => r) }, deltas);
    return { venta, items, pagos: vp };
  });

export const anularVenta = (venta_id: string, motivo: string) =>
  conSync(async () => {
    const v = await db.ventas.get(venta_id);
    if (!v || v.estado === "anulada") return;
    const items = await db.venta_items.where("venta_id").equals(venta_id).toArray();
    const pagos = await db.venta_pagos.where("venta_id").equals(venta_id).toArray();
    await db.ventas.update(venta_id, { estado: "anulada" });
    const deltas: Deltas = { stock: items.map((x) => ({ producto_id: x.producto_id, lote_id: x.lote_id, delta: x.cantidad })), saldo: [] };
    const ajuste_id = uuidv7();
    const fiado = pagos.find((p) => p.medio === "fiado");
    if (fiado && v.cliente_id) {
      await db.cuenta_corriente_mov.put({ id: ajuste_id, cliente_id: v.cliente_id, tipo: "ajuste", monto: -fiado.monto, medio_pago: null, venta_id, caja_sesion_id: null, creado_cliente_at: ahora() });
      deltas.saldo.push({ cliente_id: v.cliente_id, delta: -fiado.monto });
    }
    await encolar("anular_venta", { venta_id, motivo, ajuste_id }, deltas);
  });

// ================= Caja =================
export const cajaAbierta = () => db.caja_sesiones.filter((c) => !c.cerrada_at).first();

export const abrirCaja = (monto_inicial: number, usuario_id: string) =>
  conSync(async () => {
    if (await cajaAbierta()) throw new Error("Ya hay una caja abierta");
    const c: CajaSesion = { id: uuidv7(), usuario_id, monto_inicial, abierta_at: ahora(), cerrada_at: null, monto_contado_real: null, monto_teorico: null, diferencia: null };
    await db.caja_sesiones.put(c);
    await encolar("caja_abrir", { id: c.id, monto_inicial, abierta_at: c.abierta_at });
  });

export const movimientoCaja = (caja_sesion_id: string, tipo: "ingreso" | "egreso", monto: number, concepto: string) =>
  conSync(async () => {
    const m: CajaMov = { id: uuidv7(), caja_sesion_id, tipo, monto, concepto, creado_at: ahora() };
    await db.caja_movimientos.put(m);
    await encolar("caja_movimiento", m);
  });

export async function resumenCaja(caja: CajaSesion, contado?: number) {
  const ventas = await db.ventas.where("caja_sesion_id").equals(caja.id).filter((v) => v.estado === "completada").toArray();
  const pagos = await db.venta_pagos.where("venta_id").anyOf(ventas.map((v) => v.id)).toArray();
  const ventas_efectivo = pagos.filter((p) => p.medio === "efectivo").reduce((s, p) => s + p.monto, 0);
  const cobros = await db.cuenta_corriente_mov.where("caja_sesion_id").equals(caja.id).filter((m) => m.tipo === "pago" && m.medio_pago === "efectivo").toArray();
  const movs = await db.caja_movimientos.where("caja_sesion_id").equals(caja.id).toArray();
  const ingresos = movs.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + m.monto, 0);
  const egresos = movs.filter((m) => m.tipo === "egreso").reduce((s, m) => s + m.monto, 0);
  const pagos_fiado_efectivo = cobros.reduce((s, m) => s + m.monto, 0);
  return { ventas_efectivo, pagos_fiado_efectivo, ingresos, egresos, movs,
    ...calcularArqueo({ monto_inicial: caja.monto_inicial, ventas_efectivo, pagos_fiado_efectivo, ingresos, egresos, contado }) };
}

export const cerrarCaja = (caja: CajaSesion, contado: number) =>
  conSync(async () => {
    const r = await resumenCaja(caja, contado);
    const cerrada_at = ahora();
    await db.caja_sesiones.update(caja.id, { cerrada_at, monto_contado_real: contado, monto_teorico: r.teorico, diferencia: contado - r.teorico });
    await encolar("caja_cerrar", { id: caja.id, cerrada_at, monto_teorico: r.teorico, monto_contado_real: contado });
  });

