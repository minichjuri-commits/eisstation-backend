const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../lib/db');
const { sendSms } = require('../lib/sms');
const {
  formatTicket, pickLeastLoaded, openItemsCountFor, buildCompletionText, linkPhoneAndNotify, orderTrackingUrl,
} = require('../lib/logic');

// Optional per ?since= und/oder ?until= (Millisekunden seit Epoch)
// einschraenkbar. Die Grenzen werden bewusst vom Client berechnet (nicht
// hier serverseitig aus Jahr/Monat/Tag), damit die tatsaechliche
// Zeitzone des Standorts zaehlt und nicht die des Render-Servers.
router.get('/', async (req, res) => {
  try {
    const data = await db.read();
    let orders = data.orders;
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    const until = req.query.until ? parseInt(req.query.until, 10) : null;
    if (since != null && !isNaN(since)) orders = orders.filter((o) => o.createdAt >= since);
    if (until != null && !isNaN(until)) orders = orders.filter((o) => o.createdAt < until);
    res.json(orders.slice().reverse());
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
    const { items, discount } = req.body;
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

    const order = {
      id: formatTicket(ticketNo),
      ticketNo,
      items: orderItems,
      createdAt,
      phone: null,
      messages: [],
      completedAt: null,
      discount: Math.max(0, Number(discount) || 0),
      // Zufaelliger Token, der zusaetzlich zur Bestellnummer noetig ist, um
      // die Kunden-Verfolgungsseite zu oeffnen - verhindert, dass jemand
      // einfach Bestellnummern durchprobiert und fremde Bestellungen samt
      // hinterlegter Telefonnummer einsehen kann.
      token: crypto.randomBytes(8).toString('hex'),
    };
    data.orders.push(order);
    data.ticketCounter += 1;
    await db.write(data);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
    res.json({
      order,
      qrTargetUrl: orderTrackingUrl(order, frontendUrl),
      qrImageUrl: `/api/public/orders/${order.id}/qrcode.png`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Telefonnummer durch das Kassenpersonal setzen/aendern
// Rabatt auf eine bestehende Bestellung setzen/aendern (auch nachtraeglich
// moeglich, z.B. aus der Detailansicht in der Kasse).
router.post('/:id/discount', async (req, res) => {
  try {
    const { discount } = req.body;
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    order.discount = Math.max(0, Number(discount) || 0);
    await db.write(data);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/phone', async (req, res) => {
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
      const completionText = buildCompletionText(order, allFinished, process.env.FRONTEND_URL || 'http://localhost:5500');
      const r = await sendSms(order.phone, completionText);
      order.messages.push({
        type: 'completion',
        text: completionText,
        time: Date.now(),
        simulated: r.simulated,
        failed: !!r.failed,
        error: r.error || null,
      });
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

// Setzt einen Artikel einen Schritt zurueck (fertig -> in Bearbeitung,
// in Bearbeitung -> offen) - fuer Vertipper an der Maschinen-Ansicht.
// Wird ein bereits fertiger Artikel zurueckgesetzt und war die Bestellung
// dadurch als "komplett fertig" markiert, wird das wieder aufgehoben (der
// Abholhinweis beim Kunden verschwindet dann, bis wirklich alles fertig
// ist). Bereits verschickte SMS koennen naturgemaess nicht zurueckgeholt
// werden.
router.patch('/:id/items/:itemId/revert', async (req, res) => {
  try {
    const data = await db.read();
    const order = data.orders.find((o) => o.id === req.params.id.toUpperCase());
    if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden' });
    const item = order.items.find((i) => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    if (item.status === 'offen') return res.status(400).json({ error: 'Artikel ist bereits offen' });
    if (item.status === 'storniert') return res.status(400).json({ error: 'Stornierte Artikel koennen nicht zurueckgesetzt werden' });

    if (item.status === 'fertig') {
      item.status = 'in_bearbeitung';
      item.itemFinishedAt = null;
      const relevant = order.items.filter((i) => i.status !== 'storniert');
      const stillAllFinished = relevant.length > 0 && relevant.every((i) => i.status === 'fertig');
      if (!stillAllFinished) order.completedAt = null;
    } else if (item.status === 'in_bearbeitung') {
      item.status = 'offen';
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
