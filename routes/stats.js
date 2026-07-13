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
    let totalRevenue = 0;
    let totalUnits = 0;

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
          totalRevenue += i.qty * i.unitPrice;
        }
      });
    });

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
      totalRevenue,
      totalUnits,
      byFlavor: Object.values(byFlavor).sort((a, b) => b.revenue - a.revenue),
      availableYears: years,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
