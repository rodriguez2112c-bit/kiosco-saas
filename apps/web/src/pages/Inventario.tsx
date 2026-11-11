import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { aCentavos, diasParaVencer, fmt, lotesPorVencer } from "@kiosco/shared";
import type { Lote, Producto, TipoProducto } from "@kiosco/shared";
import { db } from "../db/db";
import { ajustarStock, crearLote, guardarProducto } from "../db/ops";

const vacio = { id: "", nombre: "", tipo: "unidad" as TipoProducto, plu: "", ean: "", precio: "", minimo: "0" };
const pesos = (c: number) => (c / 100).toString();

export default function Inventario() {
  const productos = useLiveQuery(() => db.productos.filter((p) => !p.deleted_at).sortBy("nombre"), [], [] as Producto[]);
  const lotes = useLiveQuery(() => db.lotes.filter((l) => !l.deleted_at).toArray(), [], [] as Lote[]);
  const [f, setF] = useState(vacio);
  const [lote, setLote] = useState({ producto_id: "", costo: "", cantidad: "", venc: "" });
  const [msg, setMsg] = useState("");
  const nombre = (id: string) => productos.find((p) => p.id === id)?.nombre ?? "?";
  const costoUltimo = (id: string) => lotes.filter((l) => l.producto_id === id).sort((a, b) => b.fecha_ingreso.localeCompare(a.fecha_ingreso))[0]?.costo_unitario;

  const agotados = productos.filter((p) => p.activo && p.stock_cache <= 0);
  const bajos = productos.filter((p) => p.activo && p.stock_cache > 0 && p.stock_cache <= p.stock_minimo);
  const porVencer = lotesPorVencer(lotes, 15).sort((a, b) => a.fecha_vencimiento!.localeCompare(b.fecha_vencimiento!));

  async function editar(p: Producto) {
    const cb = await db.codigos_barras.where("producto_id").equals(p.id).first();
    setF({ id: p.id, nombre: p.nombre, tipo: p.tipo, plu: p.plu ?? "", ean: cb?.ean ?? "", precio: pesos(p.precio_venta), minimo: String(p.stock_minimo) });
  }
  async function guardar() {
    if (!f.nombre.trim()) return setMsg("Falta el nombre");
    await guardarProducto({ id: f.id || undefined, nombre: f.nombre.trim(), tipo: f.tipo, plu: f.plu.trim() || null, categoria_id: null, activo: true,
      precio_venta: aCentavos(parseFloat(f.precio) || 0), stock_minimo: parseFloat(f.minimo) || 0 }, f.ean.trim() ? [f.ean.trim()] : []);
    setF(vacio); setMsg("Producto guardado");
  }
  async function ingresarLote() {
    if (!lote.producto_id || !(parseFloat(lote.cantidad) > 0)) return setMsg("Elegí el producto y la cantidad");
    await crearLote({ producto_id: lote.producto_id, costo_unitario: aCentavos(parseFloat(lote.costo) || 0), cantidad: parseFloat(lote.cantidad), fecha_vencimiento: lote.venc || null });
    setLote({ producto_id: lote.producto_id, costo: "", cantidad: "", venc: "" }); setMsg("Lote ingresado");
  }

  return (
    <>
      {(agotados.length > 0 || bajos.length > 0 || porVencer.length > 0) && (
        <section className="card"><h2>Alertas</h2>
          {agotados.length > 0 && <p><span className="tag bad">Agotados</span> {agotados.map((p) => p.nombre).join(", ")}</p>}
          {bajos.length > 0 && <p><span className="tag warn">Stock bajo</span> {bajos.map((p) => `${p.nombre} (${p.stock_cache})`).join(", ")}</p>}
          {porVencer.length > 0 && <p><span className="tag warn">Vencen en ≤15 días</span> {porVencer.map((l) => `${nombre(l.producto_id)} · ${l.restante_cache} u · ${diasParaVencer(l.fecha_vencimiento!)} d`).join(" | ")}<br /><span className="muted">Se venden con descuento automático de liquidación.</span></p>}
        </section>)}
      {msg && <p className="muted">{msg}</p>}
      <div className="grid">
        <section className="card"><h2>{f.id ? "Editar producto" : "Nuevo producto"}</h2>
          <label>Nombre<input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></label>
          <div className="row">
            <label>Código de barras (EAN)<input value={f.ean} onChange={(e) => setF({ ...f, ean: e.target.value })} /></label>
            <label>PLU / acceso rápido<input value={f.plu} onChange={(e) => setF({ ...f, plu: e.target.value })} /></label>
          </div>
          <div className="row">
            <label>Tipo<select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as TipoProducto })}><option value="unidad">Unidad</option><option value="peso">Por peso</option><option value="elaborado">Elaboración propia</option></select></label>
            <label>Precio de venta ($)<input inputMode="decimal" value={f.precio} onChange={(e) => setF({ ...f, precio: e.target.value })} /></label>
            <label>Stock mínimo<input inputMode="decimal" value={f.minimo} onChange={(e) => setF({ ...f, minimo: e.target.value })} /></label>
          </div>
          <div className="row"><button onClick={() => void guardar()}>Guardar</button>{f.id && <button className="sec" onClick={() => setF(vacio)}>Cancelar</button>}</div>
        </section>
        <section className="card"><h2>Ingresar lote (compra)</h2>
          <label>Producto<select value={lote.producto_id} onChange={(e) => setLote({ ...lote, producto_id: e.target.value })}><option value="">Elegir…</option>{productos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></label>
          <div className="row">
            <label>Costo unitario ($)<input inputMode="decimal" value={lote.costo} onChange={(e) => setLote({ ...lote, costo: e.target.value })} /></label>
            <label>Cantidad<input inputMode="decimal" value={lote.cantidad} onChange={(e) => setLote({ ...lote, cantidad: e.target.value })} /></label>
            <label>Vence<input type="date" value={lote.venc} onChange={(e) => setLote({ ...lote, venc: e.target.value })} /></label>
          </div>
          <button onClick={() => void ingresarLote()}>Ingresar lote</button>
        </section>
      </div>
      <section className="card scroll-x"><h2>Productos ({productos.length})</h2>
        <table><thead><tr><th>Producto</th><th className="n">Stock</th><th className="n">Mín.</th><th className="n">Precio</th><th className="n">Costo</th><th className="n">Margen</th><th /></tr></thead>
          <tbody>{productos.map((p) => { const c = costoUltimo(p.id); return (
            <tr key={p.id}>
              <td>{p.nombre}</td><td className="n">{p.stock_cache}</td><td className="n">{p.stock_minimo}</td><td className="n">{fmt(p.precio_venta)}</td>
              <td className="n">{c != null ? fmt(c) : "—"}</td><td className="n">{c != null && p.precio_venta > 0 ? Math.round(((p.precio_venta - c) / p.precio_venta) * 100) + "%" : "—"}</td>
              <td><button className="sec" onClick={() => void editar(p)}>Editar</button>{" "}
                <button className="sec" onClick={() => { const d = parseFloat(prompt("Ajuste de stock (+ suma / − resta)") ?? ""); if (d) void ajustarStock({ producto_id: p.id, lote_id: null, delta: d, motivo: d < 0 ? "merma" : "ajuste" }); }}>Ajustar</button></td>
            </tr>); })}</tbody></table>
      </section>
    </>
  );
}
