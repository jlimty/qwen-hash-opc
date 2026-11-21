const passJson = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

export const pgTypes = Object.freeze({
  json: { to: 114, from: [114], serialize: passJson, parse: JSON.parse },
  jsonb: { to: 3802, from: [3802], serialize: passJson, parse: JSON.parse },
  bigint: { to: 20, from: [20], serialize: String, parse: Number },
});

function tlsOptions(url) {
  try {
    const parsed = new URL(url);
    const mode = parsed.searchParams.get('sslmode');
    if (!parsed.hostname || !mode || mode === 'disable') return undefined;
    return { servername: parsed.hostname, rejectUnauthorized: true };
  } catch { return undefined; }
}

export function connectPg(postgres, url, options = {}) {
  const ssl = options.ssl === undefined ? tlsOptions(url) : options.ssl;
  return postgres(url, { prepare: false, max: 3, idle_timeout: 5, connect_timeout: 10, onnotice() {}, types: pgTypes, ...options, ...(ssl === undefined ? {} : { ssl }) });
}

export function createPgDatabase(sql) {
  const runner = (target) => ({
    async query(text, params = []) {
      return { rows: [...await target.unsafe(text, params)] };
    },
  });
  return {
    ...runner(sql),
    async exec(text) {
      await sql.unsafe(text).simple();
    },
    transaction: (work) => sql.begin((tx) => work(runner(tx))),
    close: () => sql.end({ timeout: 2 }),
  };
}

export function poolTypes(defaultTypes) {
  return { getTypeParser: (oid, format) => (oid === 20 ? (value) => Number(value) : defaultTypes.getTypeParser(oid, format)) };
}

export function createPoolDatabase(pool) {
  const runner = (target) => ({
    async query(text, params = []) {
      return { rows: (await (params.length ? target.query(text, params) : target.query(text))).rows };
    },
  });
  return {
    ...runner(pool),
    async exec(text) {
      await pool.query(text);
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(runner(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
