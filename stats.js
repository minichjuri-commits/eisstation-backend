const express = require('express');
const router = express.Router();
const db = require('../lib/db');

function inRange(ts, start, end) {
  return ts >= start && ts < end;
}

router.get('/', async (req, res) => {
  try {
    const { year, month, day } = req.query;
    const data = await db.read();
    let start, end, label;

    if (day) {
      const d = new Date(day + 'T00:00:00');
      start = d.getTime();
      end = start + 24 * 60 * 60 * 1000;
      label = day;
    } else {
      const y = parseInt(year, 10) || new Date().getFullYear();
      if (month) {
        const m = parseInt(month, 10) - 1;
        start = new Date(y, m, 1).getTime();
        end = new Date(y, m + 1, 1).getTime();
        label = String(m + 1).padStart(2, '0') + '.' + y;
      } else {
        start = new Date(y, 0, 1).getTime();
        end = new Date(y + 1, 0, 1).getTime();
        label = String(y);
      }
    }

    const byFlavor = {};
    let grossRevenue = 0;
    let totalUnits = 0;
    let totalDiscount = 0;

    data.orders.forEach((o) => {
      o.items.forEach((i) => {
        if (i.status === 'fertig' && i.itemFinishedAt && inRange(i.itemFinishedAt, start, end)) {
          const flavor = data.flavors.find((f) => f.id === i.flavorId);
          const key = i.flavorId;
          if (!byFlavor[key]) {
            byFlavor[key] = { flavorId: key, name: flavor ? flavor.name : '(geloeschte Sorte)', color: flavor ? flavor.color : '#888', units: 0, revenue: 0 };
          }
          byFlavor[key].units += i.qty;
          byFlavor[key].revenue += i.qty * i.unitPrice;
          totalUnits += i.qty;
          grossRevenue += i.qty * i.unitPrice;
        }
      });
      // Rabatt wird der Periode zugeordnet, in der die Bestellung komplett
      // fertiggestellt wurde (analog zur Sorten-Auswertung, die ebenfalls
      // auf den Fertigstellungszeitpunkt abstellt).
      if (o.completedAt && inRange(o.completedAt, start, end) && o.discount > 0) {
        totalDiscount += Number(o.discount) || 0;
      }
    });

    const byFlavorList = Object.values(byFlavor).sort((a, b) => b.revenue - a.revenue);
    if (totalDiscount > 0) {
      byFlavorList.push({ flavorId: '__discount__', name: 'Rabatte', color: '#6D7278', units: 0, revenue: -totalDiscount });
    }

    const years = [
      ...new Set(
        data.orders.flatMap((o) =>
          o.items.filter((i) => i.status === 'fertig' && i.itemFinishedAt).map((i) => new Date(i.itemFinishedAt).getFullYear())
        )
      ),
    ].sort();
    if (years.length === 0) years.push(new Date().getFullYear());

    res.json({
      label,
      start,
      end,
      totalRevenue: Math.max(0, grossRevenue - totalDiscount),
      totalDiscount,
      totalUnits,
      byFlavor: byFlavorList,
      availableYears: years,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
