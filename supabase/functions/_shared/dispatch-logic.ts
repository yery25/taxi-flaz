import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Platform, sendMessage } from "./messaging.ts";
import { ZadarmaService } from "./zadarma.ts";

// =========================
// 🔄 FUNCIÓN PARA REORGANIZAR TURNOS
// =========================
export async function reorganizarTurnos(supabase: SupabaseClient) {
    console.log("🔄 Reorganizando turnos...");

    const { data: taxisDisponibles, error } = await supabase
        .from("taxis")
        .select("id, turno, creado")
        .eq("estado", "DISPONIBLE")
        .order("creado", { ascending: true });

    if (error) {
        console.error("❌ Error obteniendo taxis:", error);
        return;
    }

    if (!taxisDisponibles || taxisDisponibles.length === 0) {
        console.log("✅ No hay taxis disponibles para reorganizar");
        return;
    }

    // Solo actualizar si el turno calculado es diferente al guardado
    let updatesCount = 0;
    for (let i = 0; i < taxisDisponibles.length; i++) {
        const taxi = taxisDisponibles[i];
        const nuevoTurno = i + 1;

        if (taxi.turno !== nuevoTurno) {
            await supabase
                .from("taxis")
                .update({ turno: nuevoTurno })
                .eq("id", taxi.id);
            updatesCount++;
        }
    }

    console.log(`✅ Turnos verificados. Se actualizaron ${updatesCount} taxis.`);
}

// =========================
// 🚕 LÓGICA DE DESPACHO (FIFO)
// =========================
export async function procesarPedidoTaxi(
    supabase: SupabaseClient,
    platform: Platform,
    chatId: string | number,
    clientId: string | number,
    ubicacion: string,
    aiResponse: string,
    clienteContacto: string,
    customer_name?: string,
) {
    console.log(
        `🚕 Procesando pedido para cliente ${clientId} en ${ubicacion} (${platform})`,
    );

    // 1. Buscar taxi disponible
    console.log("🔍 Buscando taxista disponible...");
    const { data: taxis, error: taxiError } = await supabase
        .from("taxis")
        .select("*")
        .eq("estado", "DISPONIBLE")
        .order("creado", { ascending: true })
        .limit(1);

    if (taxiError || !taxis || taxis.length === 0) {
        console.log("🚖 No hay taxis disponibles para este pedido (Estado: DISPONIBLE).");
        console.log("📭 No hay taxis disponibles, poniendo en lista de espera...");
        
        // Poner en lista de espera dedicada
        const { error: waitError } = await supabase.from("lista_de_espera").insert({
            cliente_id: String(clientId),
            nombre: customer_name || String(clientId),
            origen: ubicacion,
            plataforma: platform,
            mensaje_confirmacion: aiResponse,
        });

        if (waitError) {
            console.error("❌ ERROR INSERTANDO EN LISTA DE ESPERA:", JSON.stringify(waitError));
            await supabase.from("zadarma_debug").insert({
                evento: "ERROR_WAITLIST_INSERT",
                payload: { clientId, ubicacion, platform },
                error: `Error lista_de_espera: ${waitError.message} | Detalles: ${waitError.details}`
            });
        }

        await sendMessage(
            platform,
            chatId,
            "🚕 Lo sentimos, no hay taxis disponibles en este momento, pero te hemos puesto en **lista de espera**. Te avisaremos automáticamente en cuanto un taxista se libere.",
        );
        return null;
    }

    const taxi = taxis[0];

    // 2. Crear pedido en modo "PENDIENTE DE CONFIRMACIÓN"
    const origenGuardado = customer_name && customer_name !== "Cliente Voz" && customer_name !== String(clientId)
        ? `${ubicacion} [Nombre: ${customer_name}]`
        : ubicacion;

    const pedidoData: Record<string, string | number | null> = {
        estado: "ASIGNADO",
        origen: origenGuardado,
        taxi_id: taxi.id,
        cliente_telegram_id: String(clientId),
    };

    console.log("📦 Intentando insertar pedido:", JSON.stringify(pedidoData));
    let { data: pedidoInserted, error: pedidoError } = await supabase.from("pedidos").insert(
        pedidoData,
    ).select().single();

    if (pedidoError) {
        console.error("❌ ERROR CRÍTICO INSERTANDO PEDIDO:", JSON.stringify(pedidoError));
        await supabase.from("zadarma_debug").insert({
            evento: "ERROR_DB_INSERT",
            payload: pedidoData,
            error: `Error pedidos: ${pedidoError.message} | Detalles: ${pedidoError.details}`
        });
        
        await sendMessage(
            platform,
            chatId,
            "Hubo un error al procesar tu pedido. Por favor, intenta de nuevo.",
        );
        return null;
    }

    // 3. Reservar al taxista cambiando su estado temporalmente a ASIGNADO (para que no reciba otros)
    await supabase.from("taxis").update({ estado: "ASIGNADO" }).eq(
        "id",
        taxi.id,
    );
    await reorganizarTurnos(supabase);
    
    // 4. Notificar al taxista (Prioridad absoluta)
    const taxiPlatform: Platform = taxi.whatsapp_id ? "whatsapp" : "telegram";
    const taxiId = taxi.whatsapp_id || taxi.telegram_id;

    console.log(`🚖 Notificando a taxista: ${taxi.nombre} (@${taxiId}) en ${taxiPlatform}`);

    try {
        if (taxiId) {
            const clienteLabel = customer_name && customer_name !== "Cliente Voz" && customer_name !== String(clientId)
                ? `${customer_name} (${clientId})`
                : clientId;

            const mensaje = `🚕 **NUEVA SOLICITUD DE SERVICIO**\n\n` +
                           `📍 **Ubicación:** ${ubicacion}\n` +
                           `👤 **Cliente:** ${clienteLabel}\n\n` +
                           `¿Aceptas este pedido?`;

            const callbackData = platform === "whatsapp_kapso" || platform === "whatsapp" 
                ? `confirmar_${clientId}` 
                : "confirmar";

            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "✅ ACEPTAR", callback_data: callbackData },
                        { text: "❌ RECHAZAR", callback_data: "rechazar" }
                    ]
                ]
            };

            await sendMessage(taxiPlatform, taxiId, mensaje, replyMarkup);
        }
    } catch (msgErr) {
        console.error("❌ Error enviando mensaje al taxista:", msgErr);
    }


    // 5. Notificar al cliente (si es plataforma de chat)
    if (platform !== "voice") {
        await sendMessage(
            platform,
            chatId,
            aiResponse || `¡Perfecto! El taxista ${taxi.nombre} ha sido notificado.`
        );
    }

    return taxi; 
}

