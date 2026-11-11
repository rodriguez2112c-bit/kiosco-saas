import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, tx } from "./db.js";
import type { Sesion } from "./auth.js";

type Ctx = { c: PoolClient; cid: string; uid: string; dev: string };

// ---------- Helpers de stock ----------
async function mov(x: Ctx, p: { producto_id: string; lote_id: string | null; delta: number; motivo: string; ref_id?: string; creado?: string }) {
  await x.c.query(
    `INSERT INTO movimientos_stock (comercio_id, producto_id, lote_id, delta, motivo, ref_id, dispositivo_id, usuario_id, creado_cliente_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [x.cid, p.producto_id, p.lote_id, p.delta, p.motivo, p.ref_id ?? null, x.dev, x.uid, p.creado ?? null]);
}

/** Descuenta stock respetando el lote que eligió el cliente; si no alcanza, reasigna por FEFO.
 *  Nunca rechaza: si igual falta, queda stock negativo y se genera una alerta. */
async function consumirStock(x: Ctx, p: { producto_id: string; lote_id: string | null; cantidad: number; venta_id: string; creado: string }) {
  let falta = p.cantidad;
  const { rows } = await x.c.query(
    `SELECT id, restante_cache AS restante FROM lotes
      WHERE comercio_id=$1 AND producto_id=$2 AND deleted_at IS NULL AND restante_cache > 0
      ORDER BY COALESCE(id = $3::uuid, false) DESC, fecha_vencimiento NULLS LAST, fecha_ingreso, id FOR UPDATE`,
    [x.cid, p.producto_id, p.lote_id]);
  for (const l of rows) {
    if (falta <= 0) break;
    const take = Math.min(l.restante, falta);
    await mov(x, { producto_id: p.producto_id, lote_id: l.id, delta: -take, motivo: "venta", ref_id: p.venta_id, creado: p.creado });
    falta = Math.round((falta - take) * 1000) / 1000;
  }
  if (falta > 0) await mov(x, { producto_id: p.producto_id, lote_id: null, delta: -falta, motivo: "venta", ref_id: p.venta_id, creado: p.creado });
  const { rows: pr } = await x.c.query("SELECT stock_cache, nombre FROM productos WHERE id=$1", [p.producto_id]);
  if (pr[0] && pr[0].stock_cache < 0)
    await x.c.query("INSERT INTO alertas (comercio_id,tipo,detalle) VALUES ($1,'stock_negativo',$2)",
      [x.cid, { producto_id: p.producto_id, nombre: pr[0].nombre, stock: pr[0].stock_cache, venta_id: p.venta_id }]);
}

async function auditar(x: Ctx, entidad: string, id: string | null, accion: string, antes: unknown, despues: unknown) {
  await x.c.query("INSERT INTO auditoria (comercio_id,usuario_id,entidad,entidad_id,accion,antes,despues) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [x.cid, x.uid, entidad, id, accion, antes ?? null, despues ?? null]);
}

// ---------- Handlers por tipo de operación ----------
const S = z.string(), N = z.number();
const H: Record<string, (x: Ctx, raw: unknown, creado: string) => Promise<void>> = {
  async producto_upsert(x, raw) {
    const p = z.object({ id: S, categoria_id: S.nullable().optional(), nombre: S, tipo: z.enum(["unidad", "peso", "elaborado"]),
      plu: S.nullable().optional(), precio_venta: N, stock_minimo: N, activo: z.boolean(), eans: z.array(S).default([]), borrar: z.boolean().optional() }).parse(raw);
    const { rows: ant } = await x.c.query("SELECT * FROM productos WHERE id=$1 AND comercio_id=$2", [p.id, x.cid]);
    if (ant[0]) {
      await x.c.query(`UPDATE productos SET categoria_id=$3, nombre=$4, tipo=$5, plu=$6, precio_venta=$7, stock_minimo=$8, activo=$9,
        version=version+1, deleted_at=CASE WHEN $10 THEN now() ELSE NULL END WHERE id=$1 AND comercio_id=$2`,
        [p.id, x.cid, p.categoria_id ?? null, p.nombre, p.tipo, p.plu ?? null, p.precio_venta, p.stock_minimo, p.activo, !!p.borrar]);
      if (ant[0].precio_venta !== p.precio_venta) await auditar(x, "producto", p.id, "cambio_precio", { precio_venta: ant[0].precio_venta }, { precio_venta: p.precio_venta });
    } else {
      await x.c.query(`INSERT INTO productos (id,comercio_id,categoria_id,nombre,tipo,plu,precio_venta,stock_minimo,activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, x.cid, p.categoria_id ?? null, p.nombre, p.tipo, p.plu ?? null, p.precio_venta, p.stock_minimo, p.activo]);
      await auditar(x, "producto", p.id, "alta", null, { nombre: p.nombre, precio_venta: p.precio_venta });
    }
    for (const ean of p.eans)
      await x.c.query(`INSERT INTO codigos_barras (ean,comercio_id,producto_id) VALUES ($1,$2,$3)
        ON CONFLICT (comercio_id,ean) DO UPDATE SET producto_id=EXCLUDED.producto_id, deleted_at=NULL`, [ean, x.cid, p.id]);
  },

  async lote_crear(x, raw, creado) {
    const l = z.object({ id: S, producto_id: S, costo_unitario: N, cantidad: N, fecha_vencimiento: S.nullable().optional() }).parse(raw);
    await x.c.query(`INSERT INTO lotes (id,comercio_id,producto_id,costo_unitario,cantidad_inicial,fecha_vencimiento) VALUES ($1,$2,$3,$4,$5,$6)`,
      [l.id, x.cid, l.producto_id, l.costo_unitario, l.cantidad, l.fecha_vencimiento ?? null]);
    await mov(x, { producto_id: l.producto_id, lote_id: l.id, delta: l.cantidad, motivo: "compra", ref_id: l.id, creado });
  },

  async ajuste_stock(x, raw, creado) {
    const a = z.object({ producto_id: S, lote_id: S.nullable().optional(), delta: N, motivo: z.enum(["ajuste", "merma"]), nota: S.optional() }).parse(raw);
    await mov(x, { producto_id: a.producto_id, lote_id: a.lote_id ?? null, delta: a.delta, motivo: a.motivo, creado });
    await auditar(x, "stock", a.producto_id, a.motivo, null, { delta: a.delta, nota: a.nota });
  },

  async cliente_upsert(x, raw) {
    const c = z.object({ id: S, nombre: S, apellido: S, celular: S, direccion: S.nullable().optional(), limite_credito: N, borrar: z.boolean().optional() }).parse(raw);
    await x.c.query(`INSERT INTO clientes (id,comercio_id,nombre,apellido,celular,direccion,limite_credito) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET nombre=$3, apellido=$4, celular=$5, direccion=$6, limite_credito=$7, deleted_at=CASE WHEN $8 THEN now() ELSE NULL END
      WHERE clientes.comercio_id=$2`, [c.id, x.cid, c.nombre, c.apellido, c.celular, c.direccion ?? null, c.limite_credito, !!c.borrar]);
  },

  async pago_cliente(x, raw) {
    const p = z.object({ id: S, cliente_id: S, monto: N.positive(), medio_pago: z.enum(["efectivo", "transferencia"]), caja_sesion_id: S.nullable().optional(), creado_at: S }).parse(raw);
    await x.c.query(`INSERT INTO cuenta_corriente_mov (id,comercio_id,cliente_id,tipo,monto,medio_pago,caja_sesion_id,creado_cliente_at)
      VALUES ($1,$2,$3,'pago',$4,$5,$6,$7)`, [p.id, x.cid, p.cliente_id, p.monto, p.medio_pago, p.caja_sesion_id ?? null, p.creado_at]);
  },

  async caja_abrir(x, raw) {
    const a = z.object({ id: S, monto_inicial: N, abierta_at: S }).parse(raw);
    await x.c.query(`INSERT INTO caja_sesiones (id,comercio_id,dispositivo_id,usuario_id,monto_inicial,abierta_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.id, x.cid, x.dev, x.uid, a.monto_inicial, a.abierta_at]);
  },
  async caja_movimiento(x, raw) {
    const m = z.object({ id: S, caja_sesion_id: S, tipo: z.enum(["ingreso", "egreso"]), monto: N.positive(), concepto: S, creado_at: S }).parse(raw);
    await x.c.query(`INSERT INTO caja_movimientos (id,comercio_id,caja_sesion_id,tipo,monto,concepto,creado_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.id, x.cid, m.caja_sesion_id, m.tipo, m.monto, m.concepto, m.creado_at]);
  },
  async caja_cerrar(x, raw) {
    const k = z.object({ id: S, cerrada_at: S, monto_teorico: N, monto_contado_real: N }).parse(raw);
    await x.c.query(`UPDATE caja_sesiones SET cerrada_at=$3, monto_teorico=$4, monto_contado_real=$5, diferencia=$5-$4 WHERE id=$1 AND comercio_id=$2`,
      [k.id, x.cid, k.cerrada_at, k.monto_teorico, k.monto_contado_real]);
    if (k.monto_contado_real !== k.monto_teorico) await auditar(x, "caja", k.id, "diferencia_arqueo", { teorico: k.monto_teorico }, { real: k.monto_contado_real });
  },

  async venta(x, raw, creado) {
    const v = z.object({
      id: S, caja_sesion_id: S, cliente_id: S.nullable(), total: N,
      items: z.array(z.object({ id: S, producto_id: S, lote_id: S.nullable(), cantidad: N.positive(), precio_unitario: N, costo_unitario: N, descuento: N })).min(1),
      pagos: z.array(z.object({ id: S, medio: z.enum(["efectivo", "transferencia", "fiado"]), monto: N.positive() })).min(1),
    }).parse(raw);
    if (v.pagos.reduce((s, p) => s + p.monto, 0) !== v.total) throw new Error("Los pagos no suman el total");
    const fiado = v.pagos.find((p) => p.medio === "fiado");
    if (fiado && !v.cliente_id) throw new Error("Fiado requiere cliente");

    await x.c.query(`INSERT INTO ventas (id,comercio_id,caja_sesion_id,usuario_id,dispositivo_id,cliente_id,total,creado_cliente_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [v.id, x.cid, v.caja_sesion_id, x.uid, x.dev, v.cliente_id, v.total, creado]);
    for (const i of v.items) {
      await x.c.query(`INSERT INTO venta_items (id,venta_id,producto_id,lote_id,cantidad,precio_unitario,costo_unitario,descuento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [i.id, v.id, i.producto_id, i.lote_id, i.cantidad, i.precio_unitario, i.costo_unitario, i.descuento]);
      await consumirStock(x, { producto_id: i.producto_id, lote_id: i.lote_id, cantidad: i.cantidad, venta_id: v.id, creado });
    }
    for (const p of v.pagos) await x.c.query(`INSERT INTO venta_pagos (id,venta_id,medio,monto) VALUES ($1,$2,$3,$4)`, [p.id, v.id, p.medio, p.monto]);
    if (fiado) {
      await x.c.query(`INSERT INTO cuenta_corriente_mov (id,comercio_id,cliente_id,tipo,monto,venta_id,creado_cliente_at) VALUES ($4,$1,$2,'cargo',$3,$4,$5)`,
        [x.cid, v.cliente_id, fiado.monto, v.id, creado]);
      const { rows } = await x.c.query("SELECT saldo_cache, limite_credito FROM clientes WHERE id=$1", [v.cliente_id]);
      if (rows[0] && rows[0].saldo_cache > rows[0].limite_credito)
        await x.c.query("INSERT INTO alertas (comercio_id,tipo,detalle) VALUES ($1,'limite_credito_excedido',$2)", [x.cid, { cliente_id: v.cliente_id, venta_id: v.id, saldo: rows[0].saldo_cache }]);
    }
  },

  async anular_venta(x, raw, creado) {
    const a = z.object({ venta_id: S, motivo: S.optional(), ajuste_id: S.optional() }).parse(raw);
    const { rows } = await x.c.query("SELECT * FROM ventas WHERE id=$1 AND comercio_id=$2 FOR UPDATE", [a.venta_id, x.cid]);
    if (!rows[0]) throw new Error("Venta inexistente (¿falta sincronizar la venta?)");
    if (rows[0].estado === "anulada") return;
    await x.c.query("UPDATE ventas SET estado='anulada', anulada_at=now() WHERE id=$1", [a.venta_id]);
    const { rows: movs } = await x.c.query("SELECT producto_id, lote_id, delta FROM movimientos_stock WHERE ref_id=$1 AND motivo='venta'", [a.venta_id]);
    for (const m of movs) await mov(x, { producto_id: m.producto_id, lote_id: m.lote_id, delta: -m.delta, motivo: "anulacion", ref_id: a.venta_id, creado });
    const { rows: cargo } = await x.c.query("SELECT cliente_id, monto FROM cuenta_corriente_mov WHERE venta_id=$1 AND tipo='cargo'", [a.venta_id]);
    for (const c of cargo)
      await x.c.query(`INSERT INTO cuenta_corriente_mov (id,comercio_id,cliente_id,tipo,monto,venta_id,creado_cliente_at) VALUES (COALESCE($6::uuid, gen_random_uuid()),$1,$2,'ajuste',$3,$4,$5)`,
        [x.cid, c.cliente_id, -c.monto, a.venta_id, creado, a.ajuste_id ?? null]);
    await auditar(x, "venta", a.venta_id, "anulacion", { total: rows[0].total }, { motivo: a.motivo });
  },
};

