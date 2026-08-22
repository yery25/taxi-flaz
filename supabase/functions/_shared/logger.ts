// ========================================================
// 📊 SISTEMA DE LOGS DETALLADOS Y TELEMETRÍA DE TIEMPO REAL
// ========================================================

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface LogDetails {
  evento: string; // Ej: "VAPI_PEDIDO_RECIBIDO", "TELEGRAM_NOTIFICACION_ENVIADA", "TAXISTA_ACEPTO_PEDIDO", "TIMEOUT_REASIGNACION"
  clientePhone?: string;
  clienteNombre?: string;
  taxistaNombre?: string;
  taxistaFicha?: string;
  taxistaTelegramId?: string | number;
  reintentoNum?: number;
  detalles?: Record<string, any> | string;
  error?: string | null;
}

/**
 * Registra eventos en vivo con precisión de milisegundos y formato legible en la base de datos.
 */
export async function registrarLogDetallado(supabase: SupabaseClient, log: LogDetails) {
  const ahora = new Date();
  
  // Formatear hora de República Dominicana con milisegundos exactos
  const opcionesFecha: Intl.DateTimeFormatOptions = {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  };
  const fechaBase = ahora.toLocaleString("es-DO", opcionesFecha);
  const msFormatted = String(ahora.getMilliseconds()).padStart(3, "0");
  const fechaHoraAST = `${fechaBase}.${msFormatted} AST`;

  const payloadCompleto = {
    fecha_hora_local: fechaHoraAST,
    iso_timestamp: ahora.toISOString(),
    epoch_ms: ahora.getTime(),
    cliente: {
      telefono: log.clientePhone || "Desconocido",
      nombre: log.clienteNombre || "Cliente"
    },
    taxista: log.taxistaNombre ? {
      nombre: log.taxistaNombre,
      ficha: log.taxistaFicha || "N/A",
      telegram_id: log.taxistaTelegramId || "N/A"
    } : null,
    reintentos: log.reintentoNum !== undefined ? `${log.reintentoNum}/3` : "N/A",
    detalles: log.detalles || {}
  };

  console.log(`📊 [LOG ${log.evento}] ${fechaHoraAST} | Taxista: ${log.taxistaNombre || "N/A"} | ${JSON.stringify(payloadCompleto)}`);

  try {
    // Escribir a tabla zadarma_debug
    await supabase.from("zadarma_debug").insert({
      evento: log.evento,
      payload: payloadCompleto,
      error: log.error || null,
      creado_at: ahora.toISOString()
    });

    // Escribir a tabla logs si existe
    await supabase.from("logs").insert({
      evento: log.evento,
      payload: payloadCompleto,
      error: log.error || null,
      creado_at: ahora.toISOString()
    }).then(() => {});
  } catch (err) {
    console.error("❌ Error guardando log en base de datos:", err);
  }
}
