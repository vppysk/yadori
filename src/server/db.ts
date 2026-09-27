import { Pool, types, type PoolClient } from "pg";

// date はJSのDateに変換せず文字列のまま扱う（タイムゾーンのずれを避ける）。daterange は既定で文字列
types.setTypeParser(types.builtins.DATE, (v) => v);

const globalForDb = globalThis as unknown as { pgPool?: Pool };

function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL が未設定です");
  globalForDb.pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return globalForDb.pgPool;
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// "[2026-07-01,2026-11-01)" → 両端を含む日付（2026-07-01〜2026-10-31）
export function parseDateRange(range: string): { from: string; to: string } {
  const match = range.match(/^([[(])([^,]*),([^)\]]*)([)\]])$/);
  if (!match) throw new Error(`daterange を解釈できません: ${range}`);
  const [, lower, from, to, upper] = match;
  return {
    from: lower === "(" ? addDays(from, 1) : from,
    to: upper === ")" ? addDays(to, -1) : to,
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// クライアントに渡す時刻はISO文字列（UTC）に揃える。文字列のまま比較・並べ替えできる
export const ISO_TIMESTAMP = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
