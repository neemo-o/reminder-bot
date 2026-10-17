import { ReminderRepo } from '../db/reminderRepo.js';
import { calculateNextTriggerAt } from './recurrence.js';
import { phoneToJid } from '../utils/phone.js';
import type { BotSender } from '../whatsapp/client.js';

export interface SchedulerDeps {
  reminderRepo: ReminderRepo;
  sender: BotSender;
  /** Poll interval; defaults to 30s. */
  intervalMs?: number;
  getNow?: () => number;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Polls the DB for due reminders and delivers them over WhatsApp.
 * - Non-recurring reminders are marked 'completed' after delivery.
 * - Recurring reminders keep the same row: triggerAt is advanced to the
 *   next occurrence and status stays 'pending'.
 * - Failed deliveries stay 'pending' and are retried on the next tick.
 */
export class ReminderScheduler {
  private readonly reminderRepo: ReminderRepo;
  private readonly sender: BotSender;
  private readonly intervalMs: number;
  private readonly getNow: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.reminderRepo = deps.reminderRepo;
    this.sender = deps.sender;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.getNow = deps.getNow ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[scheduler] iniciado — verificação a cada ${Math.round(this.intervalMs / 1000)}s`);
    this.timer = setInterval(() => {
      void this.processDueReminders(this.getNow());
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
    const due = this.reminderRepo.getPendingRemindersDue(nowMs);
    for (const reminder of due) {
      try {
        const sent = await this.sender.sendMessage(
          phoneToJid(reminder.phone),
          `⏰ Lembrete: ${reminder.message}`
        );
        if (sent === false) {
          // Blocked (e.g. TEST_PHONE_NUMBER filter): keep pending, retry later
          console.warn(`[scheduler] envio bloqueado para ${reminder.phone} (lembrete ${reminder.id})`);
          continue;
        }
      } catch (err) {
        // Delivery failed: keep pending so the next tick retries
        console.error(`[scheduler] falha ao enviar lembrete ${reminder.id}:`, err);
        continue;
      }

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
}
