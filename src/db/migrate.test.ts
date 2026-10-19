import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('runMigrations - migrações versionadas', () => {
  let migrationsDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    migrationsDir = path.join(os.tmpdir(), `test-migrations-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Cria migração de teste 001
    fs.writeFileSync(
      path.join(migrationsDir, '001_create_foo.sql'),
      `CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`
    );

    // Cria migração de teste 002
    fs.writeFileSync(
      path.join(migrationsDir, '002_create_bar.sql'),
      `CREATE TABLE IF NOT EXISTS bar (id INTEGER PRIMARY KEY, foo_id INTEGER NOT NULL REFERENCES foo(id));`
    );

    dbPath = path.join(os.tmpdir(), `test-migrate-${Date.now()}-${Math.random()}.db`);
    // Não usa initDb: evita aplicar as migrações reais (001_initial_schema, 002_delivery_log)
    // que conflitariam com as versões de teste. O runMigrations é responsável por criar
    // a tabela schema_migrations e aplicar os arquivos do diretório informado.
    db = new Database(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
    // limpa pasta de migrações de teste
    try { fs.rmSync(migrationsDir, { recursive: true, force: true }); } catch {}
  });

  it('aplica migrações em ordem e registra na schema_migrations', () => {
    runMigrations(db, migrationsDir);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('foo');
    expect(tableNames).toContain('bar');
    expect(tableNames).toContain('schema_migrations');

    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: string;
    }[];
    expect(applied.map((r) => r.version)).toEqual(['001_create_foo', '002_create_bar']);
  });

  it('não reaplica migrações já executadas (idempotente)', () => {
    runMigrations(db, migrationsDir);
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;

    runMigrations(db, migrationsDir);
    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;

    expect(countAfter).toBe(countBefore);
  });

  it('aplica apenas a nova migração ao adicionar um arquivo', () => {
    runMigrations(db, migrationsDir);

    fs.writeFileSync(
      path.join(migrationsDir, '003_create_baz.sql'),
      `CREATE TABLE IF NOT EXISTS baz (id INTEGER PRIMARY KEY, valor TEXT);`
    );

    runMigrations(db, migrationsDir);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baz'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: string;
    }[];
    expect(applied.map((r) => r.version)).toEqual([
      '001_create_foo',
      '002_create_bar',
      '003_create_baz',
    ]);
  });

  it('cria tabela schema_migrations mesmo sem arquivos de migração', () => {
    const emptyDir = path.join(os.tmpdir(), `test-empty-migrations-${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });

    runMigrations(db, emptyDir);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
  });

  it('preserva dados de um banco legado ao aplicar migrações atuais', () => {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        message TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        recurrence TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE TABLE delivery_log (
        reminder_id TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        delivered_at INTEGER NOT NULL,
        whatsapp_msg_id TEXT,
        lease_token TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY (reminder_id, trigger_at),
        FOREIGN KEY(reminder_id) REFERENCES reminders(id)
      );
      INSERT INTO users VALUES ('user-1', '5511999999999', 'Tester', 1);
      INSERT INTO reminders VALUES ('reminder-1', 'user-1', '5511999999999', 'legacy', 2, NULL, 'pending', 1);
      INSERT INTO delivery_log VALUES ('reminder-1', 2, 3, 'msg-1', NULL, 'delivered');
    `);

    runMigrations(db, path.resolve('src/db/migrations'));

    expect(db.prepare('SELECT message FROM reminders WHERE id = ?').get('reminder-1')).toEqual({
      message: 'legacy',
    });
    expect(db.prepare('SELECT whatsapp_msg_id FROM delivery_log WHERE reminder_id = ?').get('reminder-1')).toEqual({
      whatsapp_msg_id: 'msg-1',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db.prepare(`UPDATE reminders SET status = 'invalid' WHERE id = 'reminder-1'`).run()
    ).toThrow();
  });
});
