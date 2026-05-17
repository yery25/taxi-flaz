// ================================
// 📞 VOZ CON PLIVO - VERSION ESTABLE (UN PASO)
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callIA } from "../_shared/ai-logic.ts";
import { procesarPedidoTaxi } from "../_shared/dispatch-logic.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const VOICE = "Polly.Mia"; // Volvemos a la voz original
const LANGUAGE = "es-MX";

serve(async (req: Request) => {
    try {
        const url = new URL(req.url);
        const formData = await req.formData();
        const from = formData.get("From") as string || "desconocido";
        const speech = formData.get("SpeechResult") as string;

        console.log(`📞 [PLIVO] Llamada de ${from}. Voz: "${speech || "Sin audio"}"`);

        // --- 1. BIENVENIDA Y CAPTURA ---
        if (!speech) {
            const xml = `
                <Response>
                    <Speak language="${LANGUAGE}" voice="${VOICE}">Bienvenido a Taxi Flaz. ¿Deseas pedir un taxi? Por favor, dime tu nombre y dirección después del tono.</Speak>
                    <GetInput action="${url.origin}/functions/v1/plivo-voice-webhook" 
                              method="POST" 
                              inputType="speech" 
                              speechEndTimeout="3" 
                              language="${LANGUAGE}" />
                    <Speak language="${LANGUAGE}" voice="${VOICE}">No te he escuchado bien. Por favor llama de nuevo.</Speak>
                    <Hangup />
                </Response>
            `;
            return new Response(xml, { headers: { "Content-Type": "application/xml" } });
        }

        // --- 2. PROCESO CON IA Y DESPACHO ---
        const interpretation = await callIA(speech, "Cliente de Voz", false);
        const { intent, response: aiResponse, location, customer_name } = interpretation;

        if ((intent === "PEDIR_TAXI" || intent === "UBICACION") && (location || speech.length > 5)) {
            const finalLocation = location || speech;
            const clienteInfo = customer_name ? `${customer_name} (${from})` : from;

            // Respuesta inmediata al cliente
            const xmlRespuesta = `
                <Response>
                    <Speak language="${LANGUAGE}" voice="${VOICE}">${aiResponse || "Entendido, estamos buscando un conductor para ti. Hasta luego."}</Speak>
                    <Hangup />
                </Response>
            `;

            // Procesar el despacho ANTES de responder para asegurar que llegue a Telegram
            await procesarPedidoTaxi(supabase, "voice", from, from, finalLocation, aiResponse, clienteInfo, customer_name);

            return new Response(xmlRespuesta, { headers: { "Content-Type": "application/xml" } });
        }

        return new Response("<Response><Hangup /></Response>", { headers: { "Content-Type": "application/xml" } });

    } catch (err) {
        return new Response("<Response><Hangup /></Response>", { headers: { "Content-Type": "application/xml" } });
    }
});
