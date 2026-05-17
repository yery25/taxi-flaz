import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { procesarPedidoTaxi, notificarLlamadaVozATaxista } from "../_shared/dispatch-logic.ts";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";
import { callIA } from "../_shared/ai-logic.ts";
import { ZadarmaService } from "../_shared/zadarma.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req: Request) => {
    const url = new URL(req.url);

    // --- 1. HANDSHAKE DE ZADARMA (Verificación) ---
    const zdEcho = url.searchParams.get("zd_echo");
    if (zdEcho) {
        console.log("✅ Zadarma Handshake: ", zdEcho);
        return new Response(zdEcho);
    }

    // --- 2. PROCESAMIENTO DE LLAMADA (POST - Form Data) ---
    try {
        // LOG DE EMERGENCIA: Ver si llega CUALQUIER cosa
        console.log("📥 Petición recibida en Zadarma Webhook");
        
        const formData = await req.formData();
        
        // Guardar payload en objeto para logs
        const allParams: Record<string, string> = {};
        for (const [key, value] of formData.entries()) {
            allParams[key] = value.toString();
        }
        
        // 📝 LOG DE ENTRADA: Guardar en la tabla de debug
        await supabase.from("zadarma_debug").insert({
            evento: allParams.event || "UNKNOWN",
            payload: allParams
        });

        console.log("📞 Webhook Zadarma:", JSON.stringify(allParams));

        const event = allParams.event || "UNKNOWN";
        let phone = allParams.caller_id || allParams.phone || "";

        // 🧠 MEMORIA DE LLAMADA: Si el evento es NOTIFY_RECORD, Zadarma no envía el caller_id.
        // Lo buscamos en la base de datos (Zadarma_debug) usando el pbx_call_id.
        if (!phone && allParams.pbx_call_id) {
            console.log(`🧠 Buscando caller_id para la llamada ${allParams.pbx_call_id}...`);
            const { data: previousEvent } = await supabase
                .from("zadarma_debug")
                .select("payload")
                .eq("payload->>pbx_call_id", allParams.pbx_call_id)
                .not("payload->>caller_id", "is", null)
                .limit(1)
                .single();
            
            if (previousEvent && previousEvent.payload) {
                // @ts-ignore: payload is jsonb
                phone = previousEvent.payload.caller_id || "";
                console.log(`✅ Teléfono recuperado: ${phone}`);
            }
        }

        // ==========================================
        // EVENTO: Inicio de llamada (NOTIFY_START)
        // ==========================================
        if (event === "NOTIFY_START" && phone) {
            console.log(`🔔 Notificando inicio de llamada de ${phone}`);
            await notificarLlamadaVozATaxista(supabase, phone);
            return new Response("OK");
        }
        // ==========================================
        // EVENTO: Grabación disponible (NOTIFY_RECORD)
        // ==========================================
        if (event === "NOTIFY_RECORD") {
            const callIdRec = allParams.call_id_with_rec;
            const pbxCallId = allParams.pbx_call_id;
            
            if (!callIdRec && !pbxCallId) return new Response("No IDs found");

            console.log(`🎙️ Solicitando grabación de ${phone}. IDs: ${callIdRec}, ${pbxCallId}`);

            try {
                let link = "";
                let lastError = "";

                // Intento 1: Usar call_id_with_rec
                if (callIdRec) {
                    try {
                        const recordData = await ZadarmaService.getRecordLink(callIdRec);
                        link = recordData.link;
                    } catch (e: any) {
                        lastError = `Intento 1 (${callIdRec}) falló: ${e.message}`;
                        console.warn(lastError);
                    }
                }

                // Intento 2: Usar pbx_call_id (si el primero falló)
                if (!link && pbxCallId) {
                    try {
                        console.log("🔄 Reintentando con pbx_call_id...");
                        const recordData = await ZadarmaService.getRecordLink(pbxCallId);
                        link = recordData.link;
                    } catch (e: any) {
                        lastError = `Intento 2 (${pbxCallId}) falló: ${e.message}`;
                        console.error(lastError);
                    }
                }

                if (!link) {
                    await supabase.from("zadarma_debug").insert({
                        evento: "ERROR_LINK",
                        payload: allParams,
                        error: `No se pudo obtener el enlace tras reintentos. Último error: ${lastError}`
                    });
                    return new Response("No recording link available", { status: 404 });
                }

                // CONTINUAR CON DESCARGA Y TRANSCRIPCIÓN
                const audioResponse = await fetch(link);
                if (!audioResponse.ok) {
                    const errorText = await audioResponse.text();
                    await supabase.from("zadarma_debug").insert({
                        evento: "ERROR_DOWNLOAD",
                        payload: allParams,
                        error: `Error descarga audio: ${errorText}`
                    });
                    return new Response("Error downloading audio", { status: 500 });
                }
                const audioBuffer = await audioResponse.arrayBuffer();

                const transcription = await transcribeWithGroq(audioBuffer);
                const text = transcription.text;

                if (!text || text.length < 3) {
                    await supabase.from("zadarma_debug").insert({
                        evento: "EMPTY_TRANSCRIPTION",
                        payload: { ...allParams, link },
                        error: "El audio no generó texto suficiente"
                    });
                    return new Response("Audio too short");
                }

                console.log(`🎙️ Procesando pedido para: ${phone}. Texto: "${text}"`);

                // --- PROCESAR CON IA ---
                const interpretation = await callIA(text, "Cliente Voz", false);
                const { intent, location, customer_name, response: aiResponse } = interpretation;

                if (intent !== "PEDIR_TAXI" && intent !== "UBICACION") {
                    console.log(`ℹ️ Llamada de ${phone} no es un pedido: ${intent}`);
                    return new Response("Not a taxi request");
                }

                const finalLocation = location || text;

                const taxi = await procesarPedidoTaxi(
                    supabase,
                    "voice", 
                    phone,
                    phone,
                    finalLocation, 
                    aiResponse || `Pedido via grabación: ${text}`,
                    phone,
                    customer_name || "Cliente Voz"
                );

                if (!taxi) {
                    console.log("⚠️ No se pudo asignar un taxi para esta llamada.");
                } else {
                    console.log(`✅ Pedido asignado exitosamente a: ${taxi.nombre}`);
                }

                await supabase.from("zadarma_debug").insert({
                    evento: "SUCCESS",
                    payload: { ...allParams, text, link },
                    error: taxi ? `Asignado a ${taxi.nombre}` : "Sin taxi disponible"
                });

                // --- RESPUESTA FINAL (CIERRE DE LLAMADA) ---
                return new Response(JSON.stringify({
                    action: "say",
                    text: `Está bien, enviaré un taxi a su ubicación en ${finalLocation}. Gracias por llamar a Taxi Flash.`,
                    language: "es"
                }), {
                    headers: { "Content-Type": "application/json" }
                });

            } catch (innerError: any) {
                await supabase.from("zadarma_debug").insert({
                    evento: "CRITICAL_ERROR",
                    payload: allParams,
                    error: innerError.message
                });
                return new Response("Critical error", { status: 500 });
            }
        }

        return new Response(JSON.stringify({ status: "processed", event }));

    } catch (err: any) {
        console.error("💥 Error en Zadarma webhook:", err);
        try {
            await supabase.from("zadarma_debug").insert({
                evento: "CRITICAL_WEBHOOK_ERROR",
                payload: { error: err.message, stack: err.stack },
                error: "Error fatal en el cuerpo del serve"
            });
        } catch (e) {
            console.error("No se pudo guardar el log de error:", e);
        }
        return new Response(JSON.stringify({ status: "error", message: err.message }), { status: 500 });
    }
});
