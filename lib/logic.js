function formatTicket(n) {
  return 'B-' + String(n).padStart(3, '0');
}

function pickLeastLoaded(counts, ids) {
  let best = ids[0];
  let bestCount = Infinity;
  for (const id of ids) {
    const c = counts[id] || 0;
    if (c < bestCount) {
      bestCount = c;
      best = id;
    }
  }
  return best;
}

// "Auslastung" = offene + in Bearbeitung befindliche Artikel (fertige und
// stornierte zaehlen nicht mehr mit).
function openItemsCountFor(orders, machineId) {
  return orders.reduce(
    (sum, o) =>
      sum + o.items.filter((i) => i.machine === machineId && (i.status === 'offen' || i.status === 'in_bearbeitung')).length,
    0
  );
}

// "orderTotal" ist der tatsaechlich zu zahlende Betrag (nach Rabatt) - wird
// fuer Kassen-/Kunden-Anzeige und die SMS-Bestaetigung verwendet. Die
// Verkaufsstatistik (routes/stats.js) rechnet bewusst getrennt davon mit den
// Brutto-Einzelpreisen je Artikel, damit ein nachtraeglich gewaehrter Rabatt
// nicht die Sorten-Auswertung verzerrt.
function orderTotal(order) {
  const gross = order.items.filter((i) => i.status !== 'storniert').reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const discount = Number(order.discount) || 0;
  return Math.max(0, gross - discount);
}

function deriveOrderStatus(order) {
  const relevant = order.items.filter((i) => i.status !== 'storniert');
  if (relevant.length === 0) return 'storniert';
  if (relevant.every((i) => i.status === 'fertig')) return 'fertig';
  if (relevant.some((i) => i.status !== 'offen')) return 'in_bearbeitung';
  return 'offen';
}

function buildCompletionText(order, allFinished) {
  return allFinished
    ? `Ihre Bestellung ${order.id} ist komplett fertig - bitte innerhalb von 2 Minuten am Ausgabeschalter abholen, sonst geht sie an den naechsten Kunden!`
    : `Ein Teil Ihrer Bestellung ${order.id} ist fertig - bitte am Ausgabeschalter abholen oder auf den Rest warten.`;
}

// Verknuepft eine Telefonnummer mit einer Bestellung, verschickt die
// Bestellbestaetigung und - falls bereits ein Artikel fertig war, bevor die
// Nummer hinterlegt wurde - die (einmalige) Fertigstellungs-Nachricht direkt hinterher.
async function linkPhoneAndNotify(order, phone, sendSms) {
  order.phone = phone.trim();
  const total = orderTotal(order);
  const confirmationText = `Bestellbestaetigung - Nr. ${order.id} ueber ${total.toFixed(2)} EUR eingegangen. Wir melden uns, sobald der erste Artikel fertig ist.`;
  const confirmationResult = await sendSms(order.phone, confirmationText);
  order.messages.push({ type: 'confirmation', text: confirmationText, time: Date.now(), simulated: confirmationResult.simulated });

  const relevant = order.items.filter((i) => i.status !== 'storniert');
  const anyFinished = relevant.some((i) => i.status === 'fertig');
  const alreadyHasCompletion = order.messages.some((m) => m.type === 'completion');
  if (anyFinished && !alreadyHasCompletion) {
    const allFinished = relevant.length > 0 && relevant.every((i) => i.status === 'fertig');
    const completionText = buildCompletionText(order, allFinished);
    const completionResult = await sendSms(order.phone, completionText);
    order.messages.push({ type: 'completion', text: completionText, time: Date.now(), simulated: completionResult.simulated });
  }
  return order;
}

// Durchschnittliche Bearbeitungszeit pro Artikel (von "offen" bis "fertig"),
// berechnet aus allen bisher fertiggestellten Artikeln. Fallback 4 Minuten,
// solange noch keine historischen Daten vorliegen.
function averageProcessingTimeMs(orders) {
  const durations = [];
  orders.forEach((o) => {
    o.items.forEach((i) => {
      if (i.status === 'fertig' && i.itemCreatedAt != null && i.itemFinishedAt != null) {
        durations.push(i.itemFinishedAt - i.itemCreatedAt);
      }
    });
  });
  if (durations.length === 0) return 4 * 60 * 1000;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

module.exports = {
  formatTicket,
  pickLeastLoaded,
  openItemsCountFor,
  orderTotal,
  deriveOrderStatus,
  buildCompletionText,
  linkPhoneAndNotify,
  averageProcessingTimeMs,
};
