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
// Actual HTML structure from fenegosida.org:
//   <div class="rate-gold post">
//     <p>FINE GOLD<br><span>per 1 tola</span><br><br>रु</span> <b>294000</b></p>
//   </div>
//   <div class="rate-gold post">
//     <p>TEJABI GOLD<br><span>per 1 tola</span><br><br>रु</span> <b>0</b></p>
//   </div>
//   <div class="rate-silver post">
//     <p>SILVER<br><span>per 1 tola</span><br><br>रु</span> <b>4830</b></p>
//   </div>

function parsePrices(html) {
  let gold = null, silver = null;

  // ── GOLD: extract <b> value from FINE GOLD block ──
  const goldBlock = html.match(/FINE GOLD[\s\S]{0,300}?<b>([\d]+)<\/b>/i);
  if (goldBlock) {
    const p = parseInt(goldBlock[1]);
    if (p > 100000 && p < 600000) {
      gold = p;
      console.log('✅ Gold (Fine 9999) per tola:', gold);
    }
  }

  // Gold fallback: any 6-digit <b> tag
  if (!gold) {
    const allB = [...html.matchAll(/<b>(\d+)<\/b>/g)];
    for (const m of allB) {
      const p = parseInt(m[1]);
      if (p > 100000 && p < 600000) {
        gold = p;
        console.log('⚠️  Gold <b> fallback:', gold);
        break;
      }
    }
  }

  // ── SILVER: must get per 1 tola, not per 10 grm ──
  // Page has SILVER twice: first = per 10 grm, second = per 1 tola
  // Target the SECOND occurrence of SILVER <b> tag

  // Strategy 1: find "rate-silver" class div (tola section only)
  const silverDiv = html.match(/rate-silver[\s\S]{0,400}?<b>([\d]+)<\/b>/i);
  if (silverDiv) {
    const p = parseInt(silverDiv[1]);
    if (p > 500 && p < 50000) {
      silver = p;
      console.log('✅ Silver per tola (rate-silver div):', silver);
    }
  }

  // Strategy 2: get ALL SILVER <b> matches, pick the last valid one (tola > 10grm)
  if (!silver) {
    const allSilver = [...html.matchAll(/SILVER[\s\S]{0,300}?<b>([\d]+)<\/b>/gi)];
    // Last match is the tola price
    for (let i = allSilver.length - 1; i >= 0; i--) {
      const p = parseInt(allSilver[i][1]);
      if (p > 500 && p < 50000) {
        silver = p;
        console.log('⚠️  Silver fallback (last match):', silver);
        break;
      }
    }
  }

  // Strategy 3: find "per 1 tola" then grab next <b> after SILVER keyword
  if (!silver) {
    const tolaSection = html.match(/per 1 tola[\s\S]{0,2000}/i);
    if (tolaSection) {
      const silverInTola = tolaSection[0].match(/SILVER[\s\S]{0,200}?<b>([\d]+)<\/b>/i);
      if (silverInTola) {
        const p = parseInt(silverInTola[1]);
        if (p > 500 && p < 50000) {
          silver = p;
          console.log('⚠️  Silver per-1-tola section fallback:', silver);
        }
      }
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
