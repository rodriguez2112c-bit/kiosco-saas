import { useState } from "react";
import { api, setSesion, type Sesion } from "../sync/sesion";

export default function Login({ onLogin }: { onLogin: (s: Sesion) => void }) {
  const [modo, setModo] = useState<"login" | "registro">("login");
  const [f, setF] = useState({ codigo: "", comercio: "", nombre: "", pin: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function enviar() {
    setErr("");
    try {
      const r = await api<Sesion>(modo === "login" ? "/auth/login" : "/auth/registro", { body: f });
      setSesion(r); onLogin(r);
    } catch (e) { setErr(navigator.onLine ? (e as Error).message : "Necesitás conexión para el primer ingreso"); }
  }
  return (
    <main style={{ maxWidth: 420 }}>
      <div className="card">
        <h2>{modo === "login" ? "Ingresar" : "Crear comercio"}</h2>
        <label>Código del comercio<input value={f.codigo} onChange={set("codigo")} autoCapitalize="none" /></label>
        {modo === "registro" && <label>Nombre del comercio<input value={f.comercio} onChange={set("comercio")} /></label>}
        <label>Usuario<input value={f.nombre} onChange={set("nombre")} /></label>
        <label>PIN<input type="password" inputMode="numeric" value={f.pin} onChange={set("pin")} /></label>
        {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        <div className="row"><button onClick={enviar}>{modo === "login" ? "Ingresar" : "Crear y entrar"}</button>
          <button className="sec" onClick={() => setModo(modo === "login" ? "registro" : "login")}>{modo === "login" ? "Soy nuevo" : "Ya tengo cuenta"}</button></div>
      </div>
    </main>
  );
}
