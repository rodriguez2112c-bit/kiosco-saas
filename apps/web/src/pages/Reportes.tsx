import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { desglosePorMedio, fmt, gananciaNeta, sinRotacion, topProductos } from "@kiosco/shared";
import type { Producto } from "@kiosco/shared";
import { db } from "../db/db";
import { anularVenta } from "../db/ops";
import { api } from "../sync/sesion";

type Periodo = "hoy" | "7" | "30";
const desdeISO = (p: Periodo) => { const d = new Date(); d.setHours(0, 0, 0, 0); if (p !== "hoy") d.setDate(d.getDate() - Number(p)); return d.toISOString(); };

export default function Reportes({ online }: { online: boolean }) {
  const [periodo, setPeriodo] = useState<Periodo>("hoy");
  const datos = useLiveQuery(async () => {
    const desde = desdeISO(periodo);
    const ventas = await db.ventas.where("creado_cliente_at").aboveOrEqual(desde).toArray();
    const ids = ventas.map((v) => v.id);
    const items = await db.venta_items.where("venta_id").anyOf(ids).toArray();
    const pagos = await db.venta_pagos.where("venta_id").anyOf(ids).toArray();
    const prods = await db.productos.filter((p) => !p.deleted_at).toArray();
    return { ventas, items, pagos, prods };
  }, [periodo]);
  const [audit, setAudit] = useState<any[] | null>(null);
  useEffect(() => { if (online) api<any[]>("/auditoria").then(setAudit).catch(() => setAudit(null)); }, [online]);

  const estancados = useSinRotacion();
  if (!datos) return null;
  const { ventas, items, pagos, prods } = datos;
  const d = desglosePorMedio(ventas, pagos);
  const nombre = (id: string) => prods.find((p: Producto) => p.id === id)?.nombre ?? "?";

  return (
    <>
      <div className="row">{(["hoy", "7", "30"] as Periodo[]).map((p) => <button key={p} className={p === periodo ? "" : "sec"} onClick={() => setPeriodo(p)}>{p === "hoy" ? "Hoy" : `Últimos ${p} días`}</button>)}</div>
      <div className="grid">
        <section className="card"><h2>Facturación</h2><p className="total">{fmt(d.total)}</p>
          <table><tbody><tr><td>Efectivo</td><td className="n">{fmt(d.efectivo)}</td></tr><tr><td>Transferencia</td><td className="n">{fmt(d.transferencia)}</td></tr><tr><td>Fiado</td><td className="n">{fmt(d.fiado)}</td></tr></tbody></table>
          <p className="muted">Ganancia neta (precio − costo): <b>{fmt(gananciaNeta(ventas, items))}</b></p></section>
        <section className="card"><h2>Más vendidos</h2><table><tbody>{topProductos(ventas, items, 8).map((t) => <tr key={t.producto_id}><td>{nombre(t.producto_id)}</td><td className="n">{t.cantidad}</td></tr>)}</tbody></table></section>
        <section className="card"><h2>Sin rotación (30 días)</h2>{estancados.length === 0 ? <p className="muted">Nada estancado.</p> : <table><tbody>{estancados.map((p) => <tr key={p.id}><td>{p.nombre}</td><td className="n">{p.stock_cache} en stock</td></tr>)}</tbody></table>}</section>
      </div>
      <section className="card scroll-x"><h2>Ventas del período</h2>
        <table><tbody>{[...ventas].reverse().map((v) => (
          <tr key={v.id}><td>{new Date(v.creado_cliente_at).toLocaleString("es-AR")}</td><td className="n">{fmt(v.total)}</td>
            <td>{v.estado === "anulada" ? <span className="tag bad">Anulada</span> : <button className="sec" onClick={() => { const m = prompt("Motivo de la anulación"); if (m) void anularVenta(v.id, m); }}>Anular</button>}</td></tr>))}</tbody></table></section>
      <section className="card scroll-x"><h2>Auditoría</h2>
        {!online ? <p className="muted">Requiere conexión.</p> : !audit ? <p className="muted">Cargando…</p> : (
          <table><tbody>{audit.map((a) => <tr key={a.id}><td>{new Date(a.creado_at).toLocaleString("es-AR")}</td><td>{a.entidad}</td><td>{a.accion}</td><td className="muted">{JSON.stringify(a.antes)} → {JSON.stringify(a.despues)}</td></tr>)}</tbody></table>)}
      </section>
    </>
  );
}

// "Sin rotación": con stock y sin ventas completadas en los últimos 30 días
function useSinRotacion() {
  return useLiveQuery(async () => {
    const desde = new Date(Date.now() - 30 * 864e5).toISOString();
    const ids = await db.ventas.where("creado_cliente_at").aboveOrEqual(desde).filter((x) => x.estado === "completada").primaryKeys();
    const items = await db.venta_items.where("venta_id").anyOf(ids).toArray();
    return sinRotacion(await db.productos.toArray(), items);
  }, [], [] as Producto[]);
}
