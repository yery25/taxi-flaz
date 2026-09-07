import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function setOffline() {
    console.log("Desconectando taxis en turno...");
    
    // update all where turno is not null
    const { data, error } = await supabase
        .from('taxis')
        .update({ estado: 'OFFLINE', turno: null })
        .not('turno', 'is', null)
        .select('nombre, estado, turno');

    if (error) {
        console.error("Error al actualizar:", error);
    } else {
        console.log("Taxis actualizados exitosamente:");
        console.log(JSON.stringify(data, null, 2));
    }
}

setOffline();
