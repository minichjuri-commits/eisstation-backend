const express = require('express');
const router = express.Router();
const db = require('../lib/db');

const PALETTE = ['#E8A33D', '#6FA8DC', '#B78EE0', '#E0C368', '#5FBFB3', '#E08A6F'];

router.get('/', async (req, res) => {
  try {
    const data = await db.read();
    res.json(data.flavors);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, price, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
    const data = await db.read();
    const flavor = {
      id: name.trim().toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36),
      name: name.trim(),
      color: (color && String(color).trim()) || PALETTE[data.flavors.length % PALETTE.length],
      price: parseFloat(price) || 10,
    };
    data.flavors.push(flavor);
    await db.write(data);
    res.json(flavor);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { price, name, color } = req.body;
    const data = await db.read();
    const flavor = data.flavors.find((f) => f.id === req.params.id);
    if (!flavor) return res.status(404).json({ error: 'Sorte nicht gefunden' });
    if (price != null && price !== '') flavor.price = parseFloat(price);
    if (name != null && String(name).trim()) flavor.name = String(name).trim();
    if (color != null && String(color).trim()) flavor.color = String(color).trim();
    await db.write(data);
    res.json(flavor);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sorte entfernen. Bestehende Bestellungen behalten ihre bisherigen Artikel
// (Name/Farbe/Preis waren dort schon zum Bestellzeitpunkt gespeichert bzw.
// werden in Anzeigen defensiv mit "?" abgefangen, falls die Sorte spaeter
// geloescht wurde) - das Loeschen betrifft nur die Sorten-Auswahlliste.
router.delete('/:id', async (req, res) => {
  try {
    const data = await db.read();
    const idx = data.flavors.findIndex((f) => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Sorte nicht gefunden' });
    data.flavors.splice(idx, 1);
    await db.write(data);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
