import { Database } from 'better-sqlite3';
import { Reminder, RecurrenceRule } from '../types/index.js';
import { randomUUID } from 'crypto';

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
    try {
      recurrence = JSON.parse(row.recurrence);
    } catch {
      recurrence = null;
    }
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
    const recurrenceStr = params.recurrence ? JSON.stringify(params.recurrence) : null;

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
      recurrence: params.recurrence || null,
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
}
