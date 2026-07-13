require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./lib/db');
const { staffAuth } = require('./lib/auth');

const flavorsRouter = require('./routes/flavors');
const machinesRouter = require('./routes/machines');
const ordersRouter = require('./routes/orders');
const publicRouter = require('./routes/public');
const statsRouter = require('./routes/stats');

const app = express();

// Frontend (Vercel) und Backend (Render) laufen auf unterschiedlichen
// Adressen -> CORS muss Anfragen von der Frontend-Adresse erlauben.
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Personal-APIs -> per Login geschuetzt (siehe lib/auth.js)
app.use('/api/flavors', staffAuth, flavorsRouter);
app.use('/api/machines', staffAuth, machinesRouter);
app.use('/api/orders', staffAuth, ordersRouter);
app.use('/api/stats', staffAuth, statsRouter);

// Kunden-API -> bewusst oeffentlich, kein Login noetig zum Scannen des QR-Codes
app.use('/api/public', publicRouter);

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', (req, res) =>
  res.json({ status: 'Eisstation-Backend laeuft. Dies ist eine reine API - die Bedienoberflaeche liegt separat (Frontend/Vercel).' })
);

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`Eisstation-Backend laeuft auf Port ${PORT}`);
      if (!process.env.TWILIO_ACCOUNT_SID) console.log('Hinweis: keine Twilio-Zugangsdaten gesetzt - SMS werden nur simuliert.');
      if (!process.env.STAFF_USER) console.log('Hinweis: kein STAFF_USER/STAFF_PASSWORD gesetzt - Personal-API ist ungeschuetzt.');
      if (!process.env.FRONTEND_URL) console.log('Hinweis: FRONTEND_URL ist nicht gesetzt - CORS erlaubt aktuell jede Adresse (*).');
    });
  } catch (err) {
    console.error('Start fehlgeschlagen (Supabase-Zugangsdaten/Tabelle pruefen):', err.message);
    process.exit(1);
  }
})();
