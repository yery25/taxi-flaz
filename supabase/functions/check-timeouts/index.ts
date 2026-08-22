import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verificarTimeoutsPedidos } from "../_shared/dispatch-logic.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req: Request) => {
  try {
    console.log("⏰ Ejecutando cron/verificación de timeouts de 4 minutos...");
    await verificarTimeoutsPedidos(supabase);
    return new Response(JSON.stringify({ status: "success", message: "Timeouts procesados correctamente" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("💥 Error procesando timeouts:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});