/**
 * 📢 Notifica al taxista de turno sobre una llamada de voz de un cliente.
 */
export async function notificarLlamadaVozATaxista(
    supabase: SupabaseClient,
    clienteTelefono: string,
    transcripcion?: string,
) {
    console.log(`📢 Buscando taxista de turno para notificar llamada de ${clienteTelefono}`);

    // 1. Buscar al taxista con Turno 1 y que esté DISPONIBLE
    const { data: taxis } = await supabase
        .from("taxis")
        .select("*")
        .eq("estado", "DISPONIBLE")
        .order("turno", { ascending: true })
        .limit(1);

    if (!taxis || taxis.length === 0) {
        console.warn("⚠️ No hay taxistas disponibles. Enviando llamada a LISTA DE ESPERA...");
        
        // Registrar en lista de espera para que se asigne en cuanto alguien entre en turno
        await supabase.from("lista_de_espera").insert({
            cliente_telegram_id: clienteTelefono,
            nombre: "Cliente de Voz",
            origen: transcripcion ? `Llamada: ${transcripcion}` : "Llamada de voz (sin dirección)",
            plataforma: "voice"
        });

        await supabase.from("zadarma_debug").insert({
            evento: "LLAMADA_EN_ESPERA",
            payload: { clienteTelefono, transcripcion },
            error: "Llamada guardada en lista de espera por falta de taxis"
        });
        return;
    }

    const taxi = taxis[0];
    const taxiPlatform: Platform = taxi.whatsapp_id ? "whatsapp" : "telegram";
    const taxiId = taxi.whatsapp_id || taxi.telegram_id;

    if (taxiId) {
        const mensaje = `📞 **NUEVA LLAMADA DE CLIENTE**\n\n👤 Teléfono: ${clienteTelefono}\n` +
            (transcripcion ? `🎙️ Dice: "${transcripcion}"\n` : "") +
            `\n👉 **Comunícate directamente con el cliente.**`;

        await sendMessage(taxiPlatform, taxiId, mensaje);
        console.log(`✅ Notificación enviada al taxista ${taxi.nombre} (${taxi.id})`);
    }
}

/**
 * 🔄 Busca pedidos en espera y los asigna al primer taxi disponible.
 * Ahora usa la tabla dedicada 'lista_de_espera'.
 */
