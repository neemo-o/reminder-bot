CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  trigger_at INTEGER NOT NULL CHECK (trigger_at >= 0),
  recurrence TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_status_trigger ON reminders(status, trigger_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
