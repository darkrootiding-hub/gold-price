// fetch-silver.js
// Fetches silver price (per tola) from fenegosida.org
// Runs via GitHub Actions twice daily — 10:30 AM + 11:10 AM NPT

const https = require('https');

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
        'User-Agent': 'Mozilla/5.0 (compatible; SilverBot/1.0)',
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

// ── Parse silver price (per tola) from fenegosida.org ──
//
// Page structure:
//   * gms   ← first tab
//   * tola  ← second tab (we want this section)
//
//   tola section <b> values in order:
//   [0] = Fine Gold   e.g. 294000
//   [1] = Tejabi Gold e.g. 0
//   [2] = Silver      e.g. 4830  ← THIS
//
function parseSilverPrice(html) {
  // Split HTML at "* tola" marker to get only the tola section
  const tolaSplit = html.split(/\*\s*tola/i);
  const tolaSection = tolaSplit.length > 1 ? tolaSplit[tolaSplit.length - 1] : null;

  if (tolaSection) {
    const bTags = [...tolaSection.matchAll(/<b>(\d+)<\/b>/g)].map(m => parseInt(m[1]));
    console.log('📊 Tola section <b> values:', bTags);
    // index [2] = silver per tola
    if (bTags.length >= 3) {
      const price = bTags[2];
      if (price > 500 && price < 50000) {
        console.log('✅ Silver per tola (index 2):', price);
        return price;
      }
    }
  }

  // Fallback 1: rate-silver div — grab LAST <b> match (tola comes after gms)
  const allSilverMatches = [...html.matchAll(/SILVER[\s\S]{0,300}?<b>(\d+)<\/b>/gi)];
  if (allSilverMatches.length > 0) {
    // Last occurrence = tola price
    const price = parseInt(allSilverMatches[allSilverMatches.length - 1][1]);
    if (price > 500 && price < 50000) {
      console.log('⚠️  Silver fallback (last SILVER match):', price);
      return price;
    }
  }

  // Fallback 2: any 4-digit number in silver range after "tola" keyword
  const tolaBlock = html.match(/tola[\s\S]{0,1000}/i);
  if (tolaBlock) {
    const nums = [...tolaBlock[0].matchAll(/\b(\d{4,5})\b/g)].map(m => parseInt(m[1]));
    const valid = nums.filter(n => n > 500 && n < 50000);
    if (valid.length) {
      console.log('⚠️  Silver tola block fallback:', valid[0]);
      return valid[0];
    }
  }

  return null;
}

// ── Write to global_data/silver_info ──
function writeToFirestore(price) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      fields: {
        rate:        { integerValue: String(price) },
        updatedBy:   { stringValue: 'auto@github-actions' },
        lastUpdated: { stringValue: new Date().toISOString() },
        source:      { stringValue: 'fenegosida.org' },
        note:        { stringValue: 'Silver per tola' }
      }
    });
    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/global_data/silver_info?key=${API_KEY}`
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

// ── Log to silver_history collection ──
function logToHistory(price) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      fields: {
        rate:      { integerValue: String(price) },
        updatedBy: { stringValue: 'auto@github-actions' },
        timestamp: { stringValue: new Date().toISOString() },
        source:    { stringValue: 'fenegosida.org' },
        note:      { stringValue: 'Silver per tola' }
      }
    });
    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/silver_history?key=${API_KEY}`
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
  console.log('🥈 Silver price auto-fetch starting...');
  console.log('📅 Time (UTC):', new Date().toISOString());
  console.log('🌐 Source: fenegosida.org');

  let html = null;
  try {
    console.log('🌐 Fetching https://fenegosida.org/');
    html = await get('https://fenegosida.org/');
    console.log('📄 Page size:', Math.round(html.length / 1024) + 'KB');
    if (!html.includes('SILVER')) {
      throw new Error('No silver data found — site structure may have changed.');
    }
  } catch (e) {
    console.error('❌ Fetch failed:', e.message);
    process.exit(1);
  }

  const price = parseSilverPrice(html);
  if (!price) {
    console.error('❌ Could not parse silver price from fenegosida.org');
    process.exit(1);
  }

  console.log('🥈 Silver price (per tola): NPR', price.toLocaleString());

  try {
    await writeToFirestore(price);
    console.log('🔥 Silver written to Firestore → global_data/silver_info');
  } catch (e) {
    console.error('❌ Firestore write failed:', e.message);
    process.exit(1);
  }

  try {
    await logToHistory(price);
    console.log('📋 Silver logged to silver_history collection');
  } catch (e) {
    console.log('⚠️  History log skipped:', e.message);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Done! silver_info.rate =', price);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
