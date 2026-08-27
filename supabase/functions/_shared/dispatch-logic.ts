import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Platform, sendMessage, editTelegramMessage } from "./messaging.ts";
import { registrarLogDetallado } from "./logger.ts";

// =========================
// 🔄 FUNCIÓN PARA REORGANIZAR TURNOS
// =========================
export async function reorganizarTurnos(supabase: SupabaseClient) {
    console.log("🔄 Reorganizando turnos...");

    // 1. Auto-limpiar pedidos viejos (>2h) que quedaron ASIGNADO o EN_CAMINO sin resolverse
    const dosHoras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: pedidosViejos } = await supabase
        .from("pedidos")
        .select("id, taxi_id")
        .in("estado", ["ASIGNADO", "EN_CAMINO"])
        .lt("creado", dosHoras);

    if (pedidosViejos && pedidosViejos.length > 0) {
        const ids = pedidosViejos.map(p => p.id);
        await supabase.from("pedidos").update({ estado: "COMPLETADO" }).in("id", ids);
        console.log(`🧹 Auto-limpié ${ids.length} pedidos viejos (>2h)`);
    }

    // 2. Liberar taxistas ASIGNADO/EN_CAMINO que ya no tienen pedido activo
    // IMPORTANTE: Solo liberar ASIGNADO/EN_CAMINO, NUNCA tocar OFFLINE (el taxista eligió desconectarse)
    const { data: taxisBloqueados } = await supabase
        .from("taxis")
        .select("id, nombre, estado")
        .in("estado", ["ASIGNADO", "EN_CAMINO"]);

    const promisesLiberar = (taxisBloqueados || []).map(async (taxi) => {
        // Solo liberar si estaba ASIGNADO o EN_CAMINO (nunca OFFLINE)
        if (taxi.estado === "OFFLINE") {
            console.log(`⛔ Taxista ${taxi.nombre} está OFFLINE por decisión propia, no se toca.`);
            return;
        }
        const { data: pedidoActivo } = await supabase
            .from("pedidos")
            .select("id")
            .eq("taxi_id", taxi.id)
            .in("estado", ["ASIGNADO", "EN_CAMINO"])
            .limit(1);

        if (!pedidoActivo || pedidoActivo.length === 0) {
            await supabase.from("taxis")
                .update({ estado: "DISPONIBLE", creado: new Date().toISOString() })
                .eq("id", taxi.id);
            console.log(`🔓 Taxista liberado automáticamente: ${taxi.nombre}`);
        }
    });
    await Promise.all(promisesLiberar);

    // 3. Obtener todos los DISPONIBLES ordenados por turno actual (los sin turno van al final)
    const { data: taxisDisponibles, error } = await supabase
        .from("taxis")
        .select("id, turno, creado, estado")
        .eq("estado", "DISPONIBLE")
        .order("turno", { ascending: true, nullsFirst: false })
        .order("creado", { ascending: true });

    if (error) {
        console.error("❌ Error obteniendo taxis:", error);
        return;
    }

    // 4. Asignar turnos secuenciales a DISPONIBLES (1, 2, 3...)
    let updatesCount = 0;
    const promisesTurnos = [];
    for (let i = 0; i < taxisDisponibles!.length; i++) {
        const taxi = taxisDisponibles![i];
        const nuevoTurno = i + 1;
        if (taxi.turno !== nuevoTurno) {
            promisesTurnos.push(supabase.from("taxis").update({ turno: nuevoTurno }).eq("id", taxi.id));
            updatesCount++;
        }
    }
    await Promise.all(promisesTurnos);

    // 5. Poner turno=NULL a los que están ASIGNADO, EN_CAMINO u OFFLINE (fuera de la cola disponible)
    await supabase.from("taxis").update({ turno: null }).neq("estado", "DISPONIBLE");

    console.log(`✅ Turnos reorganizados. Actualizados: ${updatesCount} taxis.`);
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
    targetTaxiId?: string,
) {
    console.log(
        `🚕 Procesando pedido para cliente ${clientId} en ${ubicacion} (${platform})`,
    );

    // 1. Buscar taxi disponible (ESTRICTAMENTE el que tenga Turno #1)
    console.log("🔍 Buscando taxista de turno (#1)...");
    let taxiQuery = supabase
        .from("taxis")
        .select("*")
        .eq("estado", "DISPONIBLE");

    if (targetTaxiId) {
        taxiQuery = taxiQuery.eq("id", targetTaxiId);
    } else {
        taxiQuery = taxiQuery.order("turno", { ascending: true, nullsFirst: false }).order("creado", { ascending: true }).limit(1);
    }

    const { data: taxis, error: taxiError } = await taxiQuery;

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

    // 2. Deduplicar: si ya existe un pedido ASIGNADO para este cliente, no crear otro
    if (clienteContacto && clienteContacto !== "Desconocido" && clienteContacto !== "0") {
        const { data: pedidoExistente } = await supabase
            .from("pedidos")
            .select("id")
            .eq("cliente_contacto", clienteContacto)
            .eq("estado", "ASIGNADO")
            .limit(1)
            .maybeSingle();
        if (pedidoExistente) {
            console.log(`⚠️ Ya existe un pedido ASIGNADO para ${clienteContacto}. Ignorando duplicado.`);
            return null;
        }
    }

    // 3. Crear pedido en modo "ASIGNADO"
    // Solo agregar [Nombre:] si el origen NO lo contiene ya (evita duplicados en reasignaciones)
    let origenGuardado = customer_name && customer_name !== "Cliente Voz" && customer_name !== String(clientId) && !ubicacion.includes("[Nombre:")
        ? `${ubicacion} [Nombre: ${customer_name}]`
        : ubicacion;

    if (!origenGuardado.includes("[CreadoOriginal:")) {
        origenGuardado = `${origenGuardado} [CreadoOriginal: ${Date.now()}]`;
    }

    const pedidoData: Record<string, string | number | null> = {
        estado: "ASIGNADO",
        origen: origenGuardado,
        taxi_id: taxi.id,
        cliente_telegram_id: String(clientId),
        cliente_contacto: clienteContacto,
        creado: new Date().toISOString(),
    };

    console.log("📦 Intentando insertar pedido:", JSON.stringify(pedidoData));
    const { data: pedidoInserted, error: pedidoError } = await supabase.from("pedidos").insert(
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

    // 3. Reservar al taxista cambiando su estado temporalmente a ASIGNADO y turno a NULL
    await supabase.from("taxis").update({ estado: "ASIGNADO", turno: null }).eq(
        "id",
        taxi.id,
    );
    // 🚀 TAREAS EN SEGUNDO PLANO (FASE 2)
    // Se ejecutan de manera asíncrona para que Vapi reciba la respuesta instantáneamente.
    const runBackgroundTasks = async () => {
        try {
            await reorganizarTurnos(supabase);
            
            // 4. Notificar al taxista (Prioridad absoluta)
            const taxiPlatform: Platform = taxi.whatsapp_id ? "whatsapp" : "telegram";
            const taxiId = taxi.whatsapp_id || taxi.telegram_id;

            console.log(`🚖 [Background] Notificando a taxista: ${taxi.nombre} (@${taxiId}) en ${taxiPlatform}`);

            let savedMessageId: number | null = null;
            if (taxiId) {
                const clienteNombreDisplay = customer_name && customer_name !== "Cliente Voz" && customer_name !== String(clientId)
                    ? customer_name
                    : "Cliente";

                const telefonoContacto = clienteContacto && clienteContacto !== "Desconocido" ? clienteContacto : null;
                let telefonoWa = "";
                if (telefonoContacto) {
                    telefonoWa = String(telefonoContacto).replace(/\D/g, "");
                    if (telefonoWa.length === 10) telefonoWa = "1" + telefonoWa;
                }

                const ubicacionLimpia = ubicacion
                    .replace(/\[Nombre:[^\]]*\]/gi, '')
                    .replace(/\[Reintentos:[^\]]*\]/gi, '')
                    .replace(/\[Rechazaron:[^\]]*\]/gi, '')
                    .replace(/\[CreadoOriginal:[^\]]*\]/gi, '')
                    .trim();

                const mensaje = `🚕 *NUEVA SOLICITUD DE SERVICIO*\n\n` +
                               `👤 *Cliente:* ${clienteNombreDisplay}\n` +
                               (telefonoContacto ? `📞 *Teléfono:* \`${telefonoContacto}\` *(toca para copiar/llamar)*\n` : ``) +
                               `📍 *Ubicación:* ${ubicacionLimpia || "Jarabacoa"}\n\n` +
                               `¿Aceptas este pedido para contactar al cliente de inmediato?`;

                const inline_keyboard: Record<string, string>[][] = [
                    [
                        { text: "✅ ACEPTAR", callback_data: "confirmar" },
                        { text: "❌ RECHAZAR", callback_data: "rechazar" }
                    ]
                ];

                if (telefonoWa) {
                    inline_keyboard.push([
                        { text: `💬 WhatsApp de ${clienteNombreDisplay}`, url: `https://wa.me/${telefonoWa}` }
                    ]);
                }

                const replyMarkup = { inline_keyboard };

                savedMessageId = await sendMessage(taxiPlatform, taxiId, mensaje, replyMarkup);

                registrarLogDetallado(supabase, {
                    evento: "TELEGRAM_NOTIFICACION_ENVIADA",
                    clientePhone: clienteContacto || "N/A",
                    clienteNombre: clienteNombreDisplay,
                    taxistaNombre: taxi.nombre,
                    taxistaFicha: taxi.numero_taxista,
                    taxistaTelegramId: taxiId,
                    detalles: { telegramMessageId: savedMessageId, plataforma: taxiPlatform, ubicacion }
                }).catch((e: unknown) => console.error("Error asíncrono en log:", e));
            }

            if (savedMessageId) {
                await supabase.from("pedidos")
                    .update({ telegram_message_id: savedMessageId })
                    .eq("id", pedidoInserted!.id);
            }

            // 5. Notificar al cliente (asíncrono si es plataforma de chat)
            if (platform !== "voice") {
                await sendMessage(
                    platform,
                    chatId,
                    aiResponse || `¡Perfecto! El taxista ${taxi.nombre} ha sido notificado.`
                );
            }
        } catch (bgErr) {
            console.error("❌ Error en tareas de fondo (runBackgroundTasks):", bgErr);
        }
    };

    // Disparar en segundo plano sin esperar a que termine, pero usando waitUntil 
    // para garantizar que Supabase no pause el servidor hasta que Telegram reciba el mensaje.
    // @ts-ignore: EdgeRuntime es global en Supabase Edge Functions
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
        // @ts-ignore
        EdgeRuntime.waitUntil(runBackgroundTasks());
    } else {
        runBackgroundTasks();
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
    console.log(`📢 Procesando llamada de voz de ${clienteTelefono} como pedido para asignación por turnos...`);
    const ubicacion = transcripcion ? `Llamada: ${transcripcion}` : "Llamada de voz (sin dirección)";
    
    await procesarPedidoTaxi(
        supabase,
        "voice", // plataforma de voz
        clienteTelefono, // chatId del cliente
        clienteTelefono, // clientId
        ubicacion, // origen/ubicacion
        "Llamada de voz recibida", // aiResponse
        clienteTelefono, // clienteContacto
        "Cliente de Voz", // customer_name
    );
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
    // También excluir taxistas que ya rechazaron este pedido
    const origenEspera = espera && espera.length > 0 ? (espera[0].origen || '') : '';
    const matchRechazaronEspera = origenEspera.match(/\[Rechazaron: ([^\]]+)\]/);
    const idsRechazaron: string[] = matchRechazaronEspera ? matchRechazaronEspera[1].split(',') : [];
    if (excluirTaxiId && !idsRechazaron.includes(excluirTaxiId)) {
        idsRechazaron.push(excluirTaxiId);
    }

    let query = supabase
        .from("taxis")
        .select("*")
        .eq("estado", "DISPONIBLE")
        .order("turno", { ascending: true, nullsFirst: false })
        .order("creado", { ascending: true });

    // Excluir a todos los taxistas que ya rechazaron este pedido
    for (const idRech of idsRechazaron) {
        if (idRech) query = query.neq("id", idRech);
    }

    const { data: taxisDisponibles } = await query.limit(1);

    if (!taxisDisponibles || taxisDisponibles.length === 0) return;

    const taxi = taxisDisponibles[0];
    
    const info = {
        id: espera ? (espera[0].cliente_id || espera[0].cliente_telegram_id || "0") : pedidosPendientes![0].cliente_telegram_id,
        plataforma: espera ? (espera[0].plataforma || "voice") : "telegram",
        nombre: espera ? espera[0].nombre : "Cliente Pendiente",
        origen: espera ? espera[0].origen : pedidosPendientes![0].origen,
        contacto: espera ? (espera[0].cliente_contacto || "") : (pedidosPendientes![0].cliente_contacto || "")
    };

    // 3. Limpiar registros previos de AMBAS tablas para evitar bucles o duplicados resucitados
    if (pedidosPendientes && pedidosPendientes.length > 0) {
        await supabase.from("pedidos").delete().eq("id", pedidosPendientes[0].id);
    }
    if (espera && espera.length > 0) {
        await supabase.from("lista_de_espera").delete().eq("id", espera[0].id);
    }
    if (info.id && info.id !== "0") {
        await supabase.from("lista_de_espera").delete().eq("cliente_id", String(info.id));
    }

    // Guard de idempotencia: no asignar si ya hay un pedido ASIGNADO activo para este cliente
    if (info.contacto && info.contacto !== "0" && info.contacto !== "") {
        const { data: yaAsignado } = await supabase
            .from("pedidos")
            .select("id")
            .eq("cliente_contacto", info.contacto)
            .eq("estado", "ASIGNADO")
            .limit(1)
            .maybeSingle();
        if (yaAsignado) {
            console.log(`⚠️ Ya hay un pedido ASIGNADO activo para ${info.contacto}. asignarPedidosPendientes cancela para evitar duplicado.`);
            return;
        }
    }

    // 4. Procesar el pedido pasando el targetTaxiId seleccionado
    await procesarPedidoTaxi(
        supabase,
        info.plataforma as Platform,
        info.id,
        info.id,
        info.origen,
        `🚕 Pedido reasignado desde lista de espera.`,
        info.contacto || String(info.id),
        info.nombre,
        taxi.id,
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
    _aiResponse: string,
) {
    // 1. Buscar taxi y su último pedido (asignado o ya en camino)
    const { data: taxi } = await supabase
        .from("taxis")
        .select("id, nombre, numero_taxista, telegram_id")
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
    await supabase.from("taxis").update({ estado: "EN_CAMINO", turno: null }).eq(
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

    // Limpiar: si el teléfono es "0", "Desconocido" o inválido, tratarlo como sin teléfono
    const telCleanCheck = String(telefonoCliente || "").replace(/\D/g, "");
    const telefonoValido = telCleanCheck && telCleanCheck !== "0" && telCleanCheck.length >= 7;
    if (!telefonoValido) telefonoCliente = null;

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
        msgFinal += `👤 **Cliente:** \`${nombreCliente}\`\n` +
                    `📍 **Ubicación:** ${pedido.origen?.replace(/\s*\[Nombre:[^\]]*\]/g, "").trim()}\n` +
                    `✅ Has confirmado el servicio correctamente.`;
    }

    const inlineKeyboard: Record<string, string>[][] = [];

    if (telefonoCliente) {
        // Limpiar el número para WhatsApp
        let telClean = String(telefonoCliente).replace(/\D/g, "");
        if (telClean.length === 10) {
            telClean = "1" + telClean;
        }
        
        inlineKeyboard.push([
            { text: `💬 WhatsApp de ${nombreCliente}`, url: `https://wa.me/${telClean}` }
        ]);
    }

    inlineKeyboard.push([
        { text: "🏁 Terminar Viaje", callback_data: `finalizar_${pedido.id}` }
    ]);

    inlineKeyboard.push([
        { text: "🛑 Terminar Día Laboral", callback_data: "salir_turno" }
    ]);

    const markupFinalizar = {
        inline_keyboard: inlineKeyboard
    };

    await sendMessage(
        platform,
        taxiChatId,
        msgFinal,
        markupFinalizar
    );

    // Log detallado de confirmación por el taxista
    await registrarLogDetallado(supabase, {
        evento: "TAXISTA_CONFIRMO_PEDIDO",
        clientePhone: telefonoCliente || "N/A",
        clienteNombre: nombreCliente,
        taxistaNombre: taxi.nombre,
        taxistaFicha: taxi.numero_taxista,
        taxistaTelegramId: taxi.telegram_id,
        detalles: { origen: pedido.origen, pedidoId: pedido.id }
    });

    // 5. Reorganizar turnos finales
    await reorganizarTurnos(supabase);
}

