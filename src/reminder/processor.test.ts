import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../db/init.js';
import { ReminderRepo } from '../db/reminderRepo.js';
import { UserRepo } from '../db/userRepo.js';
import { MessageProcessor, HELP_TEXT, formatConfirmation } from './processor.js';
import { parseReminderDeterministic } from '../ai/parseReminder.js';
import type { IncomingMessage, ParseReminderResult } from '../types/index.js';

const PHONE = '5511999999999';
const OTHER_PHONE = '5511888888888';
const HOUR = 3600 * 1000;
// Sexta-feira, 16/10/2026, 10:00 (hora local)
const NOW = new Date(2026, 9, 16, 10, 0, 0, 0).getTime();

function makeMsg(phone: string, text: string, isGroup = false): IncomingMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    fromJid: `${phone}@s.whatsapp.net`,
    senderPhone: phone,
    isGroup,
    participant: isGroup ? `${PHONE}@s.whatsapp.net` : undefined,
    text,
    timestamp: NOW,
  };
}

function fakeParse(overrides: Partial<ParseReminderResult> = {}): ParseReminderResult {
  return {
    isReminderRequest: true,
    message: 'comprar leite',
    trigger_at: NOW + HOUR,
    recurrence: null,
    confidence: 0.9,
    ...overrides,
  };
}

