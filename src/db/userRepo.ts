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
    const now = Date.now();
    const id = randomUUID();

    // INSERT ... ON CONFLICT(phone) DO NOTHING é atômico: duas chamadas
    // concorrentes não criam duplicatas. Uma insere (RETURNING retorna linha),
    // a outra não insere e cai no SELECT de fallback abaixo.
    const insert = this.db.prepare(`
      INSERT INTO users (id, phone, name, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO NOTHING
      RETURNING id, phone, name, created_at
    `);

    const row = insert.get(
      id,
      cleanPhone,
      name ?? null,
      now
    ) as { id: string; phone: string; name: string | null; created_at: number } | undefined;

    if (row) {
      return {
        id: row.id,
        phone: row.phone,
        name: row.name || undefined,
        createdAt: row.created_at,
      };
    }

    const existing = this.getUserByPhone(cleanPhone);
    if (!existing) {
      throw new Error('Não foi possível criar nem recuperar o usuário');
    }
    return existing;
  }

  /**
   * Sincroniza o telefone dos lembretes pendentes de um usuário com o
   * telefone atual cadastrado em users.phone.
   *
   * Política: o telefone do lembrete é um SNAPSHOT imutável no momento da
   * criação (garante que disparos históricos não mudem de destino
   * retroativamente). Somente lembretes com status 'pending' são atualizados;
   * lembretes já concluídos ou cancelados mantêm o snapshot original.
   *
   * Retorna a quantidade de linhas atualizadas. Ainda não há fluxo de mudança
   * de telefone do usuário no bot; esta função fica disponível para quando
   * esse fluxo for implementado.
   */
  syncUserPhoneReminders(userId: string): number {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        UPDATE reminders
        SET phone = (SELECT phone FROM users WHERE id = reminders.user_id)
        WHERE user_id = ? AND status = 'pending'
      `).run(userId);
      return info.changes;
    });
    return tx();
  }
}
