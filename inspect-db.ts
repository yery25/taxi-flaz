import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function inspect() {
    console.log("--- INSPECCIÓN DE TABLA TAXIS ---");
    const { data, error } = await supabase.from("taxis").select("*").limit(1);
    if (error) {
        console.error("Error:", error);
    } else {
        console.log("Columnas detectadas:", Object.keys(data[0] || {}));
        console.log("Fila de ejemplo:", data[0]);
    }

    console.log("\n--- BUSCANDO A BRAYAN (Cédula: 001-0000000-1 o similar) ---");
    const { data: brayan } = await supabase.from("taxis").select("*").ilike("nombre", "%Brayan%");
    console.log("Resultado Brayan:", brayan);
}

inspect();
