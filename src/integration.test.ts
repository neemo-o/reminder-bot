import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from './db/init.js';
import { ReminderRepo } from './db/reminderRepo.js';
import { UserRepo } from './db/userRepo.js';
import { MessageProcessor } from './reminder/processor.js';
import { ReminderScheduler } from './reminder/scheduler.js';
import { parseReminderDeterministic } from './ai/parseReminder.js';
import type { IncomingMessage } from './types/index.js';

const PHONE = '5511999999999';
const HOUR = 3600 * 1000;
// Sexta-feira, 16/10/2026, 10:00 (hora local)
const START = new Date(2026, 9, 16, 10, 0, 0, 0).getTime();

function makeMsg(text: string): IncomingMessage {
  return {
    id: 'msg-e2e',
    fromJid: `${PHONE}@s.whatsapp.net`,
    senderPhone: PHONE,
    isGroup: false,
    participant: undefined,
    text,
    timestamp: START,
  };
}

describe('E2E: mensagem -> lembrete -> disparo -> recorrência', () => {
  let db: Database.Database;
  let repo: ReminderRepo;
  let userRepo: UserRepo;
  let sender: { sendMessage: ReturnType<typeof vi.fn> };
  let now: number;

  beforeEach(() => {
    db = initDb(':memory:');
    repo = new ReminderRepo(db);
    userRepo = new UserRepo(db);
    sender = { sendMessage: vi.fn(async () => true) };
    now = START;
  });

  afterEach(() => {
    db.close();
  });

  it('fluxo completo de lembrete único', async () => {
    const processor = new MessageProcessor({
      userRepo,
      reminderRepo: repo,
      sender,
      testPhoneNumber: '',
      parseFn: (text, nowMs) => Promise.resolve(parseReminderDeterministic(text, nowMs)),
      getNow: () => now,
    });
    const scheduler = new ReminderScheduler({ reminderRepo: repo, sender, getNow: () => now });

    // 1) usuário envia a mensagem
    await processor.handleIncoming(makeMsg('Me lembre daqui a 2 horas para tomar meu remedio'));

    // 2) confirmação enviada e lembrete persistido como pendente
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage.mock.calls[0][1]).toContain('✅ Lembrete criado!');
    const user = userRepo.getOrCreateUser(PHONE);
    const pending = repo.getRemindersForUser(user.id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].triggerAt).toBe(START + 2 * HOUR);

    // 3) antes da hora: nada é disparado
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);

    // 4) na hora: dispara e conclui
    now = START + 2 * HOUR + 1000;
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
    const delivered = sender.sendMessage.mock.calls[1][1];
    expect(delivered).toContain('⏰ Lembrete:');
    expect(delivered).toContain('tomar meu remedio');
    expect(repo.getReminderById(pending[0].id)!.status).toBe('completed');
  });

  it('fluxo completo de lembrete recorrente diário', async () => {
    const processor = new MessageProcessor({
      userRepo,
      reminderRepo: repo,
      sender,
      testPhoneNumber: '',
      parseFn: (text, nowMs) => Promise.resolve(parseReminderDeterministic(text, nowMs)),
      getNow: () => now,
    });
    const scheduler = new ReminderScheduler({ reminderRepo: repo, sender, getNow: () => now });

    // "todo dia às 8h": agora são 10:00 -> primeiro disparo amanhã 08:00
    await processor.handleIncoming(makeMsg('me avise todo dia às 8h pra tomar café'));
    const user = userRepo.getOrCreateUser(PHONE);
    let row = repo.getRemindersForUser(user.id, 'pending')[0];
    expect(row.triggerAt).toBe(new Date(2026, 9, 17, 8, 0, 0, 0).getTime());

    // 1º disparo no dia 17 às 08:01
    now = new Date(2026, 9, 17, 8, 1, 0, 0).getTime();
    await scheduler.processDueReminders(now);
    const first = sender.sendMessage.mock.calls.at(-1)![1];
    expect(first).toContain('café');
    row = repo.getReminderById(row.id)!;
    expect(row.status).toBe('pending'); // continua pendente (recorrente)
    expect(row.triggerAt).toBe(new Date(2026, 9, 18, 8, 0, 0, 0).getTime()); // próximo dia 08:00

    // 2º disparo no dia 18 às 08:00
    now = new Date(2026, 9, 18, 8, 0, 30, 0).getTime();
    await scheduler.processDueReminders(now);
    expect(sender.sendMessage).toHaveBeenCalledTimes(3);
    row = repo.getReminderById(row.id)!;
    expect(row.triggerAt).toBe(new Date(2026, 9, 19, 8, 0, 0, 0).getTime());
    // nenhuma linha duplicada
    expect(repo.getRemindersForUser(user.id)).toHaveLength(1);
  });
});
