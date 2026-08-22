import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LISTA_TAXISTAS } from "./supabase/functions/_shared/lista_taxistas.ts";

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

function obtenerTelegramIdPlaceholder(numeroTaxista: string): number {
  const num = Number(numeroTaxista.replace(/\D/g, ""));
  return -(100 + (isNaN(num) ? 0 : num));
}

async function sync() {
  console.log(`🤖 Iniciando sincronización de ${LISTA_TAXISTAS.length} taxistas con la base de datos...`);

  for (const taxista of LISTA_TAXISTAS) {
    console.log(`\n🔍 Procesando: ${taxista.nombre} (Unidad: ${taxista.numero_taxista})`);

    // Intentar buscar por número de taxi, cédula o nombre
    let existingTaxi = null;
    const { data: byNum, error: selectError } = await supabase
      .from("taxis")
      .select("*")
      .eq("numero_taxista", taxista.numero_taxista)
      .maybeSingle();

    if (selectError) {
      console.error(`❌ Error consultando base de datos para ${taxista.nombre}:`, selectError.message);
      continue;
    }
    existingTaxi = byNum;

    if (!existingTaxi && taxista.cedula) {
      const { data: byCedula } = await supabase
        .from("taxis")
        .select("*")
        .eq("cedula", taxista.cedula)
        .maybeSingle();
      existingTaxi = byCedula;
    }

    if (!existingTaxi) {
      const { data: byNombre } = await supabase
        .from("taxis")
        .select("*")
        .ilike("nombre", taxista.nombre)
        .maybeSingle();
      existingTaxi = byNombre;
    }

    if (existingTaxi) {
      console.log(`➡️ El taxista ya existe. Actualizando datos de vehículo y contacto...`);
      const { error: updateError } = await supabase
        .from("taxis")
        .update({
          nombre: taxista.nombre,
          cedula: taxista.cedula,
          numero_taxista: taxista.numero_taxista,
          telefono: existingTaxi.telefono || taxista.telefono,
          modelo: taxista.modelo,
          color: taxista.color,
          placa: taxista.placa
        })
        .eq("id", existingTaxi.id);

      if (updateError) {
        console.error(`❌ Error actualizando a ${taxista.nombre}:`, updateError.message);
      } else {
        console.log(`✅ ${taxista.nombre} actualizado correctamente.`);
      }
    } else {
      console.log(`➕ El taxista no existe. Creando nuevo registro con placeholder para telegram_id...`);
      
      const placeholderTelegramId = obtenerTelegramIdPlaceholder(taxista.numero_taxista);
      
      const { error: insertError } = await supabase
        .from("taxis")
        .insert({
          nombre: taxista.nombre,
          cedula: taxista.cedula,
          numero_taxista: taxista.numero_taxista,
          telefono: taxista.telefono,
          telegram_id: placeholderTelegramId,
          modelo: taxista.modelo,
          color: taxista.color,
          placa: taxista.placa,
          estado: "OFFLINE",
          creado: new Date().toISOString()
        });

      if (insertError) {
        console.error(`❌ Error insertando a ${taxista.nombre}:`, insertError.message);
      } else {
        console.log(`✅ ${taxista.nombre} insertado correctamente con telegram_id placeholder: ${placeholderTelegramId}`);
      }
    }
  }

  console.log("\n🏁 Sincronización finalizada.");
}

sync();
