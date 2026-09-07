import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://auwiqcabiojbckjncssl.supabase.co";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1d2lxY2FiaW9qYmNram5jc3NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQ3MzkwMCwiZXhwIjoyMDg1MDQ5OTAwfQ.GbCPjyK4r_Q9_ZGCZ2tL2Rbr7IAiRFbEyi5EGxHYZys";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function setOnline() {
    const turnos = [
        { nombre: 'Yeferson Polanco', turno: 1 },
        { nombre: 'Iris Ramirez', turno: 2 },
        { nombre: 'Cristian Cepeda', turno: 3 },
        { nombre: 'Yesenia Rosario', turno: 4 }
    ];

    console.log("Asignando turnos...");
    
    for (const t of turnos) {
        const { data, error } = await supabase
            .from('taxis')
            .update({ estado: 'DISPONIBLE', turno: t.turno })
            .eq('nombre', t.nombre)
            .select('nombre, estado, turno');
        
        if (error) {
            console.error(`Error al actualizar a ${t.nombre}:`, error);
        } else {
            console.log(`Actualizado: ${t.nombre} -> Turno ${t.turno}`);
        }
    }
    
    console.log("Proceso completado.");
}

setOnline();
