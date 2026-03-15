// fetch-gold.js
// Fetches gold price from fenegosida.org (official Nepal Gold & Silver Dealers Federation)
// Runs via GitHub Actions twice daily — 11:30 AM + 7:00 PM NPT

const https = require('https');

// ── Firebase config (injected from GitHub Secrets) ──
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY    = process.env.FIREBASE_API_KEY;

if (!PROJECT_ID || !API_KEY) {
  console.error('❌ Missing FIREBASE_PROJECT_ID or FIREBASE_API_KEY env vars.');
  process.exit(1);
}

// ── Fetch URL (follows redirects) ──
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldBot/1.0)',
        'Accept':     'text/html,application/xhtml+xml',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parse gold price from fenegosida.org ──
function parseGoldPrice(html) {
  // Primary: "FINE GOLD (9999) per 1 tola रु 309400"
  // HTML pattern: रु **309400**
  const fine = html.match(/FINE GOLD[\s\S]{0,300}?per 1 tola[\s\S]{0,100}?[\u0930\u0941\s\*]+([\d]+)/);
  if (fine) {
    const price = parseInt(fine[1]);
    if (price > 100000 && price < 600000) {
      console.log('✅ Fine Gold (9999) per tola found:', price);
      return price;
    }
  }

  // Strategy 2: रु **XXXXXX** pattern (Nepali rupee symbol before price)
  const ruMatches = [...html.matchAll(/[\u0930\u0941]\s*\*{0,2}(\d{5,7})\*{0,2}/g)];
  for (const m of ruMatches) {
    const price = parseInt(m[1]);
    if (price > 100000 && price < 600000) {
      console.log('✅ रु pattern price found:', price);
      return price;
    }
  }

  // Strategy 3: Nrs XXXXXX pattern
  const nrsMatches = [...html.matchAll(/Nrs\s*\*{0,2}(\d{5,7})\*{0,2}/gi)];
  for (const m of nrsMatches) {
    const price = parseInt(m[1]);
    if (price > 100000 && price < 600000) {
      console.log('✅ Nrs pattern price found:', price);
      return price;
    }
  }

  // Strategy 4: any 6-digit number in gold range after "tola"
  const tolaBlock = html.match(/per 1 tola[\s\S]{0,200}/i);
  if (tolaBlock) {
    const nums = [...tolaBlock[0].matchAll(/(\d{6})/g)].map(m => parseInt(m[1]));
    const valid = nums.filter(n => n > 100000 && n < 600000);
    if (valid.length) {
      console.log('⚠️  Tola block fallback:', valid[0]);
      return valid[0];
    }
  }

  return null;
}

// ── Write to Firestore via REST API ──
function writeToFirestore(price) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      fields: {
        rate:        { integerValue: String(price) },
        updatedBy:   { stringValue: 'auto@github-actions' },
        lastUpdated: { stringValue: new Date().toISOString() },
        source:      { stringValue: 'fenegosida.org' },
        note:        { stringValue: 'Fine Gold (9999) per tola' }
      }
    });

    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/global_data/gold_info?key=${API_KEY}`
    );

    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'PATCH',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error('Firestore error ' + res.statusCode + ': ' + data));
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Also log to gold_history collection ──
function logToHistory(price) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      fields: {
        rate:      { integerValue: String(price) },
        updatedBy: { stringValue: 'auto@github-actions' },
        timestamp: { stringValue: new Date().toISOString() },
        source:    { stringValue: 'fenegosida.org' },
        note:      { stringValue: 'Fine Gold (9999) per tola' }
      }
    });

    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/gold_history?key=${API_KEY}`
    );

    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', e => resolve('history log skipped: ' + e.message));
    req.write(body);
    req.end();
  });
}

// ── Main ──
async function main() {
  console.log('🕘 Gold price auto-fetch starting...');
  console.log('📅 Time (UTC):', new Date().toISOString());
  console.log('🌐 Source: fenegosida.org (Nepal Gold & Silver Dealers Federation)');

  let html = null;
  try {
    console.log('🌐 Fetching https://fenegosida.org/');
    html = await get('https://fenegosida.org/');
    console.log('📄 Page size:', Math.round(html.length / 1024) + 'KB');

    if (!html.includes('FINE GOLD') && !html.includes('tola')) {
      throw new Error('Page fetched but no gold data found — site structure may have changed.');
    }
  } catch (e) {
    console.error('❌ Fetch failed:', e.message);
    process.exit(1);
  }

  const price = parseGoldPrice(html);
  if (!price) {
    console.error('❌ Could not parse gold price from fenegosida.org');
    process.exit(1);
  }

  console.log('💰 Fine Gold price (per tola): NPR', price.toLocaleString());

  try {
    await writeToFirestore(price);
    console.log('🔥 Successfully written to Firestore!');
  } catch (e) {
    console.error('❌ Firestore write failed:', e.message);
    process.exit(1);
  }

  try {
    await logToHistory(price);
    console.log('📋 Logged to gold_history collection');
  } catch (e) {
    console.log('⚠️  History log skipped:', e.message);
  }

  console.log('✅ Done. gold_info.rate =', price);
}

main();
