const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM_NUMBER;

let client = null;
if (sid && token) {
  const twilio = require('twilio');
  client = twilio(sid, token);
}

// Verschickt eine echte SMS ueber Twilio, sobald TWILIO_* in der .env gesetzt
// sind. Ohne Zugangsdaten wird die Nachricht nur in die Server-Konsole
// geschrieben (Simulationsmodus) - die App bleibt so auch ohne Twilio-Konto
// benutzbar, sendet aber erst mit echten Zugangsdaten wirklich SMS raus.
async function sendSms(to, body) {
  if (!client || !from) {
    console.log(`[SMS-SIMULATION] an ${to}: ${body}`);
    return { simulated: true, to, body };
  }
  try {
    const msg = await client.messages.create({ body, from, to });
    return { simulated: false, sid: msg.sid, to, body };
  } catch (err) {
    console.error('Twilio Fehler:', err.message);
    console.log(`[SMS-SIMULATION, wegen Fehler] an ${to}: ${body}`);
    return { simulated: true, failed: true, error: err.message, to, body };
  }
}

module.exports = { sendSms };
