// Bestellnummern laufen als B-001 bis B-999, danach beginnt automatisch der
// naechste Buchstabe wieder bei 001 (C-001, C-999, D-001, ...) statt auf
// vierstellige Zahlen zu wechseln. Nach Z (nach 25 * 999 Bestellungen -
// praktisch nie erreicht) wird auf zweistellige Buchstabenfolgen
// ausgewichen (AA, AB, ...), damit es nie einen harten Fehler gibt.
const TICKET_BLOCK_SIZE = 999;

function letterForBlock(blockIndex) {
  const singleLetterCount = 25; // B bis Z
  if (blockIndex < singleLetterCount) {
    return String.fromCharCode('B'.charCodeAt(0) + blockIndex);
  }
  // Zweistellige Buchstabenfolge (AA, AB, ..., AZ, BA, ...) - komplett
  // getrennt vom einstelligen Bereich, damit keine Buchstaben doppelt
  // vergeben werden.
  const idx = blockIndex - singleLetterCount;
  const first = Math.floor(idx / 26);
  const second = idx % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}

function formatTicket(n) {
  const blockIndex = Math.floor((n - 1) / TICKET_BLOCK_SIZE);
  const withinBlock = ((n - 1) % TICKET_BLOCK_SIZE) + 1;
  return letterForBlock(blockIndex) + '-' + String(withinBlock).padStart(3, '0');
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

function orderTrackingUrl(order, frontendUrl) {
  return `${frontendUrl}/order/${order.id}-${order.token}`;
}

function buildCompletionText(order, allFinished, frontendUrl) {
  const link = orderTrackingUrl(order, frontendUrl);
  return allFinished
    ? `Ihre Bestellung ${order.id} ist komplett fertig - bitte innerhalb von 2 Minuten am Ausgabeschalter abholen, sonst geht sie an den naechsten Kunden! Status: ${link}`
    : `Ein Teil Ihrer Bestellung ${order.id} ist fertig - bitte am Ausgabeschalter abholen oder auf den Rest warten. Status: ${link}`;
}

// Verknuepft eine Telefonnummer mit einer Bestellung, verschickt die
// Bestellbestaetigung und - falls bereits ein Artikel fertig war, bevor die
// Nummer hinterlegt wurde - die (einmalige) Fertigstellungs-Nachricht direkt hinterher.
async function linkPhoneAndNotify(order, phone, sendSms, frontendUrl) {
  order.phone = phone.trim();
  const total = orderTotal(order);
  const link = orderTrackingUrl(order, frontendUrl);
  const confirmationText = `Bestellbestaetigung - Nr. ${order.id} ueber ${total.toFixed(2)} EUR eingegangen. Verfolgen: ${link}`;
  const confirmationResult = await sendSms(order.phone, confirmationText);
  order.messages.push({
    type: 'confirmation',
    text: confirmationText,
    time: Date.now(),
    simulated: confirmationResult.simulated,
    failed: !!confirmationResult.failed,
    error: confirmationResult.error || null,
  });

  const relevant = order.items.filter((i) => i.status !== 'storniert');
  const anyFinished = relevant.some((i) => i.status === 'fertig');
  const alreadyHasCompletion = order.messages.some((m) => m.type === 'completion');
  if (anyFinished && !alreadyHasCompletion) {
    const allFinished = relevant.length > 0 && relevant.every((i) => i.status === 'fertig');
    const completionText = buildCompletionText(order, allFinished, frontendUrl);
    const completionResult = await sendSms(order.phone, completionText);
    order.messages.push({
      type: 'completion',
      text: completionText,
      time: Date.now(),
      simulated: completionResult.simulated,
      failed: !!completionResult.failed,
      error: completionResult.error || null,
    });
  }
  return order;
}

// Durchschnittliche Bearbeitungszeit pro Artikel (von "offen" bis "fertig"),
// berechnet aus allen bisher fertiggestellten Artikeln. Fallback 4 Minuten,
// solange noch keine historischen Daten vorliegen.
function percentile(sortedArr, p) {
  const idx = (sortedArr.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (idx - lower);
}

// Durchschnittliche Bearbeitungszeit pro Artikel (von "offen" bis "fertig").
// - dayStart/dayEnd (optional, Millisekunden): werden vom Client anhand
//   seiner eigenen lokalen Zeitzone berechnet und uebergeben, damit nur
//   Fertigstellungen des jeweils "heutigen" Kalendertags am Standort
//   einfliessen - nicht die des Render-Servers und nicht andere Tage.
// - Ausreisser (ungewoehnlich kurze oder lange Bearbeitungszeiten, z.B.
//   durch eine liegen gelassene Bestellung) werden per IQR-Methode
//   herausgefiltert, sofern genug Datenpunkte vorliegen.
function averageProcessingTimeMs(orders, dayStart, dayEnd) {
  let durations = [];
  orders.forEach((o) => {
    o.items.forEach((i) => {
      if (i.status === 'fertig' && i.itemCreatedAt != null && i.itemFinishedAt != null) {
        if (dayStart != null && dayEnd != null && (i.itemFinishedAt < dayStart || i.itemFinishedAt >= dayEnd)) {
          return;
        }
        durations.push(i.itemFinishedAt - i.itemCreatedAt);
      }
    });
  });
  if (durations.length === 0) return 4 * 60 * 1000;

  durations.sort((a, b) => a - b);

  if (durations.length >= 4) {
    const q1 = percentile(durations, 0.25);
    const q3 = percentile(durations, 0.75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    const filtered = durations.filter((d) => d >= lowerBound && d <= upperBound);
    if (filtered.length > 0) durations = filtered;
  }

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
  orderTrackingUrl,
};
