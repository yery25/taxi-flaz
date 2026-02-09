// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
// ================================
// 🤖 TELEGRAM + IA (GROQ / OPENAI)
// Supabase Edge Function (Deno)
// ================================
// index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LISTA_TAXISTAS } from "./lista_taxistas.ts";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";

// =========================
// 🔐 VARIABLES DE ENTORNO - USAR TUS VARIABLES PERSONALIZADAS
// =========================
// ESTAS son las que configuraste con "supabase secrets set"
const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const IA_PROVIDER = Deno.env.get("IA_PROVIDER") || "groq";

// =========================
// 🔧 VALIDACIÓN
// =========================
console.log("=== INICIANDO BOT DE TAXIS ===");
console.log("✅ URL cargada:", SUPABASE_URL ? "Sí" : "No");
console.log(
  "✅ SERVICE_ROLE_KEY cargada:",
  SUPABASE_SERVICE_ROLE_KEY ? "Sí" : "No",
);
console.log("✅ TELEGRAM_TOKEN cargada:", TELEGRAM_TOKEN ? "Sí" : "No");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_TOKEN) {
  console.error("❌ FALTAN VARIABLES CRÍTICAS");
  throw new Error("Variables de entorno faltantes");
}

if (SUPABASE_SERVICE_ROLE_KEY.startsWith("sk-")) {
  console.error(
    "❌ ERROR CRÍTICO: Estás usando una clave de OpenAI (sk-...) en SERVICE_ROLE_KEY.",
  );
  console.error(
    "Debes usar la clave 'service_role' de Supabase (empieza con eyJ...).",
  );
}

if (
  !SUPABASE_URL.includes("supabase.co") &&
  !SUPABASE_URL.includes("localhost") && !SUPABASE_URL.includes("127.0.0.1")
) {
  console.error(
    "❌ ERROR CRÍTICO: La URL no parece ser una URL válida de Supabase.",
  );
}

// =========================
// 🔧 CLIENTE SUPABASE
// =========================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

console.log("🤖 Cliente Supabase creado");

