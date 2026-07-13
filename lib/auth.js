// Einfache Basic-Auth fuer die Personal-Bereiche (/kasse, /maschine/*, /statistik
// und die zugehoerigen /api/* Routen). Wird nur aktiv, wenn STAFF_USER und
// STAFF_PASSWORD in der .env gesetzt sind - sonst bleibt der Bereich offen
// (nur fuer lokale Tests empfohlen).
function staffAuth(req, res, next) {
  const user = process.env.STAFF_USER;
  const pass = process.env.STAFF_PASSWORD;
  if (!user || !pass) return next();

  const header = req.headers.authorization || '';
  const token = header.split(' ')[1] || '';
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const u = sep >= 0 ? decoded.slice(0, sep) : '';
  const p = sep >= 0 ? decoded.slice(sep + 1) : '';

  if (u === user && p === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Eisstation Personal"');
  return res.status(401).send('Authentifizierung erforderlich');
}

module.exports = { staffAuth };
