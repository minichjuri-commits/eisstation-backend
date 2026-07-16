const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { sendSms } = require('../lib/sms');
const { generateQrPngBuffer } = require('../lib/qr');
const { linkPhoneAndNotify, averageProcessingTimeMs } = require('../lib/logic');

// Diese Routen sind bewusst OHNE Login erreichbar - hier landet der Kunde
// nach dem Scannen des QR-Codes. Der QR-Code selbst liegt hier (statt im
// geschuetzten Bereich), weil ein <img>-Tag im Browser keine eigenen
// Login-Header mitschicken kann - die Bilddatei ist nicht sensibel genug,
// um das zu rechtfertigen.

router.get('/flavors', async (req, res) => {
  try {
    const data = await db.read();
    res.json(data.flavors);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id/qrcode.png', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).send('Not found');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
    const buffer = await generateQrPngBuffer(`${frontendUrl}/order/${order.id}`);
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) {
    res.status(500).send('Fehler');
  }
});

router.post('/orders/:id/link-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Telefonnummer fehlt' });
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    await linkPhoneAndNotify(order, phone, sendSms, process.env.FRONTEND_URL || 'http://localhost:5500');
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id/queue', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });

    const dayStart = req.query.dayStart ? parseInt(req.query.dayStart, 10) : null;
    const dayEnd = req.query.dayEnd ? parseInt(req.query.dayEnd, 10) : null;
    const avgMs = averageProcessingTimeMs(data.orders, dayStart, dayEnd);
    const involvedMachines = [
      ...new Set(order.items.filter((i) => i.status === 'offen' || i.status === 'in_bearbeitung').map((i) => i.machine)),
    ];

    const machineQueues = involvedMachines.map((machineId) => {
      const machine = data.machines.find((m) => m.id === machineId);
      const queue = [];
      data.orders.forEach((o) => {
        o.items.forEach((i) => {
          if (i.machine === machineId && (i.status === 'offen' || i.status === 'in_bearbeitung')) {
            queue.push({ itemId: i.itemId, orderId: o.id, status: i.status, isMine: o.id === order.id, createdAt: o.createdAt });
          }
        });
      });
      queue.sort((a, b) => {
        const pr = { in_bearbeitung: 0, offen: 1 };
        if (pr[a.status] !== pr[b.status]) return pr[a.status] - pr[b.status];
        return a.createdAt - b.createdAt;
      });
      let myEstimateMs = 0;
      queue.forEach((q, idx) => {
        if (q.isMine) {
          const waitMs = (idx + 1) * avgMs;
          if (waitMs > myEstimateMs) myEstimateMs = waitMs;
        }
      });
      return {
        machineId,
        machineName: machine ? machine.name : 'Maschine ' + machineId,
        queue: queue.map((q) => ({ itemId: q.itemId, orderId: q.isMine ? q.orderId : null, status: q.status, isMine: q.isMine })),
        myEstimateMs,
      };
    });

    const overallEstimateMs = machineQueues.length > 0 ? Math.max(...machineQueues.map((m) => m.myEstimateMs)) : 0;
    res.json({ machineQueues, overallEstimateMs, avgProcessingMs: avgMs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
