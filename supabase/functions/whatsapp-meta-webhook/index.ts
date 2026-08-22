// ================================
// 🤖 WHATSAPP META (OFICIAL)
// Supabase Edge Function (Deno)
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callIA } from "../_shared/ai-logic.ts";
import {
    asignarPedidosPendientes,
    confirmarPedido,
    procesarPedidoTaxi,
    reorganizarTurnos,
} from "../_shared/dispatch-logic.ts";
import { LISTA_TAXISTAS } from "../_shared/lista_taxistas.ts";
import { sendMessage } from "../_shared/messaging.ts";

const supabaseClient = (url: string, key: string) => createClient(url, key, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

serve(async (req: Request) => {
    const startTime = Date.now();
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "taxi_flaz_verify_2026";

    const supabase = supabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);

    // --- 1. VERIFICACIÓN DEL WEBHOOK (GET) ---
    if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
            console.log("✅ Webhook verificado por Meta");
            return new Response(challenge, { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
    }

    // --- 2. RECEPCIÓN DE MENSAJES (POST) ---
    try {
        const body = await req.json();
        
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        
        // Ignorar ACKS o estados que no sean mensajes
        if (!value?.messages) {
            return new Response("ok");
        }

        const message = value.messages[0];
        const whatsappId = message.from.startsWith("+") ? message.from : `+${message.from}`; 
        const contact = value.contacts?.[0];
        const nombreStr = contact?.profile?.name || "Usuario de WhatsApp";
        
        let texto = "";
        let location = null;

        // 📍 Soporte para Ubicación
        if (message.type === "location") {
            const loc = message.location;
            location = `${loc.latitude},${loc.longitude}`;
            texto = `Mi ubicación actual es: https://www.google.com/maps?q=${location}`;
        } else if (message.type === "text") {
            texto = message.text.body;
        } else {
            console.log(`ℹ️ Mensaje ignorado (${message.type}) de ${whatsappId}`);
            return new Response("ok");
        }

        console.log(`\n📩 [WA META] Recibido de ${nombreStr} (${whatsappId}): "${texto}"`);

        console.log(`\n📩 [WA META] Recibido de ${nombreStr} (${whatsappId}): "${texto}"`);

        // A. VERIFICAR TAXISTA (Búsqueda multi-criterio robusta)
        const cleanNumber = whatsappId.replace(/\D/g, "");
        const querySuffix = cleanNumber.slice(-10);
        
        let { data: existingTaxi } = await supabase
            .from("taxis")
            .select("*")
            .or(`whatsapp_id.eq.${whatsappId},whatsapp_id.eq.whatsapp:${whatsappId},telefono.ilike.%${querySuffix}%`)
            .maybeSingle();

        // --- VERIFICAR EN LISTA_TAXISTAS (Referencia Maestra) ---
        const autorizado = LISTA_TAXISTAS.find((t) =>
            t.telefono && cleanNumber.endsWith(t.telefono)
        );

        // --- SINCRONIZACIÓN Y VINCULACIÓN DE CUENTA ---
        if (autorizado) {
            try {
                // Si no se encontró por ID pero sí estamos autorizados, intentar una búsqueda MUY agresiva por número de taxi
                // para evitar duplicados si el teléfono en DB estaba mal formateado.
                if (!existingTaxi) {
                    const { data: fallbackTaxi } = await supabase
                        .from("taxis")
                        .select("*")
                        .eq("numero_taxista", autorizado.numero_taxista)
                        .maybeSingle();
                    if (fallbackTaxi) existingTaxi = fallbackTaxi;
                }

                // Sincronizar/Actualizar el registro (Vinculando el nuevo whatsapp_id si no estaba)
                if (!existingTaxi || existingTaxi.whatsapp_id !== whatsappId) {
                    console.log(`✨ Vinculando/Sincronizando taxista: ${autorizado.nombre}`);
                    
                    const placeholderTelegramId = existingTaxi?.telegram_id || -(100 + Number(autorizado.numero_taxista.replace(/\D/g, "")));
                    
                    const { data: syncedTaxi, error: syncError } = await supabase.from("taxis").upsert({
                        id: existingTaxi?.id, // Si existe (aunque sea por número), lo preservamos
                        telegram_id: placeholderTelegramId,
                        whatsapp_id: whatsappId,
                        nombre: autorizado.nombre,
                        cedula: autorizado.cedula,
                        numero_taxista: autorizado.numero_taxista,
                        telefono: autorizado.telefono || cleanNumber,
                        modelo: autorizado.modelo,
                        color: autorizado.color,
                        placa: autorizado.placa,
                        estado: existingTaxi?.estado || "DISPONIBLE",
                    }, { onConflict: "id" }).select().maybeSingle();

                    if (!syncError && syncedTaxi) {
                        existingTaxi = syncedTaxi;
                    }
                }
            } catch (syncErr) {
                console.error("⚠️ Error en vinculación:", syncErr);
            }
        }

        // Siempre confiar en autorizado o en la base de datos
        const isTaxista = !!existingTaxi || !!autorizado;

        // B. LLAMADA A IA
        const iaStart = Date.now();
        const interpretation = await callIA(
            texto,
            nombreStr,
            isTaxista,
            existingTaxi || undefined,
        );
        console.log(`🤖 IA respondió en ${Date.now() - iaStart}ms`);

        const { intent, response: aiResponse, location: locIA, customer_name } = interpretation;
        const finalLocation = location || locIA;

        // C. LÓGICA POR INTENCIÓN
        switch (intent) {
            case "DISPONIBLE": {
                if (isTaxista && (existingTaxi || autorizado)) {
                    // Si no tenemos existingTaxi pero sí autorizado, el upsert previo debería haberlo creado.
                    // Usamos el ID del registro para asegurar que afectamos la fila correcta.
                    const taxiId = existingTaxi?.id;
                    
                    if (taxiId) {
                        await supabase.from("taxis").update({ 
                            estado: "DISPONIBLE",
                            creado: new Date().toISOString()
                        }).eq("id", taxiId);
                    } else {
                        // Fallback por si acaso falló el upsert
                        await supabase.from("taxis").update({ 
                            estado: "DISPONIBLE",
                            creado: new Date().toISOString()
                        }).eq("whatsapp_id", whatsappId);
                    }
                    
                    await reorganizarTurnos(supabase);
                    await asignarPedidosPendientes(supabase);
                    await sendMessage("whatsapp", whatsappId, aiResponse);
                }
                break;
            }

            case "NO_DISPONIBLE": {
                if (isTaxista) {
                    const taxiId = existingTaxi?.id;
                    if (taxiId) {
                        await supabase.from("taxis").update({ estado: "OFFLINE", turno: null })
                            .eq("id", taxiId);
                    } else {
                        await supabase.from("taxis").update({ estado: "OFFLINE", turno: null })
                            .eq("whatsapp_id", whatsappId);
                    }
                    await reorganizarTurnos(supabase);
                    await sendMessage("whatsapp", whatsappId, aiResponse);
                }
                break;
            }

            case "PEDIR_TAXI":
            case "UBICACION": {
                if (finalLocation) {
                    const clienteInfo = customer_name ? `${customer_name} (${whatsappId})` : whatsappId;
                    await procesarPedidoTaxi(
                        supabase,
                        "whatsapp",
                        whatsappId,
                        whatsappId,
                        finalLocation,
                        aiResponse,
                        clienteInfo,
                        customer_name
                    );
                } else {
                    await sendMessage("whatsapp", whatsappId, aiResponse);
                }
                break;
            }

            case "CONFIRMAR": {
                if (isTaxista) {
                    await confirmarPedido(
                        supabase,
                        "whatsapp",
                        whatsappId,
                        whatsappId,
                        aiResponse,
                    );
                }
                break;
            }

            default: {
                let finalResponse = aiResponse;
                if (!isTaxista) {
                    finalResponse += `\n\n_(Debug ID: ${whatsappId})_`;
                }
                await sendMessage("whatsapp", whatsappId, finalResponse);
                break;
            }
        }

        console.log(`✅ Procesado completo en ${Date.now() - startTime}ms`);
        return new Response("ok");
    } catch (err) {
        console.error("💥 Error en WhatsApp Meta webhook:", err);
        return new Response("error", { status: 500 });
    }
});