describe('MessageProcessor', () => {
  let db: Database.Database;
  let repo: ReminderRepo;
  let userRepo: UserRepo;
  let sender: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = initDb(':memory:');
    repo = new ReminderRepo(db);
    userRepo = new UserRepo(db);
    sender = { sendMessage: vi.fn(async () => true) };
  });

  afterEach(() => {
    db.close();
  });

  function makeProcessor(opts: {
    testPhoneNumber?: string;
    parseFn?: (text: string, nowMs?: number) => Promise<ParseReminderResult>;
  } = {}) {
    return new MessageProcessor({
      userRepo,
      reminderRepo: repo,
      sender,
      testPhoneNumber: opts.testPhoneNumber ?? '',
      parseFn: opts.parseFn ?? (async () => fakeParse()),
      getNow: () => NOW,
    });
  }

  it('ignora mensagens de grupo (DM-only)', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, 'me lembre de comprar leite às 14h', true));
    expect(sender.sendMessage).not.toHaveBeenCalled();
    expect(repo.getRemindersForUser(userRepo.getOrCreateUser(PHONE).id)).toHaveLength(0);
  });

  it('com TEST_PHONE_NUMBER definido: ignora outros números silenciosamente', async () => {
    const p = makeProcessor({ testPhoneNumber: PHONE });
    await p.handleIncoming(makeMsg(OTHER_PHONE, 'me lembre de comprar leite às 14h'));
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('com TEST_PHONE_NUMBER definido: atende o número configurado', async () => {
    const p = makeProcessor({ testPhoneNumber: PHONE });
    await p.handleIncoming(makeMsg(PHONE, 'me lembre de comprar leite às 14h'));
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage.mock.calls[0][1]).toContain('✅');
  });

  it('sem TEST_PHONE_NUMBER: aceita qualquer DM', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(OTHER_PHONE, 'me lembre de comprar leite às 14h'));
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ignora texto vazio', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, '   '));
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('"meus lembretes" sem lembretes responde lista vazia', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, 'meus lembretes'));
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage.mock.calls[0][1]).toContain('📭');
  });

  it('"meus lembretes" lista lembretes pendentes', async () => {
    const p = makeProcessor({
      parseFn: async () => fakeParse({ message: 'reuniao' }),
    });
    await p.handleIncoming(makeMsg(PHONE, 'me lembre da reuniao amanhã 10h'));
    sender.sendMessage.mockClear();
    await p.handleIncoming(makeMsg(PHONE, 'meus lembretes'));
    const out = sender.sendMessage.mock.calls[0][1];
    expect(out).toContain('📋');
    expect(out).toContain('reuniao');
    expect(out).toContain('ID:');
  });

  it('confirmação contém data formatada e ID curto', async () => {
    const p = makeProcessor({
      parseFn: async () => fakeParse({ message: 'reuniao', trigger_at: new Date(2026, 9, 17, 10, 0, 0, 0).getTime() }),
    });
    await p.handleIncoming(makeMsg(PHONE, 'me lembre da reuniao amanhã 10h'));
    const out = sender.sendMessage.mock.calls[0][1];
    expect(out).toContain('✅ Lembrete criado!');
    expect(out).toContain('reuniao');
    expect(out).toContain('🆔 ID: ');
    expect(out).toMatch(/cancelar [0-9a-f]{8}/);

    const user = userRepo.getOrCreateUser(PHONE);
    const rows = repo.getRemindersForUser(user.id, 'pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].triggerAt).toBe(new Date(2026, 9, 17, 10, 0, 0, 0).getTime());
  });

  it('confirmação de recorrência mostra o rótulo', async () => {
    const p = makeProcessor({
      parseFn: async () => fakeParse({ recurrence: { type: 'daily' } }),
    });
    await p.handleIncoming(makeMsg(PHONE, 'me avise todo dia às 8h pra tomar café'));
    expect(sender.sendMessage.mock.calls[0][1]).toContain('🔁 Repetição: Diário');
  });

  it('"cancelar <id>" cancela o lembrete pendente', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, 'me lembre de comprar leite amanhã'));
    const user = userRepo.getOrCreateUser(PHONE);
    const created = repo.getRemindersForUser(user.id, 'pending')[0];
    sender.sendMessage.mockClear();

    await p.handleIncoming(makeMsg(PHONE, `cancelar ${created.id.slice(0, 8)}`));
    expect(sender.sendMessage.mock.calls[0][1]).toContain('cancelado');
    expect(repo.getReminderById(created.id)!.status).toBe('cancelled');
  });

  it('"cancelar" com ID inexistente nega o cancelamento', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, 'cancelar ffffffff'));
    expect(sender.sendMessage.mock.calls[0][1]).toContain('❌');
  });

  it('"cancelar" sem ID mostra instruções de uso', async () => {
    const p = makeProcessor();
    await p.handleIncoming(makeMsg(PHONE, 'cancelar'));
    expect(sender.sendMessage.mock.calls[0][1]).toContain('Uso: cancelar <ID>');
  });

  it('parse sem intenção de lembrete responde com ajuda e não grava nada', async () => {
    const p = makeProcessor({
      parseFn: async () => fakeParse({ isReminderRequest: false, trigger_at: 0, confidence: 0.1 }),
    });
    await p.handleIncoming(makeMsg(PHONE, 'qualquer coisa'));
    expect(sender.sendMessage.mock.calls[0][1]).toBe(HELP_TEXT);
    expect(repo.getRemindersForUser(userRepo.getOrCreateUser(PHONE).id)).toHaveLength(0);
  });

  it('parse com horário no passado responde com ajuda', async () => {
    const p = makeProcessor({
      parseFn: async () => fakeParse({ trigger_at: NOW - HOUR }),
    });
    await p.handleIncoming(makeMsg(PHONE, 'me lembre de algo'));
    expect(sender.sendMessage.mock.calls[0][1]).toBe(HELP_TEXT);
  });

  it('fluxo com parser determinístico real: "daqui a 2 horas" persiste NOW+2h', async () => {
    const p = makeProcessor({
      parseFn: (text, nowMs) => Promise.resolve(parseReminderDeterministic(text, nowMs)),
    });
    await p.handleIncoming(makeMsg(PHONE, 'Me lembre daqui a 2 horas para tomar meu remedio'));
    const user = userRepo.getOrCreateUser(PHONE);
    const rows = repo.getRemindersForUser(user.id, 'pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].triggerAt).toBe(NOW + 2 * HOUR);
  });

  it('formatConfirmation: texto base correto', () => {
    const out = formatConfirmation({
      id: 'a1b2c3d4e5f6',
      userId: 'u1',
      phone: PHONE,
      message: 'teste',
      triggerAt: NOW + HOUR,
      recurrence: null,
      status: 'pending',
      createdAt: NOW,
    });
    expect(out).toContain('✅ Lembrete criado!');
    expect(out).toContain('🆔 ID: a1b2c3d4');
    expect(out).toContain('cancelar a1b2c3d4');
  });
});
