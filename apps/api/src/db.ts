import pg from "pg";

pg.types.setTypeParser(20, (v) => Number(v));      // bigint -> number (centavos entran de sobra)
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number
pg.types.setTypeParser(1082, (v) => v);             // date -> 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
