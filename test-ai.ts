import { callIA } from "./supabase/functions/_shared/ai-logic.ts";
import "https://deno.land/std@0.224.0/dotenv/load.ts";

async function run() {
    console.log("Probando IA para cliente de voz...");
    try {
        const res = await callIA("Jumbo La Vega", "Cliente de Voz", false);
        console.log(res);
    } catch (e) {
        console.error(e);
    }
}

run();
