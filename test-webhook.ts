import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { procesarPedidoTaxi } from "./supabase/functions/_shared/dispatch-logic.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

async function run() {
    console.log("Simulando webhook de plivo...");
    try {
        const from = "+18496540294";
        const finalLocation = "Jumbo La Vega";
        const aiResponse = "Entendido";
        const clienteInfo = "+18496540294";
        
        console.log("Ejecutando procesarPedidoTaxi...");
        const result = await procesarPedidoTaxi(
            supabase,
            "voice",
            from,
            from,
            finalLocation,
            aiResponse,
            clienteInfo,
            undefined
        );
        console.log("RESULTADO", result);
    } catch (e) {
        console.error("EXCEPCION!", e);
    }
}

run();
