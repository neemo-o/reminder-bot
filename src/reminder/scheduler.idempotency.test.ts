import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../db/init.js';
import { UserRepo } from '../db/userRepo.js';
import { ReminderRepo } from '../db/reminderRepo.js';
import { ReminderScheduler } from './scheduler.js';
import type { BotSender } from '../whatsapp/client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PHONE = '5511999999999';
const HOUR = 3600 * 1000;

const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

describe('ReminderScheduler - idempotência de entrega (delivery_log)', () => {
  let dbPath: string;
  let db: Database.Database;
  let repo: ReminderRepo;
  let userId: string;
  let sender: BotSender & { sendMessage: ReturnType<typeof vi.fn> };
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-sched-${Date.now()}-${Math.random()}.db`);
    db = initDb(dbPath);
    repo = new ReminderRepo(db);
    userId = new UserRepo(db).getOrCreateUser(PHONE, 'Tester').id;
    sender = { sendMessage: vi.fn(async () => true) };
    scheduler = new ReminderScheduler({ reminderRepo: repo, sender });
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('não envia duas vezes o mesmo lembrete no mesmo trigger_at (duas chamadas sequenciais)', async () => {
    const now = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'tomar remédio',
      triggerAt: now - 1000,
    });

    await scheduler.processDueReminders(now);
    await scheduler.processDueReminders(now); // segunda chamada para o mesmo trigger

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('não envia duas vezes quando duas chamadas concorrentes disputam o mesmo lembrete', async () => {
    const now = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'concorrência',
      triggerAt: now - 1000,
    });

    // Duas chamadas "concorrentes" (sequenciais no JS, mas simulando disputa pelo delivery_log)
    await Promise.all([
      scheduler.processDueReminders(now),
      scheduler.processDueReminders(now),
    ]);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('retry após falha de envio: segundo tick consegue entregar', async () => {
    const trigger = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'tentar de novo',
      triggerAt: trigger - 1000,
    });

    sender.sendMessage.mockRejectedValueOnce(new Error('boom'));
    await scheduler.processDueReminders(trigger);
    expect(repo.getReminderById(r.id)!.status).toBe('pending');

    sender.sendMessage.mockResolvedValue(true);
    await scheduler.processDueReminders(trigger + 1000);
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('delivery_log impede reentrega mesmo que o lembrete ainda esteja pendente (estado inconsistente)', async () => {
    const now = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'inconsistente',
      triggerAt: now - 1000,
    });

    // Primeira entrega completa normalmente
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.getReminderById(r.id)!.status).toBe('completed');

    // Força o lembrete de volta para pending sem apagar o delivery_log
    repo.updateReminderStatus(r.id, 'pending');

    // Terceira chamada não deve reenviar porque delivery_log já tem 'delivered'
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });
});
