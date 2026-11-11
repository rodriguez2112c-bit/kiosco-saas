# Kiosco POS — PWA offline-first

Monorepo pnpm: `apps/web` (React + Vite + Dexie + PWA), `apps/api` (Fastify + PostgreSQL), `packages/shared` (lógica común: FEFO, dinero, fiados, arqueo, reportes).

## Puesta en marcha
```bash
pnpm install
docker compose up -d                          # Postgres
cp apps/api/.env.example apps/api/.env        # editar JWT_SECRET
pnpm db:init                                  # crea las tablas
pnpm test                                     # tests de la lógica compartida
pnpm dev:api                                  # http://localhost:3000
pnpm dev:web                                  # http://localhost:5173 (proxy /api -> :3000)
```
Primer uso: "Soy nuevo" → crea el comercio y el usuario dueño. Luego: Inventario (producto + lote) → Caja (abrir) → Vender.

## Probar el modo offline
1. Abrí la app con conexión (se cachea el shell y se descarga el catálogo).
2. DevTools → Network → *Offline*. Vendé: el contador "N sin sincronizar" sube.
3. Volvé a *Online*: se sincroniza solo. Reenviar una venta no la duplica (idempotencia por `op_id`).

## Cómo funciona la sincronización
- Cada acción escribe en Dexie **y** en `outbox` en una sola transacción (`apps/web/src/db/ops.ts`).
- `POST /api/sync/push` procesa la cola en orden; cada operación es una transacción SQL con su `op_id` en `sync_operaciones`.
- El stock es un libro mayor (`movimientos_stock`); `stock_cache` lo mantiene un trigger. Ventas offline nunca se rechazan: si falta stock se reasigna por FEFO y, si aun así no alcanza, queda negativo + alerta.
- `GET /api/sync/pull?cursor=N` devuelve cambios de catálogo/clientes/cuenta corriente ordenados por `sync_seq`.
- Tras cada pull, lo que sigue en cola se re-aplica sobre lo recién sobrescrito (`aplicarDeltas`).

## Para producción
- Servir web y API bajo el mismo dominio con HTTPS (requisito de PWA y de la cámara). Ej.: Caddy/Nginx: `/api` → Fastify, resto → `apps/web/dist`.
- Activar RLS en Postgres por `comercio_id` (hoy el aislamiento lo hacen las consultas).
- Backups diarios de Postgres. Rotar `JWT_SECRET`.
- Impresión térmica directa (ESC/POS por WebUSB/Bluetooth) y la API oficial de WhatsApp quedan como etapa siguiente; hoy se usa el diálogo de impresión del navegador y links `wa.me`.
- Pendiente a futuro: roles con permisos finos en la UI (anular/editar precios solo dueño), reportes multi-dispositivo desde el servidor, edición de categorías.

## No verificado
Se probó la lógica de `packages/shared` (`pnpm test`). El resto (API, web, PWA) está escrito pero **no se compiló ni ejecutó** en este entorno sin red: al hacer `pnpm install` + `pnpm --filter web typecheck` / `pnpm --filter api typecheck` pueden aparecer ajustes menores de tipos.
