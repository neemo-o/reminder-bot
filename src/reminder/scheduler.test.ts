import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../db/init.js';
import { ReminderRepo } from '../db/reminderRepo.js';
import { UserRepo } from '../db/userRepo.js';
import { ReminderScheduler } from './scheduler.js';
import { calculateNextTriggerAt } from './recurrence.js';
import type { BotSender } from '../whatsapp/client.js';

const PHONE = '5511999999999';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

describe('calculateNextTriggerAt', () => {
  it('diário: avança 1 dia preservando a hora', () => {
    const next = calculateNextTriggerAt(local(2026, 9, 16, 8, 0), { type: 'daily' });
    expect(next).toBe(local(2026, 9, 17, 8, 0));
  });

  it('semanal com dias: sexta -> próxima segunda', () => {
    const next = calculateNextTriggerAt(local(2026, 9, 16, 19, 0), { type: 'weekly', daysOfWeek: [1, 3] });
    expect(next).toBe(local(2026, 9, 19, 19, 0));
  });

  it('mensal dia 31: clamp para 28 de fevereiro', () => {
    const next = calculateNextTriggerAt(local(2026, 0, 31, 9, 0), { type: 'monthly', dayOfMonth: 31 });
    expect(next).toBe(local(2026, 1, 28, 9, 0));
  });

  it('intervalo: soma intervalMs', () => {
    const next = calculateNextTriggerAt(local(2026, 9, 16, 10, 0), { type: 'interval', intervalMs: 2 * HOUR });
    expect(next).toBe(local(2026, 9, 16, 12, 0));
  });
});

describe('ReminderScheduler.processDueReminders', () => {
  let db: Database.Database;
  let repo: ReminderRepo;
  let userId: string;
  let sender: BotSender & { sendMessage: ReturnType<typeof vi.fn> };
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    db = initDb(':memory:');
    repo = new ReminderRepo(db);
    userId = new UserRepo(db).getOrCreateUser(PHONE, 'Tester').id;
    sender = { sendMessage: vi.fn(async () => true) };
    scheduler = new ReminderScheduler({ reminderRepo: repo, sender });
  });

  afterEach(() => {
    db.close();
  });

  it('entrega lembrete simples e marca como concluído', async () => {
    const now = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({ userId, phone: PHONE, message: 'tomar remédio', triggerAt: now - 1000 });

    await scheduler.processDueReminders(now);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage.mock.calls[0][0]).toBe(`${PHONE}@s.whatsapp.net`);
    expect(sender.sendMessage.mock.calls[0][1]).toContain('⏰ Lembrete:');
    expect(sender.sendMessage.mock.calls[0][1]).toContain('tomar remédio');
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('lembrete recorrente: mesma linha reagendada como pendente (sem duplicar)', async () => {
    const trigger = local(2026, 9, 17, 8, 0);
    const r = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'café',
      triggerAt: trigger,
      recurrence: { type: 'daily' },
    });

    await scheduler.processDueReminders(trigger + 1000);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    const after = repo.getReminderById(r.id)!;
    expect(after.status).toBe('pending');
    expect(after.triggerAt).toBe(local(2026, 9, 18, 8, 0));
    // nenhuma linha nova criada
    expect(repo.getRemindersForUser(userId)).toHaveLength(1);
  });

  it('falha de envio mantém pendente e tenta de novo no próximo tick', async () => {
    const trigger = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({ userId, phone: PHONE, message: 'tentar de novo', triggerAt: trigger - 1000 });

    sender.sendMessage.mockRejectedValueOnce(new Error('boom'));
    await scheduler.processDueReminders(trigger);
    expect(repo.getReminderById(r.id)!.status).toBe('pending');

    await scheduler.processDueReminders(trigger + 1000);
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('envio bloqueado (retorna false) mantém pendente', async () => {
    const trigger = local(2026, 9, 16, 10, 0);
    const r = repo.createReminder({ userId, phone: PHONE, message: 'bloqueado', triggerAt: trigger - 1000 });

    sender.sendMessage.mockResolvedValueOnce(false);
    await scheduler.processDueReminders(trigger);

    expect(repo.getReminderById(r.id)!.status).toBe('pending');
  });

  it('nada vencido: nenhum envio', async () => {
    const now = local(2026, 9, 16, 10, 0);
    repo.createReminder({ userId, phone: PHONE, message: 'futuro', triggerAt: now + HOUR });
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});
