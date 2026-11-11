import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { aCentavos, fmt, linkWhatsApp, r3, subtotal, ticketTexto } from "@kiosco/shared";
import type { Cliente, Producto, Venta, VentaItem, VentaPago } from "@kiosco/shared";
import { db } from "../db/db";
import { cajaAbierta, cotizar, crearVenta, type ItemCotizado, type Linea } from "../db/ops";
import { imprimirTexto } from "../services/print";
import { Camara } from "../services/Camara";
import type { Sesion } from "../sync/sesion";

type Ticket = { venta: Venta; items: VentaItem[]; pagos: VentaPago[]; cliente: Cliente | null };
const num = (s: string) => aCentavos(parseFloat(s.replace(",", ".")) || 0);

export default function Pos({ sesion }: { sesion: Sesion }) {
  const caja = useLiveQuery(() => cajaAbierta(), [], undefined);
  const productos = useLiveQuery(() => db.productos.filter((p) => !p.deleted_at && p.activo).toArray(), [], [] as Producto[]);
  const clientes = useLiveQuery(() => db.clientes.filter((c) => !c.deleted_at).toArray(), [], [] as Cliente[]);
  const [q, setQ] = useState("");
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [cot, setCot] = useState<{ items: ItemCotizado[]; total: number }>({ items: [], total: 0 });
  const [pago, setPago] = useState({ efectivo: "", transferencia: "", fiado: "", pagaCon: "" });
  const [clienteId, setClienteId] = useState("");
  const [error, setError] = useState("");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [ancho, setAncho] = useState<32 | 48>(32);
  const [camara, setCamara] = useState(false);

  useEffect(() => { let vivo = true; cotizar(lineas).then((r) => vivo && setCot(r)); return () => { vivo = false; }; }, [lineas]);

  const nombres = useMemo(() => new Map(productos.map((p) => [p.id, p.nombre])), [productos]);
  const sugeridos = q.length >= 2 && !/^\d+$/.test(q) ? productos.filter((p) => p.nombre.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  const rapidos = productos.filter((p) => p.plu).slice(0, 12);

  const agregar = (p: Producto, cant = 1) => setLineas((ls) => {
    const i = ls.findIndex((l) => l.producto.id === p.id);
    if (i < 0) return [...ls, { producto: p, cantidad: cant }];
    const c = [...ls]; c[i] = { ...c[i], cantidad: r3(c[i].cantidad + cant) }; return c;
  });

  async function porCodigo(t: string): Promise<boolean> {
    t = t.trim();
    const cb = await db.codigos_barras.get(t);
    const p = cb && !cb.deleted_at ? await db.productos.get(cb.producto_id) : productos.find((x) => x.plu === t);
    if (p && !p.deleted_at) { agregar(p); return true; }
    return false;
  }
  async function enter() {
    setError("");
    if (!q.trim()) return;
    if (!(await porCodigo(q))) { if (sugeridos.length === 1) agregar(sugeridos[0]); else setError("Producto no encontrado"); }
    setQ("");
  }

  const ef = num(pago.efectivo), tr = num(pago.transferencia), fi = num(pago.fiado);
  const resto = cot.total - ef - tr - fi;
  const vuelto = pago.pagaCon ? Math.max(0, num(pago.pagaCon) - ef) : 0;
  const cliente = clientes.find((c) => c.id === clienteId) ?? null;
  const pesos = (c: number) => (c / 100).toFixed(2);

  async function cobrar() {
    setError("");
    try {
      if (fi > 0 && cliente && cliente.saldo_cache + fi > cliente.limite_credito && !confirm("Supera el límite de crédito del cliente. ¿Fiar igual?")) return;
      const r = await crearVenta({ items: cot.items, total: cot.total, cliente_id: clienteId || null, pagos: { efectivo: ef, transferencia: tr, fiado: fi }, usuario_id: sesion.usuario_id });
      setTicket({ ...r, cliente });
      setLineas([]); setPago({ efectivo: "", transferencia: "", fiado: "", pagaCon: "" }); setClienteId("");
    } catch (e) { setError((e as Error).message); }
  }

  const texto = ticket ? ticketTexto({ comercio: sesion.comercio_nombre, venta: ticket.venta, pagos: ticket.pagos, ancho,
    items: ticket.items.map((i) => ({ ...i, nombre: nombres.get(i.producto_id) ?? "Producto" })) }) : "";

  return (
    <div className="grid">
      <section className="card">
        <h2>Productos</h2>
        {!caja && <p style={{ color: "var(--bad)" }}>No hay caja abierta. Abrila en la pestaña Caja para poder vender.</p>}
        <div className="row">
          <input autoFocus style={{ flex: 1 }} placeholder="Escaneá o escribí código, PLU o nombre" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void enter()} />
          <button className="sec" onClick={() => setCamara(true)}>Cámara</button>
        </div>
        {sugeridos.length > 0 && <div className="pills">{sugeridos.map((p) => <button key={p.id} onClick={() => { agregar(p); setQ(""); }}>{p.nombre} · {fmt(p.precio_venta)}</button>)}</div>}
        {rapidos.length > 0 && <><p className="muted">Accesos rápidos (PLU)</p><div className="pills">{rapidos.map((p) => <button key={p.id} onClick={() => agregar(p)}>{p.plu} · {p.nombre}</button>)}</div></>}
        {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      </section>

      <section className="card">
        <h2>Ticket</h2>
        {lineas.length === 0 ? <p className="muted">Todavía no hay productos.</p> : (
          <table><tbody>
            {lineas.map((l) => (
              <tr key={l.producto.id}>
                <td>{l.producto.nombre}</td>
                <td><input type="number" step={l.producto.tipo === "peso" ? "0.001" : "1"} min="0" style={{ width: "5.5rem" }} value={l.cantidad}
                  onChange={(e) => setLineas(lineas.map((x) => x === l ? { ...x, cantidad: parseFloat(e.target.value) || 0 } : x).filter((x) => x.cantidad > 0))} /></td>
                <td className="n">{fmt(subtotal(l.producto.precio_venta, l.cantidad))}</td>
                <td><button className="sec" onClick={() => setLineas(lineas.filter((x) => x !== l))}>×</button></td>
              </tr>))}
          </tbody></table>
        )}
        {cot.items.some((i) => i.descuento > 0) && <p><span className="tag warn">Liquidación por vencimiento aplicada</span></p>}
        <div className="total">{fmt(cot.total)}</div>

        {cot.total > 0 && <>
          <div className="row">
            <label>Efectivo<input inputMode="decimal" value={pago.efectivo} onChange={(e) => setPago({ ...pago, efectivo: e.target.value })} /></label>
            <label>Transferencia<input inputMode="decimal" value={pago.transferencia} onChange={(e) => setPago({ ...pago, transferencia: e.target.value })} /></label>
            <label>Fiado<input inputMode="decimal" value={pago.fiado} onChange={(e) => setPago({ ...pago, fiado: e.target.value })} /></label>
          </div>
          <div className="row">
            <button className="sec" onClick={() => setPago({ ...pago, efectivo: pesos(cot.total), transferencia: "", fiado: "" })}>Todo efectivo</button>
            <button className="sec" onClick={() => setPago({ ...pago, transferencia: pesos(cot.total), efectivo: "", fiado: "" })}>Todo transferencia</button>
            <label>Paga con (vuelto)<input inputMode="decimal" value={pago.pagaCon} onChange={(e) => setPago({ ...pago, pagaCon: e.target.value })} /></label>
          </div>
          {fi > 0 && <label>Cliente (fiado)<select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
            <option value="">Elegir…</option>{clientes.map((c) => <option key={c.id} value={c.id}>{c.apellido}, {c.nombre} · debe {fmt(c.saldo_cache)}</option>)}</select></label>}
          <p className={resto === 0 ? "muted" : ""} style={{ color: resto === 0 ? undefined : "var(--warn)" }}>
            {resto === 0 ? "Pagos completos" : resto > 0 ? `Faltan ${fmt(resto)}` : `Sobran ${fmt(-resto)}`}{vuelto > 0 && ` · Vuelto ${fmt(vuelto)}`}
          </p>
          <button className="ok" disabled={!caja || resto !== 0 || (fi > 0 && !clienteId)} onClick={() => void cobrar()}>Cobrar {fmt(cot.total)}</button>
        </>}
      </section>

      {ticket && (
        <div className="modal"><div className="modal-box">
          <h2>Venta registrada</h2>
          <pre className="ticket">{texto}</pre>
          <div className="row">
            <label>Papel<select value={ancho} onChange={(e) => setAncho(Number(e.target.value) as 32 | 48)}><option value={32}>58 mm</option><option value={48}>80 mm</option></select></label>
            <button onClick={() => imprimirTexto(texto, ancho)}>Imprimir</button>
            <button className="sec" onClick={() => { const cel = ticket.cliente?.celular ?? prompt("Celular del cliente (con código de área, sin 15)"); if (cel) window.open(linkWhatsApp(cel, texto), "_blank"); }}>WhatsApp</button>
          </div>
          <button className="sec" onClick={() => setTicket(null)}>Cerrar</button>
        </div></div>
      )}
      {camara && <Camara onClose={() => setCamara(false)} onCodigo={(c) => void porCodigo(c)} />}
    </div>
  );
}
