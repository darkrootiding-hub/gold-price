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

// ── Parse gold + silver from fenegosida.org ──
//
// Page structure (tola section):
//   FINE GOLD (9999)  per 1 tola  रु **294000**
//   TEJABI GOLD       per 1 tola  रु **0**
//   SILVER            per 1 tola  रु **4830**
//
// Strategy: find the "tola" section of the page, then extract
// all रु **XXXXX** values in order → [0]=gold, [1]=tejabi, [2]=silver

function parsePrices(html) {
  let gold = null, silver = null;

  // Isolate the "per 1 tola" block — everything after "per 1 tola" first occurrence
  const tolaIdx = html.indexOf('per 1 tola');
  if (tolaIdx === -1) {
    console.log('⚠️  Could not find "per 1 tola" section');
    return { gold, silver };
  }
  const tolaBlock = html.slice(tolaIdx, tolaIdx + 2000);
  console.log('📋 Tola block preview:', tolaBlock.slice(0, 300).replace(/\n/g,' '));

  // Extract all रु **DIGITS** in order from tola block
  // Matches: रु **294000** or रु **4830** etc.
  const ruPattern = /[\u0930\u0941]\s*\*{0,2}\s*(\d+)\s*\*{0,2}/g;
  const allPrices = [];
  let m;
  while ((m = ruPattern.exec(tolaBlock)) !== null) {
    allPrices.push(parseInt(m[1]));
  }
  console.log('📊 All tola prices found:', allPrices);

  // Index 0 = Fine Gold, Index 1 = Tejabi, Index 2 = Silver
  if (allPrices.length >= 1) {
    const p = allPrices[0];
    if (p > 100000 && p < 600000) {
      gold = p;
      console.log('✅ Gold (Fine 9999) per tola:', gold);
    }
  }
  if (allPrices.length >= 3) {
    const p = allPrices[2];
    if (p > 500 && p < 50000) {
      silver = p;
      console.log('✅ Silver per tola:', silver);
    }
  }

  // Gold fallback: Nrs **XXXXXX** pattern
  if (!gold) {
    const nrsPattern = /Nrs\s*\*{0,2}\s*(\d{5,7})\s*\*{0,2}/gi;
    while ((m = nrsPattern.exec(html)) !== null) {
      const p = parseInt(m[1]);
      if (p > 100000 && p < 600000) { gold = p; console.log('⚠️  Gold Nrs fallback:', gold); break; }
    }
  }

  // Silver fallback: find Nrs **4XXX** range (silver ~3000-20000)
  if (!silver) {
    const nrsAll = [...html.matchAll(/Nrs\s*\*{0,2}\s*(\d{3,5})\s*\*{0,2}/gi)];
    for (const mm of nrsAll) {
      const p = parseInt(mm[1]);
      if (p > 500 && p < 20000) { silver = p; console.log('⚠️  Silver Nrs fallback:', silver); break; }
    }
  }

  return { gold, silver };
}

// ── Write to Firestore (PATCH = update/create) ──
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

// ── Log to history collection (POST = auto-ID) ──
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
    console.log('🔥 Gold → Firestore: global_data/gold_info');
  } catch (e) {
    console.error('❌ Gold write failed:', e.message); process.exit(1);
  }
  try {
    await postDoc('gold_history', { ...makeFields(gold, 'Fine Gold (9999) per tola'), timestamp: { stringValue: new Date().toISOString() } });
    console.log('📋 Gold → gold_history');
  } catch (e) { console.log('⚠️  Gold history skipped:', e.message); }

  // ── SILVER ──
  if (!silver) {
    console.warn('⚠️  Could not parse silver price — skipping.');
  } else {
    console.log('🥈 Silver (per tola): NPR', silver.toLocaleString());
    try {
      await writeDoc('global_data/silver_info', makeFields(silver, 'Silver per tola'));
      console.log('🔥 Silver → Firestore: global_data/silver_info');
    } catch (e) { console.error('❌ Silver write failed:', e.message); }
    try {
      await postDoc('silver_history', { ...makeFields(silver, 'Silver per tola'), timestamp: { stringValue: new Date().toISOString() } });
      console.log('📋 Silver → silver_history');
    } catch (e) { console.log('⚠️  Silver history skipped:', e.message); }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Done!');
  console.log('   gold_info.rate   =', gold);
  if (silver) console.log('   silver_info.rate =', silver);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
