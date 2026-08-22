import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callIA } from "../_shared/ai-logic.ts";
import { sendMessage } from "../_shared/messaging.ts";
import { LISTA_TAXISTAS } from "../_shared/lista_taxistas.ts";
import { reorganizarTurnos, asignarPedidosPendientes, procesarPedidoTaxi, rechazarPedido, verificarTimeoutsPedidos } from "../_shared/dispatch-logic.ts";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";
import { registrarLogDetallado } from "../_shared/logger.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req: Request) => {
    try {
        if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        // ⏰ Verificar timeouts de 4 minutos automáticamente
        await verificarTimeoutsPedidos(supabase);

        const body = await req.json();
        // SÚPER LOG: Para ver exactamente qué manda Kapso en llamadas o mensajes
        console.log("📥 [KAPSO PAYLOAD]:", JSON.stringify(body, null, 2));

        const message = body.message;
        if (!message) {
            return new Response("No message found", { status: 200 });
        }

        const whatsappId = message.from;
        const nombreStr = body.conversation?.contact_name || "Cliente WhatsApp";
        let text = "";
        
        if (message.type === "interactive") {
            const interactive = message.interactive;
            if (interactive?.button_reply) {
                text = interactive.button_reply.title || interactive.button_reply.id;
            } else if (interactive?.list_reply) {
                text = interactive.list_reply.title || interactive.list_reply.id;
            }
        } else {
            text = message.text?.body || "";
        }

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

        // 📊 Log detallado de entrada del mensaje WhatsApp (solo para clientes, no taxistas)
        if (!isTaxista) {
            await registrarLogDetallado(supabase, {
                evento: "KAPSO_MENSAJE_CLIENTE",
                clientePhone: whatsappId,
                clienteNombre: nombreStr,
                detalles: { texto: text.substring(0, 100), tipo: message.type || "text" }
            });
        }

        // 🚀 BYPASS DE IA PARA VELOCIDAD EXTREMA EN SALUDOS Y BOTONES
        const textLower = text.toLowerCase().trim();
        if (!isTaxista && (textLower === "hola" || textLower === "buenas" || textLower === "menu" || textLower === "menú" || textLower === "saludos")) {
            const saludoText = `¡Hola ${nombreStr}! Bienvenido a *Taxi Flash* 🚖.\n\nSoy tu asistente virtual. ¿En qué te puedo ayudar hoy?`;
            const menuBotones = {
                inline_keyboard: [
                    [
                        { text: "🚕 Pedir Taxi", callback_data: "pedir_taxi" },
                        { text: "🗣️ Soporte Humano", callback_data: "soporte_humano" }
                    ]
                ]
            };
            await sendMessage("whatsapp_kapso", whatsappId, saludoText, menuBotones);
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        }
        
        if (!isTaxista && (textLower.includes("pedir taxi") || textLower === "pedir_taxi")) {
            await sendMessage("whatsapp_kapso", whatsappId, "Perfecto. Por favor, indícame la dirección exacta donde debemos enviarte el taxi (incluye ciudad o referencia):");
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        }
        
        if (!isTaxista && (textLower.includes("soporte humano") || textLower === "soporte_humano")) {
            await sendMessage("whatsapp_kapso", whatsappId, "En un momento uno de nuestros agentes se pondrá en contacto contigo. Por favor, espera en línea.");
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        }

        // 2. LLAMADA A IA PARA EL RESTO DE MENSAJES
        const interpretation = await callIA(text, nombreStr, isTaxista, existingTaxi || undefined);
        const { intent, response: aiResponse } = interpretation;

        if (isTaxista) {
            // --- LÓGICA PARA TAXISTAS ---
            console.log(`🚕 Mensaje de TAXISTA: ${nombreStr}`);
            
            // Buscar si ya existe en la base de datos por número de taxi o cédula para obtener su id y conservar telegram_id
            const { data: dbTaxi } = await supabase
                .from("taxis")
                .select("*")
                .or(`whatsapp_id.eq.${whatsappId},numero_taxista.eq.${existingTaxi?.numero_taxista || autorizado?.numero_taxista || ""}${autorizado?.cedula ? `,cedula.eq.${autorizado.cedula}` : ""}`)
                .maybeSingle();

            const placeholderTelegramId = dbTaxi?.telegram_id || -(100 + Number((existingTaxi?.numero_taxista || autorizado?.numero_taxista || "0").replace(/\D/g, "")));

            if (intent === "ASIGNAR_TURNO" || intent === "DISPONIBLE") {
                await supabase.from("taxis").upsert({
                    id: dbTaxi?.id, // Conserva el UUID original si ya existe
                    telegram_id: placeholderTelegramId,
                    whatsapp_id: whatsappId,
                    nombre: dbTaxi?.nombre || autorizado?.nombre,
                    cedula: dbTaxi?.cedula || autorizado?.cedula,
                    numero_taxista: dbTaxi?.numero_taxista || autorizado?.numero_taxista,
                    telefono: dbTaxi?.telefono || autorizado?.telefono || soloNumeros,
                    modelo: dbTaxi?.modelo || autorizado?.modelo,
                    color: dbTaxi?.color || autorizado?.color,
                    placa: dbTaxi?.placa || autorizado?.placa,
                    estado: "DISPONIBLE",
                    creado: new Date().toISOString()
                }, { onConflict: 'id' });
                
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

                // A. MEMORIA: Verificar si ya tiene un pedido activo (evitar duplicados si el cliente sigue escribiendo)
                const diezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000).toISOString();
                const { data: pedidoActivo } = await supabase
                    .from("pedidos")
                    .select("id, estado, taxis(nombre, numero_taxista)")
                    .eq("cliente_telegram_id", whatsappId)
                    .in("estado", ["CREADO", "ASIGNADO", "EN_CAMINO"])
                    .gt("creado", diezMinutosAtras)
                    .order("creado", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (pedidoActivo) {
                    console.log(`⚠️ Cliente ${whatsappId} ya tiene pedido activo en estado ${pedidoActivo.estado}. No se crea duplicado.`);
                    let respuestaEstado = "Tu solicitud de taxi ya está en proceso. En breve te confirmamos la unidad.";
                    if (pedidoActivo.estado === "EN_CAMINO") {
                        const nombreChofer = (pedidoActivo.taxis as any)?.nombre || "asignado";
                        const ficha = (pedidoActivo.taxis as any)?.numero_taxista || "";
                        respuestaEstado = `Tu taxi con ${nombreChofer} ${ficha ? `(${ficha})` : ''} ya va en camino hacia tu ubicación. 🚕`;
                    }
                    await sendMessage("whatsapp_kapso", whatsappId, respuestaEstado);
                    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
                }

                const clienteInfo = nombreStr ? `${nombreStr} (${whatsappId})` : whatsappId;
                await procesarPedidoTaxi(
                    supabase,
                    "whatsapp_kapso",
                    whatsappId,
                    whatsappId,
                    ubicacion,
                    interpretation.response,
                    clienteInfo,
                    nombreStr
                );
                // Ya no necesitamos manejar hola ni botones aquí porque se manejaron arriba en el Bypass
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
