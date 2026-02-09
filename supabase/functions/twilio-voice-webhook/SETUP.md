# Activación de Llamadas Telefónicas (Futuro)

## 📋 Requisitos Previos

1. **Cuenta de Twilio**: [Crea una cuenta](https://www.twilio.com/try-twilio)
2. **Número de teléfono**: Comprar en Twilio Console
3. **Crédito**: Mínimo $20 USD recomendado

---

## 🔧 Configuración

### 1. Comprar Número de Teléfono

1. Ve a Twilio Console → Phone Numbers → Buy a number
2. Selecciona país (ej: República Dominicana)
3. Filtro: "Voice" habilitado
4. Compra el número (~$1 USD/mes)

### 2. Configurar Secrets en Supabase

```bash
cd c:\Users\Yer Perez\Desktop\taxi-ia

supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=xxxxxxxxxx
supabase secrets set TWILIO_PHONE_NUMBER=+1234567890
```

### 3. Desplegar Webhook

```bash
supabase functions deploy twilio-voice-webhook
```

### 4. Configurar Webhook en Twilio

1. Copia la URL del webhook:
   ```
   https://[tu-proyecto].supabase.co/functions/v1/twilio-voice-webhook
   ```
2. Ve a Twilio Console → Phone Numbers → Manage → Active numbers
3. Selecciona tu número
4. En "Voice Configuration":
   - A call comes in: Webhook
   - URL: Pega la URL del webhook
   - HTTP: POST
5. Guardar

---

## 🧪 Probar

1. Llama al número de Twilio desde tu celular
2. Escucha el saludo del bot
3. Habla tu solicitud: "Necesito un taxi en Calle 5"
4. El bot debería procesar y responder

---

## 💰 Costos Estimados

- Número de teléfono: ~$1 USD/mes
- Llamadas entrantes: ~$0.0085 USD/minuto
- Llamadas salientes: ~$0.014 USD/minuto
- Text-to-Speech: ~$0.04 USD/1000 caracteres

**Total estimado:** ~$10-15 USD/mes para uso moderado (100 llamadas/mes de 2 min
c/u)
