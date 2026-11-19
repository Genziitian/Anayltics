import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db';

/** Apply every migrations/*.sql file that hasn't run yet, in name order, each in its own transaction. */
export async function migrate(dir = join(process.cwd(), 'migrations')) {
  await db.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const done = new Set((await db.pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [f, Date.now()]);
      await client.query('COMMIT');
      console.log(`migrated ${f}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
}

