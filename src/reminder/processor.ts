import { UserRepo } from '../db/userRepo.js';
import { ReminderRepo } from '../db/reminderRepo.js';
import { parseReminder } from '../ai/parseReminder.js';
import { isPhoneAllowed } from '../utils/phone.js';
import type { BotSender } from '../whatsapp/client.js';
import type {
  IncomingMessage,
  AudioMedia,
  ParseReminderResult,
  RecurrenceRule,
  Reminder,
} from '../types/index.js';
import type { Transcriber } from '../audio/transcriber.js';

export interface MessageProcessorDeps {
  userRepo: UserRepo;
  reminderRepo: ReminderRepo;
  sender: BotSender;
  /** If non-empty, only messages from this phone are accepted. */
  testPhoneNumber: string;
  /** Optional getter to read the current filter value at runtime (reactive). */
  getTestPhoneNumber?: () => string;
  /** Optional local audio transcriber. When provided, audio/voice messages are
   *  transcribed locally before reminder parsing. */
  audioTranscriber?: Transcriber;
  /** Injectable for tests. Defaults to the real (LLM + fallback) parser. */
  parseFn?: (text: string, nowMs?: number) => Promise<ParseReminderResult>;
  getNow?: () => number;
}

export const HELP_TEXT = `🤖 *Bot de Lembretes*

Envie uma mensagem de texto ou áudio descrevendo o que você quer lembrar:

• "me lembre de tomar remédio daqui a 2 horas"
• "lembre me da reunião amanhã 10h"
• "me lembre dia 21 desse mês de ir ao médico"
• "me avise todo dia às 8h pra tomar café"
• "toda segunda às 19h academia"
• "a cada 2 horas beber água"

Você também pode enviar um *áudio* (mensagem de voz) dizendo o lembrete;
o bot transcreve localmente e agenda o lembrete.

Comandos:
• meus lembretes — lista os lembretes ativos
• cancelar <ID> — cancela um lembrete pelo ID
• ajuda — mostra esta mensagem`;

function recurrenceLabel(rule: RecurrenceRule): string {
  switch (rule.type) {
    case 'daily':
      return 'Diário';
    case 'weekly':
      return 'Semanal';
    case 'monthly':
      return 'Mensal';
    case 'interval': {
      const ms = rule.intervalMs ?? 0;
      const hours = Math.round(ms / 3_600_000);
      if (hours >= 1) return `A cada ${hours}h`;
      return `A cada ${Math.max(1, Math.round(ms / 60_000))}min`;
    }
  }
}

export function formatConfirmation(reminder: Reminder): string {
  const date = new Date(reminder.triggerAt).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const shortId = reminder.id.slice(0, 8);
  let msg = '✅ Lembrete criado!\n\n';
  msg += `📝 ${reminder.message}\n`;
  msg += `⏰ ${date}\n`;
  msg += `🆔 ID: ${shortId}\n`;
  if (reminder.recurrence) {
    msg += `🔁 Repetição: ${recurrenceLabel(reminder.recurrence)}\n`;
  }
  msg += `\nPara cancelar, envie: cancelar ${shortId}`;
  return msg;
}

export class MessageProcessor {
  private readonly userRepo: UserRepo;
  private readonly reminderRepo: ReminderRepo;
  private readonly sender: BotSender;
  private readonly testPhoneNumber: string;
  private readonly getTestPhoneNumber?: () => string;
  private readonly parseFn: (text: string, nowMs?: number) => Promise<ParseReminderResult>;
  private readonly getNow: () => number;
  private readonly audioTranscriber?: Transcriber;

  constructor(deps: MessageProcessorDeps) {
    this.userRepo = deps.userRepo;
    this.reminderRepo = deps.reminderRepo;
    this.sender = deps.sender;
    this.testPhoneNumber = deps.testPhoneNumber;
    this.getTestPhoneNumber = deps.getTestPhoneNumber;
    this.parseFn = deps.parseFn ?? ((text: string, nowMs?: number) => parseReminder(text, nowMs));
    this.getNow = deps.getNow ?? Date.now;
    this.audioTranscriber = deps.audioTranscriber;
  }

  /**
   * Entry point for every inbound WhatsApp message.
   * DM-only and TEST_PHONE_NUMBER filtering happen here: filtered
   * messages are dropped silently (no reply, no DB writes).
   */
  async handleIncoming(msg: IncomingMessage): Promise<void> {
    try {
      // DM-only: ignore groups entirely
      if (msg.isGroup) {
        console.log(`[processor] Mensagem de grupo ignorada (${msg.fromJid})`);
        return;
      }

      // Test-number filter: check fromJid, senderPhone and senderPn (LID support)
      const effectivePhone = this.getTestPhoneNumber ? this.getTestPhoneNumber() : this.testPhoneNumber;
      const allowed =
        isPhoneAllowed(msg.fromJid, effectivePhone) ||
        isPhoneAllowed(msg.senderPhone, effectivePhone) ||
        (msg.senderPn ? isPhoneAllowed(msg.senderPn, effectivePhone) : false);

      if (!allowed) {
        console.warn(`[processor] Mensagem ignorada por filtro TEST_PHONE_NUMBER (${msg.fromJid}). Permitido: ${effectivePhone || 'todos'}`);
        return;
      }

      // Mensagem de áudio/voz: transcreve localmente antes de processar como lembrete
      if (msg.audio && (msg.mediaType === 'audio' || msg.mediaType === 'voice')) {
        const audio = msg.audio;
        await this.handleAudioReminderRequest(msg, audio);
        return;
      }

      const text = msg.text.trim();
      if (!text) return;

      console.log(`[processor] Mensagem recebida de ${msg.fromJid}: "${text}"`);
      const lower = text.toLowerCase();

      if (lower === 'meus lembretes' || lower === 'lembretes' || lower === 'listar') {
        await this.listReminders(msg);
        return;
      }
      if (lower === 'cancelar' || lower.startsWith('cancelar ')) {
        const prefix = lower === 'cancelar' ? '' : text.slice('cancelar '.length).trim();
        await this.cancelByPrefix(msg, prefix);
        return;
      }
      if (['ajuda', 'help', 'oi', 'olá', 'ola', 'começar', 'início', 'inicio'].includes(lower)) {
        await this.sender.sendMessage(msg.fromJid, HELP_TEXT);
        return;
      }

      const created = await this.handleReminderRequest(msg, text);
      if (!created) {
        await this.sender.sendMessage(msg.fromJid, HELP_TEXT);
      }
    } catch (err) {
      console.error('[processor] erro ao processar mensagem:', err);
      try {
        await this.sender.sendMessage(msg.fromJid, '❌ Erro ao processar sua mensagem. Tente novamente.');
      } catch (sendErr) {
        console.error('[processor] falha ao enviar resposta de erro:', sendErr);
      }
    }
  }

