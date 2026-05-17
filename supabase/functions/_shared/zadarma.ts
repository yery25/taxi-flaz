import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const ZADARMA_KEY = Deno.env.get("ZADARMA_KEY");
const ZADARMA_SECRET = Deno.env.get("ZADARMA_SECRET");

/**
 * Genera la firma para la API de Zadarma.
 * 
 * Algoritmo oficial (PHP):
 *   $sign = base64_encode(hash_hmac('sha1', $method.$paramsStr.md5($paramsStr), $secret));
 *
 * NOTA CRÍTICA: En PHP, hash_hmac() sin el flag `true` devuelve un HEX STRING,
 * NO bytes crudos. Por eso base64_encode recibe el HEX, no los bytes.
 */
async function generateSignature(method: string, paramsStr: string, secret: string): Promise<string> {
    // 1. MD5 del string de parámetros -> hex lowercase
    const paramsData = new TextEncoder().encode(paramsStr);
    const md5Buffer = await crypto.subtle.digest("MD5", paramsData);
    const md5Hex = encodeHex(md5Buffer).toLowerCase();

    // 2. Cadena base: method + paramsStr + md5Hex
    const signString = method + paramsStr + md5Hex;

    // 3. HMAC-SHA1
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
        "raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signString));

    // 4. ✅ CRÍTICO: Convertir bytes -> HEX string -> Base64
    //    (PHP: base64_encode(hash_hmac('sha1',...)) devuelve base64 del HEX, no de bytes crudos)
    const sigHex = encodeHex(sigBuffer); // hex lowercase
    return encodeBase64(new TextEncoder().encode(sigHex));
}

export class ZadarmaService {
    private static baseUrl = "https://api.zadarma.com";

    /**
     * Realiza una petición firmada a la API de Zadarma
     */
    static async request(method: string, params: Record<string, string> = {}, httpMethod: "GET" | "POST" = "GET") {
        if (!ZADARMA_KEY || !ZADARMA_SECRET) {
            throw new Error("ZADARMA_KEY o ZADARMA_SECRET no configurados");
        }

        // Ordenar parámetros alfabéticamente (ksort de PHP)
        const sortedKeys = Object.keys(params).sort();
        const queryParts = sortedKeys.map(key => `${key}=${encodeURIComponent(params[key])}`);
        const paramsStr = queryParts.join('&');

        const signature = await generateSignature(method, paramsStr, ZADARMA_SECRET);
        const url = `${this.baseUrl}${method}${httpMethod === "GET" && paramsStr ? '?' + paramsStr : ''}`;

        const response = await fetch(url, {
            method: httpMethod,
            headers: {
                "Authorization": `${ZADARMA_KEY}:${signature}`,
                ...(httpMethod === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
            },
            ...(httpMethod === "POST" ? { body: paramsStr } : {})
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Error Zadarma API (${method}):`, errorText);
            throw new Error(`Zadarma API ${response.status}: ${errorText}`);
        }

        return await response.json();
    }

    /**
     * Obtiene la lista de extensiones SIP
     */
    static async getSipList() {
        return await this.request("/v1/sip/");
    }

    /**
     * Realiza un callback (Llamada saliente conectando dos puntos)
     */
    static async makeCallback(from: string, to: string) {
        console.log(`📞 Iniciando callback Zadarma: ${from} -> ${to}`);
        return await this.request("/v1/request/callback/", { from, to }, "GET");
    }

    /**
     * Envía un mensaje SMS
     */
    static async sendSms(to: string, message: string) {
        console.log(`✉️ Enviando SMS Zadarma a ${to}: ${message}`);
        return await this.request("/v1/sms/send/", { number: to, message }, "POST");
    }

    /**
     * Obtiene el enlace de descarga de una grabación
     * @param callId El ID de la llamada con grabación (call_id_with_rec)
     */
    static async getRecordLink(callId: string) {
        console.log(`🔗 Solicitando enlace de descarga para ID: ${callId}`);
        return await this.request("/v1/pbx/record/request/", { call_id: callId }, "GET");
    }

    /**
     * Realiza una transferencia de una llamada activa
     * @param pbxCallId ID de la llamada (pbx_call_id)
     * @param destination Extensión o número externo al que transferir
     */
    static async transferCall(pbxCallId: string, destination: string) {
        return await this.request("/v1/pbx/transfer/", {
            pbx_call_id: pbxCallId,
            target: destination
        }, "GET");
    }
}
