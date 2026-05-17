-- Migración para añadir soporte de WhatsApp
ALTER TABLE taxis ADD COLUMN IF NOT EXISTS whatsapp_id text UNIQUE;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_whatsapp_id text;
