import Dexie, { type Table } from "dexie";
import { r3 } from "@kiosco/shared";
import type { CajaMov, CajaSesion, CodigoBarras, Cliente, Lote, MovCC, Producto, TipoOp, Venta, VentaItem, VentaPago } from "@kiosco/shared";

export interface Deltas {
  stock: { producto_id: string; lote_id: string | null; delta: number }[];
  saldo: { cliente_id: string; delta: number }[];
}
export interface OutboxRow {
  seq?: number; op_id: string; tipo: TipoOp; payload: unknown;
  deltas: Deltas; // efecto local YA aplicado; se re-aplica después de cada pull hasta que el servidor confirme
  estado: "pendiente" | "fallida"; intentos: number; error?: string; creado_at: string;
}

class KioscoDB extends Dexie {
  meta!: Table<{ clave: string; valor: unknown }, string>;
  productos!: Table<Producto, string>;
  codigos_barras!: Table<CodigoBarras, string>;
  lotes!: Table<Lote, string>;
  clientes!: Table<Cliente, string>;
  cuenta_corriente_mov!: Table<MovCC, string>;
  ventas!: Table<Venta, string>;
  venta_items!: Table<VentaItem, string>;
  venta_pagos!: Table<VentaPago, string>;
  caja_sesiones!: Table<CajaSesion, string>;
  caja_movimientos!: Table<CajaMov, string>;
  outbox!: Table<OutboxRow, number>;

  constructor() {
    super("kiosco");
    // Cambiar el esquema => subir el número de versión y agregar un .upgrade() si hay que migrar datos.
    this.version(1).stores({
      meta: "clave",
      productos: "id, nombre, plu",
      codigos_barras: "ean, producto_id",
      lotes: "id, producto_id, fecha_vencimiento",
      clientes: "id, nombre",
      cuenta_corriente_mov: "id, cliente_id, caja_sesion_id",
      ventas: "id, creado_cliente_at, caja_sesion_id",
      venta_items: "id, venta_id, producto_id",
      venta_pagos: "id, venta_id",
      caja_sesiones: "id, abierta_at",
      caja_movimientos: "id, caja_sesion_id",
      outbox: "++seq, &op_id, estado",
    });
  }
}
export const db = new KioscoDB();

export const getMeta = async <T>(k: string) => (await db.meta.get(k))?.valor as T | undefined;
export const setMeta = (k: string, valor: unknown) => db.meta.put({ clave: k, valor });

/** Aplica cambios de stock/saldo sobre los valores locales (cache).
 *  `solo`: restringe a las entidades que un pull acaba de sobrescribir con el valor del servidor. */
export async function aplicarDeltas(d: Deltas, solo?: { productos: Set<string>; lotes: Set<string>; clientes: Set<string> }) {
  for (const s of d.stock) {
    if (!solo || solo.productos.has(s.producto_id))
      await db.productos.where("id").equals(s.producto_id).modify((p) => { p.stock_cache = r3(p.stock_cache + s.delta); });
    if (s.lote_id && (!solo || solo.lotes.has(s.lote_id)))
      await db.lotes.where("id").equals(s.lote_id).modify((l) => { l.restante_cache = r3(l.restante_cache + s.delta); });
  }
  for (const s of d.saldo)
    if (!solo || solo.clientes.has(s.cliente_id))
      await db.clientes.where("id").equals(s.cliente_id).modify((c) => { c.saldo_cache += s.delta; });
}
