// Einfache In-Memory-Rate-Begrenzung (kein externer Speicher noetig). Zaehlt
// Aufrufe pro Schluessel innerhalb eines gleitenden Zeitfensters. Da der
// Speicher nur im laufenden Prozess existiert, setzt sich das bei einem
// Neustart/Ruhezustand des Backends zurueck - fuer den Zweck hier (grobe
// Missbrauchsbremse, keine harte Sicherheitsgrenze) ausreichend.
const buckets = new Map();

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = [];
    buckets.set(key, bucket);
  }
  while (bucket.length > 0 && bucket[0] <= now - windowMs) bucket.shift();
  if (bucket.length >= maxRequests) return false;
  bucket.push(now);
  return true;
}

// Verhindert unbegrenztes Wachstum der Map ueber sehr lange Laufzeiten.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    while (bucket.length > 0 && bucket[0] <= now - 24 * 60 * 60 * 1000) bucket.shift();
    if (bucket.length === 0) buckets.delete(key);
  }
}, 60 * 60 * 1000).unref();

module.exports = { checkRateLimit };
