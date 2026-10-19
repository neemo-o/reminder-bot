-- Migração 004: adiciona coluna whatsapp_msg_id ao delivery_log para rastrear
-- o ID da mensagem enviada pelo WhatsApp, permitindo detecção de duplicata
-- mesmo após re-entrega por expiração de maxIdleMs.
-- SQLite suporta ALTER TABLE ADD COLUMN a partir da versão 3.35.0.
ALTER TABLE delivery_log ADD COLUMN whatsapp_msg_id TEXT;
