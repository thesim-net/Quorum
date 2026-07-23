import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (error) => {
  console.error('Unexpected database pool error:', error);
});

/**
 * Runs a single query against the pool.
 *
 * @param {string} text SQL with $1-style placeholders.
 * @param {Array<*>} params Bound parameters.
 * @returns {Promise<import('pg').QueryResult>} Query result.
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Runs a function inside a transaction, rolling back if it throws.
 *
 * @param {(client: import('pg').PoolClient) => Promise<*>} fn Receives a
 *   dedicated client; every query inside it shares one transaction.
 * @returns {Promise<*>} Whatever `fn` resolves to.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
