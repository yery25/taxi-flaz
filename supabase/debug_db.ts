import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkColumns() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/?apikey=${SUPABASE_KEY}`);
    const schema = await res.json();
    
    console.log("--- COLUMNAS DE LA TABLA PEDIDOS ---");
    console.log(Object.keys(schema.definitions.pedidos.properties).join(", "));
    
    console.log("\n--- COLUMNAS DE LA TABLA LISTA_DE_ESPERA ---");
    console.log(Object.keys(schema.definitions.lista_de_espera.properties).join(", "));
}

checkColumns();