export async function asignarPedidosPendientes(supabase: SupabaseClient, excluirTaxiId?: string) {
    console.log("🔍 Buscando en lista de espera...");

    // 1. Buscar el registro más antiguo en espera o asignado que necesite reasignación
    const { data: espera } = await supabase
        .from("lista_de_espera")
        .select("*")
        .order("creado", { ascending: true })
        .limit(1);

    // También buscar en pedidos que quedaron sin taxi (creados pero taxi_id null)
    const { data: pedidosPendientes } = await supabase
        .from("pedidos")
        .select("*")
        .is("taxi_id", null)
        .eq("estado", "CREADO")
        .order("creado", { ascending: true })
        .limit(1);

    if ((!espera || espera.length === 0) && (!pedidosPendientes || pedidosPendientes.length === 0)) return;

    // 2. Buscar si hay taxi disponible
    const query = supabase
        .from("taxis")
        .select("*")
        .eq("estado", "DISPONIBLE")
        .order("creado", { ascending: true });

    if (excluirTaxiId) {
        query.neq("id", excluirTaxiId);
    }

    const { data: taxisDisponibles } = await query.limit(1);

    if (!taxisDisponibles || taxisDisponibles.length === 0) return;

    const taxi = taxisDisponibles[0];
    
    const info = {
        id: espera ? espera[0].cliente_telegram_id : pedidosPendientes![0].cliente_telegram_id,
        plataforma: espera ? espera[0].plataforma : "telegram",
        nombre: espera ? espera[0].nombre : "Cliente Pendiente",
        origen: espera ? espera[0].origen : pedidosPendientes![0].origen
    };

    // 3. Limpiar o actualizar registros previos
    if (pedidosPendientes && pedidosPendientes.length > 0) {
        await supabase.from("pedidos").delete().eq("id", pedidosPendientes[0].id);
    } else if (espera && espera.length > 0) {
        await supabase.from("lista_de_espera").delete().eq("id", espera[0].id);
    }

    // 4. Procesar el pedido usando la lógica estándar
    await procesarPedidoTaxi(
        supabase,
        info.plataforma as Platform,
        info.id,
        info.id,
        info.origen,
        `🚕 ¡Un taxista se ha liberado! El taxista **${taxi.nombre}** ha sido asignado a tu pedido en **${info.origen}**.`,
        info.id,
        info.nombre,
    );
}

/**
 * 📋 Obtener todos los clientes en espera (para administración)
 */
export async function obtenerListaEspera(supabase: SupabaseClient) {
    const { data, error } = await supabase
        .from("lista_de_espera")
        .select("*")
        .order("creado", { ascending: true });
    
    if (error) throw error;
    return data;
}

