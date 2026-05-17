import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function inspect() {
    console.log("--- TODOS LOS TAXIS ---");
    const { data: taxis } = await supabase.from("taxis").select("id, nombre, telegram_id, estado, turno");
    console.log(JSON.stringify(taxis, null, 2));

    console.log("\n--- TODOS LOS PEDIDOS ---");
    const { data: pedidos } = await supabase.from("pedidos").select("id, taxi_id, estado").order("creado", { ascending: false }).limit(5);
    console.log(JSON.stringify(pedidos, null, 2));
}

inspect();
