-- Migração 003: valida valores em bancos existentes sem recriar tabelas.
-- Recriar users/reminders pode violar chaves estrangeiras e perder dados
-- relacionados; triggers fornecem as mesmas validações sem alterar as linhas.

CREATE TRIGGER IF NOT EXISTS users_created_at_insert
BEFORE INSERT ON users
WHEN NEW.created_at < 0
BEGIN
  SELECT RAISE(ABORT, 'users.created_at must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS users_created_at_update
BEFORE UPDATE OF created_at ON users
WHEN NEW.created_at < 0
BEGIN
  SELECT RAISE(ABORT, 'users.created_at must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS reminders_values_insert
BEFORE INSERT ON reminders
WHEN NEW.trigger_at < 0
  OR NEW.created_at < 0
  OR NEW.status NOT IN ('pending', 'completed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'invalid reminder values');
END;

CREATE TRIGGER IF NOT EXISTS reminders_values_update
BEFORE UPDATE OF trigger_at, created_at, status ON reminders
WHEN NEW.trigger_at < 0
  OR NEW.created_at < 0
  OR NEW.status NOT IN ('pending', 'completed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'invalid reminder values');
END;
