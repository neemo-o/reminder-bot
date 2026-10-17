import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from './init.js';
import { ReminderRepo } from './reminderRepo.js';
import { UserRepo } from './userRepo.js';

const PHONE = '5511999999999';
const HOUR = 3600 * 1000;

let db: Database.Database;
let repo: ReminderRepo;
let userRepo: UserRepo;
let userId: string;

beforeEach(() => {
  db = initDb(':memory:');
  repo = new ReminderRepo(db);
  userRepo = new UserRepo(db);
  userId = userRepo.getOrCreateUser(PHONE, 'Tester').id;
});

afterEach(() => {
  db.close();
});

describe('ReminderRepo', () => {
  it('creates and retrieves a reminder (recurrence JSON roundtrip)', () => {
    const created = repo.createReminder({
      userId,
      phone: PHONE,
      message: 'tomar remédio',
      triggerAt: Date.now() + HOUR,
      recurrence: { type: 'weekly', daysOfWeek: [1, 3] },
    });
    expect(created.id).toBeDefined();
    expect(created.status).toBe('pending');

    const fetched = repo.getReminderById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.message).toBe('tomar remédio');
    expect(fetched!.recurrence).toEqual({ type: 'weekly', daysOfWeek: [1, 3] });
  });

  it('returns only past-due pending reminders ordered ASC', () => {
    const now = Date.now();
    const older = repo.createReminder({ userId, phone: PHONE, message: 'older', triggerAt: now - 2 * HOUR });
    repo.createReminder({ userId, phone: PHONE, message: 'future', triggerAt: now + HOUR });
    const newer = repo.createReminder({ userId, phone: PHONE, message: 'newer', triggerAt: now - HOUR });

    const due = repo.getPendingRemindersDue(now);
    expect(due.map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  it('transitions status via updateReminderStatus', () => {
    const r = repo.createReminder({ userId, phone: PHONE, message: 'x', triggerAt: Date.now() + HOUR });
    repo.updateReminderStatus(r.id, 'completed');
    expect(repo.getReminderById(r.id)!.status).toBe('completed');
  });

  it('cancelReminder returns true for existing id and false for unknown', () => {
    const r = repo.createReminder({ userId, phone: PHONE, message: 'x', triggerAt: Date.now() + HOUR });
    expect(repo.cancelReminder(r.id)).toBe(true);
    expect(repo.getReminderById(r.id)!.status).toBe('cancelled');
    expect(repo.cancelReminder('id-inexistente')).toBe(false);
  });

  it('getRemindersForUser filters by status', () => {
    const a = repo.createReminder({ userId, phone: PHONE, message: 'a', triggerAt: Date.now() + HOUR });
    const b = repo.createReminder({ userId, phone: PHONE, message: 'b', triggerAt: Date.now() + 2 * HOUR });
    repo.updateReminderStatus(a.id, 'cancelled');

    const all = repo.getRemindersForUser(userId);
    expect(all).toHaveLength(2);
    const pending = repo.getRemindersForUser(userId, 'pending');
    expect(pending.map((r) => r.id)).toEqual([b.id]);
  });

  it('updateReminderTriggerAt advances the trigger and keeps it pending', () => {
    const r = repo.createReminder({ userId, phone: PHONE, message: 'x', triggerAt: Date.now() + HOUR });
    const next = Date.now() + 25 * HOUR;
    repo.updateReminderTriggerAt(r.id, next, 'pending');
    const updated = repo.getReminderById(r.id)!;
    expect(updated.triggerAt).toBe(next);
    expect(updated.status).toBe('pending');
  });
});
