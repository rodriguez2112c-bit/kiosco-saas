import { readFileSync } from "node:fs";
import pg from "pg";

const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(sql);
await c.end();
console.log("Esquema creado.");
