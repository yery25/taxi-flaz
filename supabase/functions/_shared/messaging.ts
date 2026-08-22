// ========================================
// ✉️ SISTEMA DE MENSAJERÍA UNIFICADO
// ========================================

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

export type Platform = "telegram" | "whatsapp" | "voice" | "whatsapp_kapso";

export async function sendMessage(
    platform: Platform,
    recipientId: string | number,
    text: string,
    replyMarkup?: any,
): Promise<number | null> {
    if (platform === "telegram") {
        return await sendToTelegram(Number(recipientId), text, replyMarkup);
    } else if (platform === "whatsapp") {
        await sendToWhatsApp(String(recipientId), text);
    } else if (platform === "whatsapp_kapso") {
        await sendToKapso(String(recipientId), text, replyMarkup);
    } else {
        console.log(`📡 [VOICE SIMULATION] Para ${recipientId}: "${text}"`);
    }
    return null;
}

export async function sendToTelegram(chatId: number, text: string, replyMarkup?: any): Promise<number | null> {
    if (!TELEGRAM_TOKEN) {
        console.error("❌ No se encontró TELEGRAM_BOT_TOKEN");
        return null;
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
            return null;
        }

        const data = await response.json();
        return data?.result?.message_id ?? null;
    } catch (error) {
        console.error("❌ Error de red con Telegram:", error);
        return null;
    }
}

/**
 * Edita un mensaje existente de Telegram (quita botones y actualiza texto).
 * Usado cuando un pedido se reasigna para limpiar el chat del taxista anterior.
 */
export async function editTelegramMessage(chatId: number, messageId: number, newText: string): Promise<void> {
    if (!TELEGRAM_TOKEN || !messageId) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: newText,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [] }, // quitar botones
            }),
        });
    } catch (err) {
        console.error("❌ Error editando mensaje de Telegram:", err);
    }
}

/**
 * Elimina un mensaje de Telegram.
 */
export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
    if (!TELEGRAM_TOKEN || !messageId) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
        });
    } catch (err) {
        console.error("❌ Error eliminando mensaje de Telegram:", err);
    }
}

export async function sendToWhatsApp(to: string, text: string) {
    const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

    // 1. ENVIAR CON META CLOUD API (Oficial)
    if (WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
        try {
            const cleanTo = to.replace(/\D/g, "");
            const url = `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

            console.log(`📡 Enviando vía Meta a ${cleanTo}...`);
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

    console.warn("⚠️ Meta Cloud API no configurado.");
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