// =========================
// ✅ CONFIRMAR PEDIDO
// =========================
export async function confirmarPedido(
    supabase: SupabaseClient,
    platform: Platform,
    taxiIdOnPlatform: string | number,
    taxiChatId: string | number,
    aiResponse: string,
) {
    // 1. Buscar taxi y su último pedido (asignado o ya en camino)
    const { data: taxi } = await supabase
        .from("taxis")
        .select("id, nombre")
        .eq(platform === "telegram" ? "telegram_id" : "whatsapp_id", String(taxiIdOnPlatform))
        .single();

    if (!taxi) {
        console.error(`❌ No se encontró ningún taxista con ID ${taxiIdOnPlatform} en ${platform}`);
        return;
    }

    console.log(`🔎 Buscando pedido ASIGNADO para taxi.id: ${taxi.id} (${taxi.nombre})`);

    const { data: pedido, error: pedidoError } = await supabase
        .from("pedidos")
        .select("*")
        .eq("taxi_id", taxi.id)
        .eq("estado", "ASIGNADO")
        .order("creado", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (pedidoError || !pedido) {
        console.error("❌ Error o pedido no encontrado:", pedidoError);
        await sendMessage(
            platform,
            taxiChatId,
            `⚠️ No encontré ningún pedido pendiente para confirmar. (Taxi ID: ${taxi.id})`
        );
        return;
    }

    // 2. Actualizar estados
    await supabase.from("pedidos").update({ estado: "EN_CAMINO" }).eq(
        "id",
        pedido.id,
    );
    await supabase.from("taxis").update({ estado: "EN_CAMINO" }).eq(
        "id",
        taxi.id,
    );

    // 3. Avisar al cliente (Asumimos WhatsApp si el ID parece un teléfono, o Telegram si es numérico corto)
    const clienteId = String(pedido.cliente_telegram_id);
    const clientePlatform: Platform = (clienteId.startsWith("1") || clienteId.length > 10) ? "whatsapp_kapso" : "telegram";

    if (clienteId) {
        // Buscamos los detalles completos del taxi para el mensaje
        const { data: taxiInfo } = await supabase
            .from("taxis")
            .select("nombre, numero_taxista, color, placa, modelo")
            .eq("id", taxi.id)
            .single();

        const ficha = taxiInfo?.numero_taxista || "N/A";
        const modelo = taxiInfo?.modelo || "Vehículo estándar";
        const color = taxiInfo?.color ? ` color ${taxiInfo.color}` : "";
        const placa = taxiInfo?.placa ? ` (Placa: ${taxiInfo.placa})` : "";

        const mensajeCliente = `🚕 **¡Taxi en camino!**\n\n` +
                               `El taxista **${taxiInfo?.nombre || "de turno"}** ha aceptado su viaje.\n` +
                               `🔹 **Unidad:** ${ficha}\n` +
                               `🔹 **Vehículo:** ${modelo}${color}${placa}\n\n` +
                               `Por favor, esté atento a su llegada. ¡Gracias por usar Taxi Flash!`;

        await sendMessage(
            clientePlatform,
            clienteId,
            mensajeCliente
        );
    }

    // 4. Intentar recuperar el teléfono del cliente (de la columna o del origen/respaldo)
    let telefonoCliente = pedido.cliente_contacto || pedido.cliente_telegram_id;
    if (!telefonoCliente && pedido.origen && pedido.origen.includes("[Tel: ")) {
        const match = pedido.origen.match(/\[Tel: ([^\]]+)\]/);
        if (match) telefonoCliente = match[1];
    }

    let nombreCliente = "Cliente Voz";
    if (pedido.origen && pedido.origen.includes("[Nombre: ")) {
        const matchName = pedido.origen.match(/\[Nombre: ([^\]]+)\]/);
        if (matchName) nombreCliente = matchName[1];
    }

    // 5. Confirmar al taxista y enviarle el número del cliente con el botón de FINALIZAR
    let msgFinal = `✅ **¡Ya estás asignado a este viaje!**\n\n` +
                   `Gracias por aceptar, por favor comunícate con el cliente ahora mismo.\n\n` +
                   `────────────────────\n`;
    
    if (telefonoCliente) {
        msgFinal += `👤 **Cliente:** \`${nombreCliente}\`\n` +
                    `📞 **Teléfono:** [\`${telefonoCliente}\`](tel:${telefonoCliente})\n\n` +
                    `👉 Toca el número de arriba para llamar directamente.`;
    } else {
        msgFinal += `📍 **Ubicación:** ${pedido.origen}\n` +
                    `✅ Has confirmado el servicio correctamente.`;
    }

    const markupFinalizar = {
        inline_keyboard: [
            [{ text: "🏁 Terminar Viaje", callback_data: `finalizar_${pedido.id}` }]
        ]
    };

    await sendMessage(
        platform,
        taxiChatId,
        msgFinal,
        markupFinalizar
    );

    // 5. Reorganizar turnos finales
    await reorganizarTurnos(supabase);
}

/**
 * Finaliza un pedido y pone al taxista disponible
 */
export async function finalizarPedido(
    supabase: any,
    platform: Platform,
    taxiIdOnPlatform: string | number,
    chatId: string | number,
    pedidoId: string
) {
    // 1. Buscar al taxista
    const { data: taxi } = await supabase
        .from("taxis")
        .select("id, nombre")
        .eq(platform === "telegram" ? "telegram_id" : "whatsapp_id", String(taxiIdOnPlatform))
        .single();

    if (!taxi) return;

    // 2. Actualizar pedido a COMPLETADO
    await supabase.from("pedidos").update({ estado: "COMPLETADO" }).eq("id", pedidoId);

    // 3. Poner taxista DISPONIBLE y reorganizar turnos
    await supabase.from("taxis").update({ 
        estado: "DISPONIBLE",
        creado: new Date().toISOString() 
    }).eq("id", taxi.id);

    const replyMarkup = {
        inline_keyboard: [
            [{ text: "🛑 Terminar Día Laboral", callback_data: "salir_turno" }]
        ]
    };

    await sendMessage(platform, chatId, `✅ ¡Excelente! El viaje ha sido finalizado. Ya estás en turno y disponible para nuevos pedidos.`, replyMarkup);
    
    // 4. Buscar si hay alguien en lista de espera para asignárselo de una vez
    await reorganizarTurnos(supabase);
    await asignarPedidosPendientes(supabase);
}