/**
 * Finaliza un pedido y pone al taxista disponible
 */
export async function finalizarPedido(
    supabase: SupabaseClient,
    platform: Platform,
    taxiIdOnPlatform: string | number,
    chatId: string | number,
    pedidoId: string
) {
    // 1. Buscar al taxista
    const { data: taxi } = await supabase
        .from("taxis")
        .select("id, nombre, numero_taxista, telegram_id")
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

/**
 * ❌ Rechaza un pedido asignado a un taxista, lo mueve al final de la cola y reasigna el pedido al siguiente taxista.
 */
export async function rechazarPedido(
    supabase: SupabaseClient,
    platform: Platform,
    taxiIdOnPlatform: string | number,
    chatId: string | number,
) {
    // 1. Buscar al taxista
    const { data: taxi } = await supabase
        .from("taxis")
        .select("id, nombre, numero_taxista, telegram_id")
        .eq(platform === "telegram" ? "telegram_id" : "whatsapp_id", String(taxiIdOnPlatform))
        .maybeSingle();

    if (!taxi) return;

    console.log(`❌ Taxista ${taxi.nombre} (ID: ${taxi.id}) rechazó el pedido.`);

    // 2. Buscar el pedido que tenía asignado
    const { data: pedido } = await supabase
        .from("pedidos")
        .select("*")
        .eq("taxi_id", taxi.id)
        .eq("estado", "ASIGNADO")
        .order("creado", { ascending: false })
        .limit(1)
        .maybeSingle();

    // 3. Mover al taxista al final de la cola de turnos
    await supabase.from("taxis").update({ 
        estado: "DISPONIBLE",
        creado: new Date().toISOString() 
    }).eq("id", taxi.id);

    await reorganizarTurnos(supabase);

    // 4. Si había un pedido asignado, moverlo a lista_de_espera y editar el mensaje anterior del taxista
    if (pedido) {
        // Editar el mensaje anterior del taxista (quitar botones, mostrar que fue rechazado)
        if (taxi.telegram_id && pedido.telegram_message_id) {
            await editTelegramMessage(
                Number(taxi.telegram_id),
                Number(pedido.telegram_message_id),
                `❌ *Pedido rechazado por ti.*\n\n📍 ${pedido.origen}\n\nEste servicio ha sido pasado al siguiente taxista de turno.`
            );
        }

        let nombreCliente = "Cliente Pendiente";
        if (pedido.origen && pedido.origen.includes("[Nombre: ")) {
            const matchName = pedido.origen.match(/\[Nombre: ([^\]]+)\]/);
            if (matchName) nombreCliente = matchName[1];
        }

        // Rastrear IDs de taxistas que ya rechazaron (para no volver a enviarles este pedido)
        let yaRechazaron: string[] = [];
        const matchRechazaron = pedido.origen?.match(/\[Rechazaron: ([^\]]+)\]/);
        if (matchRechazaron) {
            yaRechazaron = matchRechazaron[1].split(',').map((id: string) => id.trim());
        }
        if (!yaRechazaron.includes(String(taxi.id))) {
            yaRechazaron.push(String(taxi.id));
        }

        // Parsear número de reintentos actual
        let reintentos = 0;
        if (pedido.origen && pedido.origen.includes("[Reintentos: ")) {
            const matchReint = pedido.origen.match(/\[Reintentos: (\d+)\]/);
            if (matchReint) reintentos = parseInt(matchReint[1], 10);
        }
        reintentos += 1;

        // Eliminar de pedidos inmediatamente
        await supabase.from("pedidos").delete().eq("id", pedido.id);

        // Límite de 8 minutos desde la primera solicitud
        let expirado = false;
        if (pedido.origen && pedido.origen.includes("[CreadoOriginal: ")) {
            const matchCreado = pedido.origen.match(/\[CreadoOriginal:\s*(\d+)\]/);
            if (matchCreado) {
                const creadoOriginalMs = parseInt(matchCreado[1], 10);
                if (Date.now() - creadoOriginalMs >= 8 * 60 * 1000) {
                    expirado = true;
                }
            }
        }

        // 🛑 LÍMITE ESTRICTO: Si pasaron 8 minutos, CANCELAR EL VIAJE
        if (expirado) {
            console.log(`🛑 Pedido de ${nombreCliente} alcanzó el límite máximo de 8 minutos circulando. Cancelando definitivamente.`);
            
            await registrarLogDetallado(supabase, {
                evento: "DESPACHO_CANCELADO_MAX_TIEMPO",
                clientePhone: pedido.cliente_contacto || "N/A",
                clienteNombre: nombreCliente,
                taxistaNombre: taxi?.nombre,
                taxistaFicha: taxi?.numero_taxista,
                reintentoNum: yaRechazaron.length,
                detalles: { origen: pedido.origen, motivo: `Alcanzó los 8 minutos de espera` }
            });

            if (pedido.cliente_contacto) {
                await supabase.from("lista_de_espera").delete().eq("cliente_contacto", pedido.cliente_contacto);
            }
            if (pedido.cliente_telegram_id) {
                const clienteIdStr = String(pedido.cliente_telegram_id);
                if (clienteIdStr.length >= 10) {
                    await sendMessage("whatsapp_kapso", clienteIdStr, "⚠️ Lo sentimos, en este momento todos los taxistas de turno están ocupados o no disponibles. Por favor intenta de nuevo en unos minutos.");
                }
            }
        } else {
            // Aún quedan intentos (< 3): actualizar origen y mover a lista de espera
            let nuevoOrigen = pedido.origen?.replace(/\s*\[Rechazaron:[^\]]*\]/, '').replace(/\s*\[Reintentos:[^\]]*\]/, '') || '';
            nuevoOrigen = `${nuevoOrigen} [Reintentos: ${reintentos}] [Rechazaron: ${yaRechazaron.join(',')}]`.trim();

            await supabase.from("lista_de_espera").insert({
                cliente_id: String(pedido.cliente_telegram_id || "0"),
                nombre: nombreCliente,
                origen: nuevoOrigen,
                plataforma: platform === "telegram" ? "telegram" : "whatsapp",
                cliente_contacto: pedido.cliente_contacto || null,
                mensaje_confirmacion: "Reasignado por rechazo de taxista"
            });

            // 6. Asignar pedidos pendientes al siguiente taxista disponible (excluyendo a los que ya rechazaron)
            await asignarPedidosPendientes(supabase, taxi.id);
        }
    }

    // 5. Avisar al taxista una sola vez
    await sendMessage(
        platform,
        chatId,
        "❌ **Pedido rechazado.**\n\nTe hemos colocado al final de la fila de turnos. Te notificaremos cuando haya un nuevo servicio disponible para ti."
    );
}

