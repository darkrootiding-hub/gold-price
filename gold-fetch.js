// fetch-gold.js
// Fetches gold price from Hamropatro and writes to Firebase Firestore
// Runs via GitHub Actions daily at 9 AM NPT (3:15 AM UTC)

const https = require('https');

// ── Firebase config (values injected from GitHub Secrets) ──
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY    = process.env.FIREBASE_API_KEY;

if (!PROJECT_ID || !API_KEY) {
  console.error('❌ Missing FIREBASE_PROJECT_ID or FIREBASE_API_KEY env vars.');
  process.exit(1);
}

// ── Fetch a URL via https (no npm needed) ──
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parse gold price from Hamropatro HTML ──
function parseGoldPrice(html) {
  // Strategy 1: "Nrs. 314,200.00" near Hallmark
  const hallmark = html.match(/[Hh]allmark[\s\S]{0,400}?Nrs?\.?\s*([\d,]+(?:\.\d+)?)/);
  if (hallmark) {
    const price = Math.round(parseFloat(hallmark[1].replace(/,/g, '')));
    if (price > 100000 && price < 600000) {
      console.log('✅ Hallmark price found:', price);
      return price;
    }
  }

  // Strategy 2: Any "Nrs. XXXXXX" in gold range
  const allNrs = [...html.matchAll(/Nrs?\.?\s*([\d,]{6,10}(?:\.\d+)?)/gi)];
  for (const m of allNrs) {
    const price = Math.round(parseFloat(m[1].replace(/,/g, '')));
    if (price > 100000 && price < 600000) {
      console.log('✅ Nrs. pattern price found:', price);
      return price;
    }
  }

  // Strategy 3: Tejabi fallback
  const tejabi = html.match(/[Tt]ajabi[\s\S]{0,400}?Nrs?\.?\s*([\d,]+(?:\.\d+)?)/);
  if (tejabi) {
    const price = Math.round(parseFloat(tejabi[1].replace(/,/g, '')));
    if (price > 100000 && price < 600000) {
      console.log('✅ Tejabi fallback price found:', price);
      return price;
    }
  }

  // Strategy 4: Any 6-digit number in gold range
  const sixDigit = [...html.matchAll(/\b(\d{6})\b/g)].map(m => parseInt(m[1]));
  const valid = sixDigit.filter(n => n > 100000 && n < 600000);
  if (valid.length > 0) {
    console.log('⚠️  Fallback 6-digit price found:', valid[0]);
    return valid[0];
  }

  return null;
}

// ── Write price to Firestore via REST API (no SDK needed) ──
function writeToFirestore(price) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      fields: {
        rate:        { integerValue: String(price) },
        updatedBy:   { stringValue: 'auto@github-actions' },
        lastUpdated: { stringValue: new Date().toISOString() },
        source:      { stringValue: 'hamropatro.com/gold' }
      }
    });

    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/global_data/gold_info?key=${API_KEY}`;

    const options = {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PATCH',
      headers: options.headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Firestore error ' + res.statusCode + ': ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──
async function main() {
  console.log('🕘 Gold price auto-fetch starting...');
  console.log('📅 Time (UTC):', new Date().toISOString());

  const GOLD_PAGE = 'https://hamropatro.com/gold';
  let html = null;

  try {
    console.log('🌐 Fetching', GOLD_PAGE);
    html = await get(GOLD_PAGE);
    console.log('📄 Page size:', Math.round(html.length / 1024) + 'KB');

    if (!html.includes('Hallmark') && !html.includes('Tajabi')) {
      throw new Error('Page fetched but no gold data found — structure may have changed.');
    }
  } catch (e) {
    console.error('❌ Fetch failed:', e.message);
    process.exit(1);
  }

  const price = parseGoldPrice(html);
  if (!price) {
    console.error('❌ Could not parse gold price from page.');
    process.exit(1);
  }

  console.log('💰 Gold price (per tola):', 'NPR', price.toLocaleString());

  try {
    await writeToFirestore(price);
    console.log('🔥 Successfully written to Firestore!');
    console.log('✅ Done. gold_info.rate =', price);
  } catch (e) {
    console.error('❌ Firestore write failed:', e.message);
    process.exit(1);
  }
}

main();
