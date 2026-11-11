// ============ Dinero (todo en centavos, enteros) ============
export const aCentavos = (pesos: number) => Math.round(pesos * 100);
export const fmt = (c: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(c / 100);
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const subtotal = (precioUnit: number, cantidad: number) => Math.round(precioUnit * cantidad);

// ============ UUID v7 (ordenable por tiempo, generado en el cliente) ============
export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ============ Tipos (mismos nombres de campo que la DB del servidor) ============
export type MedioPago = "efectivo" | "transferencia" | "fiado";
export type TipoProducto = "unidad" | "peso" | "elaborado";

export interface Producto {
  id: string; categoria_id: string | null; nombre: string; tipo: TipoProducto;
  plu: string | null; precio_venta: number; stock_minimo: number; stock_cache: number;
  activo: boolean; version: number; deleted_at: string | null;
}
export interface CodigoBarras { ean: string; producto_id: string; deleted_at: string | null }
export interface Lote {
  id: string; producto_id: string; costo_unitario: number; cantidad_inicial: number;
  restante_cache: number; fecha_ingreso: string; fecha_vencimiento: string | null; deleted_at: string | null;
}
export interface Cliente {
  id: string; nombre: string; apellido: string; celular: string; direccion: string | null;
  limite_credito: number; saldo_cache: number; deleted_at: string | null;
}
export interface MovCC {
  id: string; cliente_id: string; tipo: "cargo" | "pago" | "ajuste"; monto: number;
  medio_pago: MedioPago | null; venta_id: string | null; caja_sesion_id: string | null; creado_cliente_at: string;
}
export interface Venta {
  id: string; caja_sesion_id: string; usuario_id: string; cliente_id: string | null; total: number;
  estado: "completada" | "anulada"; creado_cliente_at: string;
}
export interface VentaItem {
  id: string; venta_id: string; producto_id: string; lote_id: string | null;
  cantidad: number; precio_unitario: number; costo_unitario: number; descuento: number;
}
export interface VentaPago { id: string; venta_id: string; medio: MedioPago; monto: number }
export interface CajaSesion {
  id: string; usuario_id: string; monto_inicial: number; abierta_at: string; cerrada_at: string | null;
  monto_contado_real: number | null; monto_teorico: number | null; diferencia: number | null;
}
export interface CajaMov { id: string; caja_sesion_id: string; tipo: "ingreso" | "egreso"; monto: number; concepto: string; creado_at: string }

export type TipoOp =
  | "producto_upsert" | "lote_crear" | "ajuste_stock" | "cliente_upsert" | "pago_cliente"
  | "caja_abrir" | "caja_movimiento" | "caja_cerrar" | "venta" | "anular_venta";

// ============ FEFO (primero vence, primero sale) ============
type LoteMin = Pick<Lote, "id" | "restante_cache" | "fecha_vencimiento" | "fecha_ingreso" | "costo_unitario">;

export function ordenFEFO<T extends LoteMin>(lotes: T[]): T[] {
  return [...lotes].sort((a, b) => {
    const va = a.fecha_vencimiento ?? "9999-12-31", vb = b.fecha_vencimiento ?? "9999-12-31";
    return va.localeCompare(vb) || a.fecha_ingreso.localeCompare(b.fecha_ingreso) || a.id.localeCompare(b.id);
  });
}

export interface Asignacion { lote_id: string | null; cantidad: number; costo_unitario: number; fecha_vencimiento: string | null }

export function asignarFEFO(lotes: LoteMin[], cantidad: number): Asignacion[] {
  const res: Asignacion[] = [];
  let falta = r3(cantidad);
  for (const l of ordenFEFO(lotes.filter((x) => x.restante_cache > 0))) {
    if (falta <= 0) break;
    const take = Math.min(l.restante_cache, falta);
    res.push({ lote_id: l.id, cantidad: r3(take), costo_unitario: l.costo_unitario, fecha_vencimiento: l.fecha_vencimiento });
    falta = r3(falta - take);
  }
  if (falta > 0) {
    // sin lote con stock: se vende igual (la venta ya ocurrió) usando el último costo conocido
    const ultimo = [...lotes].sort((a, b) => b.fecha_ingreso.localeCompare(a.fecha_ingreso))[0];
    res.push({ lote_id: null, cantidad: falta, costo_unitario: ultimo?.costo_unitario ?? 0, fecha_vencimiento: null });
  }
  return res;
}

// ============ Vencimientos y liquidación automática ============
export function diasParaVencer(fechaISO: string, hoy = new Date()): number {
  const d = new Date(fechaISO + "T00:00:00");
  const h = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.round((d.getTime() - h.getTime()) / 86400000);
}
export const lotesPorVencer = <T extends Pick<Lote, "fecha_vencimiento" | "restante_cache">>(lotes: T[], dias = 15, hoy = new Date()) =>
  lotes.filter((l) => l.restante_cache > 0 && l.fecha_vencimiento && diasParaVencer(l.fecha_vencimiento, hoy) <= dias);

/** Precio con descuento de liquidación si el lote vence dentro de `dias` (default 15). */
export function precioLiquidacion(precio: number, venc: string | null, pct = 20, dias = 15, hoy = new Date()) {
  if (!venc || diasParaVencer(venc, hoy) > dias) return { precio, descuento: 0 };
  const p = Math.round(precio * (1 - pct / 100));
  return { precio: p, descuento: precio - p };
}

// ============ Cuentas corrientes ============
export const saldoCliente = (movs: Pick<MovCC, "tipo" | "monto">[]) =>
  movs.reduce((s, m) => s + (m.tipo === "pago" ? -m.monto : m.monto), 0);

export interface Partida { cargo_id: string; venta_id: string | null; fecha: string; monto: number; pagado: number; estado: "Pendiente" | "Parcial" | "Pagado" }

/** Reparte los pagos sobre los cargos más viejos (FIFO) para derivar Pendiente/Pagado por partida. */
export function partidasFiado(movs: MovCC[]): Partida[] {
  const anuladas = new Set(movs.filter((m) => m.tipo === "ajuste" && m.monto < 0 && m.venta_id).map((m) => m.venta_id));
  const cargos = movs.filter((m) => m.tipo === "cargo" && !anuladas.has(m.venta_id))
    .sort((a, b) => a.creado_cliente_at.localeCompare(b.creado_cliente_at));
  let pagos = movs.filter((m) => m.tipo === "pago").reduce((s, m) => s + m.monto, 0);
  return cargos.map((c) => {
    const aplicado = Math.min(c.monto, pagos);
    pagos -= aplicado;
    return { cargo_id: c.id, venta_id: c.venta_id, fecha: c.creado_cliente_at, monto: c.monto, pagado: aplicado,
      estado: aplicado >= c.monto ? "Pagado" : aplicado > 0 ? "Parcial" : "Pendiente" };
  });
}

// ============ WhatsApp / tickets ============
export function normalizarCelular(cel: string): string {
  let d = cel.replace(/\D/g, "").replace(/^0+/, "");
  if (!d.startsWith("54")) d = "549" + d; // Argentina móvil: 549 + área + número (sin 15)
  return d;
}
export const linkWhatsApp = (cel: string, texto: string) => `https://wa.me/${normalizarCelular(cel)}?text=${encodeURIComponent(texto)}`;

export function resumenCuentaTexto(c: Pick<Cliente, "nombre" | "apellido">, movs: MovCC[], comercio: string): string {
  const L = [`*${comercio}* - Resumen de cuenta`, `Cliente: ${c.nombre} ${c.apellido}`, ""];
  for (const p of partidasFiado(movs)) {
    L.push(`${p.fecha.slice(0, 10)}  ${fmt(p.monto)}  ${p.estado}${p.estado === "Parcial" ? ` (pagó ${fmt(p.pagado)})` : ""}`);
  }
  const pagos = movs.filter((m) => m.tipo === "pago");
  if (pagos.length) { L.push("", "Pagos a cuenta:"); pagos.forEach((m) => L.push(`${m.creado_cliente_at.slice(0, 10)}  ${fmt(m.monto)} (${m.medio_pago})`)); }
  L.push("", `*SALDO ADEUDADO: ${fmt(saldoCliente(movs))}*`);
  return L.join("\n");
}

export function ticketTexto(p: { comercio: string; venta: Venta; items: (VentaItem & { nombre: string })[]; pagos: VentaPago[]; ancho?: number }): string {
  const w = p.ancho ?? 32; // 58mm ≈ 32 cols, 80mm ≈ 48 cols
  const linea = "-".repeat(w);
  const dosCols = (a: string, b: string) => a.slice(0, Math.max(0, w - b.length - 1)).padEnd(w - b.length) + b;
  const L = [p.comercio.slice(0, w), new Date(p.venta.creado_cliente_at).toLocaleString("es-AR"), linea];
  for (const i of p.items) L.push(dosCols(`${i.cantidad} x ${i.nombre}`, fmt(subtotal(i.precio_unitario, i.cantidad))));
  L.push(linea, dosCols("TOTAL", fmt(p.venta.total)));
  for (const x of p.pagos) L.push(dosCols(x.medio, fmt(x.monto)));
  L.push(linea, "Gracias por su compra");
  return L.join("\n");
}

// ============ Caja ============
export function calcularArqueo(a: { monto_inicial: number; ventas_efectivo: number; pagos_fiado_efectivo: number; ingresos: number; egresos: number; contado?: number }) {
  const teorico = a.monto_inicial + a.ventas_efectivo + a.pagos_fiado_efectivo + a.ingresos - a.egresos;
  return { teorico, diferencia: a.contado == null ? null : a.contado - teorico };
}

// ============ Reportes ============
export function desglosePorMedio(ventas: Venta[], pagos: VentaPago[]) {
  const ok = new Set(ventas.filter((v) => v.estado === "completada").map((v) => v.id));
  const r = { efectivo: 0, transferencia: 0, fiado: 0, total: 0 };
  for (const p of pagos) if (ok.has(p.venta_id)) { r[p.medio] += p.monto; r.total += p.monto; }
  return r;
}
export function gananciaNeta(ventas: Venta[], items: VentaItem[]) {
  const ok = new Set(ventas.filter((v) => v.estado === "completada").map((v) => v.id));
  return items.filter((i) => ok.has(i.venta_id)).reduce((s, i) => s + Math.round((i.precio_unitario - i.costo_unitario) * i.cantidad), 0);
}
export function topProductos(ventas: Venta[], items: VentaItem[], n = 10) {
  const ok = new Set(ventas.filter((v) => v.estado === "completada").map((v) => v.id));
  const m = new Map<string, number>();
  for (const i of items) if (ok.has(i.venta_id)) m.set(i.producto_id, (m.get(i.producto_id) ?? 0) + i.cantidad);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([producto_id, cantidad]) => ({ producto_id, cantidad: r3(cantidad) }));
}
export function sinRotacion(productos: Producto[], itemsDesdeFecha: VentaItem[]) {
  const vendidos = new Set(itemsDesdeFecha.map((i) => i.producto_id));
  return productos.filter((p) => p.activo && !p.deleted_at && p.stock_cache > 0 && !vendidos.has(p.id));
}
