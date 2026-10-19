import Database from 'better-sqlite3';
import { config } from '../utils/config.js';
import { runMigrations } from './migrate.js';

export function initDb(dbPath: string = config.databasePath): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Chaves estrangeiras devem ser aplicadas pelo SQLite, não apenas declaradas.
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  if (fkViolations.length > 0) {
    const tables = Array.from(new Set(fkViolations.map((v) => v.table))).join(', ');
    throw new Error(
      `Integridade do banco comprometida: ${fkViolations.length} violação(ões) de chave estrangeira detectada(s) na(s) tabela(s): ${tables}`
    );
  }

  runMigrations(db);

  return db;
}
