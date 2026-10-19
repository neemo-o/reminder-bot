import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from './init.js';
import { UserRepo } from './userRepo.js';
import { ReminderRepo } from './reminderRepo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UserRepo.syncUserPhoneReminders', () => {
  let dbPath: string;
  let db: Database.Database;
  let userRepo: UserRepo;
  let reminderRepo: ReminderRepo;
  let userId: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-sync-${Date.now()}-${Math.random()}.db`);
    db = initDb(dbPath);
    userRepo = new UserRepo(db);
    reminderRepo = new ReminderRepo(db);
    userId = userRepo.getOrCreateUser('5511999999999', 'Tester').id;
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('atualiza apenas lembretes pendentes quando o telefone do usuário muda', () => {
    const pending = reminderRepo.createReminder({
      userId,
      phone: '5511999999999',
      message: 'pendente',
      triggerAt: Date.now() + 3600 * 1000,
    });
    const completed = reminderRepo.createReminder({
      userId,
      phone: '5511999999999',
      message: 'concluído',
      triggerAt: Date.now() + 3600 * 1000,
    });
    reminderRepo.updateReminderStatus(completed.id, 'completed');
    const cancelled = reminderRepo.createReminder({
      userId,
      phone: '5511999999999',
      message: 'cancelado',
      triggerAt: Date.now() + 3600 * 1000,
    });
    reminderRepo.updateReminderStatus(cancelled.id, 'cancelled');

    // Simula mudança de telefone do usuário
    const updatePhone = db.prepare('UPDATE users SET phone = ? WHERE id = ?');
    updatePhone.run('5511888888888', userId);

    const changed = userRepo.syncUserPhoneReminders(userId);
    expect(changed).toBe(1);

    const p = reminderRepo.getReminderById(pending.id)!;
    expect(p.phone).toBe('5511888888888');

    const c = reminderRepo.getReminderById(completed.id)!;
    expect(c.phone).toBe('5511999999999'); // snapshot mantido

    const ca = reminderRepo.getReminderById(cancelled.id)!;
    expect(ca.phone).toBe('5511999999999'); // snapshot mantido
  });

  it('retorna 0 quando não há lembretes pendentes para sincronizar', () => {
    const updatePhone = db.prepare('UPDATE users SET phone = ? WHERE id = ?');
    updatePhone.run('5511888888888', userId);

    const changed = userRepo.syncUserPhoneReminders(userId);
    expect(changed).toBe(0);
  });
});
