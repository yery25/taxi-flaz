// ================================
// 📱 WHATSAPP WEBHOOK (TWILIO)
// Supabase Edge Function (Deno)
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";
import { callIA } from "../_shared/ai-logic.ts";
import { LISTA_TAXISTAS } from "../_shared/lista_taxistas.ts";
import {
    asignarPedidosPendientes,
    confirmarPedido,
    procesarPedidoTaxi,
    reorganizarTurnos,
} from "../_shared/dispatch-logic.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");

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
        const from = formData.get("From")?.toString() || ""; // whatsapp:+123456789
        const body = formData.get("Body")?.toString() || "";
        const mediaUrl = formData.get("MediaUrl0")?.toString();
        const mediaContentType = formData.get("MediaContentType0")?.toString();

        // El ID de WhatsApp para nosotros será el número sin el prefijo 'whatsapp:'
        const whatsappId = from.replace("whatsapp:", "");
        const nombre = formData.get("ProfileName")?.toString() ||
            "Usuario de WhatsApp";

        let texto = "";

        // 🎙️ PROCESAMIENTO DE NOTA DE VOZ
        if (mediaUrl && mediaContentType?.includes("audio")) {
            console.log("🎙️ Nota de voz de WhatsApp detectada");
            const audioResponse = await fetch(mediaUrl, {
                headers: {
                    "Authorization": `Basic ${
                        btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
                    }`,
                },
            });
            const audioBuffer = await audioResponse.arrayBuffer();
            const transcription = await transcribeWithGroq(audioBuffer);
            texto = transcription.text;
        } else {
            texto = body;
        }

        if (!texto) return new Response("ok");

        console.log(`📩 Mensaje de ${nombre} (WA): "${texto}"`);

        // 1. VERIFICAR TAXISTA
        const { data: existingTaxi } = await supabase
            .from("taxis")
            .select("*")
            .eq("whatsapp_id", whatsappId)
            .single();

        const isTaxista = !!existingTaxi;

        // --- INTERCEPTAR "SOY TAXISTA" ---
        if (texto.toLowerCase().includes("soy taxista")) {
            const autorizado = LISTA_TAXISTAS.find((t) =>
                texto.includes(t.cedula) && texto.includes(t.numero_taxista)
            );

            if (!autorizado) {
                return new Response(
                    generateWhatsAppTwiML(
                        "🚫 Para registrarte, debes enviar: *Soy taxista [CÉDULA] [NUMERO TAXI]*",
                    ),
                    { headers: { "Content-Type": "text/xml" } },
                );
            }

            await supabase.from("taxis").upsert({
                whatsapp_id: whatsappId,
                nombre: autorizado.nombre,
                cedula: autorizado.cedula,
                numero_taxista: autorizado.numero_taxista,
                telefono: autorizado.telefono,
                estado: "DISPONIBLE",
                creado: new Date().toISOString(),
            }, { onConflict: "whatsapp_id" });

            await reorganizarTurnos(supabase);
            await asignarPedidosPendientes(supabase);

            const { data: tOk } = await supabase.from("taxis").select("turno")
                .eq("whatsapp_id", whatsappId).single();
            return new Response(
                generateWhatsAppTwiML(
                    `✅ Bienvenido *${autorizado.nombre}*. \n🔢 *Tu turno es: ${
                        tOk?.turno || "N/A"
                    }*`,
                ),
                { headers: { "Content-Type": "text/xml" } },
            );
        }

        // 2. IA
        const interpretation = await callIA(
            texto,
            nombre,
            isTaxista,
            existingTaxi || undefined,
        );
        const { intent, response: aiResponse, location, customer_name } = interpretation;

        let respuestaFinal = aiResponse || "Recibido.";

        // 3. LÓGICA POR INTENCIÓN
        switch (intent) {
            case "DISPONIBLE": {
                if (!isTaxista) {
                    respuestaFinal = "🚫 Para registrarte, debes enviar: *Soy taxista [CÉDULA] [NUMERO TAXI]*";
                    break;
                }
                await supabase.from("taxis").update({
                    estado: "DISPONIBLE",
                    creado: new Date().toISOString(),
                }).eq("whatsapp_id", whatsappId);

                await reorganizarTurnos(supabase);
                await asignarPedidosPendientes(supabase);
                
                const { data: tOk } = await supabase.from("taxis").select("turno")
                    .eq("whatsapp_id", whatsappId).single();
                
                respuestaFinal = aiResponse
                    ? aiResponse.replace("{turno}", String(tOk?.turno || "N/A"))
                    : `✅ ¡Listo! Estás en el turno: *${tOk?.turno || "N/A"}*`;
                break;
            }

            case "NO_DISPONIBLE": {
                if (isTaxista) {
                    await supabase.from("taxis").update({
                        estado: "OFFLINE",
                        turno: null,
                    }).eq("whatsapp_id", whatsappId);
                    await reorganizarTurnos(supabase);
                } else {
                    respuestaFinal = "No tienes un turno activo que cerrar.";
                }
                break;
            }

            case "PEDIR_TAXI":
            case "UBICACION": {
                if (!location && intent === "PEDIR_TAXI") {
                    // Solo pide ubicación (iaResponse ya lo tiene)
                    await supabase.from("pedidos").insert({
                        cliente_whatsapp_id: whatsappId,
                        estado: "CREADO",
                        origen: "Pendiente",
                    });
                } else if (location) {
                    const clienteInfo = customer_name ? `${customer_name} (${nombre})` : nombre;
                    await procesarPedidoTaxi(
                        supabase,
                        "whatsapp",
                        from,
                        whatsappId,
                        location,
                        aiResponse,
                        clienteInfo,
                        customer_name,
                    );
                    // No respondemos aquí directamente porque procesarPedidoTaxi ya lo hace o maneja la lógica
                    return new Response("ok");
                }
                break;
            }

            case "CONSULTAR_TURNO": {
                if (isTaxista) {
                    respuestaFinal = existingTaxi.estado === "DISPONIBLE"
                        ? `📊 Turno: *${existingTaxi.turno}*\nEstado: DISPONIBLE ✅`
                        : `📊 Estado: ${existingTaxi.estado}`;
                }
                break;
            }

            case "CONFIRMAR": {
                if (isTaxista) {
                    await confirmarPedido(
                        supabase,
                        "whatsapp",
                        whatsappId,
                        from,
                        aiResponse,
                    );
                    return new Response("ok");
                }
                break;
            }
        }

        return new Response(generateWhatsAppTwiML(respuestaFinal), {
            headers: { "Content-Type": "text/xml" },
        });
    } catch (error) {
        console.error("❌ Error WA:", error);
        return new Response(
            generateWhatsAppTwiML("Error procesando tu mensaje."),
            { headers: { "Content-Type": "text/xml" } },
        );
    }
});

function generateWhatsAppTwiML(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
}

function escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case "&":
                return "&amp;";
            case '"':
                return "&quot;";
            case "'":
                return "&apos;";
            default:
                return c;
        }
    });
}
