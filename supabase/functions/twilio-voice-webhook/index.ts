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

// Variables de entorno
const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER");

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
        const callSid = formData.get("CallSid")?.toString() || "";
        const speechResult = formData.get("SpeechResult")?.toString(); // Transcripción automática de Twilio

        console.log(`\n📞 Llamada de ${from}`);

        // ========================================
        // 🎯 PRIMERA LLAMADA: Saludo inicial
        // ========================================
        if (!speechResult) {
            console.log("👋 Llamada nueva, enviando saludo");

            return new Response(
                generateVoiceTwiML(
                    "Hola, bienvenido al servicio de taxis. ¿Desde dónde necesitas un taxi?",
                    true, // Esperar respuesta
                ),
                { headers: { "Content-Type": "text/xml" } },
            );
        }

        // ========================================
        // 🗣️ PROCESAMIENTO DE RESPUESTA DEL CLIENTE
        // ========================================
        console.log(`🗣️ Cliente dijo: "${speechResult}"`);

        // AQUÍ PUEDES INTEGRAR LA MISMA LÓGICA DE IA
        // que usas en Telegram para procesar la solicitud

        // Ejemplo simple
        if (speechResult.toLowerCase().includes("cancelar")) {
            return new Response(
                generateVoiceTwiML(
                    "Entendido, cancelando tu solicitud. Gracias por llamar.",
                    false, // No esperar respuesta, colgar
                ),
                { headers: { "Content-Type": "text/xml" } },
            );
        }

        // Respuesta por defecto
        return new Response(
            generateVoiceTwiML(
                `Recibido: ${speechResult}. Procesando tu solicitud de taxi.`,
                false,
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
  <Gather input="speech" timeout="5" language="es-MX" speechTimeout="auto" action="">
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
