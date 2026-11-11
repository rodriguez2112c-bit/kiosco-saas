-- Esquema PostgreSQL. Montos en CENTAVOS (bigint). IDs UUID generados por el cliente (v7).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SEQUENCE IF NOT EXISTS sync_seq_global;

-- Cada INSERT/UPDATE en tablas sincronizables recibe un número de secuencia: es el "cursor" del pull.
CREATE OR REPLACE FUNCTION bump_sync_seq() RETURNS trigger AS $$
BEGIN NEW.sync_seq := nextval('sync_seq_global'); NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- ===== Núcleo / multi-tenant =====
CREATE TABLE comercios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text UNIQUE NOT NULL,            -- lo que se tipea en el login
  nombre text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  config jsonb NOT NULL DEFAULT '{"descuento_liquidacion_pct":20,"dias_alerta_vencimiento":15}',
  creado_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sucursales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id uuid NOT NULL REFERENCES comercios(id), nombre text NOT NULL
);
CREATE TABLE usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id uuid NOT NULL REFERENCES comercios(id),
  nombre text NOT NULL, rol text NOT NULL CHECK (rol IN ('dueno','cajero')),
  pin_hash text NOT NULL, activo boolean NOT NULL DEFAULT true,
  UNIQUE (comercio_id, nombre)
);
CREATE TABLE dispositivos (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  nombre text, ultimo_sync_at timestamptz
);

