CREATE TABLE IF NOT EXISTS lista_de_espera (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creado timestamp with time zone DEFAULT now(),
    cliente_id text,
    nombre text,
    origen text,
    plataforma text,
    mensaje_confirmacion text
);
