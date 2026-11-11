import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { aCentavos, fmt, linkWhatsApp, partidasFiado, resumenCuentaTexto } from "@kiosco/shared";
import type { Cliente, MovCC } from "@kiosco/shared";
import { db } from "../db/db";
import { guardarCliente, registrarPago } from "../db/ops";
import { imprimirTexto } from "../services/print";
import { getSesion } from "../sync/sesion";

const vacio = { id: "", nombre: "", apellido: "", celular: "", direccion: "", limite: "" };

export default function Fiados() {
  const clientes = useLiveQuery(() => db.clientes.filter((c) => !c.deleted_at).sortBy("nombre"), [], [] as Cliente[]);
  const [sel, setSel] = useState<string>("");
  const movs = useLiveQuery(() => (sel ? db.cuenta_corriente_mov.where("cliente_id").equals(sel).sortBy("creado_cliente_at") : Promise.resolve([] as MovCC[])), [sel], [] as MovCC[]);
  const [f, setF] = useState(vacio);
  const [pago, setPago] = useState({ monto: "", medio: "efectivo" as "efectivo" | "transferencia" });
  const [err, setErr] = useState("");
  const cliente = clientes.find((c) => c.id === sel);
  const comercio = getSesion()?.comercio_nombre ?? "";

  async function guardar() {
    if (!f.nombre.trim() || !f.apellido.trim() || !f.celular.trim()) return setErr("Nombre, apellido y celular son obligatorios");
    setErr("");
    const id = await guardarCliente({ id: f.id || undefined, nombre: f.nombre.trim(), apellido: f.apellido.trim(), celular: f.celular.trim(), direccion: f.direccion.trim() || null, limite_credito: aCentavos(parseFloat(f.limite) || 0) });
    setF(vacio); setSel(id);
  }
  async function cobrar() {
    const monto = aCentavos(parseFloat(pago.monto.replace(",", ".")) || 0);
    if (!cliente || monto <= 0) return;
    await registrarPago({ cliente_id: cliente.id, monto, medio_pago: pago.medio });
    setPago({ ...pago, monto: "" });
  }
  const resumen = cliente ? resumenCuentaTexto(cliente, movs, comercio) : "";

  return (
    <div className="grid">
      <section className="card"><h2>Clientes</h2>
        <table><tbody>{clientes.map((c) => (
          <tr key={c.id} onClick={() => setSel(c.id)} style={{ cursor: "pointer", background: c.id === sel ? "#e3eaee" : undefined }}>
            <td>{c.apellido}, {c.nombre}<br /><span className="muted">{c.celular}</span></td>
            <td className="n"><span className={"tag " + (c.saldo_cache > 0 ? "warn" : "ok")}>{c.saldo_cache > 0 ? "Debe " + fmt(c.saldo_cache) : "Al día"}</span></td>
          </tr>))}</tbody></table>
        <h2 style={{ marginTop: "1rem" }}>{f.id ? "Editar cliente" : "Nuevo cliente"}</h2>
        <div className="row"><label>Nombre<input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></label><label>Apellido<input value={f.apellido} onChange={(e) => setF({ ...f, apellido: e.target.value })} /></label></div>
        <div className="row"><label>Celular<input inputMode="tel" value={f.celular} onChange={(e) => setF({ ...f, celular: e.target.value })} /></label><label>Límite de crédito ($)<input inputMode="decimal" value={f.limite} onChange={(e) => setF({ ...f, limite: e.target.value })} /></label></div>
        <label>Dirección / referencia<input value={f.direccion} onChange={(e) => setF({ ...f, direccion: e.target.value })} /></label>
        {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        <div className="row"><button onClick={() => void guardar()}>Guardar cliente</button>
          {cliente && <button className="sec" onClick={() => setF({ id: cliente.id, nombre: cliente.nombre, apellido: cliente.apellido, celular: cliente.celular, direccion: cliente.direccion ?? "", limite: String(cliente.limite_credito / 100) })}>Editar seleccionado</button>}</div>
      </section>

      <section className="card">
        {!cliente ? <p className="muted">Elegí un cliente para ver su cuenta.</p> : <>
          <h2>{cliente.apellido}, {cliente.nombre}</h2>
          <p className="total">{fmt(cliente.saldo_cache)}</p>
          <p className="muted">Límite de crédito: {fmt(cliente.limite_credito)}</p>
          <div className="row">
            <label>Pago a cuenta ($)<input inputMode="decimal" value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} /></label>
            <label>Medio<select value={pago.medio} onChange={(e) => setPago({ ...pago, medio: e.target.value as "efectivo" | "transferencia" })}><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
            <button className="ok" onClick={() => void cobrar()}>Registrar pago</button>
          </div>
          <div className="row">
            <button onClick={() => window.open(linkWhatsApp(cliente.celular, resumen), "_blank")}>Enviar por WhatsApp</button>
            <button className="sec" onClick={() => imprimirTexto(resumen, 0)}>Imprimir / PDF</button>
          </div>
          <h2>Partidas</h2>
          <table><tbody>{partidasFiado(movs).map((p) => (
            <tr key={p.cargo_id}><td>{p.fecha.slice(0, 10)}</td><td className="n">{fmt(p.monto)}</td>
              <td><span className={"tag " + (p.estado === "Pagado" ? "ok" : p.estado === "Parcial" ? "warn" : "bad")}>{p.estado}</span></td></tr>))}</tbody></table>
          <h2 style={{ marginTop: "1rem" }}>Pagos a cuenta</h2>
          <table><tbody>{movs.filter((m) => m.tipo === "pago").map((m) => <tr key={m.id}><td>{m.creado_cliente_at.slice(0, 10)}</td><td>{m.medio_pago}</td><td className="n">{fmt(m.monto)}</td></tr>)}</tbody></table>
        </>}
      </section>
    </div>
  );
}
