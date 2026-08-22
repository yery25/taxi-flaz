ALTER TABLE lista_de_espera ADD COLUMN IF NOT EXISTS cliente_contacto TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
