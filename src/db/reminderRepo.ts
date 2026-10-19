import { Database } from 'better-sqlite3';
import { Reminder, RecurrenceRule } from '../types/index.js';
import { randomUUID } from 'crypto';
import { validateRecurrence } from '../reminder/recurrence.validate.js';

interface DbReminderRow {
  id: string;
  user_id: string;
  phone: string;
  message: string;
  trigger_at: number;
  recurrence: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  created_at: number;
}

function mapRowToReminder(row: DbReminderRow): Reminder {
  let recurrence: RecurrenceRule | null = null;
  if (row.recurrence) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.recurrence);
    } catch {
      throw new Error(
        `Recorrência inválida no lembrete ${row.id}: não é um JSON válido`
      );
    }
    const validated = validateRecurrence(parsed);
    if (!validated) {
      throw new Error(
        `Recorrência inválida no lembrete ${row.id}: ${row.recurrence}`
      );
    }
    recurrence = validated;
  }

  return {
    id: row.id,
    userId: row.user_id,
    phone: row.phone,
    message: row.message,
    triggerAt: row.trigger_at,
    recurrence,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class ReminderRepo {
  constructor(private db: Database) {}

  createReminder(params: Omit<Reminder, 'id' | 'createdAt' | 'status'> & { id?: string; createdAt?: number; status?: 'pending' | 'completed' | 'cancelled' }): Reminder {
    const id = params.id || randomUUID();
    const createdAt = params.createdAt || Date.now();
    const status = params.status || 'pending';
    const recurrenceValid = validateRecurrence(params.recurrence ?? null);
    if (params.recurrence && !recurrenceValid) {
      throw new Error(
        `Regra de recorrência inválida: ${JSON.stringify(params.recurrence)}`
      );
    }
    const recurrenceStr = recurrenceValid ? JSON.stringify(recurrenceValid) : null;

    const stmt = this.db.prepare(`
      INSERT INTO reminders (id, user_id, phone, message, trigger_at, recurrence, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, params.userId, params.phone, params.message, params.triggerAt, recurrenceStr, status, createdAt);

    return {
      id,
      userId: params.userId,
      phone: params.phone,
      message: params.message,
      triggerAt: params.triggerAt,
      recurrence: recurrenceValid || null,
      status,
      createdAt,
    };
  }

  getReminderById(id: string): Reminder | null {
    const stmt = this.db.prepare('SELECT * FROM reminders WHERE id = ?');
    const row = stmt.get(id) as DbReminderRow | undefined;
    if (!row) return null;
    return mapRowToReminder(row);
  }

  getPendingRemindersDue(dueBeforeMs: number): Reminder[] {
    const stmt = this.db.prepare('SELECT * FROM reminders WHERE status = ? AND trigger_at <= ? ORDER BY trigger_at ASC');
    const rows = stmt.all('pending', dueBeforeMs) as DbReminderRow[];
    return rows.map(mapRowToReminder);
  }

  updateReminderStatus(id: string, status: 'pending' | 'completed' | 'cancelled'): void {
    const stmt = this.db.prepare('UPDATE reminders SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  updateReminderTriggerAt(id: string, triggerAt: number, status: 'pending' | 'completed' | 'cancelled' = 'pending'): void {
    const stmt = this.db.prepare('UPDATE reminders SET trigger_at = ?, status = ? WHERE id = ?');
    stmt.run(triggerAt, status, id);
  }

  getRemindersForUser(userId: string, status?: 'pending' | 'completed' | 'cancelled'): Reminder[] {
    if (status) {
      const stmt = this.db.prepare('SELECT * FROM reminders WHERE user_id = ? AND status = ? ORDER BY trigger_at ASC');
      const rows = stmt.all(userId, status) as DbReminderRow[];
      return rows.map(mapRowToReminder);
    } else {
      const stmt = this.db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY trigger_at ASC');
      const rows = stmt.all(userId) as DbReminderRow[];
      return rows.map(mapRowToReminder);
    }
  }

  cancelReminder(id: string): boolean {
    const stmt = this.db.prepare('UPDATE reminders SET status = ? WHERE id = ?');
    const info = stmt.run('cancelled', id);
    return info.changes > 0;
  }

  /* ---------- Delivery log (idempotência de envio) ---------- */

  /** Retorna o registro de entrega existente para (reminder_id, trigger_at), se houver. */
  getDelivery(reminderId: string, triggerAt: number): {
    status: string;
    deliveredAt: number;
    whatsappMsgId: string | null;
  } | null {
    const stmt = this.db.prepare(
      'SELECT status, delivered_at, whatsapp_msg_id FROM delivery_log WHERE reminder_id = ? AND trigger_at = ?'
    );
    const row = stmt.get(reminderId, triggerAt) as {
      status: string;
      delivered_at: number;
      whatsapp_msg_id: string | null;
    } | undefined;
    if (!row) return null;
    return {
      status: row.status,
      deliveredAt: row.delivered_at,
      whatsappMsgId: row.whatsapp_msg_id,
    };
  }

  /**
   * Tenta reivindicar a entrega de um lembrete inserindo (ou recuperando) um
   * registro no delivery_log. Retorna o token da concessão ou null se outra
   * instância já estiver enviando ou a entrega já tiver sido concluída.
   *
   * - 'failed': pode ser re-clamado imediatamente.
   * - 'sending': só pode ser re-clamado após maxIdleMs de ociosidade,
   *   EVITAR que duas instâncias disputem o mesmo envio ativo.
   * - Se já existe whatsapp_msg_id: nunca re-entrega.
   *
   * @param maxIdleMs tempo máximo (ms) de ociosidade antes de recuperar um
   *                  registro 'sending'. Padrão: 5 minutos.
   */
  claimDelivery(
    reminderId: string,
    triggerAt: number,
    maxIdleMs: number = 5 * 60 * 1000
  ): string | null {
    const cutoff = Date.now() - maxIdleMs;
    const leaseToken = randomUUID();

    // Se já existe um whatsapp_msg_id para este trigger, a mensagem já foi
    // aceita pelo WhatsApp. Nunca re-entrega, independentemente do status.
    const existing = this.getDelivery(reminderId, triggerAt);
    if (existing && existing.whatsappMsgId) {
      return null;
    }

    const row = this.db.prepare(
      `INSERT INTO delivery_log (reminder_id, trigger_at, delivered_at, lease_token, status)
       VALUES (?, ?, ?, ?, 'sending')
       ON CONFLICT(reminder_id, trigger_at) DO UPDATE
       SET delivered_at = excluded.delivered_at,
           lease_token = excluded.lease_token,
           status = 'sending'
       WHERE delivery_log.status = 'failed'
          OR (delivery_log.status = 'sending'
              AND delivery_log.delivered_at < ?
              AND delivery_log.whatsapp_msg_id IS NULL)
       RETURNING status`
    ).get(
      reminderId,
      triggerAt,
      Date.now(),
      leaseToken,
      cutoff
    ) as {
      status: string;
    } | undefined;

    // Se a linha existe mas está 'delivered', o UPDATE WHERE não casa e
    // RETURNING não retorna nada -> não entregamos de novo.
    if (!row) return null;
    return leaseToken;
  }

  /** Renova uma reivindicação ainda pertencente a esta execução. */
  heartbeatDelivery(reminderId: string, triggerAt: number, leaseToken: string): boolean {
    const info = this.db.prepare(
      `UPDATE delivery_log SET delivered_at = ?
       WHERE reminder_id = ? AND trigger_at = ? AND status = 'sending' AND lease_token = ?`
    ).run(Date.now(), reminderId, triggerAt, leaseToken);
    return info.changes > 0;
  }

  /** Marca a entrega como concluída no delivery_log, registrando o messageId do WhatsApp. */
  completeDelivery(
    reminderId: string,
    triggerAt: number,
    leaseToken: string,
    whatsappMsgId: string | null = null
  ): void {
    this.db.prepare(
      `UPDATE delivery_log
       SET status = 'delivered', whatsapp_msg_id = ?, lease_token = NULL
       WHERE reminder_id = ? AND trigger_at = ? AND status = 'sending' AND lease_token = ?`
    ).run(whatsappMsgId, reminderId, triggerAt, leaseToken);
  }

  /** Marca a entrega como falha no delivery_log (libera para nova tentativa). */
  failDelivery(reminderId: string, triggerAt: number, leaseToken: string): void {
    this.db.prepare(
      `UPDATE delivery_log SET status = 'failed', lease_token = NULL
       WHERE reminder_id = ? AND trigger_at = ? AND status = 'sending' AND lease_token = ?`
    ).run(reminderId, triggerAt, leaseToken);
  }

  /** Remove registros de envio abandonado (sending) mais velhos que maxIdleMs. */
  cleanupStuckSending(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    const info = this.db.prepare(
      `DELETE FROM delivery_log
       WHERE status = 'sending' AND delivered_at < ? AND whatsapp_msg_id IS NULL`
    ).run(cutoff);
    return info.changes;
  }
}
