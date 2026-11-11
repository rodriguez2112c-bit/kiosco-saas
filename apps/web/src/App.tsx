import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db/db";
import { clearSesion, getSesion, type Sesion } from "./sync/sesion";
import { iniciarSync, sincronizar, useEstadoSync } from "./sync/syncManager";
import Login from "./pages/Login";
import Pos from "./pages/Pos";
import Inventario from "./pages/Inventario";
import Fiados from "./pages/Fiados";
import Caja from "./pages/Caja";
import Reportes from "./pages/Reportes";

const TABS = ["Vender", "Inventario", "Fiados", "Caja", "Reportes"] as const;

export default function App() {
  const [sesion, setSesion] = useState<Sesion | null>(getSesion());
  const [tab, setTab] = useState<(typeof TABS)[number]>("Vender");
  const [online, setOnline] = useState(navigator.onLine);
  const sync = useEstadoSync();
  const pendientes = useLiveQuery(() => db.outbox.count(), [], 0);
  const fallidas = useLiveQuery(() => db.outbox.where("estado").equals("fallida").count(), [], 0);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  useEffect(() => { if (sesion) iniciarSync(); }, [sesion]);

  if (!sesion) return <Login onLogin={(s) => { setSesion(s); void sincronizar(); }} />;
  return (
    <>
      <header>
        <h1>{sesion.comercio_nombre}</h1>
        <span className={"chip " + (online ? "" : "off")}>{online ? "En línea" : "Sin conexión"}</span>
        <span className={"chip " + (pendientes ? "off" : "")}>{pendientes ? `${pendientes} sin sincronizar` : "Sincronizado"}</span>
        {sync.error && <span className="chip err">{sync.error}</span>}
        {fallidas > 0 && <span className="chip err">{fallidas} operaciones rechazadas</span>}
        <button className="sec" onClick={() => void sincronizar()} disabled={!online || sync.sincronizando}>{sync.sincronizando ? "Sincronizando…" : "Sincronizar"}</button>
        <button className="sec" onClick={() => { clearSesion(); setSesion(null); }}>Salir</button>
      </header>
      <nav>{TABS.map((t) => <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
      <main>
        {tab === "Vender" && <Pos sesion={sesion} />}
        {tab === "Inventario" && <Inventario />}
        {tab === "Fiados" && <Fiados />}
        {tab === "Caja" && <Caja sesion={sesion} />}
        {tab === "Reportes" && <Reportes online={online} />}
      </main>
    </>
  );
}
