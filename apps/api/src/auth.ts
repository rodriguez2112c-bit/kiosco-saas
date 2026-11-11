import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, tx } from "./db.js";

export interface Sesion { comercio_id: string; usuario_id: string; rol: "dueno" | "cajero" }

export async function authRoutes(app: FastifyInstance) {
  // Alta de un comercio nuevo + usuario dueño
  app.post("/auth/registro", async (req, reply) => {
    const b = z.object({ codigo: z.string().min(3), comercio: z.string().min(2), nombre: z.string().min(2), pin: z.string().min(4) }).parse(req.body);
    const r = await tx(async (c) => {
      const com = await c.query("INSERT INTO comercios (codigo, nombre) VALUES ($1,$2) RETURNING id", [b.codigo.toLowerCase(), b.comercio]);
      const cid = com.rows[0].id;
      await c.query("INSERT INTO sucursales (comercio_id, nombre) VALUES ($1,'Principal')", [cid]);
      const u = await c.query("INSERT INTO usuarios (comercio_id,nombre,rol,pin_hash) VALUES ($1,$2,'dueno',$3) RETURNING id", [cid, b.nombre, await bcrypt.hash(b.pin, 10)]);
      return { comercio_id: cid, usuario_id: u.rows[0].id as string, rol: "dueno" as const, comercio_nombre: b.comercio };
    }).catch(() => null);
    if (!r) return reply.code(409).send({ error: "El código de comercio ya existe" });
    return { token: app.jwt.sign({ comercio_id: r.comercio_id, usuario_id: r.usuario_id, rol: r.rol }, { expiresIn: "30d" }), ...r };
  });

  app.post("/auth/login", async (req, reply) => {
    const b = z.object({ codigo: z.string(), nombre: z.string(), pin: z.string() }).parse(req.body);
    const { rows } = await pool.query(
      `SELECT u.id, u.comercio_id, u.rol, u.pin_hash, c.nombre AS comercio_nombre FROM usuarios u
       JOIN comercios c ON c.id = u.comercio_id WHERE c.codigo = $1 AND u.nombre = $2 AND u.activo`,
      [b.codigo.toLowerCase(), b.nombre]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(b.pin, u.pin_hash))) return reply.code(401).send({ error: "Credenciales inválidas" });
    return { token: app.jwt.sign({ comercio_id: u.comercio_id, usuario_id: u.id, rol: u.rol }, { expiresIn: "30d" }),
      comercio_id: u.comercio_id, usuario_id: u.id, rol: u.rol, comercio_nombre: u.comercio_nombre };
  });
}