// =========================
// 🚀 EDGE FUNCTION
// =========================
serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return new Response("Solo POST permitido", { status: 405 });
    }

    const body = await req.json();

    // Verificar que hay un mensaje válido (texto o voz)
    if (!body.message) return new Response("ok");
    if (!body.message.text && !body.message.voice) return new Response("ok");

    const message = body.message;
    const chatId = message.chat.id;
    const telegramId = message.from.id;
    const nombre = message.from.first_name || message.from.username ||
      "Usuario";

    let texto = "";

    // ========================================
    // 🎙️ SOPORTE PARA MENSAJES DE VOZ
    // ========================================
    if (message.voice) {
      console.log(`\n🎙️ Mensaje de voz recibido de ${nombre}`);

      try {
        // 1. Obtener información del archivo de voz
        const voiceFileId = message.voice.file_id;

        // 2. Descargar el archivo de Telegram
        console.log("📥 Descargando archivo de voz de Telegram...");
        const fileUrl = await getTelegramFileUrl(voiceFileId);
        const audioResponse = await fetch(fileUrl);
        const audioBuffer = await audioResponse.arrayBuffer();

        // 3. Transcribir con Groq Whisper
        console.log("🔄 Transcribiendo audio...");
        const transcription = await transcribeWithGroq(audioBuffer);
        texto = transcription.text;

        console.log(`✅ Transcripción: "${texto}"`);

        // Notificar al usuario que se está procesando
        await sendToTelegram(
          chatId,
          `🎙️ Recibido: "${texto}"\n\nProcesando tu solicitud...`,
        );
      } catch (error) {
        console.error("❌ Error procesando mensaje de voz:", error);
        await sendToTelegram(
          chatId,
          "❌ Hubo un error procesando tu mensaje de voz. Por favor, intenta de nuevo o envía un mensaje de texto.",
        );
        return new Response("ok");
      }
    } else {
      // Mensaje de texto normal
      texto = message.text;
      console.log(`\n📩 Mensaje de texto de ${nombre}: "${texto}"`);
    }

    console.log(`\n📩 Mensaje de ${nombre}: "${texto}"`);

    // 1. VERIFICAR SI EL USUARIO YA ES UN TAXISTA REGISTRADO
    const { data: existingTaxi } = await supabase
      .from("taxis")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    const isTaxista = !!existingTaxi;
    console.log(`👤 ¿Es taxista registrado?: ${isTaxista ? "Sí" : "No"}`);

    // --- NUEVO: INTERCEPTAR COMANDO "SOY TAXISTA" ---
    if (texto.toLowerCase().includes("soy taxista")) {
      // 1. Verificar si menciona alguna cédula Y número de la lista (Requiere AMBOS)
      const autorizado = LISTA_TAXISTAS.find((t) =>
        texto.includes(t.cedula) && texto.includes(t.numero_taxista)
      );

      if (!autorizado) {
        // Buscamos si al menos mencionó UNO para darle una pista más específica, o mensaje genérico
        const posible = LISTA_TAXISTAS.find((t) =>
          texto.includes(t.cedula) || texto.includes(t.numero_taxista)
        );
        if (posible) {
          await sendToTelegram(
            chatId,
            `🚫 Faltan datos. Para registrarte debes enviar AMBOS:\n\nSoy taxista ${posible.cedula} ${posible.numero_taxista}`,
          );
        } else {
          await sendToTelegram(
            chatId,
            "🚫 Para registrarte, debes enviar: **Soy taxista [CÉDULA] [NUMERO TAXI]**\n\nEjemplo: Soy taxista 001-0000000-0 TX-001",
          );
        }
        return new Response("ok");
      }

      // 2. Verificar si ya está registrado en OTRO dispositivo
      const { data: yaRegistrado } = await supabase
        .from("taxis")
        .select("*")
        .or(
          `cedula.eq.${autorizado.cedula},numero_taxista.eq.${autorizado.numero_taxista}`,
        )
        .neq("telegram_id", telegramId)
        .single();

      if (yaRegistrado) {
        await sendToTelegram(
          chatId,
          `⚠️ Error: El taxista ${autorizado.nombre} ya está registrado en otro dispositivo.`,
        );
        return new Response("ok");
      }

      // 3. Registrar/Actualizar (sin asignar turno aún)
      console.log(
        `✅ Taxista autorizado detectado: ${autorizado.nombre} -> Telegram: ${telegramId}`,
      );

      const { error: upsertError } = await supabase.from("taxis").upsert({
        telegram_id: telegramId,
        nombre: autorizado.nombre,
        cedula: autorizado.cedula,
        numero_taxista: autorizado.numero_taxista,
        estado: "DISPONIBLE",
        turno: null, // Se asignará al reorganizar
        creado: new Date().toISOString(),
      }, { onConflict: "telegram_id" });

      if (upsertError) {
        console.error("❌ Error registrando taxista:", upsertError);
        await sendToTelegram(
          chatId,
          "Hubo un error técnico al registrarte. Revisa si tus datos son correctos.",
        );
        return new Response("ok");
      }

      // 4. Reorganizar turnos para todos los DISPONIBLES
      await reorganizarTurnos();

      // 5. Obtener el turno asignado
      const { data: taxiActualizado } = await supabase
        .from("taxis")
        .select("turno")
        .eq("telegram_id", telegramId)
        .single();

      const turnoAsignado = taxiActualizado?.turno || "N/A";

      console.log(
        `💾 Taxista ${autorizado.nombre} registrado/actualizado - Turno: ${turnoAsignado}`,
      );
      await sendToTelegram(
        chatId,
        `✅ Bienvenido **${autorizado.nombre}**. \nHas sido registrado correctamente.\n\n🔢 **Tu turno es: ${turnoAsignado}**`,
      );
      return new Response("ok");
    }

    // 2. LLAMADA A IA PARA INTERPRETAR INTENCIÓN
    // MODIFICADO: Solo si es taxista registrado le decimos a la IA que lo es.
    // Si no, la IA asumirá que es cliente.
    const interpretation = await callIA(texto, nombre, isTaxista, existingTaxi);
    console.log("🤖 IA interpretó:", interpretation);

    const { intent, response: aiResponse, location } = interpretation;

    // 3. LÓGICA SEGÚN LA INTENCIÓN
    switch (intent) {
      case "DISPONIBLE": {
        // Registrar taxista como disponible (sin asignar turno aún)
        console.log(
          `💾 Intentando upsert de taxi: ${nombre} (${telegramId})`,
        );
        const { data: upsertData, error: upsertError } = await supabase.from(
          "taxis",
        ).upsert({
          telegram_id: telegramId,
          nombre: nombre,
          estado: "DISPONIBLE",
          turno: null, // Se asignará al reorganizar
          creado: new Date().toISOString(),
        }, { onConflict: "telegram_id" }).select();

        if (upsertError) {
          console.error("❌ Error en upsert de taxi:", upsertError);
          await sendToTelegram(
            chatId,
            "Hubo un error al registrarte. Intenta de nuevo.",
          );
          break;
        }

        console.log("✅ Taxi actualizado en DB:", upsertData);

        // Reorganizar turnos para todos los DISPONIBLES
        await reorganizarTurnos();

        // Obtener el turno asignado
        const { data: taxiActualizado } = await supabase
          .from("taxis")
          .select("turno")
          .eq("telegram_id", telegramId)
          .single();

        const turnoAsignado = taxiActualizado?.turno || "N/A";

        const msgFinal = aiResponse?.includes("{turno}")
          ? aiResponse.replace("{turno}", turnoAsignado.toString())
          : aiResponse ||
            `¡Entendido ${nombre}! Ya estás en la lista. Eres el turno número ${turnoAsignado}.`;

        await sendToTelegram(chatId, msgFinal);

        // --- NUEVO: Asignar automáticamente si hay pedidos pendientes ---
        console.log("🔍 Buscando pedidos pendientes para el nuevo taxista...");
        const { data: pedidosPendientes } = await supabase
          .from("pedidos")
          .select("*")
          .eq("estado", "CREADO")
          .neq("origen", "Pendiente") // Que tengan ubicación
          .order("creado", { ascending: true })
          .limit(1);

        if (pedidosPendientes && pedidosPendientes.length > 0) {
          const pedido = pedidosPendientes[0];
          console.log(`🎯 Asignando pedido ${pedido.id} al nuevo taxista.`);

          // Como no tenemos el objeto message aquí, intentamos un contacto genérico o recuperamos el telegram_id
          const clienteContacto =
            `[Cliente ${pedido.cliente_telegram_id}](tg://user?id=${pedido.cliente_telegram_id})`;

          await procesarPedidoTaxi(
            Number(pedido.cliente_telegram_id), // En este caso chatId del cliente
            Number(pedido.cliente_telegram_id),
            pedido.origen,
            "",
            clienteContacto,
          );
        }
        break;
      }

      case "NO_DISPONIBLE": {
        if (!isTaxista) {
          await sendToTelegram(
            chatId,
            "Solo los taxistas registrados pueden marcarse como no disponibles.",
          );
          break;
        }

        console.log(`💾 Taxista ${nombre} (${telegramId}) marca NO DISPONIBLE`);

        // Verificar primero que el taxista existe completamente registrado
        const { data: taxistaActual, error: verifyError } = await supabase
          .from("taxis")
          .select("*")
          .eq("telegram_id", telegramId)
          .single();

        if (verifyError || !taxistaActual) {
          console.error("❌ Error verificando taxista:", verifyError);
          await sendToTelegram(
            chatId,
            `❌ No estás registrado correctamente como taxista. Por favor envía:\n\nSoy taxista [CÉDULA] [NUMERO TAXI]\n\nEjemplo: Soy taxista 001-0000000-0 TX-001`,
          );
          break;
        }

        // Actualizar estado a OFFLINE (cuando el taxista no está disponible)
        const { error: updateError } = await supabase.from("taxis").update({
          estado: "OFFLINE",
          turno: null, // Importante: liberar el turno
        }).eq("telegram_id", telegramId);

        if (updateError) {
          console.error("❌ Error actualizando a OFFLINE:", updateError);
          await sendToTelegram(chatId, "Hubo un error al cambiar tu estado.");
        } else {
          // Reorganizar turnos de los que quedan DISPONIBLES
          await reorganizarTurnos();

          console.log(
            `✅ Taxista ${nombre} marcado como OFFLINE (No disponible)`,
          );
          await sendToTelegram(
            chatId,
            aiResponse ||
              `✅ Entendido ${nombre}. Te he marcado como NO DISPONIBLE. ¡Buen descanso!`,
          );
        }
        break;
      }

      case "PEDIR_TAXI": {
        if (!location) {
          // Si no hay ubicación, pedírsela (la IA ya debería generar el texto pidiéndola)
          await sendToTelegram(
            chatId,
            aiResponse || "Por favor, dime tu ubicación para enviarte un taxi.",
          );
          // Crear un pedido pendiente
          console.log("💾 Creando pedido pendiente...");
          const { error: pendingError } = await supabase.from("pedidos").insert(
            {
              cliente_telegram_id: telegramId,
              estado: "CREADO",
              origen: "Pendiente",
            },
          );
          if (pendingError) {
            console.error("❌ Error creando pedido pendiente:", pendingError);
          }
        } else {
          // Ya tenemos ubicación, buscar taxi FIFO
          const clienteContacto = message.from.username
            ? `@${message.from.username}`
            : `[${nombre}](tg://user?id=${telegramId})`;
          await procesarPedidoTaxi(
            chatId,
            telegramId,
            location,
            aiResponse,
            clienteContacto,
          );
        }
        break;
      }

      case "UBICACION": {
        // el cliente dio su ubicación
        if (!location) {
          console.log("⚠️ IA detectó UBICACION pero no extrajo el texto.");
          await sendToTelegram(
            chatId,
            "No pude entender bien la ubicación. ¿Podrías repetirla?",
          );
        } else {
          const clienteContacto = message.from.username
            ? `@${message.from.username}`
            : `[${nombre}](tg://user?id=${telegramId})`;
          await procesarPedidoTaxi(
            chatId,
            telegramId,
            location,
            aiResponse,
            clienteContacto,
          );
        }
        break;
      }

      case "CONSULTAR_TURNO": {
        // El taxista pregunta por su turno
        if (!isTaxista || !existingTaxi) {
          await sendToTelegram(
            chatId,
            "Solo los taxistas registrados pueden consultar su turno.",
          );
          break;
        }

        const turno = existingTaxi.turno || "Sin turno asignado";
        const estado = existingTaxi.estado;

        let mensaje = "";
        if (estado === "DISPONIBLE" && turno) {
          mensaje =
            `📊 Estás en el turno número **${turno}**.\n\nEstado: DISPONIBLE ✅`;
        } else if (estado === "OFFLINE") {
          mensaje =
            `📊 Actualmente estás OFFLINE.\n\nPara recibir un turno, envía "Estoy disponible".`;
        } else if (estado === "ASIGNADO" || estado === "EN_CAMINO") {
          mensaje = `📊 Tienes un servicio activo.\n\nEstado: ${estado}`;
        } else {
          mensaje = aiResponse || `📊 Tu turno: ${turno}\nEstado: ${estado}`;
        }

        await sendToTelegram(chatId, mensaje);
        break;
      }

      case "CONFIRMAR": {
        // Solo un taxista debería poder confirmar
        if (!isTaxista) {
          await sendToTelegram(
            chatId,
            "Lo siento, solo los taxistas autorizados pueden confirmar pedidos.",
          );
          break;
        }
        // El taxista confirma el pedido
        await confirmarPedido(telegramId, chatId, aiResponse);
        break;
      }

      default: {
        // Mensaje genérico o charla
        await sendToTelegram(
          chatId,
          aiResponse || "Hola, ¿en qué puedo ayudarte?",
        );
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("💥 Error en el webhook:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }
});

// =========================
// 🔄 FUNCIÓN PARA REORGANIZAR TURNOS
// =========================
// Reorganiza los turnos de los taxis DISPONIBLES
// Asigna 1, 2, 3, ... en orden de llegada (creado)
async function reorganizarTurnos() {
  console.log("🔄 Reorganizando turnos...");

  // 1. Obtener todos los taxis DISPONIBLES ordenados por fecha de creación
  const { data: taxisDisponibles, error } = await supabase
    .from("taxis")
    .select("*")
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

  // 2. Asignar turnos secuenciales (1, 2, 3, ...)
  const updates = taxisDisponibles.map((taxi, index) => ({
    telegram_id: taxi.telegram_id,
    turno: index + 1, // Turno empieza en 1
  }));

  // 3. Actualizar todos los turnos
  for (const update of updates) {
    const { error: updateError } = await supabase
      .from("taxis")
      .update({ turno: update.turno })
      .eq("telegram_id", update.telegram_id);

    if (updateError) {
      console.error(
        `❌ Error actualizando turno para ${update.telegram_id}:`,
        updateError,
      );
    } else {
      console.log(
        `✅ Turno ${update.turno} asignado a telegram_id: ${update.telegram_id}`,
      );
    }
  }

  console.log(`✅ Turnos reorganizados: ${updates.length} taxis`);
}

// =========================
// 🧠 FUNCIÓN PARA LLAMAR A LA IA (GROQ)
// =========================
async function callIA(
  text: string,
  userName: string,
  isTaxista: boolean,
  taxiData?: any,
) {
  // Construir contexto rico del usuario
  let userContext = `- Nombre: ${userName}\n`;

  if (isTaxista && taxiData) {
    userContext += `- Es taxista registrado: SÍ\n`;
    userContext += `- Número de taxi: ${taxiData.numero_taxista || "N/A"}\n`;
    userContext += `- Turno actual: ${taxiData.turno || "Sin turno"}\n`;
    userContext += `- Estado: ${taxiData.estado || "OFFLINE"}\n`;
    userContext += `- Cédula: ${taxiData.cedula || "N/A"}\n`;
  } else {
    userContext += `- Es taxista registrado: NO (es cliente)\n`;
  }

  const systemPrompt = `Eres un asistente inteligente de despacho de taxis. 
Tu objetivo PRINCIPAL es atender a CLIENTES que necesitan un taxi.
NO preguntes si es taxista. Asume que es cliente a menos que el sistema te indique lo contrario.

DATOS DEL USUARIO ACTUAL:
${userContext}

RESPONDE SIEMPRE EN JSON con este formato:
{
  "intent": "DISPONIBLE" | "NO_DISPONIBLE" | "PEDIR_TAXI" | "UBICACION" | "CONFIRMAR" | "CONSULTAR_TURNO" | "OTROS",
  "response": "Tu respuesta amable al usuario",
  "location": "La dirección o coordenadas si las menciona (solo para clientes)",
  "role": "taxista" | "cliente"
}

REGLAS IMPORTANTES:

1. **CONFIRMACIONES (MUY IMPORTANTE)**: Si el usuario responde con palabras de confirmación como:
   - "sí", "si", "yes", "ok", "claro", "dale", "por favor", "necesito"
   - Y NO menciona una ubicación específica
   → Clasifica como "PEDIR_TAXI" y en "response" pide la ubicación directamente.
   → Ejemplo: "¡Perfecto! ¿Desde dónde necesitas el taxi? Por favor indícame tu ubicación."

2. **UBICACIÓN DIRECTA**: Si el usuario menciona una dirección, calle, barrio, o lugar específico:
   → Clasifica como "UBICACION" y extrae la ubicación en el campo "location"
   → Ejemplo: Usuario dice "Calle 5ta #10" → intent: "UBICACION", location: "Calle 5ta #10"

3. **SOLICITUD EXPLÍCITA**: Si el usuario pide un taxi directamente:
   - "necesito un taxi", "quiero un taxi", "envíame un taxi"
   → Clasifica como "PEDIR_TAXI" y pide la ubicación en "response"

4. **TAXISTAS**:
   - "DISPONIBLE": SOLO si "Es taxista registrado" es SÍ y el usuario dice estar libre/disponible
   - "NO_DISPONIBLE": Cuando el taxista registrado indica que se retira, cierra turno, descansa
   - "CONFIRMAR": Cuando el taxista acepta un pedido (ej: "acepto", "voy en camino")
   - **"CONSULTAR_TURNO"**: Cuando el taxista pregunta por su turno/posición
     * Ejemplos: "¿Qué turno soy?", "¿Cuál es mi turno?", "¿En qué posición estoy?"
     * Responde usando la información en "Turno actual"
     * Ejemplo respuesta: "Estás en el turno número {turno}"

5. **INTELIGENCIA CONTEXTUAL**:
   - Si el usuario menciona nombres de taxistas conocidos (Yery, Juan, Maria), usa el contexto
   - Si la transcripción de voz puede tener errores (ej: "Jerry" en vez de "Yery"), usa el contexto para corregir
   - Siempre usa la información del usuario actual para dar respuestas personalizadas

6. **OTROS**: Solo para mensajes de charla general o preguntas sin intención clara.

FLUJO CONVERSACIONAL:
- Si el cliente confirma (sí/ok) → Pedir ubicación
- Si el cliente da ubicación → Procesar pedido
- Si el taxista pregunta su turno → Responder con "Turno actual"
- NO repitas la misma pregunta si el usuario ya confirmó`;

  const url = IA_PROVIDER === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";

  const key = IA_PROVIDER === "groq"
    ? GROQ_API_KEY
    : Deno.env.get("OPENAI_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: IA_PROVIDER === "groq" ? "llama-3.3-70b-versatile" : "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Usuario: ${userName}\nMensaje: ${text}` },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// =========================
// 🚕 LÓGICA DE DESPACHO (FIFO)
// =========================
async function procesarPedidoTaxi(
  chatId: number,
  clienteId: number,
  ubicacion: string,
  aiResponse: string,
  clienteContacto: string,
) {
  console.log(
    `🚕 Procesando pedido para cliente ${clienteId} (${clienteContacto}) en ${ubicacion}`,
  );

  // 1. Buscar el taxi más antiguo que esté DISPONIBLE
  const { data: taxis, error: taxiError } = await supabase
    .from("taxis")
    .select("*")
    .eq("estado", "DISPONIBLE")
    .order("creado", { ascending: true })
    .limit(1);

  if (taxiError) {
    console.error("❌ Error buscando taxis disponibles:", taxiError);
    await sendToTelegram(
      chatId,
      "Hubo un error técnico al buscar taxis. Por favor, intenta de nuevo más tarde.",
    );
    return;
  }

  if (!taxis || taxis.length === 0) {
    console.log("📭 No hay taxis disponibles");
    await sendToTelegram(
      chatId,
      "Lo siento, no hay taxis disponibles en este momento. Te avisaré en cuanto uno se libere.",
    );
    return;
  }

  const taxi = taxis[0];
  console.log(`🎯 Taxi seleccionado: ${taxi.nombre} (ID: ${taxi.id})`);

  // 2. Crear pedido y asignar taxi
  const { data: _pedido, error: pedidoError } = await supabase.from("pedidos")
    .insert({
      cliente_telegram_id: clienteId,
      taxi_id: taxi.id,
      estado: "ASIGNADO",
      origen: ubicacion,
    }).select().single();

  if (pedidoError) {
    console.error("❌ Error creando pedido:", pedidoError);
    await sendToTelegram(chatId, "Hubo un error al procesar tu pedido.");
    return;
  }

  // 3. Cambiar estado del taxi
  const { error: updateTaxiError } = await supabase.from("taxis").update({
    estado: "ASIGNADO",
  }).eq("id", taxi.id);

  if (updateTaxiError) {
    console.error("❌ Error actualizando estado del taxi:", updateTaxiError);
  }

  // 4. Notificar a ambos
  console.log(`📤 Notificando al cliente ${chatId}...`);
  await sendToTelegram(
    chatId,
    aiResponse ||
      `¡Perfecto! He encontrado un taxi para ti. El taxista ${taxi.nombre} ha sido notificado.`,
  );

  console.log(
    `📤 Notificando al taxista ${taxi.nombre} (${taxi.telegram_id})...`,
  );
  await sendToTelegram(
    Number(taxi.telegram_id),
    `🚕 **NUEVO SERVICIO ASIGNADO**\n\n📍 Ubicación: ${ubicacion}\n👤 Cliente: ${clienteContacto}\n\nResponde "Acepto" o "Voy en camino" para confirmar.`,
  );
  console.log("✅ Proceso de notificación completado.");
}

async function confirmarPedido(
  taxiTelegramId: number,
  taxiChatId: number,
  aiResponse: string,
) {
  // 1. Buscar taxi y su pedido asignado
  const { data: taxi } = await supabase.from("taxis").select("id, nombre").eq(
    "telegram_id",
    taxiTelegramId,
  ).single();

  if (!taxi) return;

  const { data: pedido } = await supabase
    .from("pedidos")
    .select("*")
    .eq("taxi_id", taxi.id)
    .eq("estado", "ASIGNADO")
    .single();

  if (!pedido) {
    await sendToTelegram(
      taxiChatId,
      "No tienes pedidos pendientes de confirmación.",
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

  // 3. Avisar al cliente
  await sendToTelegram(
    Number(pedido.cliente_telegram_id),
    `🚕 ¡Buenas noticias! Tu taxista (${taxi.nombre}) ha confirmado y está en camino a tu ubicación.`,
  );

  // 4. Confirmar al taxista
  await sendToTelegram(
    taxiChatId,
    aiResponse ||
      "¡Excelente! El cliente ha sido notificado de que vas en camino.",
  );
}

// =========================
// 📥 FUNCIÓN PARA OBTENER URL DE ARCHIVO DE TELEGRAM
// =========================
async function getTelegramFileUrl(fileId: string): Promise<string> {
  try {
    // 1. Obtener información del archivo usando getFile API
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`,
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error("❌ Error obteniendo archivo de Telegram:", result);
      throw new Error("No se pudo obtener el archivo de Telegram");
    }

    const filePath = result.result.file_path;

    // 2. Construir URL de descarga
    const fileUrl =
      `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    console.log("✅ URL del archivo obtenida:", fileUrl);
    return fileUrl;
  } catch (error) {
    console.error("❌ Error en getTelegramFileUrl:", error);
    throw error;
  }
}

// =========================
// 📩 FUNCIÓN AUXILIAR PARA TELEGRAM
// =========================
async function sendToTelegram(chatId: number, text: string): Promise<void> {
  try {
    console.log(
      `📤 Enviando a Telegram (chat ${chatId}):`,
      text.substring(0, 50) + "...",
    );

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      },
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ Telegram API error:", result);
      console.error("Status:", response.status);
      console.error("Token usado:", TELEGRAM_TOKEN ? "Presente" : "Falta");
    } else {
      console.log("✅ Mensaje enviado a Telegram OK");
    }

    return result;
  } catch (error: unknown) {
    console.error("❌ Error enviando a Telegram:", error);
    throw error;
  }
}

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/telegram-webhook' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