-- ===== Inventario =====
CREATE TABLE categorias (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id), nombre text NOT NULL,
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE productos (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  categoria_id uuid REFERENCES categorias(id),
  nombre text NOT NULL, tipo text NOT NULL DEFAULT 'unidad' CHECK (tipo IN ('unidad','peso','elaborado')),
  plu text, precio_venta bigint NOT NULL DEFAULT 0,
  stock_minimo numeric(12,3) NOT NULL DEFAULT 0,
  stock_cache numeric(12,3) NOT NULL DEFAULT 0,   -- = SUM(movimientos_stock.delta), lo mantiene un trigger
  activo boolean NOT NULL DEFAULT true, version int NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX productos_plu_uq ON productos (comercio_id, plu) WHERE plu IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE codigos_barras (
  ean text NOT NULL, comercio_id uuid NOT NULL REFERENCES comercios(id),
  producto_id uuid NOT NULL REFERENCES productos(id),
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  PRIMARY KEY (comercio_id, ean)
);
CREATE TABLE lotes (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  producto_id uuid NOT NULL REFERENCES productos(id),
  costo_unitario bigint NOT NULL, cantidad_inicial numeric(12,3) NOT NULL,
  restante_cache numeric(12,3) NOT NULL DEFAULT 0,
  fecha_ingreso date NOT NULL DEFAULT current_date, fecha_vencimiento date,
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE movimientos_stock (          -- LIBRO MAYOR de stock: solo se inserta, nunca se edita
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id uuid NOT NULL REFERENCES comercios(id),
  producto_id uuid NOT NULL REFERENCES productos(id), lote_id uuid REFERENCES lotes(id),
  delta numeric(12,3) NOT NULL,
  motivo text NOT NULL CHECK (motivo IN ('venta','compra','ajuste','anulacion','merma')),
  ref_id uuid, dispositivo_id uuid, usuario_id uuid,
  creado_cliente_at timestamptz, recibido_server_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON movimientos_stock (producto_id); CREATE INDEX ON movimientos_stock (ref_id);

CREATE OR REPLACE FUNCTION aplicar_mov_stock() RETURNS trigger AS $$
BEGIN
  UPDATE productos SET stock_cache = stock_cache + NEW.delta WHERE id = NEW.producto_id;
  IF NEW.lote_id IS NOT NULL THEN UPDATE lotes SET restante_cache = restante_cache + NEW.delta WHERE id = NEW.lote_id; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_mov_stock AFTER INSERT ON movimientos_stock FOR EACH ROW EXECUTE FUNCTION aplicar_mov_stock();

-- ===== Clientes y cuenta corriente =====
CREATE TABLE clientes (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  nombre text NOT NULL, apellido text NOT NULL, celular text NOT NULL, direccion text,
  limite_credito bigint NOT NULL DEFAULT 0, saldo_cache bigint NOT NULL DEFAULT 0,
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
-- Libro mayor: cargo suma, pago resta, ajuste suma (puede ser negativo, p.ej. anulación de venta)
CREATE TABLE cuenta_corriente_mov (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  cliente_id uuid NOT NULL REFERENCES clientes(id),
  tipo text NOT NULL CHECK (tipo IN ('cargo','pago','ajuste')), monto bigint NOT NULL,
  medio_pago text CHECK (medio_pago IN ('efectivo','transferencia')),
  venta_id uuid, caja_sesion_id uuid,
  creado_cliente_at timestamptz NOT NULL DEFAULT now(),
  sync_seq bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION aplicar_mov_cc() RETURNS trigger AS $$
BEGIN
  UPDATE clientes SET saldo_cache = saldo_cache + (CASE WHEN NEW.tipo = 'pago' THEN -NEW.monto ELSE NEW.monto END)
  WHERE id = NEW.cliente_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_mov_cc AFTER INSERT ON cuenta_corriente_mov FOR EACH ROW EXECUTE FUNCTION aplicar_mov_cc();

-- ===== Caja =====
CREATE TABLE caja_sesiones (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  dispositivo_id uuid, usuario_id uuid, monto_inicial bigint NOT NULL DEFAULT 0,
  abierta_at timestamptz NOT NULL, cerrada_at timestamptz,
  monto_teorico bigint, monto_contado_real bigint, diferencia bigint
);
CREATE TABLE caja_movimientos (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  caja_sesion_id uuid NOT NULL REFERENCES caja_sesiones(id),
  tipo text NOT NULL CHECK (tipo IN ('ingreso','egreso')), monto bigint NOT NULL, concepto text, creado_at timestamptz NOT NULL
);

-- ===== Ventas =====
CREATE TABLE ventas (
  id uuid PRIMARY KEY, comercio_id uuid NOT NULL REFERENCES comercios(id),
  caja_sesion_id uuid REFERENCES caja_sesiones(id), usuario_id uuid, dispositivo_id uuid,
  cliente_id uuid REFERENCES clientes(id), total bigint NOT NULL,
  estado text NOT NULL DEFAULT 'completada' CHECK (estado IN ('completada','anulada')),
  creado_cliente_at timestamptz NOT NULL, recibido_server_at timestamptz NOT NULL DEFAULT now(), anulada_at timestamptz
);
CREATE INDEX ON ventas (comercio_id, creado_cliente_at);
CREATE TABLE venta_items (
  id uuid PRIMARY KEY, venta_id uuid NOT NULL REFERENCES ventas(id), producto_id uuid NOT NULL REFERENCES productos(id),
  lote_id uuid REFERENCES lotes(id), cantidad numeric(12,3) NOT NULL,
  precio_unitario bigint NOT NULL, costo_unitario bigint NOT NULL DEFAULT 0, descuento bigint NOT NULL DEFAULT 0
);
CREATE TABLE venta_pagos (
  id uuid PRIMARY KEY, venta_id uuid NOT NULL REFERENCES ventas(id),
  medio text NOT NULL CHECK (medio IN ('efectivo','transferencia','fiado')), monto bigint NOT NULL
);

-- ===== Control =====
CREATE TABLE auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comercio_id uuid NOT NULL REFERENCES comercios(id),
  usuario_id uuid, entidad text NOT NULL, entidad_id uuid, accion text NOT NULL,
  antes jsonb, despues jsonb, creado_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sync_operaciones (            -- idempotencia: un op_id se procesa UNA sola vez
  op_id uuid PRIMARY KEY, comercio_id uuid NOT NULL, dispositivo_id uuid, tipo text NOT NULL,
  procesada_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comercio_id uuid NOT NULL REFERENCES comercios(id),
  tipo text NOT NULL, detalle jsonb, creada_at timestamptz NOT NULL DEFAULT now(), resuelta boolean NOT NULL DEFAULT false
);

-- Triggers de sync_seq
CREATE TRIGGER s_categorias BEFORE INSERT OR UPDATE ON categorias FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
CREATE TRIGGER s_productos  BEFORE INSERT OR UPDATE ON productos  FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
CREATE TRIGGER s_codigos    BEFORE INSERT OR UPDATE ON codigos_barras FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
CREATE TRIGGER s_lotes      BEFORE INSERT OR UPDATE ON lotes      FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
CREATE TRIGGER s_clientes   BEFORE INSERT OR UPDATE ON clientes   FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
CREATE TRIGGER s_cc         BEFORE INSERT OR UPDATE ON cuenta_corriente_mov FOR EACH ROW EXECUTE FUNCTION bump_sync_seq();
