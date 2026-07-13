const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { pickLeastLoaded, openItemsCountFor } = require('../lib/logic');

router.get('/', async (req, res) => {
  try {
    const data = await db.read();
    res.json(data.machines.map((m) => ({ ...m, openCount: openItemsCountFor(data.orders, m.id) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/queue', async (req, res) => {
  try {
    const data = await db.read();
    const machineId = parseInt(req.params.id, 10);
    const queue = [];
    data.orders.forEach((o) => {
      o.items.forEach((i) => {
        if (i.machine === machineId && i.status !== 'storniert') {
          queue.push({ ...i, orderId: o.id, orderCreatedAt: o.createdAt, phone: o.phone, orderItemCount: o.items.length });
        }
      });
    });
    queue.sort((a, b) => {
      const pr = { offen: 0, in_bearbeitung: 1, fertig: 2 };
      if (pr[a.status] !== pr[b.status]) return pr[a.status] - pr[b.status];
      return a.orderCreatedAt - b.orderCreatedAt;
    });
    res.json(queue);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = await db.read();
    const id = data.nextMachineId || Math.max(0, ...data.machines.map((m) => m.id)) + 1;
    const name = (req.body && req.body.name && String(req.body.name).trim()) || 'Maschine ' + id;
    const machine = { id, name, active: true };
    data.machines.push(machine);
    data.nextMachineId = id + 1;
    await db.write(data);
    res.json(machine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { active, name } = req.body;
    const machineId = parseInt(req.params.id, 10);
    const data = await db.read();
    const machine = data.machines.find((m) => m.id === machineId);
    if (!machine) return res.status(404).json({ error: 'Maschine nicht gefunden' });

    if (name != null && String(name).trim()) machine.name = String(name).trim();

    if (active === false && machine.active) {
      machine.active = false;
      const remainingActiveIds = data.machines.filter((m) => m.active && m.id !== machineId).map((m) => m.id);
      if (remainingActiveIds.length > 0) {
        const counts = {};
        remainingActiveIds.forEach((id) => {
          counts[id] = openItemsCountFor(data.orders, id);
        });
        data.orders.forEach((o) => {
          o.items.forEach((i) => {
            if (i.machine === machineId && i.status === 'offen') {
              const target = pickLeastLoaded(counts, remainingActiveIds);
              counts[target] += 1;
              i.machine = target;
            }
          });
        });
      }
    } else if (active === true && !machine.active) {
      machine.active = true;
      const activeIds = data.machines.filter((m) => m.active).map((m) => m.id);
      const refs = [];
      data.orders.forEach((o) => {
        o.items.forEach((i) => {
          if (activeIds.includes(i.machine) && (i.status === 'offen' || i.status === 'in_bearbeitung')) {
            refs.push({ order: o, item: i });
          }
        });
      });
      const queues = {};
      activeIds.forEach((id) => {
        queues[id] = refs
          .filter((r) => r.item.machine === id)
          .sort((a, b) => {
            const pr = { in_bearbeitung: 0, offen: 1 };
            if (pr[a.item.status] !== pr[b.item.status]) return pr[a.item.status] - pr[b.item.status];
            return a.order.createdAt - b.order.createdAt;
          });
      });
      const pool = [];
      const counts = {};
      activeIds.forEach((id) => {
        queues[id].forEach((r, idx) => {
          if (idx === 0) counts[id] = (counts[id] || 0) + 1;
          else pool.push(r);
        });
        if (counts[id] === undefined) counts[id] = 0;
      });
      pool.forEach((r) => {
        const target = pickLeastLoaded(counts, activeIds);
        counts[target] += 1;
        r.item.machine = target;
      });
    }

    await db.write(data);
    res.json(machine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