  /**
   * Processa uma mensagem de áudio/voz: transcreve localmente e, se o texto
   * resultando for um pedido de lembrete, cria o lembrete.
   */
  private async handleAudioReminderRequest(msg: IncomingMessage, audio: AudioMedia): Promise<void> {
    if (!this.audioTranscriber) {
      await this.sender.sendMessage(
        msg.fromJid,
        '❌ Recebi seu áudio, mas o bot não está configurado com um transcritor local. Envie o lembrete por texto.',
      );
      return;
    }

    const available = await this.audioTranscriber.isAvailable();
    if (!available) {
      await this.sender.sendMessage(
        msg.fromJid,
        '❌ O transcritor de áudio não está disponível no momento. Envie o lembrete por texto.',
      );
      return;
    }

    try {
      // Avisa que está processando o áudio
      await this.sender.sendMessage(msg.fromJid, '🎧 Recebi seu áudio. Transcrevendo localmente...');

      const { text, language } = await this.audioTranscriber.transcribe(
        audio.buffer,
        audio.mimeType,
      );

      if (!text || text.length === 0) {
        await this.sender.sendMessage(
          msg.fromJid,
          '❌ Não consegui transcrever o áudio. Tente enviar o lembrete por texto.',
        );
        return;
      }

      // Informa o usuário da transcrição antes de criar o lembrete
      await this.sender.sendMessage(
        msg.fromJid,
        `📝 Transcrição: "${text}"\n\nProcessando como lembrete...`,
      );

      // Agora processa o texto transcrito como pedido de lembrete
      const created = await this.handleReminderRequest(msg, text);
      if (!created) {
        await this.sender.sendMessage(
          msg.fromJid,
          `📝 Transcrição: "${text}"\n\n` +
            `Não reconheci isso como um pedido de lembrete. Tente dizer algo como:\n` +
            `• "me lembre de tomar remédio daqui a 2 horas"\n` +
            `• "lembre da reunião amanhã 10h"\n` +
            `• "me avise todo dia às 8h"`,
        );
      }
    } catch (err) {
      console.error('[processor] erro ao transcrever áudio:', err);
      await this.sender.sendMessage(
        msg.fromJid,
        '❌ Erro ao transcrever o áudio. Tente enviar o lembrete por texto.',
      );
    }
  }

  private async handleReminderRequest(msg: IncomingMessage, text: string): Promise<boolean> {
    const now = this.getNow();
    const parsed = await this.parseFn(text, now);

    if (!parsed.isReminderRequest || parsed.trigger_at <= now) {
      return false;
    }

    const user = this.userRepo.getOrCreateUser(msg.senderPhone, undefined);
    const reminder = this.reminderRepo.createReminder({
      userId: user.id,
      phone: user.phone,
      message: parsed.message,
      triggerAt: parsed.trigger_at,
      recurrence: parsed.recurrence ?? null,
    });

    await this.sender.sendMessage(msg.fromJid, formatConfirmation(reminder));
    return true;
  }

  private async listReminders(msg: IncomingMessage): Promise<void> {
    const user = this.userRepo.getOrCreateUser(msg.senderPhone, undefined);
    const pending = this.reminderRepo.getRemindersForUser(user.id, 'pending');
    if (pending.length === 0) {
      await this.sender.sendMessage(msg.fromJid, '📭 Você não tem lembretes ativos.');
      return;
    }
    let out = '📋 *Seus lembretes:*\n\n';
    for (const r of pending.slice(0, 10)) {
      const date = new Date(r.triggerAt).toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
      out += `⏳ ${r.message} — ${date} (ID: ${r.id.slice(0, 8)})\n`;
    }
    await this.sender.sendMessage(msg.fromJid, out);
  }

  private async cancelByPrefix(msg: IncomingMessage, prefix: string): Promise<void> {
    if (!prefix) {
      await this.sender.sendMessage(msg.fromJid, 'Uso: cancelar <ID>\nExemplo: cancelar a1b2c3d4');
      return;
    }
    const user = this.userRepo.getOrCreateUser(msg.senderPhone, undefined);
    const pending = this.reminderRepo.getRemindersForUser(user.id, 'pending');
    const normalized = prefix.toLowerCase();
    const match = pending.find((r) => r.id.toLowerCase().startsWith(normalized));
    if (!match) {
      await this.sender.sendMessage(msg.fromJid, '❌ Lembrete não encontrado (ou já processado).');
      return;
    }
    this.reminderRepo.cancelReminder(match.id);
    await this.sender.sendMessage(msg.fromJid, `✅ Lembrete "${match.message}" cancelado.`);
  }
}