/**
 * ⏰ Revisa si hay pedidos en estado ASIGNADO con más de 30 segundos sin respuesta de aceptación.
 * Si han pasado 30 segundos, notifica al taxista, lo mueve al final de la cola
 * y reasigna automáticamente el servicio al siguiente taxista de turno.
 */
export async function verificarTimeoutsPedidos(supabase: SupabaseClient) {
    // 🧹 1. Limpieza automática de lista_de_espera: Borrar solicitudes con más de 8 minutos
    try {
        const OCHO_MINUTOS_MS = 8 * 60 * 1000;
        const fechaLimiteEspera = new Date(Date.now() - OCHO_MINUTOS_MS).toISOString();
        await supabase
            .from("lista_de_espera")
            .delete()
            .lt("creado", fechaLimiteEspera);
    } catch (e) {
        console.error("❌ Error al limpiar lista_de_espera de > 3 min:", e);
    }

    // Buscar todos los pedidos en estado ASIGNADO y verificar el tiempo real en milisegundos
    const { data: pedidosAsignados, error } = await supabase
        .from("pedidos")
        .select("*, taxis(*)")
        .eq("estado", "ASIGNADO");

    if (error || !pedidosAsignados || pedidosAsignados.length === 0) {
        return;
    }

    const ahora = Date.now();
    const pedidosExpirados = pedidosAsignados.filter((p: Record<string, unknown>) => {
        if (!p.creado) return false;
        let isoDate = String(p.creado).trim();
        if (!isoDate.endsWith("Z") && !isoDate.includes("+")) {
            isoDate += "Z";
        }
        const creadoMs = new Date(isoDate).getTime();
        if (isNaN(creadoMs)) return false;
        const diffMs = ahora - creadoMs;
        // Solo expira si pasaron REALMENTE más de 60 segundos (60,000 ms)
        return diffMs >= 60 * 1000;
    });

    if (pedidosExpirados.length === 0) {
        return;
    }

    console.log(`⏰ Encontrados ${pedidosExpirados.length} pedidos con timeout real (> 60 seg). Procesando solo el más antiguo...`);

    // FIX CRÍTICO: Procesar solo EL PRIMERO por ciclo del cron.
    // Si hay múltiples pedidos expirados, procesarlos uno a uno en cada ejecución del cron
    // para evitar la "tormenta" de asignarPedidosPendientes concurrentes.
    const pedidoAOrdenar = pedidosExpirados.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const creadoA = String(a.creado);
        const creadoB = String(b.creado);
        const ta = new Date(creadoA.endsWith('Z') ? creadoA : creadoA + 'Z').getTime();
        const tb = new Date(creadoB.endsWith('Z') ? creadoB : creadoB + 'Z').getTime();
        return ta - tb;
    });
    // Solo procesar el pedido más antiguo
    for (const pedido of [pedidoAOrdenar[0]]) {
        const taxi = pedido.taxis;
        const taxiId = taxi?.id;

        // 1. Editar el mensaje original del taxista para quitar botones y notificar sin enviar un segundo mensaje
        if (taxi && taxi.telegram_id && pedido.telegram_message_id) {
            await editTelegramMessage(
                Number(taxi.telegram_id),
                Number(pedido.telegram_message_id),
                `⏰ *TIEMPO AGOTADO (60 seg)*\n\n📍 ${pedido.origen}\n\nNo respondiste a tiempo. El sistema te ha puesto OFFLINE para no retrasar más servicios. Cuando estés listo, pide turno de nuevo.`
            );
        }

        // 2. Poner al taxista OFFLINE automáticamente por no responder
        if (taxi) {
            const { data: taxiActual } = await supabase.from("taxis").select("estado").eq("id", taxiId).single();
            if (taxiActual && taxiActual.estado !== "OFFLINE") {
                await supabase.from("taxis").update({ 
                    estado: "OFFLINE",
                    turno: null
                }).eq("id", taxiId);
                console.log(`📴 Taxista ${taxi?.nombre} puesto OFFLINE automáticamente por timeout.`);
            }
        }

        // 3. Mover el pedido a la lista de espera para reasignación limpia (máximo 3 reintentos)
        let nombreCliente = "Cliente Pendiente";
        if (pedido.origen && pedido.origen.includes("[Nombre: ")) {
            const matchName = pedido.origen.match(/\[Nombre: ([^\]]+)\]/);
            if (matchName) nombreCliente = matchName[1];
        }

        // Parsear número de reintentos actual
        let reintentos = 0;
        if (pedido.origen && pedido.origen.includes("[Reintentos: ")) {
            const matchReint = pedido.origen.match(/\[Reintentos: (\d+)\]/);
            if (matchReint) reintentos = parseInt(matchReint[1], 10);
        }
        reintentos += 1;

        // 4. Eliminar el pedido asignado expirado de la tabla pedidos
        await supabase.from("pedidos").delete().eq("id", pedido.id);

        // Verificar límite de 8 minutos
        let expirado = false;
        if (pedido.origen && pedido.origen.includes("[CreadoOriginal: ")) {
            const matchCreado = pedido.origen.match(/\[CreadoOriginal:\s*(\d+)\]/);
            if (matchCreado) {
                const creadoOriginalMs = parseInt(matchCreado[1], 10);
                if (Date.now() - creadoOriginalMs >= 8 * 60 * 1000) {
                    expirado = true;
                }
            }
        }

        if (expirado) {
            console.log(`🛑 Pedido de ${nombreCliente} alcanzó el límite máximo de 8 minutos en espera. Cancelando servicio.`);
            
            await registrarLogDetallado(supabase, {
                evento: "DESPACHO_CANCELADO_MAX_TIEMPO",
                clientePhone: pedido.cliente_contacto || "N/A",
                clienteNombre: nombreCliente,
                taxistaNombre: taxi?.nombre,
                taxistaFicha: taxi?.numero_taxista,
                reintentoNum: reintentos,
                detalles: { origen: pedido.origen, motivo: "Pasaron 8 minutos sin éxito" }
            });

            if (pedido.cliente_contacto) {
                await supabase.from("lista_de_espera").delete().eq("cliente_contacto", pedido.cliente_contacto);
            }
        } else {
            await registrarLogDetallado(supabase, {
                evento: "DESPACHO_REINTENTO_TIMEOUT",
                clientePhone: pedido.cliente_contacto || "N/A",
                clienteNombre: nombreCliente,
                taxistaNombre: taxi?.nombre,
                taxistaFicha: taxi?.numero_taxista,
                reintentoNum: reintentos,
                detalles: { origen: pedido.origen, proximoReintento: `${reintentos + 1}/3` }
            });

            // Rastrear IDs de taxistas que no respondieron o rechazaron
            let yaRechazaron: string[] = [];
            const matchRechazaron = pedido.origen?.match(/\[Rechazaron: ([^\]]+)\]/);
            if (matchRechazaron) {
                yaRechazaron = matchRechazaron[1].split(',').map((id: string) => id.trim());
            }
            if (taxiId && !yaRechazaron.includes(String(taxiId))) {
                yaRechazaron.push(String(taxiId));
            }

            // Actualizar la etiqueta de reintentos y rechazaron en el origen
            let nuevoOrigen = pedido.origen?.replace(/\s*\[Rechazaron:[^\]]*\]/, '') || '';
            if (nuevoOrigen.includes("[Reintentos: ")) {
                nuevoOrigen = nuevoOrigen.replace(/\[Reintentos: \d+\]/, `[Reintentos: ${reintentos}]`);
            } else {
                nuevoOrigen = `${nuevoOrigen} [Reintentos: ${reintentos}]`;
            }
            nuevoOrigen = `${nuevoOrigen} [Rechazaron: ${yaRechazaron.join(',')}]`.trim();

            const clienteIdRaw = pedido.cliente_telegram_id;
            const clienteIdSafe = (clienteIdRaw !== null && clienteIdRaw !== undefined && String(clienteIdRaw) !== "0")
                ? clienteIdRaw
                : "0";

            await supabase.from("lista_de_espera").insert({
                cliente_id: String(clienteIdSafe),
                nombre: nombreCliente,
                origen: nuevoOrigen,
                plataforma: "voice",
                cliente_contacto: pedido.cliente_contacto || null,
                mensaje_confirmacion: `Reasignado (Intento ${reintentos}/3)`
            });

            // 5. Reorganizar turnos y asignar al siguiente taxista
            await reorganizarTurnos(supabase);
            await asignarPedidosPendientes(supabase, taxiId);
        }
    }
}

