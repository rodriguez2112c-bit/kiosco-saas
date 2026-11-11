import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { authRoutes } from "./auth.js";
import { syncRoutes } from "./sync.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.JWT_SECRET ?? "dev-secret-cambiar" });

app.get("/api/health", async () => ({ ok: true }));
await app.register(authRoutes, { prefix: "/api" });
await app.register(syncRoutes, { prefix: "/api" });

app.setErrorHandler((err, _req, reply) => {
  const status = (err as { statusCode?: number }).statusCode ?? 400;
  reply.code(status).send({ error: err.message });
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
