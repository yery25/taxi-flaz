import { callIA } from "./supabase/functions/_shared/ai-logic.ts";

async function test() {
    try {
        console.log("Testing callIA...");
        const res = await callIA("Hola", "Brayan", true, { nombre: "Brayan", estado: "EN_CAMINO", turno: 1 });
        console.log("Result:", res);
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
