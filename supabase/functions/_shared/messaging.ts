// ========================================
// ✉️ SISTEMA DE MENSAJERÍA UNIFICADO
// ========================================

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER") ||
    "whatsapp:+18095749999"; // Número de empresa con WhatsApp Business

export type Platform = "telegram" | "whatsapp" | "voice" | "whatsapp_kapso";

export async function sendMessage(
    platform: Platform,
    recipientId: string | number,
    text: string,
    replyMarkup?: any,
) {
    if (platform === "telegram") {
        await sendToTelegram(Number(recipientId), text, replyMarkup);
    } else if (platform === "whatsapp") {
        await sendToWhatsApp(String(recipientId), text);
    } else if (platform === "whatsapp_kapso") {
        await sendToKapso(String(recipientId), text, replyMarkup);
    } else {
        console.log(`📡 [VOICE SIMULATION] Para ${recipientId}: "${text}"`);
    }
}

export async function sendToTelegram(chatId: number, text: string, replyMarkup?: any) {
    if (!TELEGRAM_TOKEN) {
        console.error("❌ No se encontró TELEGRAM_BOT_TOKEN");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const body: any = {
            chat_id: chatId,
            text: text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
        };

        if (replyMarkup) {
            body.reply_markup = replyMarkup;
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            console.error(`❌ Error enviando a Telegram (${chatId}):`, error);
        }
    } catch (error) {
        console.error("❌ Error de red con Telegram:", error);
    }
}

/**
 * Envia un mensaje de WhatsApp usando Meta Cloud API (Preferencia) o Twilio (Fallback/Legacy)
 */
export async function sendToWhatsApp(to: string, text: string) {
    const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

    // 1. INTENTAR CON META CLOUD API (Oficial)
    if (WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
        try {
            // Limpiar el número (solo números)
            const cleanTo = to.replace(/\D/g, "");
            const url = `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

            console.log(`📡 Intentando enviar vía Meta a ${cleanTo}...`);
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: cleanTo,
                    type: "text",
                    text: { body: text },
                }),
            });

            if (response.ok) {
                const resData = await response.json();
                console.log(`✅ Mensaje enviado vía Meta. ID: ${resData.messages?.[0]?.id}`);
                return;
            } else {
                const error = await response.text();
                console.error(`❌ Error API Meta (${response.status}):`, error);
            }
        } catch (error) {
            console.error("❌ Error de red con Meta Cloud API:", error);
        }
    }

    // 2. FALLBACK A TWILIO (Legacy)
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        try {
            const formData = new URLSearchParams();
            formData.append(
                "To",
                to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
            );
            formData.append("From", TWILIO_PHONE_NUMBER);
            formData.append("Body", text);

            const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
            const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Basic ${auth}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: formData.toString(),
            });

            if (!response.ok) {
                const error = await response.text();
                console.error(`❌ Error enviando a WhatsApp vía Twilio (${to}):`, error);
            }
            return;
        } catch (error) {
            console.error("❌ Error de red con Twilio:", error);
        }
    }

    console.warn("⚠️ Ningún proveedor de WhatsApp configurado.");
    console.log(`[SIMULACIÓN WHATSAPP] Para: ${to}, Mensaje: ${text}`);
}

/**
 * Envía un mensaje de WhatsApp usando Kapso API (Estructura del video)
 */
export async function sendToKapso(to: string, text: string, replyMarkup?: any) {
    const KAPSO_API_KEY = Deno.env.get("KAPSO_API_KEY");
    const KAPSO_PHONE_NUMBER_ID = Deno.env.get("KAPSO_PHONE_NUMBER_ID");

    if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) {
        console.error("❌ Faltan KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID");
        return;
    }

    try {
        let cleanTo = to.replace(/\D/g, "");
        // Si el número tiene 10 dígitos (formato RD: 809/829/849...), le ponemos el 1 delante
        if (cleanTo.length === 10) {
            cleanTo = "1" + cleanTo;
        }
        const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${KAPSO_PHONE_NUMBER_ID}/messages`;

        console.log(`📡 Enviando vía Kapso a ${cleanTo}...`);
        let bodyPayload: any = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: cleanTo,
        };

        if (replyMarkup && replyMarkup.inline_keyboard) {
            // Formato para botones de WhatsApp (Kapso / Meta Cloud API)
            bodyPayload.type = "interactive";
            bodyPayload.interactive = {
                type: "button",
                body: { text: text },
                action: {
                    buttons: replyMarkup.inline_keyboard[0].map((btn: any, index: number) => ({
                        type: "reply",
                        reply: {
                            id: btn.callback_data || `btn_${index}`,
                            title: btn.text.substring(0, 20) // WhatsApp tiene límite de 20 caracteres en botones
                        }
                    }))
                }
            };
        } else {
            bodyPayload.type = "text";
            bodyPayload.text = { body: text };
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "X-API-Key": KAPSO_API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(bodyPayload),
        });

        const responseText = await response.text();
        if (response.ok) {
            console.log(`✅ Mensaje enviado vía Kapso a ${cleanTo}:`, responseText);
        } else {
            console.error(`❌ Error en Kapso API (${response.status}):`, responseText);
        }
    } catch (error) {
        console.error("❌ Error de red con Kapso:", error);
    }
}