// ---------- Rutas ----------
const TABLAS = ["categorias", "productos", "codigos_barras", "lotes", "clientes", "cuenta_corriente_mov"];

export async function syncRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req) => { await req.jwtVerify(); });
  const ses = (req: { user: unknown }) => req.user as Sesion;

  app.post("/sync/push", async (req) => {
    const { comercio_id: cid, usuario_id: uid } = ses(req);
    const body = z.object({ dispositivo_id: S, ops: z.array(z.object({ op_id: S, tipo: S, payload: z.unknown(), creado_at: S })).max(100) }).parse(req.body);
    await pool.query(`INSERT INTO dispositivos (id,comercio_id,ultimo_sync_at) VALUES ($1,$2,now()) ON CONFLICT (id) DO UPDATE SET ultimo_sync_at=now() WHERE dispositivos.comercio_id=$2`, [body.dispositivo_id, cid]);

    const results: { op_id: string; estado: "ok" | "duplicada" | "error"; error?: string }[] = [];
    for (const op of body.ops) {            // en orden; se frena en el primer error para respetar dependencias
      try {
        const estado = await tx(async (c) => {
          const ins = await c.query(`INSERT INTO sync_operaciones (op_id,comercio_id,dispositivo_id,tipo) VALUES ($1,$2,$3,$4) ON CONFLICT (op_id) DO NOTHING`,
            [op.op_id, cid, body.dispositivo_id, op.tipo]);
          if (ins.rowCount === 0) return "duplicada" as const;   // ya procesada: idempotencia
          const h = H[op.tipo];
          if (!h) throw new Error("Tipo de operación desconocido: " + op.tipo);
          await h({ c, cid, uid, dev: body.dispositivo_id }, op.payload, op.creado_at);
          return "ok" as const;
        });
        results.push({ op_id: op.op_id, estado });
      } catch (e) {
        results.push({ op_id: op.op_id, estado: "error", error: (e as Error).message });
        break;
      }
    }
    return { results };
  });

  // Pull incremental por cursor. Una sola consulta UNION ordenada por sync_seq => el cursor nunca se salta filas.
  app.get("/sync/pull", async (req) => {
    const { comercio_id: cid } = ses(req);
    const q = z.object({ cursor: z.coerce.number().default(0) }).parse(req.query);
    const LIMITE = 1000;
    const union = TABLAS.map((t) => `SELECT '${t}' AS t, sync_seq, to_jsonb(x) AS row FROM ${t} x WHERE comercio_id=$1 AND sync_seq > $2`).join(" UNION ALL ");
    const { rows } = await pool.query(`SELECT t, sync_seq, row FROM (${union}) u ORDER BY sync_seq LIMIT ${LIMITE}`, [cid, q.cursor]);
    const { rows: cfg } = await pool.query("SELECT config, nombre FROM comercios WHERE id=$1", [cid]);
    return { filas: rows.map((r) => ({ t: r.t, row: r.row })), cursor: rows.length ? Number(rows[rows.length - 1].sync_seq) : q.cursor,
      hay_mas: rows.length === LIMITE, config: cfg[0]?.config, comercio_nombre: cfg[0]?.nombre };
  });

  // Consultas de solo lectura (requieren conexión)
  app.get("/auditoria", async (req) => {
    const { comercio_id: cid } = ses(req);
    const { rows } = await pool.query("SELECT * FROM auditoria WHERE comercio_id=$1 ORDER BY creado_at DESC LIMIT 200", [cid]);
    return rows;
  });
  app.get("/alertas", async (req) => {
    const { comercio_id: cid } = ses(req);
    const { rows } = await pool.query("SELECT * FROM alertas WHERE comercio_id=$1 AND NOT resuelta ORDER BY creada_at DESC LIMIT 100", [cid]);
    return rows;
  });
}
