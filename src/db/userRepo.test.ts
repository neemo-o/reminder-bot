import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from './init.js';
import { UserRepo } from './userRepo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UserRepo.getOrCreateUser - segurança contra concorrência', () => {
  let dbPath: string;
  let db: Database.Database;
  let repo: UserRepo;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-users-${Date.now()}-${Math.random()}.db`);
    db = initDb(dbPath);
    repo = new UserRepo(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('múltiplas chamadas com mesmo telefone criam exatamente um usuário', () => {
    const phone = '5511999999999';
    const results = Array.from({ length: 20 }, () => repo.getOrCreateUser(phone, 'Tester'));

    const ids = results.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(1);

    const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE phone = ?').get(phone) as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it('retorna o mesmo id para chamadas repetidas com mesmo telefone', () => {
    const phone = '5511999999998';
    const first = repo.getOrCreateUser(phone, 'Primeiro');
    const second = repo.getOrCreateUser(phone, 'Segundo');

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Primeiro'); // nome não sobrescrito
  });

  it('cria usuários distintos para telefones distintos', () => {
    const a = repo.getOrCreateUser('5511999999997', 'A');
    const b = repo.getOrCreateUser('5511999999996', 'B');

    expect(a.id).not.toBe(b.id);
  });
});
