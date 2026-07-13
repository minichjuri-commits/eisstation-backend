const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { sendSms } = require('../lib/sms');
const {
  formatTicket, pickLeastLoaded, openItemsCountFor, buildCompletionText, linkPhoneAndNotify,
} = require('../lib/logic');

router.get('/', async (req, res) => {
  try {
    const data = await db.read();
    res.json(data.orders.slice().reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Neue Bestellung: jedes einzelne Stueck wird separat der aktiven Maschine
// mit der geringsten Auslastung zugewiesen (auch innerhalb derselben Bestellung).
router.post('/', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Keine Artikel uebermittelt' });
    }
    const data = await db.read();
    const activeIds = data.machines.filter((m) => m.active).map((m) => m.id);
    if (activeIds.length === 0) return res.status(400).json({ error: 'Keine Maschine aktiv' });

    const counts = {};
    activeIds.forEach((id) => {
      counts[id] = openItemsCountFor(data.orders, id);
    });

    const ticketNo = data.ticketCounter;
    const createdAt = Date.now();
    const orderItems = [];
    let unitIndex = 0;
    for (const line of items) {
      const flavor = data.flavors.find((f) => f.id === line.flavorId);
      if (!flavor) continue;
      const qty = Math.max(1, parseInt(line.qty, 10) || 1);
      for (let u = 0; u < qty; u++) {
        unitIndex += 1;
        const machine = pickLeastLoaded(counts, activeIds);
        counts[machine] += 1;
        orderItems.push({
          itemId: formatTicket(ticketNo) + '-' + unitIndex,
          flavorId: flavor.id,
          qty: 1,
          unitPrice: flavor.price,
          machine,
          status: 'offen',
          itemCreatedAt: createdAt,
          itemFinishedAt: null,
        });
      }
    }
    if (orderItems.length === 0) return res.status(400).json({ error: 'Keine gueltigen Artikel' });

    const order = { id: formatTicket(ticketNo), ticketNo, items: orderItems, createdAt, phone: null, messages: [], completedAt: null };
    data.orders.push(order);
    data.ticketCounter += 1;
    await db.write(data);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
    res.json({
      order,
      qrTargetUrl: `${frontendUrl}/order/${order.id}`,
      qrImageUrl: `/api/public/orders/${order.id}/qrcode.png`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Telefonnummer durch das Kassenpersonal setzen/aendern
router.post('/:id/phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Telefonnummer fehlt' });
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    await linkPhoneAndNotify(order, phone, sendSms);
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/items/:itemId/advance', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    const item = order.items.find((i) => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    if (item.status === 'storniert' || item.status === 'fertig') {
      return res.status(400).json({ error: 'Artikel kann nicht mehr fortgesetzt werden' });
    }

    const prevStatus = item.status;
    if (item.status === 'offen') item.status = 'in_bearbeitung';
    else if (item.status === 'in_bearbeitung') {
      item.status = 'fertig';
      item.itemFinishedAt = Date.now();
    }

    const justFinished = prevStatus === 'in_bearbeitung' && item.status === 'fertig';
    const relevant = order.items.filter((i) => i.status !== 'storniert');
    const alreadyHasCompletion = order.messages.some((m) => m.type === 'completion');

    if (justFinished && order.phone && !alreadyHasCompletion) {
      const allFinished = relevant.every((i) => i.status === 'fertig');
      const completionText = buildCompletionText(order, allFinished);
      const r = await sendSms(order.phone, completionText);
      order.messages.push({ type: 'completion', text: completionText, time: Date.now(), simulated: r.simulated });
    }
    if (justFinished) {
      const allFinishedNow = relevant.length > 0 && relevant.every((i) => i.status === 'fertig');
      if (allFinishedNow && !order.completedAt) order.completedAt = Date.now();
    }

    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/items/:itemId/cancel', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    const item = order.items.find((i) => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    if (item.status === 'fertig') return res.status(400).json({ error: 'Fertige Artikel koennen nicht mehr storniert werden' });
    item.status = 'storniert';
    item.itemCancelledAt = Date.now();
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    order.items.forEach((i) => {
      if (i.status === 'offen' || i.status === 'in_bearbeitung') {
        i.status = 'storniert';
        i.itemCancelledAt = Date.now();
      }
    });
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/items/:itemId/reassign', async (req, res) => {
  try {
    const { machine } = req.body;
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    const item = order.items.find((i) => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    if (item.status !== 'offen' && item.status !== 'in_bearbeitung') {
      return res.status(400).json({ error: 'Artikel kann nicht verschoben werden' });
    }
    const targetMachine = data.machines.find((m) => m.id === parseInt(machine, 10));
    if (!targetMachine) return res.status(400).json({ error: 'Unbekannte Maschine' });
    item.machine = targetMachine.id;
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
