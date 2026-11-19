import pg from 'pg';

// Timestamps are stored as BIGINT milliseconds and counts come back as BIGINT/NUMERIC.
// Both fit comfortably in a JS number, so return numbers instead of strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** `?` placeholders (SQLite style, as in the original Minilytics code) → `$1, $2, …`, skipping string literals. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += ch === '?' && !inStr ? `$${++n}` : ch;
  }
  return out;
}

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export class Statement {
  constructor(
    private db: Db,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  get isRead() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql);
  }

  async exec(q: Queryable = this.db.pool) {
    return q.query(toPgPlaceholders(this.sql), this.params as any[]);
  }

  async first<T = Record<string, any>>(): Promise<T | null> {
    return ((await this.exec()).rows[0] as T) ?? null;
  }

  async all<T = Record<string, any>>(): Promise<{ results: T[] }> {
    return { results: (await this.exec()).rows as T[] };
  }

  async run(): Promise<{ changes: number }> {
    return { changes: (await this.exec()).rowCount ?? 0 };
  }
}

export class Db {
  constructor(readonly pool: pg.Pool) {}

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  /**
   * Run several statements. Read-only batches run in parallel; anything that writes runs in one transaction,
   * in order, like D1's batch().
   */
  async batch(stmts: Statement[]): Promise<{ results: any[] }[]> {
    if (stmts.every((s) => s.isRead)) {
      return Promise.all(stmts.map(async (s) => ({ results: (await s.exec()).rows })));
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out: { results: any[] }[] = [];
      for (const s of stmts) out.push({ results: (await s.exec(client)).rows });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

export const db = new Db(
  new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/gitracker',
    max: Number(process.env.DB_POOL_SIZE) || 20,
  }),
);
