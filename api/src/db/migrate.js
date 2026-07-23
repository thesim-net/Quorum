import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies every migration that has not run yet, in filename order.
 *
 * Each file runs inside its own transaction and is recorded in
 * `schema_migrations`, so a failure leaves the database on the last complete
 * migration rather than half-applied.
 *
 * @returns {Promise<string[]>} Names of the migrations applied by this run.
 */
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  const ran = [];
  for (const name of files) {
    if (applied.has(name)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    await transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });

    console.log(`Applied migration ${name}`);
    ran.push(name);
  }

  if (ran.length === 0) console.log('Database schema is up to date.');
  return ran;
}

// Allow `npm run migrate` as well as import from the server's boot sequence.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
