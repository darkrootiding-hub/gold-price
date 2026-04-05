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

// ── Parse both gold and silver prices ──
function parsePrices(html) {
  let gold = null, silver = null;

  // ── GOLD: FINE GOLD (9999) per 1 tola ──
  const fine = html.match(/FINE GOLD[\s\S]{0,300}?per 1 tola[\s\S]{0,100}?[\u0930\u0941\s\*]+([\d]+)/);
  if (fine) {
    const p = parseInt(fine[1]);
    if (p > 100000 && p < 600000) {
      gold = p;
      console.log('✅ Fine Gold (9999) per tola:', gold);
    }
  }

  // Gold fallback: रु **XXXXXX**
  if (!gold) {
    for (const m of [...html.matchAll(/[\u0930\u0941]\s*\*{0,2}(\d{5,7})\*{0,2}/g)]) {
      const p = parseInt(m[1]);
      if (p > 100000 && p < 600000) { gold = p; console.log('✅ Gold रु pattern:', gold); break; }
    }
  }

  // Gold fallback: Nrs XXXXXX
  if (!gold) {
    for (const m of [...html.matchAll(/Nrs\s*\*{0,2}(\d{5,7})\*{0,2}/gi)]) {
      const p = parseInt(m[1]);
      if (p > 100000 && p < 600000) { gold = p; console.log('✅ Gold Nrs pattern:', gold); break; }
    }
  }

  // Gold fallback: 6-digit near "tola"
  if (!gold) {
    const block = html.match(/per 1 tola[\s\S]{0,200}/i);
    if (block) {
      const nums = [...block[0].matchAll(/(\d{6})/g)].map(m => parseInt(m[1]));
      const valid = nums.filter(n => n > 100000 && n < 600000);
      if (valid.length) { gold = valid[0]; console.log('⚠️  Gold tola fallback:', gold); }
    }
  }

  // ── SILVER: SILVER per 1 tola ──
  // fenegosida shows: SILVER per 1 tola रु 5270
  const silBlock = html.match(/SILVER[\s\S]{0,300}?per 1 tola[\s\S]{0,100}?[\u0930\u0941\s\*]+([\d]+)/);
  if (silBlock) {
    const p = parseInt(silBlock[1]);
    if (p > 1000 && p < 50000) {
      silver = p;
      console.log('✅ Silver per tola:', silver);
    }
  }

  // Silver fallback: find "SILVER" block then grab 4-5 digit number
  if (!silver) {
    const silverSection = html.match(/SILVER[\s\S]{0,500}/i);
    if (silverSection) {
      const nums = [...silverSection[0].matchAll(/\b(\d{4,5})\b/g)].map(m => parseInt(m[1]));
      const valid = nums.filter(n => n > 1000 && n < 50000);
      if (valid.length) { silver = valid[0]; console.log('⚠️  Silver fallback:', silver); }
    }
  }

  return { gold, silver };
}

// ── Write gold to global_data/gold_info ──
function writeGold(price) {
  return writeDoc('global_data/gold_info', {
    rate:        { integerValue: String(price) },
    updatedBy:   { stringValue: 'auto@github-actions' },
    lastUpdated: { stringValue: new Date().toISOString() },
    source:      { stringValue: 'fenegosida.org' },
    note:        { stringValue: 'Fine Gold (9999) per tola' }
  });
}

// ── Write silver to global_data/silver_info ──
function writeSilver(price) {
  return writeDoc('global_data/silver_info', {
    rate:        { integerValue: String(price) },
    updatedBy:   { stringValue: 'auto@github-actions' },
    lastUpdated: { stringValue: new Date().toISOString() },
    source:      { stringValue: 'fenegosida.org' },
    note:        { stringValue: 'Silver per tola' }
  });
}

// ── Log to gold_history ──
function logGoldHistory(price) {
  return postDoc('gold_history', {
    rate:      { integerValue: String(price) },
    updatedBy: { stringValue: 'auto@github-actions' },
    timestamp: { stringValue: new Date().toISOString() },
    source:    { stringValue: 'fenegosida.org' },
    note:      { stringValue: 'Fine Gold (9999) per tola' }
  });
}

// ── Log to silver_history ──
function logSilverHistory(price) {
  return postDoc('silver_history', {
    rate:      { integerValue: String(price) },
    updatedBy: { stringValue: 'auto@github-actions' },
    timestamp: { stringValue: new Date().toISOString() },
    source:    { stringValue: 'fenegosida.org' },
    note:      { stringValue: 'Silver per tola' }
  });
}

// ── PATCH a Firestore document ──
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
        else reject(new Error('Firestore PATCH error ' + res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── POST to a Firestore collection (auto-ID) ──
function postDoc(collection, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields });
    const urlObj = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?key=${API_KEY}`
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
    req.write(body);
    req.end();
  });
}

// ── Main ──
async function main() {
  console.log('🕘 Gold + Silver auto-fetch starting...');
  console.log('📅 Time (UTC):', new Date().toISOString());
  console.log('🌐 Source: fenegosida.org');

  let html = null;
  try {
    console.log('🌐 Fetching https://fenegosida.org/');
    html = await get('https://fenegosida.org/');
    console.log('📄 Page size:', Math.round(html.length / 1024) + 'KB');
    if (!html.includes('FINE GOLD') && !html.includes('tola')) {
      throw new Error('No gold data found — site structure may have changed.');
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
    await writeGold(gold);
    console.log('🔥 Gold written to Firestore → global_data/gold_info');
  } catch (e) {
    console.error('❌ Gold Firestore write failed:', e.message);
    process.exit(1);
  }
  try {
    await logGoldHistory(gold);
    console.log('📋 Gold logged to gold_history');
  } catch (e) {
    console.log('⚠️  Gold history skipped:', e.message);
  }

  // ── SILVER ──
  if (!silver) {
    console.warn('⚠️  Could not parse silver price — skipping silver update.');
  } else {
    console.log('🥈 Silver (per tola): NPR', silver.toLocaleString());
    try {
      await writeSilver(silver);
      console.log('🔥 Silver written to Firestore → global_data/silver_info');
    } catch (e) {
      console.error('❌ Silver Firestore write failed:', e.message);
    }
    try {
      await logSilverHistory(silver);
      console.log('📋 Silver logged to silver_history');
    } catch (e) {
      console.log('⚠️  Silver history skipped:', e.message);
    }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Done!');
  console.log('   gold_info.rate   =', gold);
  if (silver) console.log('   silver_info.rate =', silver);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
