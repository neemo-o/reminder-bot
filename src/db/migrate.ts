import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        Date.now()
      );
    });

    tx();
  }
}
