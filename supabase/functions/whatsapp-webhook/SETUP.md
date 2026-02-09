# Activación de WhatsApp (Futuro)

## 📋 Requisitos Previos

1. **Cuenta de Twilio**: [Crea una cuenta](https://www.twilio.com/try-twilio)
2. **WhatsApp Business Profile**: Solicitar aprobación en Twilio Console
3. **Verificación**: Proceso puede tardar 1-3 días hábiles

---

## 🔧 Configuración

### 1. Configurar Twilio WhatsApp

1. Ve a Twilio Console → Messaging → WhatsApp senders
2. Sigue el proceso de configuración de WhatsApp Business
3. Obtén tu número de WhatsApp habilitado

### 2. Configurar Secrets en Supabase

```bash
cd c:\Users\Yer Perez\Desktop\taxi-ia

supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=xxxxxxxxxx
supabase secrets set TWILIO_PHONE_NUMBER=whatsapp:+1234567890
```

### 3. Desplegar Webhook

```bash
supabase functions deploy whatsapp-webhook
```

### 4. Configurar Webhook en Twilio

1. Copia la URL del webhook:
   ```
   https://[tu-proyecto].supabase.co/functions/v1/whatsapp-webhook
   ```
2. Ve a Twilio Console → WhatsApp → Sandbox (o tu número configurado)
3. Pega la URL en "When a message comes in"
4. Método: POST
5. Guardar

---

## 🧪 Probar

1. Envía mensaje de WhatsApp al número de Twilio
2. Prueba con texto: "Necesito un taxi"
3. Prueba con nota de voz

---

## 💰 Costos Estimados

- Mensajes salientes: ~$0.005-0.02 USD/mensaje
- Mensajes entrantes: Gratis
- Notas de voz: Contadas como mensajes

**Total estimado:** ~$5-10 USD/mes para uso moderado
