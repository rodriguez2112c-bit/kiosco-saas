import { useSyncExternalStore } from "react";
import { aplicarDeltas, db, getMeta, setMeta } from "../db/db";
import { api, getDispositivoId, getSesion } from "./sesion";

// ---- estado observable para la UI ----
type Estado = { sincronizando: boolean; error: string | null; ultimo: number | null };
let estado: Estado = { sincronizando: false, error: null, ultimo: null };
const subs = new Set<() => void>();
const setEstado = (p: Partial<Estado>) => { estado = { ...estado, ...p }; subs.forEach((f) => f()); };
export const useEstadoSync = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => estado);

const MAX_INTENTOS = 5;
let corriendo = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Llamar después de cada operación local: sincroniza ya (si hay red) sin bloquear la venta. */
export function solicitarSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void sincronizar(), 300);
}

export function iniciarSync() {
  window.addEventListener("online", () => void sincronizar());
  setInterval(() => void sincronizar(), 30_000); // red de seguridad (Background Sync no existe en Safari/iOS)
  void sincronizar();
}

export async function sincronizar() {
  if (corriendo || !navigator.onLine || !getSesion()) return;
  corriendo = true;
  setEstado({ sincronizando: true });
  try {
    await push();
    await pull();
    setEstado({ error: null, ultimo: Date.now() });
  } catch (e) {
    const err = e as Error & { status?: number };
    setEstado({ error: err.status === 401 ? "Sesión vencida: volvé a ingresar para sincronizar" : "Sin conexión con el servidor" });
  } finally {
    corriendo = false;
    setEstado({ sincronizando: false });
  }
}

async function push() {
  for (;;) {
    const lote = (await db.outbox.where("estado").equals("pendiente").sortBy("seq")).slice(0, 50);
    if (!lote.length) return;
    const { results } = await api<{ results: { op_id: string; estado: string; error?: string }[] }>("/sync/push", {
      body: { dispositivo_id: getDispositivoId(), ops: lote.map((o) => ({ op_id: o.op_id, tipo: o.tipo, payload: o.payload, creado_at: o.creado_at })) },
    });
    let huboError = false;
    for (const r of results) {
      const row = lote.find((o) => o.op_id === r.op_id)!;
      if (r.estado === "ok" || r.estado === "duplicada") await db.outbox.delete(row.seq!);
      else {
        huboError = true;
        const intentos = row.intentos + 1;
        await db.outbox.update(row.seq!, { intentos, error: r.error, estado: intentos >= MAX_INTENTOS ? "fallida" : "pendiente" });
      }
    }
    if (huboError) throw new Error("Operación rechazada por el servidor"); // se reintenta en el próximo ciclo
  }
}

async function pull() {
  let cursor = (await getMeta<number>("cursor")) ?? 0;
  let primera = true;
  for (;;) {
    // En la primera página se pide un poco antes del cursor: los upserts son idempotentes y cubre commits fuera de orden.
    const desde = primera ? Math.max(0, cursor - 50) : cursor;
    primera = false;
    const r = await api<{ filas: { t: string; row: any }[]; cursor: number; hay_mas: boolean; config?: unknown; comercio_nombre?: string }>(`/sync/pull?cursor=${desde}`);
    await db.transaction("rw", [db.productos, db.codigos_barras, db.lotes, db.clientes, db.cuenta_corriente_mov, db.outbox, db.meta], async () => {
      const por: Record<string, any[]> = {};
      for (const f of r.filas) (por[f.t] ??= []).push(f.row);
      if (por.productos) await db.productos.bulkPut(por.productos);
      if (por.codigos_barras) await db.codigos_barras.bulkPut(por.codigos_barras);
      if (por.lotes) await db.lotes.bulkPut(por.lotes);
      if (por.clientes) await db.clientes.bulkPut(por.clientes);
      if (por.cuenta_corriente_mov) await db.cuenta_corriente_mov.bulkPut(por.cuenta_corriente_mov);
      // El servidor no conoce lo que todavía está en la cola: se re-aplica encima, solo sobre lo recién sobrescrito.
      const solo = {
        productos: new Set<string>((por.productos ?? []).map((x) => x.id)),
        lotes: new Set<string>((por.lotes ?? []).map((x) => x.id)),
        clientes: new Set<string>((por.clientes ?? []).map((x) => x.id)),
      };
      for (const o of await db.outbox.where("estado").equals("pendiente").toArray()) await aplicarDeltas(o.deltas, solo);
      if (r.config) await setMeta("config", r.config);
      if (r.comercio_nombre) await setMeta("comercio_nombre", r.comercio_nombre);
    });
    cursor = r.cursor;
    await setMeta("cursor", cursor);
    if (!r.hay_mas) return;
  }
}
