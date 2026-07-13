const { createClient } = require('@supabase/supabase-js');

const DEFAULT_FLAVORS = [
  { id: 'vanille', name: 'Vanille', color: '#E8D9B5', price: 10 },
  { id: 'schoko', name: 'Schokolade', color: '#8B5A2B', price: 10 },
  { id: 'erdbeere', name: 'Erdbeere', color: '#D9637E', price: 10 },
  { id: 'pistazie', name: 'Pistazie', color: '#7FB77E', price: 10 },
];

const ROW_ID = 1;
let supabase = null;

function getClient() {
  if (!supabase) {
    // .trim() faengt den haeufigsten Fehler ab: ein unsichtbares Leerzeichen
    // oder ein Zeilenumbruch, das beim Kopieren aus dem Supabase-Dashboard
    // versehentlich mitkopiert wurde.
    const url = (process.env.SUPABASE_URL || '').trim();
    const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !key) {
      throw new Error('SUPABASE_URL und SUPABASE_SERVICE_KEY muessen als Umgebungsvariablen gesetzt sein.');
    }
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
      throw new Error(
        `SUPABASE_URL sieht ungueltig aus: "${url}". Erwartet wird genau die "Project URL" aus ` +
        `Supabase (Project Settings -> API), z.B. https://abcdefgh.supabase.co - ohne ` +
        `Anfuehrungszeichen, ohne Leerzeichen/Zeilenumbruch, ohne zusaetzlichen Pfad.`
      );
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

// Speicherformat: EINE Zeile in der Tabelle "app_state" mit einer JSON-Spalte
// "data", die genau dieselbe Struktur enthaelt wie zuvor die lokale
// db.json-Datei (flavors/machines/orders/ticketCounter/nextMachineId). Das
// ist bewusst keine vollstaendig normalisierte Datenbank-Struktur, sondern
// die einfachste Variante, die mit Supabase/Postgres funktioniert, ohne den
// gesamten restlichen Code umschreiben zu muessen. Fuer sehr grosse
// Bestellmengen waere eine Tabelle pro Entitaet (orders, order_items, ...)
// langfristig sauberer.
async function init() {
  const client = getClient();
  const { data, error } = await client.from('app_state').select('id').eq('id', ROW_ID).maybeSingle();
  if (error) throw error;
  if (!data) {
    const initial = {
      flavors: DEFAULT_FLAVORS,
      machines: [1, 2, 3, 4].map((id) => ({ id, name: 'Maschine ' + id, active: true })),
      nextMachineId: 5,
      orders: [],
      ticketCounter: 1,
    };
    const { error: insertError } = await client.from('app_state').insert({ id: ROW_ID, data: initial });
    if (insertError) throw insertError;
  }
}

async function read() {
  const client = getClient();
  const { data, error } = await client.from('app_state').select('data').eq('id', ROW_ID).single();
  if (error) throw error;
  return data.data;
}

async function write(state) {
  const client = getClient();
  const { error } = await client.from('app_state').update({ data: state }).eq('id', ROW_ID);
  if (error) throw error;
}

module.exports = { init, read, write };
