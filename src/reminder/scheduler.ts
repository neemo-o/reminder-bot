import { createHash } from 'node:crypto';
import { ReminderRepo } from '../db/reminderRepo.js';
import { calculateNextTriggerAt } from './recurrence.js';
import { phoneToJid } from '../utils/phone.js';
import type { BotSender } from '../whatsapp/client.js';
import type { Reminder } from '../types/index.js';

export interface SchedulerDeps {
  reminderRepo: ReminderRepo;
  sender: BotSender;
  /** Poll interval; defaults to 30s. */
  intervalMs?: number;
  getNow?: () => number;
  /**
   * Idle time (ms) after which a 'sending' delivery log entry is considered
   * stuck and can be reclaimed by another process. Defaults to 5 minutes.
   */
  maxIdleMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_IDLE_MS = 5 * 60 * 1000; // 5 minutes

function deliveryMessageId(reminderId: string, triggerAt: number): string {
  const digest = createHash('sha256')
    .update(`${reminderId}:${triggerAt}`)
    .digest('hex')
    .slice(0, 18)
    .toUpperCase();
  return `3EB0${digest}`;
}

/**
 * Mutex simples (fila de promises) que serializa execuções concorrentes de
 * processDueReminders dentro do mesmo processo. Sem ele, duas chamadas
 * concorrentes poderiam reivindicar o mesmo delivery_log antes de qualquer
 * uma marcar como 'delivered', gerando envio duplicado.
 */
const makeMutex = () => {
  let mutex = Promise.resolve();
  return (fn: () => Promise<void>) => {
    let release: () => void = () => {};
    const ready = new Promise<void>((r) => { release = r; });
    const previous = mutex;
    mutex = previous.then(() => ready);
    return previous.then(() => fn()).finally(() => release());
  };
};

/**
 * Polls the DB for due reminders and delivers them over WhatsApp.
 * - Non-recurring reminders are marked 'completed' after delivery.
 * - Recurring reminders keep the same row: triggerAt is advanced to the
 *   next occurrence and status stays 'pending'.
 * - Failed deliveries stay 'pending' and are retried on the next tick.
 *
 * This method is intentionally NOT wrapped in the internal mutex: it can be
 * called directly (tests, manual triggers). The periodic timer in start()
 * serializes invocations via runExclusive to avoid deadlock.
 */
export class ReminderScheduler {
  private readonly reminderRepo: ReminderRepo;
  private readonly sender: BotSender;
  private readonly intervalMs: number;
  private readonly getNow: () => number;
  private readonly maxIdleMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly runExclusive: (fn: () => Promise<void>) => Promise<void>;

  constructor(deps: SchedulerDeps) {
    this.reminderRepo = deps.reminderRepo;
    this.sender = deps.sender;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.getNow = deps.getNow ?? Date.now;
    this.maxIdleMs = deps.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    this.runExclusive = makeMutex();
  }

  start(): void {
    if (this.timer) return;
    console.log(`[scheduler] iniciado — verificação a cada ${Math.round(this.intervalMs / 1000)}s`);
    this.timer = setInterval(() => {
      void this.runExclusive(() => this.processDueReminders(this.getNow()));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[scheduler] parado');
    }
  }

  async processDueReminders(nowMs: number): Promise<void> {
    // Recupera envios travados antes de processar novos vencimentos.
    const cleaned = this.reminderRepo.cleanupStuckSending(this.maxIdleMs);
    if (cleaned > 0) {
      console.log(`[scheduler] limpeza de envios travados: ${cleaned} registro(s) recuperado(s)`);
    }

    const due = this.reminderRepo.getPendingRemindersDue(nowMs);
    for (const reminder of due) {
      // Idempotência: se já entregou (ou falhou) neste trigger_at, não reenvia.
      const delivery = this.reminderRepo.getDelivery(reminder.id, reminder.triggerAt);
      if (delivery && delivery.status === 'delivered') {
        await this.finalizeReminder(reminder);
        continue;
      }

      // Reivindica a entrega. Se outra instância já reivindicou e ainda não
      // expirou o prazo de ociosidade, pula. Se já existe whatsapp_msg_id
      // (mensagem já aceita pelo WhatsApp), nunca re-entrega.
      const claimed = this.reminderRepo.claimDelivery(
        reminder.id,
        reminder.triggerAt,
        this.maxIdleMs
      );
      if (!claimed) {
        console.warn(
          `[scheduler] entrega já reivindicada para lembrete ${reminder.id} @${reminder.triggerAt}`
        );
        continue;
      }

      const heartbeatMs = Math.max(1, Math.floor(this.maxIdleMs / 3));
      const heartbeat = setInterval(() => {
        try {
          const renewed = this.reminderRepo.heartbeatDelivery(
            reminder.id,
            reminder.triggerAt,
            claimed
          );
          if (!renewed) {
            console.warn(`[scheduler] concessão de envio perdida para lembrete ${reminder.id}`);
          }
        } catch (err) {
          console.error(`[scheduler] falha ao renovar concessão do lembrete ${reminder.id}:`, err);
        }
      }, heartbeatMs);

      try {
        const sent = await this.sender.sendMessage(
          phoneToJid(reminder.phone),
          `⏰ Lembrete: ${reminder.message}`,
          deliveryMessageId(reminder.id, reminder.triggerAt)
        );

        if (sent === false) {
          // Bloqueado pelo filtro: libera a reivindicação para tentar depois
          this.reminderRepo.failDelivery(reminder.id, reminder.triggerAt, claimed);
          console.warn(`[scheduler] envio bloqueado para ${reminder.phone} (lembrete ${reminder.id})`);
          continue;
        }

        const whatsappMsgId = typeof sent === 'string' ? sent : null;
        this.reminderRepo.completeDelivery(reminder.id, reminder.triggerAt, claimed, whatsappMsgId);
        await this.finalizeReminder(reminder);
        console.log(`[scheduler] lembrete ${reminder.id} entregue`);
      } catch (err) {
        this.reminderRepo.failDelivery(reminder.id, reminder.triggerAt, claimed);
        console.error(`[scheduler] falha ao enviar lembrete ${reminder.id}:`, err);
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  private async finalizeReminder(reminder: Reminder): Promise<void> {
    if (reminder.recurrence) {
      const next = calculateNextTriggerAt(reminder.triggerAt, reminder.recurrence);
      this.reminderRepo.updateReminderTriggerAt(reminder.id, next, 'pending');
      console.log(
        `[scheduler] lembrete recorrente ${reminder.id} reagendado para ${new Date(next).toLocaleString('pt-BR')}`
      );
    } else {
      this.reminderRepo.updateReminderStatus(reminder.id, 'completed');
      console.log(`[scheduler] lembrete ${reminder.id} entregue e concluído`);
    }
  }
}
