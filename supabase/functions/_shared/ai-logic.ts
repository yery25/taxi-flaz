// ========================================
// 🧠 LÓGICA DE IA COMPARTIDA
// ========================================

export async function callIA(
    text: string,
    userName: string,
    isTaxista: boolean,
    taxiData?: Record<string, unknown>,
) {
    const IA_PROVIDER = Deno.env.get("IA_PROVIDER") || "groq";
    const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    // Construir contexto rico del usuario
    let userContext = `- Nombre: ${userName}\n`;

    if (isTaxista) {
        userContext += `- Es taxista registrado: SÍ\n`;
        if (taxiData) {
            userContext += `- Número de taxi: ${taxiData.numero_taxista || "N/A"}\n`;
            userContext += `- Turno actual: ${taxiData.turno || "Sin turno"}\n`;
            userContext += `- Estado: ${taxiData.estado || "OFFLINE"}\n`;
            userContext += `- Cédula: ${taxiData.cedula || "N/A"}\n`;
        }
    } else {
        userContext += `- Es taxista registrado: NO (es cliente)\n`;
    }

    const isVoice = userName === "Cliente de Voz" || userName === "Cliente Voz";

    let systemPrompt = "";

    if (isVoice || !isTaxista) {
        systemPrompt = `Eres "Lupita", asistente virtual de voz de Taxi Flash. Tu voz es natural, ultra-rápida y eficiente.
HABLAS ÚNICAMENTE EN ESPAÑOL.

ESTADO INICIAL:
- El saludo inicial ("Taxi Flash a su servicio.") ya fue dicho por el sistema al contestar.
- PROHIBIDO decir "Hola", "Buenas", o volver a saludar.

FLUJO DE ATENCIÓN (Sigue estos pasos estrictamente en orden):
PASO 1: CUANDO EL CLIENTE PIDE UN TAXI O DA SU UBICACIÓN/DESTINO
- El cliente indicará que necesita un taxi o dirá hacia dónde va.
- Clasifica la intención como "PEDIR_TAXI".
- Extrae la ubicación/origen y el nombre si lo menciona.
- Responde: "Espere un momento para asignarle un taxi. Veré si tenemos taxista en turno."

PASO 2: ASIGNACIÓN Y RESPUESTA FINAL
- Tras consultar el sistema, se asigna el taxista de turno y se lee la confirmación exacta con los datos del vehículo y taxista.

SI EL CLIENTE DICE QUE NO O CANCELA:
- Responde: "Entendido, quedamos a tu orden. ¡Feliz día!"

Responde SIEMPRE en este formato JSON:
{
  "intent": "PEDIR_TAXI" | "UBICACION" | "SALUDO" | "PRECIO" | "CANCELAR" | "OTROS",
  "location": "Ubicación/origen extraído o null",
  "customer_name": "Nombre extraído o null",
  "response": "Tu respuesta de Lupita en ESPAÑOL"
}`;
    } else {
        // PROMPT PARA TAXISTAS REGISTRADOS (TELEGRAM/WHATSAPP)
        systemPrompt = `Eres el coordinador de despacho de Taxi-Flaz. 
Tu tono debe ser directo, profesional y muy dominicano. 
Habla como si estuvieras por el radio de la central (la QAP). 
Confirma turnos, disponibilidad y asignaciones a los taxistas registrados.

DATOS DEL TAXISTA ACTUAL:
${userContext}

RESPONDE SIEMPRE EN JSON:
{
  "intent": "DISPONIBLE" | "NO_DISPONIBLE" | "CONFIRMAR" | "CONSULTAR_TURNO" | "ASIGNAR_TURNO" | "IDENTIFICACION" | "OTROS",
  "response": "Tu respuesta corta al taxista",
  "assignment_request": boolean
}

REGLAS DE INTELIGENCIA (Taxi-Flaz - Solo Taxistas):

1. **IDENTIFICACIÓN**: Si el usuario dice "Soy taxista", "Quiero registrarme":
   - Clasifica como "IDENTIFICACION" y pide Cédula y número de unidad.
2. **ASIGNAR TURNO**: 
   - Si quiere entrar en turno (ej: "ponme disponible"), clasifica como "ASIGNAR_TURNO" ("assignment_request": true).
3. **DISPONIBILIDAD/CONFIRMACION**:
   - "DISPONIBLE": Ya está libre.
   - "CONFIRMAR": Acepta pedido o va en camino.
   - "NO_DISPONIBLE": Termina turno.`;
    }

    const url = IA_PROVIDER === "groq"
        ? "https://api.groq.com/openai/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions";

    const key = IA_PROVIDER === "groq" ? GROQ_API_KEY : OPENAI_API_KEY;

    if (!key) {
        throw new Error(`API Key para ${IA_PROVIDER} no encontrada.`);
    }

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: IA_PROVIDER === "groq"
                ? "openai/gpt-oss-120b"
                : "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: `Usuario: ${userName}\nMensaje: ${text}`,
                },
            ],
            response_format: { type: "json_object" },
        }),
    });

    if (!res.ok) {
        throw new Error(`IA API error: ${await res.text()}`);
    }

    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
}
