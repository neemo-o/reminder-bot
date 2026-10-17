export type RecurrenceType = 'daily' | 'weekly' | 'monthly' | 'interval';

export interface RecurrenceRule {
  type: RecurrenceType;
  intervalMs?: number;
  daysOfWeek?: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  dayOfMonth?: number; // 1-31
}

export interface Reminder {
  id: string;
  userId: string;
  phone: string;
  message: string;
  triggerAt: number; // Unix timestamp in ms (UTC)
  recurrence?: RecurrenceRule | null;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: number;
}

export interface User {
  id: string;
  phone: string;
  name?: string;
  createdAt: number;
}

export interface ParseReminderResult {
  message: string;
  trigger_at: number; // ms UTC
  recurrence?: RecurrenceRule | null;
  confidence: number;
  isReminderRequest: boolean;
}

export type { IncomingMessage } from './whatsapp.js';
