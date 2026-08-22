import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { procesarPedidoTaxi, notificarLlamadaVozATaxista } from "./supabase/functions/_shared/dispatch-logic.ts";
import { callIA } from "./supabase/functions/_shared/ai-logic.ts";
import { ZadarmaService } from "./supabase/functions/_shared/zadarma.ts";

console.log("✅ Todos los módulos se importaron correctamente.");
