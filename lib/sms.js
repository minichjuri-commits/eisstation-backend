// SMS-Versand ueber seven.io (deutscher Anbieter, https://www.seven.io).
// Einfache HTTP-API, kein SDK-Paket noetig - nutzt das in Node 18+ eingebaute
// fetch(). Ohne gesetzten API-Schluessel laeuft die App trotzdem, SMS werden
// dann nur in der Server-Konsole simuliert.
const apiKey = process.env.SEVEN_API_KEY;
const sender = process.env.SEVEN_SENDER || 'Eisstation';

async function sendSms(to, body) {
  if (!apiKey) {
    console.log(`[SMS-SIMULATION] an ${to}: ${body}`);
    return { simulated: true, to, body };
  }

  // seven.io erwartet die Nummer ohne "+" am Anfang (z.B. 4915112345678
  // statt +4915112345678) und ohne Leerzeichen.
  const cleanTo = String(to).trim().replace(/^\+/, '').replace(/\s+/g, '');

  try {
    const res = await fetch('https://gateway.seven.io/api/sms', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ to: cleanTo, text: body, from: sender }),
    });
    const data = await res.json();
    const msg = data.messages && data.messages[0];

    if (data.success === '100' && msg && msg.success) {
      return { simulated: false, id: msg.id, to, body };
    }

    const errorText = (msg && (msg.error_text || msg.error)) || `seven.io Fehlercode ${data.success}`;
    console.error('seven.io Fehler:', errorText);
    console.log(`[SMS-SIMULATION, wegen Fehler] an ${to}: ${body}`);
    return { simulated: true, failed: true, error: errorText, to, body };
  } catch (err) {
    console.error('seven.io Fehler:', err.message);
    console.log(`[SMS-SIMULATION, wegen Fehler] an ${to}: ${body}`);
    return { simulated: true, failed: true, error: err.message, to, body };
  }
}

module.exports = { sendSms };
