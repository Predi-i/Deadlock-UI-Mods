import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";

function positiveLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(100000, Math.floor(parsed));
}

/**
 * Minimal Durable Object storage-compatible adapter backed by one SQLite file.
 *
 * Values use V8's structured serializer so Uint8Array-backed Pixel Battle tiles,
 * arrays and plain lobby objects round-trip without a JSON conversion. All public
 * methods are async to preserve the interface worker.core.js already consumes.
 */
export class SqliteStorage {
  constructor(filename) {
    this.filename = resolve(filename);
    mkdirSync(dirname(this.filename), { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.inTransaction = false;

    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA temp_store=MEMORY");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS kv (" +
      "key TEXT PRIMARY KEY COLLATE BINARY, " +
      "value BLOB NOT NULL" +
      ") WITHOUT ROWID"
    );

    this.getStatement = this.db.prepare("SELECT value FROM kv WHERE key = ?");
    this.putStatement = this.db.prepare(
      "INSERT INTO kv(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    this.deleteStatement = this.db.prepare("DELETE FROM kv WHERE key = ?");
  }

  async get(key) {
    const row = this.getStatement.get(String(key));
    return row ? deserialize(row.value) : undefined;
  }

  async put(key, value) {
    this.putStatement.run(String(key), serialize(value));
  }

  async delete(key) {
    return this.deleteStatement.run(String(key)).changes > 0;
  }

  async list(options) {
    const opts = options || {};
    const where = [];
    const params = [];

    if (opts.prefix !== undefined && String(opts.prefix) !== "") {
      const prefix = String(opts.prefix);
      where.push("key >= ? AND key < ?");
      params.push(prefix, prefix + "\uffff");
    }
    if (opts.start !== undefined) {
      where.push("key >= ?");
      params.push(String(opts.start));
    }
    if (opts.startAfter !== undefined) {
      where.push("key > ?");
      params.push(String(opts.startAfter));
    }
    if (opts.end !== undefined) {
      where.push("key < ?");
      params.push(String(opts.end));
    }

    let sql = "SELECT key, value FROM kv";
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += opts.reverse ? " ORDER BY key DESC" : " ORDER BY key ASC";
    const limit = positiveLimit(opts.limit);
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params);
    const result = new Map();
    for (let i = 0; i < rows.length; i++) {
      result.set(rows[i].key, deserialize(rows[i].value));
    }
    return result;
  }

  async transaction(callback) {
    if (this.inTransaction) {
      throw new Error("Nested SQLite storage transactions are not supported");
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = await callback(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("SQLite rollback failed:", rollbackError);
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close() {
    try {
      this.db.exec("PRAGMA optimize");
    } finally {
      this.db.close();
    }
  }
}
