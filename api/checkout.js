// Funzione serverless (Vercel): crea una Stripe Checkout Session con le quantità del carrello.
// La chiave segreta arriva SOLO dalla variabile d'ambiente STRIPE_SECRET_KEY:
// non va mai scritta nel codice né nei file HTML/JS del sito.
const Stripe = require('stripe');

// Catalogo lato server: prezzi e nomi qui sono quelli "veri".
// Il browser invia solo id, taglia e quantità, così nessuno può modificare il prezzo.
const CATALOG = {
  tee:    { name: "Maglietta dell'album",               cents: 3500, sizes: ['S', 'M', 'L', 'XL'] },
  hoodie: { name: 'Felpa con cappuccio "Debut"',        cents: 6500, sizes: ['S', 'M', 'L', 'XL'] },
  vinyl:  { name: 'Vinile in edizione limitata',        cents: 3000, sizes: null },
  poster: { name: "Poster con la copertina dell'album", cents: 500,  sizes: null },
  cap:    { name: 'Cappellino classico da papà',        cents: 2500, sizes: null, oneSize: true }
};
const ONE_SIZE = 'Taglia unica';
const MAX_QTY = 99;
const MAX_LINES = 20;
// Paesi in cui si spedisce: modificare secondo necessità
const SHIPPING_COUNTRIES = ['IT', 'US', 'FR', 'DE', 'ES', 'GB', 'CH'];

// Riduce un valore come " diana.vercel.app/index.html/ " a "https://diana.vercel.app".
// Restituisce null se il valore non è un indirizzo valido.
function toOrigin(value) {
  if (!value) return null;
  let v = String(value).trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v; // manca il protocollo
  try {
    return new URL(v).origin; // tiene solo protocollo + dominio (+ porta), scarta percorsi e "/"
  } catch (e) {
    return null;
  }
}

// Sceglie il dominio a cui Stripe deve riportare l'utente.
// 1. Il dominio da cui è partita la richiesta, ma SOLO se è autorizzato
//    (SITE_URL o gli indirizzi che Vercel assegna a questo progetto): così il cliente torna
//    sullo stesso sito dove ha il carrello, anche nei deploy di anteprima.
// 2. Altrimenti SITE_URL, poi il dominio di produzione Vercel, infine l'host della richiesta.
function resolveSiteUrl(req) {
  const siteUrl = toOrigin(process.env.SITE_URL);
  const allowed = [
    siteUrl,
    toOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL), // variabili di sistema di Vercel
    toOrigin(process.env.VERCEL_BRANCH_URL),
    toOrigin(process.env.VERCEL_URL)
  ].filter(Boolean);

  const requestOrigin = toOrigin(req.headers.origin);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;

  if (siteUrl) return siteUrl;
  if (allowed.length) return allowed[0];

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? toOrigin(`${proto}://${host}`) : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurata sul server' });
  }

  // ---- Validazione del carrello ricevuto ----
  const items = req.body && req.body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) {
    return res.status(400).json({ error: 'Carrello non valido' });
  }

  const lineItems = [];
  for (const item of items) {
    const product = item && CATALOG[item.id];
    if (!product || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_QTY) {
      return res.status(400).json({ error: 'Articolo non valido nel carrello' });
    }
    const expectedSize = product.sizes ? item.size : (product.oneSize ? ONE_SIZE : null);
    if (product.sizes ? !product.sizes.includes(item.size) : item.size !== expectedSize) {
      return res.status(400).json({ error: 'Taglia non valida' });
    }

    const label = product.sizes ? `${product.name} — Taglia ${item.size}` : product.name;
    lineItems.push({
      quantity: item.qty, // ← la quantità scelta nel carrello arriva a Stripe
      // il cliente può comunque modificarla nella pagina di pagamento
      adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_QTY },
      price_data: {
        currency: 'usd',
        unit_amount: product.cents,
        product_data: {
          name: label,
          metadata: { product_id: item.id, size: item.size || '' }
        }
      }
    });
  }

  const siteUrl = resolveSiteUrl(req);
  if (!siteUrl) {
    console.error('URL del sito non determinabile: controllare SITE_URL su Vercel');
    return res.status(500).json({ error: 'URL del sito non configurato correttamente' });
  }
  console.log('Checkout: URL di ritorno =', `${siteUrl}/thanks.html`);

  try {
    const stripe = Stripe(secretKey);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      success_url: `${siteUrl}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/merch.html`
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Errore Stripe:', err.message);
    return res.status(502).json({ error: 'Impossibile avviare il pagamento' });
  }
};
