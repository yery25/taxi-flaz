import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";
const TELEGRAM_TOKEN = "7867793712:AAFuXw6Xfx8Mu1RDNTH8XU9prWycdJpvwnU";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

async function run() {
    // Check all debug logs
    console.log("=== TODOS LOS LOGS (ultimos 10) ===");
    const { data: logs } = await supabase.from("zadarma_debug").select("*").order("id", { ascending: false }).limit(10);
    console.log(JSON.stringify(logs, null, 2));

    // Check last pedidos
    console.log("\n=== ULTIMOS PEDIDOS ===");
    const { data: pedidos } = await supabase.from("pedidos").select("*").order("creado", { ascending: false }).limit(3);
    console.log(JSON.stringify(pedidos, null, 2));

    // Check taxi state
    console.log("\n=== TAXIS ===");
    const { data: taxis } = await supabase.from("taxis").select("nombre, estado, turno, telegram_id");
    console.log(JSON.stringify(taxis, null, 2));

    // Test Telegram directly
    console.log("\n=== PROBANDO TELEGRAM DIRECTO ===");
    const TAXI_TELEGRAM_ID = 7543786102;
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: TAXI_TELEGRAM_ID,
            text: "🔧 Prueba de conexión directa. El sistema está funcionando.",
            parse_mode: "Markdown"
        })
    });
    const telegramResult = await r.json();
    console.log("Telegram response:", JSON.stringify(telegramResult));
}

run();
