// Función compartida para transcribir audio usando Groq Whisper API
// Puede ser usada por Telegram, WhatsApp y llamadas telefónicas

/**
 * Transcribe un archivo de audio a texto usando Groq Whisper API
 * @param audioBuffer - Buffer del archivo de audio
 * @param language - Código de idioma (default: 'es' para español)
 * @returns Objeto con el texto transcrito
 */
export async function transcribeWithGroq(
    audioBuffer: ArrayBuffer,
    language: string = "es",
): Promise<{ text: string }> {
    const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");

    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY no está configurada");
    }

    try {
        // Convertir ArrayBuffer a Blob con tipo MIME apropiado
        const blob = new Blob([audioBuffer], { type: "audio/ogg" });

        // Crear FormData para el request
        const formData = new FormData();
        formData.append("file", blob, "audio.ogg");
        formData.append("model", "whisper-large-v3");
        formData.append("language", language);
        formData.append("response_format", "json");

        console.log("🎙️ Enviando audio a Groq Whisper para transcripción...");

        const response = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY}`,
                },
                body: formData,
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ Error de Groq Whisper:", errorText);
            throw new Error(`Groq Whisper API error: ${response.status}`);
        }

        const result = await response.json();
        console.log("✅ Transcripción completada:", result.text);

        return result;
    } catch (error) {
        console.error("❌ Error transcribiendo audio:", error);
        throw error;
    }
}
