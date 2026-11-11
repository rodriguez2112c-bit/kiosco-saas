import { uuidv7 } from "@kiosco/shared";

export interface Sesion { token: string; usuario_id: string; comercio_id: string; rol: "dueno" | "cajero"; comercio_nombre: string }

export const getSesion = (): Sesion | null => {
  try { return JSON.parse(localStorage.getItem("sesion") ?? "null"); } catch { return null; }
};
export const setSesion = (s: Sesion) => localStorage.setItem("sesion", JSON.stringify(s));
export const clearSesion = () => localStorage.removeItem("sesion");

export function getDispositivoId(): string {
  let id = localStorage.getItem("dispositivo_id");
  if (!id) { id = uuidv7(); localStorage.setItem("dispositivo_id", id); }
  return id;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const s = getSesion();
  const r = await fetch("/api" + path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(s ? { Authorization: `Bearer ${s.token}` } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw Object.assign(new Error(e.error ?? "Error"), { status: r.status });
  }
  return r.json();
}
