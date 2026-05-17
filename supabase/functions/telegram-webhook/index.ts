// ================================
// 🤖 TELEGRAM + IA (GROQ / OPENAI)
// Supabase Edge Function (Deno)
// ================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LISTA_TAXISTAS } from "../_shared/lista_taxistas.ts";
import { transcribeWithGroq } from "../_shared/audio-transcription.ts";
import { callIA } from "../_shared/ai-logic.ts";
import { sendMessage, sendToTelegram } from "../_shared/messaging.ts";
import {
  asignarPedidosPendientes,
  confirmarPedido,
  finalizarPedido,
  procesarPedidoTaxi,
  reorganizarTurnos,
} from "../_shared/dispatch-logic.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_TOKEN) {
  throw new Error("Variables de entorno faltantes");
}

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

    const body = await req.json();


    if (!body.message && !body.callback_query) return new Response("ok");

    // 🔀 SOPORTE PARA CALLBACK QUERIES (Botones)
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const data = callbackQuery.data;
      const chatId = callbackQuery.message.chat.id;
      const telegramId = String(callbackQuery.from.id);
      
      console.log(`🔘 Callback de ${telegramId}: ${data}`);

      // 1. Responder de inmediato a Telegram y QUITAR BOTONES para evitar spam
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          callback_query_id: callbackQuery.id,
          text: "✅ Procesando pedido..."
        })
      });

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });

      if (data.startsWith("confirmar")) {
          const parts = data.split("_");
          const whatsappId = parts.length > 1 ? parts[1] : null;

          // Marcamos como confirmado
          await confirmarPedido(supabase, "telegram", telegramId, chatId, "¡Confirmado!");

          if (whatsappId) {
              try {
                  const { data: taxi } = await supabase.from("taxis").select("nombre").eq("telegram_id", Number(telegramId)).single();
                  const mensajeCliente = `🚕 ¡Buenas noticias! El taxista **${taxi?.nombre || "de turno"}** ha aceptado tu viaje y va en camino.`;
                  await sendMessage("whatsapp_kapso", whatsappId, mensajeCliente);
              } catch (err) {
                  console.error("❌ Error avisando al cliente en WhatsApp:", err);
              }
          }
      } else if (data.startsWith("finalizar_")) {
          const pedidoId = data.split("_")[1];
          await finalizarPedido(supabase, "telegram", telegramId, chatId, pedidoId);
      } else if (data === "salir_turno") {
          // Lógica para ponerse OFFLINE
          await supabase.from("taxis").update({ 
            estado: "OFFLINE",
            turno: null
          }).eq("telegram_id", Number(telegramId));
          
          await reorganizarTurnos(supabase);
          
          await sendToTelegram(chatId, `🛑 Has terminado tu día laboral. Ya no recibirás nuevos pedidos. ¡Que descanses!`, {
            inline_keyboard: [
              [{ text: "🚀 Iniciar Día Laboral", callback_data: "entrar_turno" }]
            ]
          });
      } else if (data === "entrar_turno") {
          // Lógica para ponerse DISPONIBLE
          await supabase.from("taxis").update({ 
            estado: "DISPONIBLE",
            creado: new Date().toISOString()
          }).eq("telegram_id", Number(telegramId));
          
          await reorganizarTurnos(supabase);
          await asignarPedidosPendientes(supabase);
          
          const { data: taxiUpdated } = await supabase.from("taxis")
            .select("turno")
            .eq("telegram_id", Number(telegramId))
            .single();
            
          await sendToTelegram(chatId, `🚀 ¡Perfecto! Ya estás en turno. Tu posición actual es la **#${taxiUpdated?.turno || 1}**. Mantente atento a los pedidos.`);
      } else if (data === "rechazar") {
          // Si rechaza, lo volvemos a poner disponible y buscamos otro
          await sendToTelegram(chatId, "Pedido rechazado. Te he puesto de nuevo en la cola.");
          await supabase.from("taxis").update({ estado: "DISPONIBLE" }).eq("telegram_id", Number(telegramId));
          await reorganizarTurnos(supabase);
          // Re-asignar el pedido que quedó huérfano
          await asignarPedidosPendientes(supabase);
      }

      return new Response("ok");
    }

    if (!body.message.text && !body.message.voice) return new Response("ok");

    const message = body.message;
    const chatId = message.chat.id;
    const telegramId = String(message.from.id);
    const nombre = message.from.first_name || message.from.username || "Usuario";

    let texto = "";

    // 🎙️ SOPORTE PARA MENSAJES DE VOZ
    if (message.voice) {
      const voiceFileId = message.voice.file_id;
      const fileUrl = await getTelegramFileUrl(voiceFileId);
      const audioResponse = await fetch(fileUrl);
      const audioBuffer = await audioResponse.arrayBuffer();
      const transcription = await transcribeWithGroq(audioBuffer);
      texto = transcription.text;
    } else {
      texto = message.text;
    }

    console.log(`📩 Mensaje de ${nombre} (TG): "${texto}"`);

    // 1. VERIFICAR SI ES TAXISTA REGISTRADO
    const { data: existingTaxi } = await supabase
      .from("taxis")
      .select("*")
      .eq("telegram_id", Number(telegramId))
      .single();

    const isTaxista = !!existingTaxi;

    // --- INTERCEPTAR REGISTRO MANUAL (Búsqueda por Cédula) ---
    const soloNumerosMensaje = texto.replace(/\D/g, "");
    
    // Si el mensaje tiene al menos 11 dígitos y el taxista no está registrado en esta sesión
    if (soloNumerosMensaje.length >= 11 && !isTaxista) {
      console.log(`🔍 Intentando registrar por cédula: ${soloNumerosMensaje}`);
      const autorizado = LISTA_TAXISTAS.find((t) => {
        const cedulaLimpia = t.cedula.replace(/\D/g, "");
        return soloNumerosMensaje.includes(cedulaLimpia);
      });

      if (autorizado) {
        console.log(`✅ Autorizado encontrado: ${autorizado.nombre}. Guardando en DB...`);
        
        const { error: upsertError } = await supabase.from("taxis").upsert({
          telegram_id: Number(telegramId), // Asegurar que sea número para BIGINT
          nombre: autorizado.nombre,
          cedula: autorizado.cedula,
          numero_taxista: autorizado.numero_taxista,
          telefono: autorizado.telefono,
          estado: "OFFLINE",
          creado: new Date().toISOString(),
        }, { onConflict: "telegram_id" });

        if (upsertError) {
          console.error("❌ Error en upsert de taxista:", upsertError);
          await supabase.from("zadarma_debug").insert({
            evento: "REGISTRO_FALLIDO",
            payload: { telegramId, nombre: autorizado.nombre, error: upsertError },
            error: upsertError.message
          });
          await sendToTelegram(chatId, `⚠️ Hubo un problema técnico al registrarte: ${upsertError.message}. Por favor, avisa al administrador.`);
          return new Response("ok");
        }

        await sendToTelegram(
          chatId,
          `✅ **¡REGISTRO EXITOSO!**\n\n` +
          `👤 **Nombre:** ${autorizado.nombre}\n` +
          `🚕 **Unidad:** ${autorizado.numero_taxista}\n\n` +
          `¡Bienvenido al equipo de Taxi-Flaz! ¿Quieres que te asigne un turno para empezar a trabajar ahora?`,
          {
            inline_keyboard: [
              [{ text: "🚀 SÍ, ENTRAR EN TURNO", callback_data: "entrar_turno" }]
            ]
          }
        );
        return new Response("ok");
      }
    }

    // 2. LLAMADA A IA PARA INTERPRETAR INTENCIÓN
    const interpretation = await callIA(
      texto,
      nombre,
      isTaxista,
      existingTaxi || undefined,
    );
    
    // @ts-ignore
    const { intent, response: aiResponse, assignment_request } = interpretation;

    // 3. LÓGICA POR INTENCIÓN
    switch (intent) {
      case "ASIGNAR_TURNO":
      case "DISPONIBLE": {
        if (!isTaxista) {
          await sendToTelegram(chatId, "Lo siento, esta función es solo para taxistas registrados.");
          break;
        }

        await supabase.from("taxis").update({ 
          estado: "DISPONIBLE",
          creado: new Date().toISOString() // Para que aparezca al final de la cola (FIFO)
        }).eq("telegram_id", Number(telegramId));
        
        await reorganizarTurnos(supabase);
        await asignarPedidosPendientes(supabase);

        const { data: taxiUpdated } = await supabase.from("taxis")
          .select("turno")
          .eq("telegram_id", Number(telegramId))
          .single();

        await sendToTelegram(
          chatId,
          aiResponse.replace("{turno}", String(taxiUpdated?.turno || "1")) || 
          `¡Perfecto! Ya estás en turno. Tu posición actual es: ${taxiUpdated?.turno || "1"}`
        );
        break;
      }

      case "NO_DISPONIBLE": {
        await supabase.from("taxis").update({ estado: "OFFLINE", turno: null })
          .eq("telegram_id", Number(telegramId));
        await reorganizarTurnos(supabase);
        await sendToTelegram(chatId, aiResponse || "Te he marcado como NO DISPONIBLE.");
        break;
      }

      case "CONSULTAR_TURNO": {
        if (!isTaxista) {
          await sendToTelegram(chatId, "No pareces estar en mis registros. Di 'Soy taxista' seguido de tu cédula para registrarte.");
        } else {
          const msg = (existingTaxi?.estado === "DISPONIBLE")
            ? `📊 Tu turno actual es: **${existingTaxi?.turno}**`
            : `📊 Actualmente estás: ${existingTaxi?.estado}. ¿Quieres entrar en turno?`;
          await sendToTelegram(chatId, msg);
        }
        break;
      }

      case "CONFIRMAR": {
        if (isTaxista) {
          await confirmarPedido(supabase, "telegram", telegramId, chatId, aiResponse);
        }
        break;
      }

      case "IDENTIFICACION": {
        await sendToTelegram(chatId, aiResponse);
        break;
      }

      default: {
        // Si no es taxista y no está intentando registrarse, enviamos respuesta denegando acceso o guiando
        if (!isTaxista) {
          await sendToTelegram(
            chatId,
            "Hola. Soy el asistente de gestión de Taxi-Flaz. Este canal es exclusivo para taxistas.\n\nSi eres taxista y quieres registrarte, por favor dime tu Cédula."
          );
        } else {
           await sendToTelegram(chatId, aiResponse);
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("💥 Error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});

async function getTelegramFileUrl(fileId: string): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`,
  );
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error("Error obteniendo archivo de Telegram");
  }
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${data.result.file_path}`;
}
