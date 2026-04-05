// fetch-gold.js
// Fetches gold + silver price from fenegosida.org
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

// ── Parse gold + silver ──
// Page layout:
//   [gms section]  FINE GOLD <b>252060</b>  TEJABI <b>0</b>  SILVER <b>4141</b>
//   [tola section] FINE GOLD <b>294000</b>  TEJABI <b>0</b>  SILVER <b>4830</b>
//
// Key: page has a tab toggle "* gms\n* tola"
// Everything AFTER "* tola" line is the tola section
// We extract all <b>DIGITS</b> from tola section only:
//   index 0 = Fine Gold tola
//   index 1 = Tejabi tola (skip)
//   index 2 = Silver tola

function parsePrices(html) {
  let gold = null, silver = null;

  // Split at the tola section marker
  // The page has "* tola" as a list item separating gms from tola prices
  const tolaSplit = html.split(/\*\s*tola/i);
  const tolaSection = tolaSplit.length > 1 ? tolaSplit[tolaSplit.length - 1] : html;

  // Extract all <b>NUMBER</b> from tola section
  const bTags = [...tolaSection.matchAll(/<b>(\d+)<\/b>/g)].map(m => parseInt(m[1]));
  console.log('📊 Tola section <b> values:', bTags);

  // index 0 = Fine Gold, index 1 = Tejabi, index 2 = Silver
  if (bTags.length >= 1 && bTags[0] > 100000 && bTags[0] < 600000) {
    gold = bTags[0];
    console.log('✅ Gold per tola:', gold);
  }
  if (bTags.length >= 3 && bTags[2] > 500 && bTags[2] < 50000) {
    silver = bTags[2];
    console.log('✅ Silver per tola:', silver);
  }

  // Gold fallback: any 6-digit <b> in full HTML
  if (!gold) {
    for (const m of [...html.matchAll(/<b>(\d+)<\/b>/g)]) {
      const p = parseInt(m[1]);
      if (p > 100000 && p < 600000) { gold = p; console.log('⚠️  Gold fallback:', gold); break; }
    }
  }

  return { gold, silver };
}

// ── Firestore PATCH (update/create doc) ──
function writeDoc(docPath, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields });
    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}?key=${API_KEY}`
    );
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'PATCH',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error('Firestore PATCH ' + res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Firestore POST (add to collection, auto-ID) ──
function postDoc(col, fields) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ fields });
    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${col}?key=${API_KEY}`
    );
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', e => resolve('skipped: ' + e.message));
    req.write(body); req.end();
  });
}

function makeFields(rate, note) {
  return {
    rate:        { integerValue: String(rate) },
    updatedBy:   { stringValue: 'auto@github-actions' },
    lastUpdated: { stringValue: new Date().toISOString() },
    source:      { stringValue: 'fenegosida.org' },
    note:        { stringValue: note }
  };
}

// ── Main ──
async function main() {
  console.log('🕘 Gold + Silver auto-fetch starting...');
  console.log('📅 Time (UTC):', new Date().toISOString());
  console.log('🌐 Source: fenegosida.org');

  let html = null;
  try {
    html = await get('https://fenegosida.org/');
    console.log('📄 Page size:', Math.round(html.length / 1024) + 'KB');
    if (!html.includes('FINE GOLD') && !html.includes('tola')) {
      throw new Error('No gold data found — site may have changed.');
    }
  } catch (e) {
    console.error('❌ Fetch failed:', e.message);
    process.exit(1);
  }

  const { gold, silver } = parsePrices(html);

  // ── GOLD ──
  if (!gold) {
    console.error('❌ Could not parse gold price.');
    process.exit(1);
  }
  console.log('💰 Gold (per tola): NPR', gold.toLocaleString());
  try {
    await writeDoc('global_data/gold_info', makeFields(gold, 'Fine Gold (9999) per tola'));
    console.log('🔥 Gold → global_data/gold_info');
  } catch (e) {
    console.error('❌ Gold write failed:', e.message);
    process.exit(1);
  }
  try {
    await postDoc('gold_history', makeFields(gold, 'Fine Gold (9999) per tola'));
    console.log('📋 Gold → gold_history');
  } catch (e) { console.log('⚠️  Gold history skipped:', e.message); }

  // ── SILVER ──
  if (!silver) {
    console.warn('⚠️  Could not parse silver price — skipping.');
  } else {
    console.log('🥈 Silver (per tola): NPR', silver.toLocaleString());
    try {
      await writeDoc('global_data/silver_info', makeFields(silver, 'Silver per tola'));
      console.log('🔥 Silver → global_data/silver_info');
    } catch (e) { console.error('❌ Silver write failed:', e.message); }
    try {
      await postDoc('silver_history', makeFields(silver, 'Silver per tola'));
      console.log('📋 Silver → silver_history');
    } catch (e) { console.log('⚠️  Silver history skipped:', e.message); }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Done!');
  console.log('   gold_info.rate   =', gold);
  if (silver) console.log('   silver_info.rate =', silver);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
