import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from './init.js';
import { UserRepo } from './userRepo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('initDb - chaves estrangeiras e integridade', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-init-${Date.now()}-${Math.random()}.db`);
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('PRAGMA foreign_keys está ativo (retorna 1)', () => {
    const r = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(r.foreign_keys).toBe(1);
  });

  it('aplica as colunas de controle de entrega em um banco novo', () => {
    const columns = db.pragma('table_info(delivery_log)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('whatsapp_msg_id');
    expect(columns.map((column) => column.name)).toContain('lease_token');
  });

  it('rejeita inserção de reminder com user_id inexistente (FK)', () => {
    const stmt = db.prepare(
      `INSERT INTO reminders (id, user_id, phone, message, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      stmt.run('reminder-1', 'usuario-inexistente', '5511999999999', 'msg', Date.now(), 'pending', Date.now())
    ).toThrow();
  });

  it('aceita inserção de reminder com user_id válido', () => {
    const userRepo = new UserRepo(db);
    const user = userRepo.getOrCreateUser('5511999999999', 'Tester');

    const stmt = db.prepare(
      `INSERT INTO reminders (id, user_id, phone, message, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      stmt.run('reminder-1', user.id, user.phone, 'msg', Date.now(), 'pending', Date.now())
    ).not.toThrow();
  });

  it('CHECK constraint rejeita status inválido', () => {
    const userRepo = new UserRepo(db);
    const user = userRepo.getOrCreateUser('5511999999999', 'Tester');

    const stmt = db.prepare(
      `INSERT INTO reminders (id, user_id, phone, message, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      stmt.run('reminder-2', user.id, user.phone, 'msg', Date.now(), 'invalido' as any, Date.now())
    ).toThrow();
  });

  it('CHECK constraint rejeita trigger_at negativo', () => {
    const userRepo = new UserRepo(db);
    const user = userRepo.getOrCreateUser('5511999999999', 'Tester');

    const stmt = db.prepare(
      `INSERT INTO reminders (id, user_id, phone, message, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      stmt.run('reminder-3', user.id, user.phone, 'msg', -1, 'pending', Date.now())
    ).toThrow();
  });
});
