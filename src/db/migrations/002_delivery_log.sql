CREATE TABLE IF NOT EXISTS delivery_log (
  reminder_id TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL CHECK (delivered_at >= 0),
  status TEXT NOT NULL CHECK (status IN ('sending', 'delivered', 'failed')),
  PRIMARY KEY (reminder_id, trigger_at),
  FOREIGN KEY(reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_reminder ON delivery_log(reminder_id);
