import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { aCentavos, fmt } from "@kiosco/shared";
import { abrirCaja, cajaAbierta, cerrarCaja, movimientoCaja, resumenCaja } from "../db/ops";
import { db } from "../db/db";
import type { Sesion } from "../sync/sesion";

const cent = (s: string) => aCentavos(parseFloat(s.replace(",", ".")) || 0);

export default function Caja({ sesion }: { sesion: Sesion }) {
  const caja = useLiveQuery(() => cajaAbierta(), [], undefined);
  const resumen = useLiveQuery(async () => { const c = await cajaAbierta(); return c ? resumenCaja(c) : null; }, [], null);
  const ultimas = useLiveQuery(() => db.caja_sesiones.filter((c) => !!c.cerrada_at).reverse().sortBy("abierta_at").then((x) => x.slice(0, 5)), [], []);
  const [inicial, setInicial] = useState("");
  const [mov, setMov] = useState({ tipo: "egreso" as "ingreso" | "egreso", monto: "", concepto: "" });
  const [contado, setContado] = useState("");
  const [err, setErr] = useState("");

  if (!caja) return (
    <>
      <section className="card"><h2>Abrir caja</h2>
        <label>Fondo para vuelto ($)<input inputMode="decimal" value={inicial} onChange={(e) => setInicial(e.target.value)} /></label>
        {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        <button onClick={() => abrirCaja(cent(inicial), sesion.usuario_id).catch((e) => setErr(e.message))}>Abrir caja</button>
      </section>
      {ultimas.length > 0 && <section className="card"><h2>Últimos cierres</h2><table><tbody>{ultimas.map((c) => (
        <tr key={c.id}><td>{c.abierta_at.slice(0, 10)}</td><td className="n">Teórico {fmt(c.monto_teorico ?? 0)}</td><td className="n">Real {fmt(c.monto_contado_real ?? 0)}</td>
          <td><span className={"tag " + ((c.diferencia ?? 0) === 0 ? "ok" : "bad")}>{(c.diferencia ?? 0) === 0 ? "Sin diferencia" : "Dif. " + fmt(c.diferencia ?? 0)}</span></td></tr>))}</tbody></table></section>}
    </>
  );

  const diferencia = contado ? cent(contado) - (resumen?.teorico ?? 0) : null;
  return (
    <div className="grid">
      <section className="card"><h2>Caja abierta</h2>
        <p className="muted">Desde {new Date(caja.abierta_at).toLocaleString("es-AR")}</p>
        {resumen && <table><tbody>
          <tr><td>Fondo inicial</td><td className="n">{fmt(caja.monto_inicial)}</td></tr>
          <tr><td>Ventas en efectivo</td><td className="n">{fmt(resumen.ventas_efectivo)}</td></tr>
          <tr><td>Cobros de fiados en efectivo</td><td className="n">{fmt(resumen.pagos_fiado_efectivo)}</td></tr>
          <tr><td>Ingresos manuales</td><td className="n">{fmt(resumen.ingresos)}</td></tr>
          <tr><td>Egresos manuales</td><td className="n">−{fmt(resumen.egresos)}</td></tr>
          <tr><td><b>Efectivo teórico en caja</b></td><td className="n"><b>{fmt(resumen.teorico)}</b></td></tr>
        </tbody></table>}
        <h2 style={{ marginTop: "1rem" }}>Movimiento manual</h2>
        <div className="row">
          <label>Tipo<select value={mov.tipo} onChange={(e) => setMov({ ...mov, tipo: e.target.value as "ingreso" | "egreso" })}><option value="egreso">Salida</option><option value="ingreso">Ingreso</option></select></label>
          <label>Monto ($)<input inputMode="decimal" value={mov.monto} onChange={(e) => setMov({ ...mov, monto: e.target.value })} /></label>
        </div>
        <label>Concepto<input value={mov.concepto} onChange={(e) => setMov({ ...mov, concepto: e.target.value })} /></label>
        <button onClick={async () => { if (cent(mov.monto) > 0 && mov.concepto.trim()) { await movimientoCaja(caja.id, mov.tipo, cent(mov.monto), mov.concepto.trim()); setMov({ ...mov, monto: "", concepto: "" }); } }}>Registrar</button>
      </section>
      <section className="card"><h2>Arqueo y cierre</h2>
        <label>Efectivo contado ($)<input inputMode="decimal" value={contado} onChange={(e) => setContado(e.target.value)} /></label>
        {diferencia != null && <p><span className={"tag " + (diferencia === 0 ? "ok" : "bad")}>{diferencia === 0 ? "Caja cuadrada" : diferencia > 0 ? `Sobran ${fmt(diferencia)}` : `Faltan ${fmt(-diferencia)}`}</span></p>}
        <button className="bad" disabled={!contado} onClick={() => { if (confirm("¿Cerrar la caja?")) void cerrarCaja(caja, cent(contado)).then(() => setContado("")); }}>Cerrar caja</button>
        <h2 style={{ marginTop: "1rem" }}>Movimientos</h2>
        <table><tbody>{(resumen?.movs ?? []).map((m) => <tr key={m.id}><td>{m.concepto}</td><td className="n">{m.tipo === "egreso" ? "−" : "+"}{fmt(m.monto)}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}
