import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const ZADARMA_KEY = "4226786299897c3d52d0";
const ZADARMA_SECRET = "39b3bd51f39928987359";

const method = "/v1/info/balance/";
const paramsStr = "";

// MD5 del paramsStr
const paramsData = new TextEncoder().encode(paramsStr);
const md5Buffer = await crypto.subtle.digest("MD5", paramsData);
const md5Hex = encodeHex(md5Buffer).toLowerCase();

// Cadena base
const signString = method + paramsStr + md5Hex;
console.log("SignString:", signString);

// HMAC-SHA1
const encoder = new TextEncoder();
const keyData = encoder.encode(ZADARMA_SECRET);
const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
);
const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signString));

// base64(hex_bytes) = la firma correcta de Zadarma
const sigHex = encodeHex(sigBuffer);
const signature = encodeBase64(new TextEncoder().encode(sigHex));
console.log("Signature:", signature);

const url = `https://api.zadarma.com${method}`;
const res = await fetch(url, {
    headers: { "Authorization": `${ZADARMA_KEY}:${signature}` }
});
console.log("Status:", res.status);
console.log("Body:", await res.text());
