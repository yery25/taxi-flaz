# Sistema de Voz y Mensajería Multi-Canal (Taxi-Flaz)

Este repositorio contiene la lógica de despacho inteligente para Taxi-Flaz, migrada recientemente de Twilio a infraestructuras más robustas: **Meta Cloud API** (WhatsApp) y **Plivo** (Voz).

este es el token permanente EAANIk1fHRE0BRBaklT2JMOhu0rtF0Kr51U5wOWRuWadDVnGbjz7CzScO3MB8jK7ufKGPgcl2PPxhb84kMa4EbLdK6OoWZAHsrbf7lurNBkGbpxLlmT6nPNEwpXibwdLVRs1Co940vWZCjamW6qllDENtRXUcXS9oVw6BY0DDKwZCy6kNsRcUDQemZBarxAzOvQZDZD

cuenta de vonage para llamada.
correo personal.
contraseña [q34hu79k.100]
contraseña de fasebook yesenia
contraseña [q34hu79k.10]



## 🚀 Infraestructura Actual

### 🟢 WhatsApp (Meta Cloud API) - ACTIVO
- **Webhook**: `whatsapp-meta-webhook`
- **Capacidades**:
    - Recepción de texto y ubicación en tiempo real.
    - Autoregistro de taxistas autorizados por número de teléfono.
    - Respuestas inteligentes vía IA (Groq/OpenAI).
- **Secrets Requeridos**: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.

### 📞 Llamadas de Voz (Plivo) - ACTIVO
- **Webhook**: `plivo-voice-webhook`
- **Capacidades**:
    - Reconocimiento de voz en español natural (`Polly.Mia`).
    - Transferencia automática (`Dial`) al taxista de turno.
    - Manejo inteligente de "Lista de Espera" si no hay conductores.
- **Secrets Requeridos**: `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`.

### 🔵 Telegram (Voz y Texto) - ACTIVO
- **Webhook**: `telegram-webhook`
- **Capacidades**: Transcripción Whisper para notas de voz.

---

## 🛠️ Guía de Despliegue (Supabase)

Para desplegar o actualizar las funciones:

```bash
# 1. Configurar Secrets (Si no se ha hecho)
supabase secrets set WHATSAPP_ACCESS_TOKEN=...
supabase secrets set PLIVO_AUTH_ID=...

# 2. Desplegar Funciones
supabase functions deploy whatsapp-meta-webhook
supabase functions deploy plivo-voice-webhook
supabase functions deploy telegram-webhook
```

## 📁 Estructura del Proyecto

```
supabase/functions/
├── _shared/
│   ├── ai-logic.ts          🧠 Cerebro de la IA
│   ├── dispatch-logic.ts    🚕 Lógica de despacho y turnos
│   ├── messaging.ts         ✉️ Proveedor unificado (Meta/Twilio/Telegram)
│   └── lista_taxistas.ts    📋 Conductores autorizados
├── whatsapp-meta-webhook/   🤖 Webhook oficial de WhatsApp
├── plivo-voice-webhook/     📞 Webhook de voz (Plivo)
└── telegram-webhook/        🔵 Webhook de Telegram
```

---

## 🚕 Flujo de Usuario

1. **Cliente llama o escribe**: La IA identifica su nombre y dirección.
2. **Asignación**: El sistema busca al taxista más antiguo en estado `DISPONIBLE`.
3. **Notificación**:
    - Si es llamada, se hace un `Dial` directo al taxista.
    - El taxista recibe un WhatsApp con los detalles del cliente.
4. **Confirmación**: El taxista responde "Acepto" y el cliente es notificado.

---
*Mantenido por Taxi-Flaz Dev Team.*
