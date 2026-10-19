import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADD_COLUMN_MIGRATIONS: Record<string, { table: string; column: string }> = {
  '004_whatsapp_msg_id': { table: 'delivery_log', column: 'whatsapp_msg_id' },
  '005_delivery_lease': { table: 'delivery_log', column: 'lease_token' },
};

/**
 * Executa migrações versionadas de esquema em ordem alfabética.
 * Cada migração é aplicada dentro de uma transação única e registrada
 * na tabela schema_migrations para não ser reaplicada.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string = path.join(__dirname, 'migrations')
): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `).run();

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: string;
  }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const unknownVersions = [...applied].filter((version) =>
    /^\d+_/.test(version) && !files.some((file) => file.replace(/\.sql$/, '') === version)
  );
  if (unknownVersions.length > 0) {
    throw new Error(`Migrações registradas sem arquivo correspondente: ${unknownVersions.join(', ')}`);
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    const tx = db.transaction(() => {
      const addedColumn = ADD_COLUMN_MIGRATIONS[version];
      const columnExists = addedColumn
        ? (db.pragma(`table_info(${addedColumn.table})`) as Array<{ name: string }>)
            .some((column) => column.name === addedColumn.column)
        : false;
      if (!columnExists) {
        db.exec(sql);
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        Date.now()
      );
    });

    tx();
  }
}
