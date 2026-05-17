// ================================
// 📞 TWILIO VOICE WEBHOOK
// Supabase Edge Function (Deno)
// ================================
// NOTA: Este archivo está PREPARADO pero NO DESPLEGADO
// Para activar:
// 1. Compra número de teléfono en Twilio
// 2. Configura webhook en Twilio Console
// 3. Agrega secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
// 4. Descomenta el código
// 5. Ejecuta: supabase functions deploy twilio-voice-webhook
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callIA } from "../_shared/ai-logic.ts";
import { procesarPedidoTaxi } from "../_shared/dispatch-logic.ts";

// Variables de entorno
const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
// const _TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER");

// Cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

serve(async (req: Request) => {
    try {
        if (req.method !== "POST") {
            return new Response("Solo POST permitido", { status: 405 });
        }

        const formData = await req.formData();

        // Datos de la llamada
        const from = formData.get("From")?.toString() || "";
        const _callSid = formData.get("CallSid")?.toString() || "";
        const speechResult = formData.get("SpeechResult")?.toString(); // Transcripción automática de Twilio

        console.log(`\n📞 Llamada de ${from}`);

        // ========================================
        // 🎯 PRIMERA LLAMADA: Saludo inicial
        // ========================================
        if (!speechResult) {
            console.log("👋 Llamada nueva, enviando saludo");

            return new Response(
                generateVoiceTwiML(
                    "Bienvenido a Taxi-Flaz. ¿Deseas pedir un taxi? Por favor, dime tu nombre y dirección.",
                    true, // Esperar respuesta
                ),
                { headers: { "Content-Type": "text/xml" } },
            );
        }

        // ========================================
        // 🗣️ PROCESAMIENTO DE RESPUESTA DEL CLIENTE
        // ========================================
        console.log(`🗣️ Cliente dijo: "${speechResult}"`);

        // 🤖 ANALIZAR CON IA
        const interpretation = await callIA(
            speechResult,
            "Cliente por Teléfono",
            false,
        );

        const { intent, response: aiResponse, location, customer_name } = interpretation;

        // Si quiere un taxi y dio ubicación, procesamos
        if ((intent === "PEDIR_TAXI" || intent === "UBICACION") && location) {
            const clienteInfo = customer_name ? `${customer_name} (${from})` : from;
            
            const taxi = await procesarPedidoTaxi(
                supabase,
                "whatsapp", 
                from,
                from,
                location,
                aiResponse,
                clienteInfo,
                customer_name,
            );

            if (taxi) {
                // Prioridad: 1. Campo telefono, 2. whatsapp_id limpio
                const rawPhone = taxi.telefono || (taxi.whatsapp_id ? taxi.whatsapp_id.replace("whatsapp:", "") : null);
                
                if (rawPhone) {
                    const dialNumber = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;

                    return new Response(
                        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Mia" language="es-MX">Un momento ${customer_name || ""}, te comunico con el taxista ${taxi.nombre}.</Say>
  <Dial timeout="20">${dialNumber}</Dial>
  <Say voice="Polly.Mia" language="es-MX">El taxista no ha podido contestar en este momento, pero ya le hemos enviado tu ubicación y nombre por WhatsApp. Por favor, mantente atento.</Say>
</Response>`,
                        { headers: { "Content-Type": "text/xml" } },
                    );
                }
            } else {
                // Caso en que entró en lista de espera (procesarPedidoTaxi devolvió null)
                return new Response(
                    generateVoiceTwiML(
                        `Lo siento ${customer_name || ""}, no hay taxis disponibles ahora, pero ya estás en lista de espera. Te avisaremos en cuanto uno se libere.`,
                        false,
                    ),
                    { headers: { "Content-Type": "text/xml" } },
                );
            }

            return new Response(
                generateVoiceTwiML(
                    aiResponse || "Tu pedido está siendo procesado.",
                    false,
                ),
                { headers: { "Content-Type": "text/xml" } },
            );
        }

        // Si falta info, volver a preguntar
        return new Response(
            generateVoiceTwiML(
                aiResponse || "¿Podrías repetirme desde dónde necesitas el taxi?",
                true,
            ),
            { headers: { "Content-Type": "text/xml" } },
        );
    } catch (error) {
        console.error("❌ Error en webhook de voz:", error);
        return new Response(
            generateVoiceTwiML(
                "Lo sentimos, hubo un error. Por favor, intenta de nuevo más tarde.",
                false,
            ),
            { headers: { "Content-Type": "text/xml" } },
        );
    }
});

// Generar respuesta TwiML para llamadas de voz
function generateVoiceTwiML(message: string, askForInput: boolean): string {
    if (askForInput) {
        // Pedir input del usuario
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="10" language="es-MX" speechTimeout="auto" action="">
    <Say voice="Polly.Mia" language="es-MX">${escapeXml(message)}</Say>
  </Gather>
  <Say voice="Polly.Mia" language="es-MX">No te escuchamos. Por favor, intenta de nuevo.</Say>
</Response>`;
    } else {
        // Solo decir y colgar
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Mia" language="es-MX">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
    }
}

// Escapar caracteres especiales XML
function escapeXml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
