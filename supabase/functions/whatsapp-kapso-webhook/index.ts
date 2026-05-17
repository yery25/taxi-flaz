import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callIA } from "../_shared/ai-logic.ts";
import { sendMessage } from "../_shared/messaging.ts";
import { LISTA_TAXISTAS } from "../_shared/lista_taxistas.ts";
import { reorganizarTurnos, asignarPedidosPendientes } from "../_shared/dispatch-logic.ts";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req: Request) => {
    try {
        if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        const body = await req.json();
        // SÚPER LOG: Para ver exactamente qué manda Kapso en llamadas o mensajes
        console.log("📥 [KAPSO PAYLOAD]:", JSON.stringify(body, null, 2));

        const message = body.message;
        if (!message || !message.text) {
            return new Response("No message text found", { status: 200 });
        }

        const whatsappId = message.from;
        const nombreStr = body.conversation?.contact_name || "Cliente WhatsApp";
        let text = message.text?.body || "";

        // 🎙️ SOPORTE PARA MENSAJES DE VOZ EN WHATSAPP (KAPSO)
        if (message.type === "audio" || message.audio) {
            console.log("🎙️ Detectado mensaje de voz en WhatsApp...");
            const mediaId = message.audio?.id || message.id; // Kapso a veces lo trae en diferentes lugares
            try {
                const mediaUrl = await getKapsoMediaUrl(mediaId);
                const audioResponse = await fetch(mediaUrl, {
                    headers: { "X-API-Key": Deno.env.get("KAPSO_API_KEY")! }
                });
                const audioBuffer = await audioResponse.arrayBuffer();
                const transcription = await transcribeWithGroq(audioBuffer);
                text = transcription.text;
                console.log(`✅ Transcripción WhatsApp: "${text}"`);
            } catch (err) {
                console.error("❌ Error procesando audio de WhatsApp:", err);
                // Si falla el audio, intentamos seguir si hay texto (raro)
            }
        }

        if (!text) {
            return new Response("No message text or audio found", { status: 200 });
        }

        // 1. VERIFICAR SI ES TAXISTA REGISTRADO
        const soloNumeros = whatsappId.replace(/\D/g, "");
        const autorizado = LISTA_TAXISTAS.find(t => t.telefono.replace(/\D/g, "").includes(soloNumeros));

        const { data: existingTaxi } = await supabase
            .from("taxis")
            .select("*")
            .eq("whatsapp_id", whatsappId)
            .maybeSingle();

        const isTaxista = !!existingTaxi || !!autorizado;

        // 2. LLAMADA A IA
        const interpretation = await callIA(text, nombreStr, isTaxista, existingTaxi || undefined);
        const { intent, response: aiResponse } = interpretation;

        if (isTaxista) {
            // --- LÓGICA PARA TAXISTAS ---
            console.log(`🚕 Mensaje de TAXISTA: ${nombreStr}`);
            
            if (intent === "ASIGNAR_TURNO" || intent === "DISPONIBLE") {
                await supabase.from("taxis").upsert({
                    whatsapp_id: whatsappId,
                    nombre: existingTaxi?.nombre || autorizado?.nombre,
                    estado: "DISPONIBLE",
                    creado: new Date().toISOString()
                }, { onConflict: 'whatsapp_id' });
                
                await reorganizarTurnos(supabase);
                // ¡IMPORTANTE! Al ponerse disponible, revisamos la lista de espera
                await asignarPedidosPendientes(supabase);
            } else if (intent === "NO_DISPONIBLE") {
                await supabase.from("taxis").update({ estado: "OFFLINE", turno: null }).eq("whatsapp_id", whatsappId);
                await reorganizarTurnos(supabase);
            }

            await sendMessage("whatsapp_kapso", whatsappId, aiResponse);

        } else {
            // --- LÓGICA PARA CLIENTES ---
            console.log(`👤 Mensaje de CLIENTE: ${nombreStr}`);

            if (interpretation.location && interpretation.location.length > 3) {
                const ubicacion = interpretation.location;
                const destino = interpretation.destination || "No especificado";

                // A. MEMORIA: Verificar si ya tiene un pedido activo
                const diezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000).toISOString();
                const { data: pedidoActivo } = await supabase
                    .from("pedidos")
                    .select("id, estado")
                    .eq("cliente_telegram_id", whatsappId)
                    .in("estado", ["CREADO", "ASIGNADO", "EN_CAMINO"])
                    .gt("creado", diezMinutosAtras)
                    .order("creado", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (pedidoActivo) {
                    if (!interpretation.location_is_new) { // Si la IA detecta que es solo seguimiento
                         const respuestaEspera = "Tu taxi ya está solicitado y va en camino. Por favor, espera un momento.";
                         await sendMessage("whatsapp_kapso", whatsappId, respuestaEspera);
                         return new Response("ok");
                    }
                }

                // B. BUSCAR TAXISTA
                const { data: taxis } = await supabase
                    .from("taxis")
                    .select("*")
                    .eq("estado", "DISPONIBLE")
                    .gt("telegram_id", 0)
                    .order("turno", { ascending: true })
                    .limit(1);

                if (taxis && taxis.length > 0) {
                    const taxi = taxis[0];
                    const taxiTelegramId = taxi.telegram_id;

                    const mensajeTelegram = `🚕 **NUEVO PEDIDO DE WHATSAPP**\n\n📍 **Ubicación:** ${ubicacion}\n👤 **Cliente:** ${nombreStr}\n📞 **Teléfono:** ${whatsappId}\n\n¿Aceptas este pedido?`;
                    const replyMarkup = {
                        inline_keyboard: [[
                            { text: "✅ ACEPTAR VIAJE", callback_data: `confirmar_${whatsappId}` },
                            { text: "💬 HABLAR WHATSAPP", url: `https://wa.me/${whatsappId}` }
                        ]]
                    };

                    await sendMessage("telegram", taxiTelegramId, mensajeTelegram, replyMarkup);
                    
                    const { error: insertError } = await supabase.from("pedidos").insert({
                        origen: ubicacion,
                        cliente_telegram_id: whatsappId, // Guardamos el WhatsApp aquí para que el sistema lo encuentre
                        taxi_id: taxi.id,
                        estado: "ASIGNADO"
                    });

                    if (insertError) {
                        console.error("❌ ERROR AL INSERTAR PEDIDO:", insertError);
                    } else {
                        console.log("✅ Pedido guardado en DB correctamente.");
                    }
                    
                    await sendMessage("whatsapp_kapso", whatsappId, interpretation.response);
                } else {
                    // C. LISTA DE ESPERA (Si no hay taxis)
                    await supabase.from("lista_de_espera").insert({
                        cliente_id: whatsappId,
                        nombre: nombreStr,
                        origen: ubicacion,
                        plataforma: "whatsapp_kapso"
                    });

                    await sendMessage("whatsapp_kapso", whatsappId, "🚕 Lo sentimos, no hay taxis disponibles en este momento, pero te hemos puesto en **lista de espera**. Te avisaremos automáticamente en cuanto un taxista se libere.");
                }
            } else {
                await sendMessage("whatsapp_kapso", whatsappId, interpretation.response);
            }
        }

        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });

    } catch (err: any) {
        console.error("💥 Error en Webhook:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
});

/**
 * Obtiene la URL de descarga de un media en Kapso/Meta
 */
async function getKapsoMediaUrl(mediaId: string): Promise<string> {
    const KAPSO_API_KEY = Deno.env.get("KAPSO_API_KEY");
    const KAPSO_PHONE_NUMBER_ID = Deno.env.get("KAPSO_PHONE_NUMBER_ID");
    
    if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) {
        throw new Error("Faltan credenciales de Kapso para obtener media");
    }

    const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${mediaId}`;
    
    const response = await fetch(url, {
        headers: { "X-API-Key": KAPSO_API_KEY }
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error("❌ Error obteniendo URL de media de Kapso:", errText);
        throw new Error(`Error Kapso Media: ${response.status}`);
    }

    const data = await response.json();
    return data.url; // Kapso/Meta devuelve un objeto con la URL de descarga
}
