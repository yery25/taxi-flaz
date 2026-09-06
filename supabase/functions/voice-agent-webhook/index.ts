import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { procesarPedidoTaxi, verificarTimeoutsPedidos } from "../_shared/dispatch-logic.ts";
import { registrarLogDetallado } from "../_shared/logger.ts";

const SUPABASE_URL = Deno.env.get("URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

serve(async (req: Request) => {
  // Manejo de CORS para llamadas preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-vapi-secret",
      },
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Solo método POST permitido" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Leer el body como texto raw primero para evitar errores de JSON malformado
    const rawBody = await req.text();
    console.log("📥 Raw body recibido:", rawBody.substring(0, 500));

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (jsonErr) {
      // Si falla el parse normal, intentar limpiar caracteres problemáticos
      console.warn("⚠️ Error parseando JSON normal, intentando limpiar...", jsonErr);
      try {
        const cleaned = rawBody
          .replace(/\\'/g, "'")
          .replace(/([^\\])\\([^"\\nrtbfu/])/g, "$1$2");
        payload = JSON.parse(cleaned);
        console.log("✅ JSON limpiado exitosamente");
      } catch (e2) {
        console.error("❌ No se pudo parsear el body de ninguna manera:", e2);
        return new Response(JSON.stringify({ 
          results: [{ toolCallId: "error", result: "Error al procesar la solicitud. Por favor intente de nuevo." }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    console.log("📥 Payload parseado:", JSON.stringify(payload).substring(0, 500));

    let origen = "";
    let nombre = "Cliente de Voz";
    let customerPhone = "Desconocido";
    let isDirectTool = true;
    let toolCallId = "default";

    // CASO A: Vapi Server Webhook (General Server URL)
    if (payload.message) {
      if (payload.message.type !== "tool-calls") {
        console.log(`ℹ️ Ignorando evento informativo de Vapi: ${payload.message.type}`);
        return new Response(JSON.stringify({ status: "ignored", type: payload.message.type }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      isDirectTool = false;
      const message = payload.message;
      const toolCalls = message.toolCalls || [];
      
      if (toolCalls.length === 0) {
        return new Response(JSON.stringify({ status: "ignored" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const toolCall = toolCalls[0];
      let args = toolCall.function?.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }

      toolCallId = toolCall.id || "default";
      origen = args.origen || args.direccion || args.location || args.ubicacion || args.address || "Solicitado por llamada de voz";
      const rawNombre = args.nombre || args.customer_name || args.name || args.cliente || "";
      nombre = (rawNombre && rawNombre !== "null" && rawNombre !== "undefined") ? rawNombre : "Cliente";
      customerPhone = 
        args.telefono || args.phone || args.cliente_contacto || args.contacto || args.whatsapp ||
        message.customer?.number || 
        message.phoneCall?.from || 
        message.call?.customer?.number ||
        message.call?.customer?.phoneNumber ||
        "Desconocido";
    }
    // CASO B: Vapi Direct apiRequest Tool / Function Tool
    else {
      isDirectTool = true;
      let args = payload;

      // Desempaquetar si viene en arguments o function.arguments
      if (payload.arguments) {
        args = typeof payload.arguments === "string" ? (JSON.parse(payload.arguments) || {}) : payload.arguments;
      } else if (payload.function?.arguments) {
        args = typeof payload.function.arguments === "string" ? (JSON.parse(payload.function.arguments) || {}) : payload.function.arguments;
      }

      toolCallId = payload.toolCallId || payload.id || "default";
      origen = args.origen || args.direccion || args.location || args.ubicacion || args.address || "Solicitado por llamada de voz";
      const rawNombreDirect = args.nombre || args.customer_name || args.name || args.cliente || "";
      nombre = (rawNombreDirect && rawNombreDirect !== "null" && rawNombreDirect !== "undefined") ? rawNombreDirect : "Cliente";
      customerPhone = args.telefono || args.phone || args.cliente_contacto || args.contacto || args.customerPhone || args.customerNumber || args.number || "Desconocido";
    }

    // ☎️ FALLBACK UNIVERSAL PARA TELÉFONO
    if (customerPhone === "Desconocido" || !customerPhone) {
      customerPhone =
        payload.message?.customer?.number ||
        payload.message?.call?.customer?.number ||
        payload.message?.call?.customer?.phoneNumber ||
        payload.message?.phoneCall?.from ||
        payload.call?.customer?.number ||
        payload.call?.customer?.phoneNumber ||
        payload.customer?.number ||
        payload.phoneNumber ||
        "Desconocido";
    }

    // 📍 FALLBACK UNIVERSAL PARA ORIGEN (nunca rechazar por falta de origen en llamadas de voz)
    if (!origen || origen.trim() === "") {
      origen = "Solicitado por llamada de voz (Contactar de inmediato)";
    }

    // 🛡️ Detectar si Vapi NO resolvió el template Liquid (envió el texto literal)
    // Ej: "{{call.customer.number}}" en lugar del número real
    if (customerPhone && customerPhone.includes("{{")) {
      console.warn("⚠️ Vapi no resolvió el template Liquid:", customerPhone, "- Tratando como sin teléfono");
      customerPhone = "Desconocido";
    }

    // Limpiar el teléfono para dejar solo dígitos (necesario para la columna bigint de pedidos en Supabase)
    let cleanedPhone = customerPhone.replace(/\D/g, "");
    if (!cleanedPhone) {
      cleanedPhone = "0"; // Fallback para llamadas de prueba web que no envían número real
    }

    console.log(`📞 Procesando para: ${customerPhone} (Limpio para DB: ${cleanedPhone}), Origen: ${origen}, Nombre: ${nombre}`);

    // 📝 Log de entrada (en paralelo, no bloquea el despacho)
    supabase.from("zadarma_debug").insert({
      evento: "VOICE_AGENT_START",
      payload: { customerPhone, cleanedPhone, origen, nombre, isDirectTool }
    }).then();

    // ✅ PREVENIR RETRIES DE VAPI (Bucle de Notificaciones Masivas)
    // Si Vapi hace timeout y reintenta el webhook, NO debemos crear otro pedido ni cerrar el anterior.
    // Además, aplicamos un "Jitter" aleatorio para evitar Race Conditions si VAPI envía solicitudes concurrentes.
    if (cleanedPhone && cleanedPhone !== "0") {
      // Jitter aleatorio entre 100ms y 1500ms
      const jitterMs = Math.floor(Math.random() * 1400) + 100;
      await new Promise((resolve) => setTimeout(resolve, jitterMs));

      const quinceMinutosAtras = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const variantes = Array.from(new Set([customerPhone, cleanedPhone, `+${cleanedPhone}`])).filter(Boolean);

      const { data: yaAsignado } = await supabase
        .from("pedidos")
        .select("id, estado")
        .or(`cliente_contacto.in.(${variantes.join(",")}),cliente_telegram_id.in.(${variantes.join(",")})`)
        .in("estado", ["CREADO", "ASIGNADO", "EN_CAMINO"])
        .gt("creado", quinceMinutosAtras)
        .order("creado", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (yaAsignado) {
        console.log(`⚠️ Vapi reintentó el webhook para ${customerPhone} (Ya está ${yaAsignado.estado}). Devolviendo éxito rápido...`);
        
        let resultMessage = "¡Perfecto! Ya tienes un taxista asignado. Él se pondrá en contacto contigo de inmediato al celular. ¡Que pases un excelente día y gracias por llamar a Taxi Flash!";
        
        // Intentar obtener los datos del taxista asignado para mantener el mismo formato
        const { data: pedidoAsignado } = await supabase
          .from("pedidos")
          .select("*, taxis(*)")
          .eq("id", yaAsignado.id)
          .single();
          
        if (pedidoAsignado && pedidoAsignado.taxis) {
          const taxi = pedidoAsignado.taxis;
          const cleanTts = (str: any) => String(str || "").replace(/-/g, " ");
          const vehiculoStr = taxi.modelo ? ` en el vehículo ${cleanTts(taxi.modelo)}` : " en su vehículo";
          const colorStr = taxi.color ? ` color ${cleanTts(taxi.color)}` : "";
          const fichaStr = taxi.numero_taxista ? `, ficha ${cleanTts(taxi.numero_taxista)}` : "";
          
          resultMessage = `¡Perfecto! Ya tienes asignado a nuestro taxista de turno. Se pondrá en contacto con usted ${taxi.nombre}${fichaStr},${vehiculoStr}${colorStr}. Él le llamará de inmediato a este celular. ¡Que pases un excelente día y gracias por llamar a Taxi Flash!`;
        }
        
        if (isDirectTool) {
          return new Response(JSON.stringify({ result: resultMessage }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        } else {
          return new Response(JSON.stringify({ results: [{ toolCallId, result: resultMessage }] }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
      }
    }

    // ✅ DESPACHO GARANTIZADO: await asegura que Telegram y la BD siempre reciben el pedido
    const taxi = await procesarPedidoTaxi(
      supabase,
      "voice",
      cleanedPhone,
      cleanedPhone,
      origen,
      "Pedido iniciado por Agente de Voz interactivo",
      customerPhone,
      nombre
    );

    let resultMessage = "";
    if (taxi) {
      console.log(`✅ Taxi asignado con éxito: ${taxi.nombre}`);

      // Log de éxito (en paralelo)
      registrarLogDetallado(supabase, {
        evento: "VAPI_ASIGNACION_EXITOSA",
        clientePhone: customerPhone,
        clienteNombre: nombre,
        taxistaNombre: taxi.nombre,
        taxistaFicha: taxi.numero_taxista,
        taxistaTelegramId: taxi.telegram_id,
        detalles: { origen, modelo: taxi.modelo, placa: taxi.placa }
      }).catch(console.error);

      // Mensaje con detalles del taxista
      const cleanTts = (str: any) => String(str || "").replace(/-/g, " ");
      const vehiculoStr = taxi.modelo ? ` en el vehículo ${cleanTts(taxi.modelo)}` : " en su vehículo";
      const colorStr = taxi.color ? ` color ${cleanTts(taxi.color)}` : "";
      const fichaStr = taxi.numero_taxista ? `, ficha ${cleanTts(taxi.numero_taxista)}` : "";
      
      resultMessage = `¡Perfecto! Te he asignado nuestro taxista de turno. Se pondrá en contacto con usted ${taxi.nombre}${fichaStr},${vehiculoStr}${colorStr}. Él le llamará de inmediato a este celular. ¡Que pases un excelente día y gracias por llamar a Taxi Flash!`;
    } else {
      console.log("📭 No hay taxis disponibles. Cliente en lista de espera.");
      resultMessage = "En este momento todos nuestros taxistas están ocupados, pero te hemos puesto en lista de espera. Te contactaremos en cuanto uno esté disponible. ¡Que pases un excelente día y gracias por llamar a Taxi Flash!";

      registrarLogDetallado(supabase, {
        evento: "VAPI_SIN_TAXIS_DISPONIBLES",
        clientePhone: customerPhone,
        clienteNombre: nombre,
        detalles: { origen },
        error: "No hay taxis disponibles en este turno"
      }).catch(console.error);
    }

    // 🚀 Retornar respuesta a Vapi (el despacho ya está 100% confirmado antes de este punto)
    if (isDirectTool) {
      console.log("📤 Enviando respuesta (DirectTool):", resultMessage);
      return new Response(JSON.stringify({ result: resultMessage }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      console.log("📤 Enviando respuesta (Server Webhook):", resultMessage);
      return new Response(JSON.stringify({
        results: [{ toolCallId, result: resultMessage }]
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

  } catch (error: any) {
    console.error("💥 Error en Voice Agent webhook:", error);
    try {
      await supabase.from("zadarma_debug").insert({
        evento: "VOICE_AGENT_ERROR",
        payload: { error: error.message, stack: error.stack },
        error: "Critical exception in webhook"
      });
    } catch (e) {
      console.error("Error insertando log de excepción:", e);
    }
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
});
