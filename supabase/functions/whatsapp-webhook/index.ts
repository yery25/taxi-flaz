// ================================
// 📱 WHATSAPP WEBHOOK (TWILIO)
// Supabase Edge Function (Deno)
// ================================
// NOTA: Este archivo está PREPARADO pero NO DESPLEGADO
// Para activar:
// 1. Configura Twilio WhatsApp Business API
// 2. Agrega secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// 3. Descomenta el código
// 4. Ejecuta: supabase functions deploy whatsapp-webhook
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";

// Variables de entorno
const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");

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

        // Twilio envía datos como application/x-www-form-urlencoded
        const formData = await req.formData();

        const from = formData.get("From")?.toString() || ""; // Número WhatsApp
        const body = formData.get("Body")?.toString() || ""; // Texto del mensaje
        const mediaUrl = formData.get("MediaUrl0")?.toString(); // URL del audio/imagen
        const mediaContentType = formData.get("MediaContentType0")?.toString();

        console.log(`\n📱 Mensaje de WhatsApp de ${from}`);

        let texto = "";

        // ========================================
        // 🎙️ PROCESAMIENTO DE NOTA DE VOZ
        // ========================================
        if (mediaUrl && mediaContentType?.includes("audio")) {
            console.log("🎙️ Nota de voz detectada");

            try {
                // 1. Descargar audio desde Twilio
                const audioResponse = await fetch(mediaUrl, {
                    headers: {
                        "Authorization": `Basic ${
                            btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
                        }`,
                    },
                });

                const audioBuffer = await audioResponse.arrayBuffer();

                // 2. Transcribir con Groq Whisper
                const transcription = await transcribeWithGroq(audioBuffer);
                texto = transcription.text;

                console.log(`✅ Transcripción: "${texto}"`);
            } catch (error) {
                console.error("❌ Error procesando nota de voz:", error);
                return new Response(
                    generateWhatsAppTwiML(
                        "❌ Error procesando tu nota de voz. Intenta de nuevo.",
                    ),
                    { headers: { "Content-Type": "text/xml" } },
                );
            }
        } else {
            // Mensaje de texto normal
            texto = body;
            console.log(`📩 Mensaje de texto: "${texto}"`);
        }

        if (!texto) {
            return new Response("ok");
        }

        // ========================================
        // 🤖 PROCESAMIENTO CON IA (Reutilizar lógica existente)
        // ========================================
        // AQUÍ PUEDES IMPORTAR Y USAR LA MISMA FUNCIÓN callIA
        // del webhook de Telegram para mantener consistencia

        // Por ahora, respuesta simple de ejemplo
        const respuesta =
            `Recibido por WhatsApp: "${texto}"\n\n(Funcionalidad pendiente de implementación completa)`;

        // ========================================
        // 📤 RESPUESTA TwiML
        // ========================================
        return new Response(
            generateWhatsAppTwiML(respuesta),
            { headers: { "Content-Type": "text/xml" } },
        );
    } catch (error) {
        console.error("❌ Error en webhook WhatsApp:", error);
        return new Response(
            generateWhatsAppTwiML("Error procesando tu mensaje."),
            { headers: { "Content-Type": "text/xml" } },
        );
    }
});

// Generar respuesta TwiML para WhatsApp
function generateWhatsAppTwiML(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
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
