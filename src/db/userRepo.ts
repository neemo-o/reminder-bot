import { Database } from 'better-sqlite3';
import { User } from '../types/index.js';
import { normalizePhone } from '../utils/phone.js';
import { randomUUID } from 'crypto';

export class UserRepo {
  constructor(private db: Database) {}

  getUserByPhone(phone: string): User | null {
    const cleanPhone = normalizePhone(phone);
    const stmt = this.db.prepare('SELECT id, phone, name, created_at FROM users WHERE phone = ?');
    const row = stmt.get(cleanPhone) as { id: string; phone: string; name: string | null; created_at: number } | undefined;
    if (!row) return null;

    return {
      id: row.id,
      phone: row.phone,
      name: row.name || undefined,
      createdAt: row.created_at,
    };
  }

  getOrCreateUser(phone: string, name?: string): User {
    const cleanPhone = normalizePhone(phone);
    const existing = this.getUserByPhone(cleanPhone);
    if (existing) return existing;

    const id = randomUUID();
    const createdAt = Date.now();
    const stmt = this.db.prepare('INSERT INTO users (id, phone, name, created_at) VALUES (?, ?, ?, ?)');
    stmt.run(id, cleanPhone, name || null, createdAt);

    return {
      id,
      phone: cleanPhone,
      name,
      createdAt,
    };
  }
}
