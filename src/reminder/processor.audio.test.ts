import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../db/init.js';
import { ReminderRepo } from '../db/reminderRepo.js';
import { UserRepo } from '../db/userRepo.js';
import { MessageProcessor } from './processor.js';
import type { IncomingMessage, ParseReminderResult } from '../types/index.js';
import { FakeTranscriber, WhisperTranscriber } from '../audio/transcriber.js';

const PHONE = '5511999999999';
const HOUR = 3600 * 1000;
// Sexta-feira, 16/10/2026, 10:00 (hora local)
const NOW = new Date(2026, 9, 16, 10, 0, 0, 0).getTime();

function makeAudioMsg(
  phone: string,
  audioBuffer: Buffer,
  mimeType = 'audio/ogg; codecs=opus',
  mediaType: 'audio' | 'voice' = 'voice',
): IncomingMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    fromJid: `${phone}@s.whatsapp.net`,
    senderPhone: phone,
    isGroup: false,
    participant: undefined,
    senderPn: undefined,
    text: '',
    timestamp: NOW,
    mediaType,
    audio: {
      buffer: audioBuffer,
      mimeType,
      fileName: 'audio.ogg',
    },
  };
}

function makeFakeParse(
  overrides: Partial<ParseReminderResult> = {},
): ParseReminderResult {
  return {
    isReminderRequest: true,
    message: 'comprar leite',
    trigger_at: NOW + HOUR,
    recurrence: null,
    confidence: 0.9,
    ...overrides,
  };
}

describe('MessageProcessor - áudio', () => {
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
    audioTranscriber?: any;
    getNow?: () => number;
  } = {}) {
    return new MessageProcessor({
      userRepo,
      reminderRepo: repo,
      sender,
      testPhoneNumber: opts.testPhoneNumber ?? '',
      parseFn: opts.parseFn ?? (async () => makeFakeParse()),
      audioTranscriber: opts.audioTranscriber,
      getNow: opts.getNow ?? (() => NOW),
    });
  }

  it('áudio com FakeTranscriber cria lembrete a partir da transcrição', async () => {
    const p = makeProcessor({
      audioTranscriber: new FakeTranscriber('me lembre de tomar água daqui a 1 hora'),
    });
    await p.handleIncoming(makeAudioMsg(PHONE, Buffer.from('fake-audio-bytes')));

    const user = userRepo.getOrCreateUser(PHONE);
    const rows = repo.getRemindersForUser(user.id, 'pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('comprar leite'); // do parseFn fake
    expect(sender.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@s.whatsapp.net'),
      expect.stringContaining('Transcrição:'),
    );
  });

  it('áudio sem transcritor configurado informa o usuário', async () => {
    const p = makeProcessor(); // sem audioTranscriber
    await p.handleIncoming(makeAudioMsg(PHONE, Buffer.from('fake-audio-bytes')));

    expect(sender.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@s.whatsapp.net'),
      expect.stringContaining('não está configurado com um transcritor local'),
    );
    const user = userRepo.getOrCreateUser(PHONE);
    expect(repo.getRemindersForUser(user.id, 'pending')).toHaveLength(0);
  });

  it('áudio com transcritor indisponível informa o usuário', async () => {
    const unavailableTranscriber = {
      isAvailable: vi.fn(async () => false),
      transcribe: vi.fn(),
    } as any;
    const p = makeProcessor({ audioTranscriber: unavailableTranscriber });
    await p.handleIncoming(makeAudioMsg(PHONE, Buffer.from('fake-audio-bytes')));

    expect(sender.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@s.whatsapp.net'),
      expect.stringContaining('não está disponível no momento'),
    );
  });

  it('áudio com transcrição vazia informa o usuário', async () => {
    const p = makeProcessor({
      audioTranscriber: new FakeTranscriber(''),
    });
    await p.handleIncoming(makeAudioMsg(PHONE, Buffer.from('fake-audio-bytes')));

    expect(sender.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@s.whatsapp.net'),
      expect.stringContaining('Não consegui transcrever o áudio'),
    );
  });

  it('WhatsAppTranscriber (classe real) existe e pode ser instanciada', () => {
    const t = new WhisperTranscriber({ modelName: 'Xenova/whisper-small' });
    expect(t).toBeInstanceOf(WhisperTranscriber);
  });

  it('FakeTranscriber.isAvailable retorna true', async () => {
    const t = new FakeTranscriber();
    expect(await t.isAvailable()).toBe(true);
  });

  it('FakeTranscriber.transcribe retorna o texto configurado', async () => {
    const t = new FakeTranscriber('texto transcrito fake');
    const result = await t.transcribe(Buffer.from('qualquer coisa'), 'audio/ogg');
    expect(result.text).toBe('texto transcrito fake');
  });
});
