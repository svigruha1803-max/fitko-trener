// Mattyho fitko robůtek — Cloudflare Worker
// Bindings: DB (D1), PHOTOS (KV), AI_SVC (service -> plavecky-csps-scraper, POST /ai)
// Secrets: APP_PASSWORD, AI_KEY (sent to plavecky /ai), VAPID_PRIVATE (JWK); vars: VAPID_PUBLIC
// Cron: daily 17:00 UTC → attendance nag push; Sunday 18:00 UTC → weekly summary
const MODEL = 'claude-sonnet-4-6';
/* ---------- Katalog cviků: sjednocení názvů (CZ/EN, s diakritikou i bez) ---------- */
const EX_CATALOG = {
  'Bench press': ['bench', 'benchpress', 'bench press', 'tlak na lavici', 'tlak na rovne lavici', 'tlak s velkou cinkou na lavici', 'barbell bench press', 'flat bench'],
  'Šikmý bench press': ['incline bench', 'incline bench press', 'sikmy bench', 'sikmy benchpress', 'tlak na sikme lavici', 'tlak na sikme lavici s velkou cinkou'],
  'Tlak s jednoručkami na lavici': ['db bench', 'dumbbell bench press', 'db bench press', 'tlak s jednoruckami', 'tlak s jednoruckami na rovne lavici', 'jednorucky na lavici'],
  'Šikmý tlak s jednoručkami': ['incline db press', 'incline dumbbell press', 'sikmy tlak s jednoruckami', 'tlak s jednoruckami na sikme lavici'],
  'Dřep': ['squat', 'back squat', 'drep', 'drep s velkou cinkou', 'zadni drep', 'barbell squat'],
  'Přední dřep': ['front squat', 'predni drep'],
  'Mrtvý tah': ['deadlift', 'mrtvy tah', 'conventional deadlift', 'klasicky mrtvy tah'],
  'Rumunský mrtvý tah': ['rdl', 'romanian deadlift', 'rumunsky mrtvy tah', 'mrtvy tah s propnutyma nohama', 'stiff leg deadlift'],
  'Tlak nad hlavu': ['ohp', 'overhead press', 'military press', 'tlak nad hlavu', 'tlak s velkou cinkou nad hlavu', 'standing press', 'vojensky tlak'],
  'Tlak s jednoručkami nad hlavu': ['db shoulder press', 'dumbbell shoulder press', 'seated db press', 'tlak s jednoruckami nad hlavu', 'tlak jednorucek vsedе'],
  'Shyby': ['pull up', 'pullup', 'pull-up', 'shyby', 'shyby nadhmatem', 'chin up', 'chinup', 'shyby podhmatem'],
  'Přítahy v předklonu': ['barbell row', 'bent over row', 'pritahy v predklonu', 'pritahy velke cinky v predklonu', 'veslovani v predklonu', 'pendlay row'],
  'Přítahy jednoručky': ['db row', 'dumbbell row', 'one arm row', 'pritahy jednorucky', 'pritah jednorucky v predklonu', 'veslovani jednoruckou'],
  'Stahování horní kladky': ['lat pulldown', 'pulldown', 'stahovani horni kladky', 'stahovani kladky', 'stahovani kladky k hrudniku'],
  'Přítahy kladky vsedě': ['seated cable row', 'cable row', 'pritahy kladky vsede', 'veslovani na kladce', 'seated row'],
  'Leg press': ['leg press', 'legpress', 'nozni lis', 'leg-press'],
  'Hip thrust': ['hip thrust', 'hipthrust', 'mostik s cinkou', 'hip-thrust'],
  'Výpady': ['lunges', 'lunge', 'vypady', 'vypady s jednoruckami', 'walking lunges', 'chuzove vypady'],
  'Bulharský dřep': ['bulgarian split squat', 'bulharsky drep', 'split squat', 'bss'],
  'Zakopávání': ['leg curl', 'hamstring curl', 'zakopavani', 'zakopavani na stroji', 'lying leg curl', 'seated leg curl'],
  'Předkopávání': ['leg extension', 'predkopavani', 'predkopavani na stroji', 'extenze kolen'],
  'Výpony': ['calf raise', 'calf raises', 'vypony', 'vypony na lytka', 'vypony ve stoje', 'standing calf raise'],
  'Kliky na bradlech': ['dips', 'dip', 'kliky na bradlech', 'bradla'],
  'Bicepsový zdvih': ['biceps curl', 'bicep curl', 'curl', 'bicepsovy zdvih', 'zdvihy na biceps', 'barbell curl', 'db curl', 'dumbbell curl'],
  'Kladivové zdvihy': ['hammer curl', 'hammer curls', 'kladivove zdvihy', 'kladiva'],
  'Stahování kladky na triceps': ['triceps pushdown', 'tricep pushdown', 'pushdown', 'stahovani kladky na triceps', 'tricepsove stahovani', 'rope pushdown'],
  'Francouzský tlak': ['skull crusher', 'skullcrusher', 'french press', 'francouzsky tlak', 'lying triceps extension'],
  'Upažování': ['lateral raise', 'lateral raises', 'side raise', 'upazovani', 'upazovani s jednoruckami', 'upazovani na kladce'],
  'Face pull': ['face pull', 'facepull', 'face pulls', 'pritahy lana k obliceji'],
  'Rozpažování': ['fly', 'flyes', 'chest fly', 'pec deck', 'rozpazovani', 'rozpazovani na stroji', 'cable fly', 'butterfly'],
  'Plank': ['plank', 'prkno', 'planking'],
  'Zvedání nohou ve visu': ['hanging leg raise', 'leg raise', 'zvedani nohou ve visu', 'zvedani nohou'],
};
const exStrip = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const EX_INDEX = (() => { const m = {}; for (const [canon, al] of Object.entries(EX_CATALOG)) { m[exStrip(canon)] = canon; m[exStrip(canon).replace(/ /g, '')] = canon; for (const a of al) { m[exStrip(a)] = canon; m[exStrip(a).replace(/ /g, '')] = canon; } } return m; })();
function canonEx(name) { const k = exStrip(name); return EX_INDEX[k] || EX_INDEX[k.replace(/ /g, '')] || String(name || '').trim(); }
const exKey = name => exStrip(canonEx(name)).replace(/ /g, '');


const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, weight REAL, waist REAL, note TEXT, photos TEXT, analysis TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, day_name TEXT, data TEXT, note TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, day TEXT, kind TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER)`,
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  schemaReady = true;
}

const now = () => new Date().toISOString();

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

function authed(req, env) {
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = env.APP_PASSWORD || '';
  if (!p || t.length !== p.length) return false;
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= t.charCodeAt(i) ^ p.charCodeAt(i);
  return d === 0;
}

async function getKV(env, k, def = null) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first();
  return r ? JSON.parse(r.v) : def;
}
async function setKV(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated')
    .bind(k, JSON.stringify(v), now()).run();
}
async function latestPlan(env) {
  const r = await env.DB.prepare('SELECT id,data,created FROM plans ORDER BY id DESC LIMIT 1').first();
  return r ? { id: r.id, created: r.created, ...JSON.parse(r.data) } : null;
}

// USD per million tokens — Anthropic price list (platform.claude.com/docs/en/about-claude/pricing), checked 2026-10-25
const PRICES = { 'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 } };
const usdOf = (m, i, o, cr = 0, cw = 0) => { const p = PRICES[m] || PRICES[MODEL]; return (i * p.input + o * p.output + cr * p.cache_read + cw * p.cache_write) / 1e6; };
async function logUsage(env, kind, model, u) {
  try {
    await env.DB.prepare('INSERT INTO usage (ts,day,kind,model,input,output,cache_read,cache_write) VALUES (?,?,?,?,?,?,?,?)')
      .bind(now(), new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' }), kind, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0).run();
  } catch (e) {}
}
async function callAI(env, system, messages, max_tokens = 3000, kind = 'chat') {
  const body = JSON.stringify({ model: MODEL, max_tokens, system, messages });
  // vlastní klíč Fitka (secret ANTHROPIC_API_KEY) má přednost; jinak přes Robůtkův Worker
  const res = env.ANTHROPIC_API_KEY
    ? await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body })
    : await env.AI_SVC.fetch('https://ai-svc/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': env.AI_KEY || '' }, body });
  const txt = await res.text();
  if (!res.ok) throw new Error('AI ' + res.status + ': ' + txt.slice(0, 300));
  const data = JSON.parse(txt);
  if (data.usage) await logUsage(env, kind, data.model || MODEL, data.usage);
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function photoBlocks(env, photos, label) {
  const out = [];
  for (const angle of ['front', 'side', 'back']) {
    const key = photos?.[angle];
    if (!key) continue;
    const { value, metadata } = await env.PHOTOS.getWithMetadata(key, 'arrayBuffer');
    if (!value) continue;
    out.push({ type: 'text', text: `${label} — ${({ front: 'zepředu', side: 'z boku', back: 'zezadu' })[angle]}:` });
    out.push({ type: 'image', source: { type: 'base64', media_type: metadata?.ct || 'image/jpeg', data: b64(value) } });
  }
  return out;
}

/* ---------- Ověřená znalostní báze (KB) — jediný povolený zdroj odborných tvrzení ----------
   Každé tvrzení ověřeno z primárního textu / oficiální stránky časopisu (rešerše 2026-10-25). */
const KB_SOURCES = {
  S1: { short: 'ACSM 2026', cite: 'Currier BS, D’Souza AC, Singh MAF, … Schoenfeld BJ, … Phillips SM. American College of Sports Medicine Position Stand. Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults: An Overview of Reviews. Med Sci Sports Exerc. 2026;58(4):851–872.', url: 'https://doi.org/10.1249/MSS.0000000000003897' },
  S2: { short: 'ACSM 2009', cite: 'American College of Sports Medicine. Position Stand: Progression Models in Resistance Training for Healthy Adults. Med Sci Sports Exerc. 2009 (březen). Nahrazeno ACSM 2026 tam, kde se liší.', url: 'https://www.sportgeneeskunde.com/wp-content/uploads/ACSM-Position-Stand-Progression-Models-in-Resistance-Training-for-Healthy-Adults.pdf' },
  S3: { short: 'Schoenfeld 2017', cite: 'Schoenfeld BJ, Ogborn D, Krieger JW. Dose-response relationship between weekly resistance training volume and increases in muscle mass: A systematic review and meta-analysis. J Sports Sci. 2017 (online 2016).', url: 'https://doi.org/10.1080/02640414.2016.1210197' },
  S4: { short: 'Morton 2018', cite: 'Morton RW, Murphy KT, McKellar SR, Schoenfeld BJ, Henselmans M, Helms E, Aragon AA, Devries MC, Banfield L, Krieger JW, Phillips SM. A systematic review, meta-analysis and meta-regression of the effect of protein supplementation on resistance training-induced gains in muscle mass and strength in healthy adults. Br J Sports Med. 2018;52(6):376.', url: 'https://bjsm.bmj.com/content/52/6/376' },
  S5: { short: 'ISSN 2017', cite: 'Jäger R, et al. International Society of Sports Nutrition Position Stand: protein and exercise. J Int Soc Sports Nutr. 2017;14:20.', url: 'https://doi.org/10.1186/s12970-017-0177-8' },
  S6: { short: 'Schumann 2022', cite: 'Schumann M, Feuerbacher JF, Sünkeler M, Freitag N, Rønnestad BR, Doma K, Lundberg TR. Compatibility of Concurrent Aerobic and Strength Training for Skeletal Muscle Size and Function: An Updated Systematic Review and Meta-Analysis. Sports Med. 2022;52:601–612.', url: 'https://doi.org/10.1007/s40279-021-01587-7' },
  S7: { short: 'Helms 2014', cite: 'Helms ER, Aragon AA, Fitschen PJ. Evidence-based recommendations for natural bodybuilding contest preparation: nutrition and supplementation. J Int Soc Sports Nutr. 2014;11:20.', url: 'https://doi.org/10.1186/1550-2783-11-20' },
};
const KB = [
  { id: 'K1', src: 'S1', t: 'Základ pro zdravé dospělé: trénovat všechny hlavní svalové skupiny aspoň 2× týdně s vysokým úsilím a postupně přidávat zátěž. Největší skok přináší přechod od žádného k jakémukoli silovému tréninku; konzistence je důležitější než dokonalost.' },
  { id: 'K2', src: 'S1', t: 'Síla: zátěž kolem ≥80 % 1RM (vztah dávka–odpověď) a 2–3 série na cvik; nad 2–3 série na cvik se přínos pro sílu oplošťuje. Frekvence 2+ tréninků týdně sílu zlepšuje (horní hranici nelze určit, efekt slábne při vyrovnaném objemu).' },
  { id: 'K3', src: 'S1', t: 'Hypertrofie: aspoň 10 sérií na svalovou skupinu týdně (vztah dávka–odpověď); meta-regrese citovaná v ACSM ukazuje klesající přínos zhruba u 18–20 sérií týdně. Kvalita důkazů pro objem a hypertrofii je střední (QoE 50 %).' },
  { id: 'K4', src: 'S1', t: 'Hypertrofie: zátěž od nízké (~30 % 1RM) po vysokou (~100 % 1RM) vede k podobnému růstu svalu, pokud je úsilí vysoké.' },
  { id: 'K5', src: 'S1', t: 'Trénink do svalového selhání není nutný – nezlepšil sílu, hypertrofii ani výbušnost. Pro hypertrofii ACSM navrhuje přibližně 2–3 opakování v rezervě (RIR), ale uvádí, že přesný cíl RIR nelze z důkazů kvantifikovat.' },
  { id: 'K6', src: 'S1', t: 'Frekvence: při stejném týdenním objemu nemá vyšší frekvence na hypertrofii vliv; rozložení sérií do více dní je tedy otázka praktičnosti.' },
  { id: 'K7', src: 'S1', t: 'Stroje vs. volné váhy: na sílu bez rozdílu (u hypertrofie nelze určit). Periodizace nebyla prokazatelně lepší než neperiodizovaný program s progresivním přetížením.' },
  { id: 'K8', src: 'S1', t: 'Plný rozsah pohybu zlepšuje sílu (u hypertrofie nelze určit). Těžší nebo prioritní cviky patří na začátek tréninku. Excentrický důraz/přetížení má pozitivní vliv na hypertrofii.' },
  { id: 'K9', src: 'S1', t: 'Pauzy mezi sériemi: krátké (<1 min) vs. delší (>1 min) neměly vliv na sílu; pro hypertrofii nelze vliv pauz určit (nízká kvalita důkazů).' },
  { id: 'K10', src: 'S2', t: 'Starší doporučení ACSM 2009: pauzy 3–5 min pro sílu (středně pokročilí a pokročilí) a 1–2 min pro hypertrofii; tempo 1–2 s v koncentrické i excentrické fázi. ACSM 2026 vliv pauz nepotvrdil, ber jako praktické vodítko.' },
  { id: 'K11', src: 'S2', t: 'Progrese zátěže (ACSM 2009): zvýšit zátěž o 2–10 %, když zvládneš současnou zátěž o 1–2 opakování nad cílový počet. ACSM 2026: progrese není nutná pro základní přínos, ale pro dlouhodobé zisky je progresivní přetížení potřeba.' },
  { id: 'K12', src: 'S2', t: 'ACSM 2009 podle úrovně: frekvence začátečník 2–3, středně pokročilý 3–4, pokročilý 4–5 dní týdně; hypertrofie zátěž 1–12 RM s důrazem na 6–12 RM ve více sériích; začátečník síla 8–12 RM.' },
  { id: 'K13', src: 'S3', t: 'Každá další týdenní série byla spojena s nárůstem svalu o ~0,37 %. Kategorie <5 / 5–9 / 10+ sérií týdně: ES 0,31 / 0,38 / 0,52 – trend mezi kategoriemi ale nebyl statisticky významný (p = 0,074) a po vyřazení jedné studie zeslábl; horní hranice nejasná (málo studií nad 12 sérií).' },
  { id: 'K14', src: 'S4', t: 'Bílkoviny: nad ~1,62 g/kg/den (95% CI 1,03–2,20) nebyl další přírůstek beztukové hmoty pozorován; kvůli širokému intervalu autoři pro maximální zisky navrhují až ~2,2 g/kg/den. Suplementace přidala v průměru +0,30 kg beztukové hmoty a +2,49 kg na 1RM.' },
  { id: 'K15', src: 'S5', t: 'ISSN: 1,4–2,0 g bílkovin/kg/den pro většinu cvičících; na porci ~0,25 g/kg nebo 20–40 g, rozložit rovnoměrně zhruba po 3–4 h; při kalorickém deficitu u trénovaných 2,3–3,1 g/kg/den.' },
  { id: 'K16', src: 'S6', t: 'Souběžný vytrvalostní trénink neomezoval hypertrofii ani maximální sílu; mírně tlumil explozivní sílu, a to hlavně když byly obě části v jednom tréninku do 20 min po sobě (při odstupu ≥3 h efekt nebyl).' },
  { id: 'K17', src: 'S7', t: 'Hubnutí se zachováním svalů (doporučení pro přírodní kulturisty): úbytek 0,5–1 % tělesné hmotnosti týdně; bílkoviny 2,3–3,1 g/kg beztukové hmoty, tuky 15–30 % energie, zbytek sacharidy.' },
];
const KB_PROMPT = `\n\n=== ZNALOSTNÍ BÁZE (jediný povolený zdroj odborných tvrzení) ===\n` +
  KB.map(k => `[${k.id}] (${KB_SOURCES[k.src].short}) ${k.t}`).join('\n') +
  `\n\nPRAVIDLA CITACÍ: Každé odborné tvrzení (objem, zátěž, opakování, pauzy, frekvence, progrese, bílkoviny, hubnutí, kombinace s vytrvalostí) MUSÍ vycházet ze znalostní báze a mít za sebou značku ve tvaru [K3] (můžeš i [K2][K11]). Nikdy neuváděj čísla ani studie, které v bázi nejsou, a nevymýšlej citace. Pokud k otázce báze nic nemá, napiš výslovně „k tomu nemám ověřený zdroj“ a případnou radu označ jako obecnou trenérskou praxi. Konkrétní volba cviků a jejich pořadí je trenérská praxe – citovat ji nemusíš. Kde se ACSM 2009 a 2026 liší, má přednost 2026.`;

const TRAINER_BASE = `Jsi "Fitko robůtek" — osobní live fitness trenér Mátyáse (plavecký trenér, chodí do plně vybavené posilovny). Piš česky, stručně, věcně, bez frází a bez emoji. Oslovuj tykáním.
Principy: progresivní přetížení, dostatečný týdenní objem na partii, technika a regenerace, rozumná frekvence. Když si nejsi jistý, řekni to.
Z fotek NEUVÁDĚJ procento tuku jako fakt — vizuální odhad z fotky je nepřesný; popisuj kvalitativní změny a ber ohled na rozdíly v osvětlení/pozici. Hlavní objektivní metriky: váha, obvod pasu, výkony v logu.
Nejsi lékař: při bolesti, zranění nebo zdravotním problému doporuč odborníka.` + KB_PROMPT;

const PLAN_FORMAT = `Když se domluvíte na novém nebo upraveném plánu, přidej na konec odpovědi PŘESNĚ jeden blok:
<plan>{"name":"...","goal":"...","days":[{"name":"A – Push","focus":"...","exercises":[{"name":"Bench press","sets":4,"reps":"6-8","rest":"2-3 min","note":"RIR 1-2"}]}],"progression":"pravidlo progrese","evidence":["K2","K3","K11"]}</plan>
Do "evidence" dej ID tvrzení ze znalostní báze, na kterých plán stojí.
Názvy cviků piš česky a vždy stejně (pokud cvik už je v plánu nebo historii, použij přesně ten název) – appka podle názvu páruje historii a rekordy. Bez bloku <plan>, pokud plán neměníš. Když se dozvíš trvalé info o uživateli (cíl, výška, věk, zkušenosti, zranění, počet dní v týdnu, délka tréninku), přidej blok <profile>{"klic":"hodnota"}</profile> jen se změněnými položkami. Bloky se uživateli nezobrazují.`;

async function buildContext(env) {
  const profile = await getKV(env, 'profile', {});
  const plan = await latestPlan(env);
  const checkins = (await env.DB.prepare('SELECT date,weight,waist,note,analysis FROM checkins ORDER BY date DESC, id DESC LIMIT 4').all()).results;
  const workouts = (await env.DB.prepare('SELECT date,day_name,data,note FROM workouts ORDER BY date DESC, id DESC LIMIT 12').all()).results;
  const memory = await getKV(env, 'memory', '');
  let ctx = `\n\n=== PROFIL ===\n${JSON.stringify(profile)}`;
  if (memory) ctx += `\n\n=== DLOUHODOBÁ PAMĚŤ (co víš o uživateli z dřívějších rozhovorů) ===\n${memory}`;
  ctx += `\n\n=== AKTUÁLNÍ PLÁN ===\n${plan ? JSON.stringify({ name: plan.name, goal: plan.goal, days: plan.days, progression: plan.progression }) : 'zatím žádný'}`;
  ctx += `\n\n=== CHECK-INY (nejnovější první) ===\n` + (checkins.length ? checkins.map(c => `${c.date}: váha ${c.weight ?? '-'} kg, pas ${c.waist ?? '-'} cm${c.note ? ', pozn: ' + c.note : ''}${c.analysis ? '\nAnalýza: ' + c.analysis.slice(0, 1200) : ''}`).join('\n\n') : 'žádné');
  ctx += `\n\n=== POSLEDNÍ TRÉNINKY ===\n` + (workouts.length ? workouts.map(w => `${w.date} ${w.day_name || ''}: ${compactWorkout(w.data)}${w.note ? ' | ' + w.note : ''}`).join('\n') : 'žádné');
  ctx += `\n\nDnešní datum: ${new Date().toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' })}`;
  return { ctx, profile };
}
function compactWorkout(data) {
  try {
    return JSON.parse(data).map(e => `${e.name} ${e.sets.filter(s => s.reps).map(s => `${s.kg ?? 0}×${s.reps}`).join(',')}`).join('; ');
  } catch { return ''; }
}

async function extractBlocks(env, text) {
  let clean = text;
  let planSaved = null;
  const pm = text.match(/<plan>([\s\S]*?)<\/plan>/);
  if (pm) {
    clean = clean.replace(pm[0], '');
    try {
      const plan = JSON.parse(pm[1].trim());
      if (Array.isArray(plan.days)) {
        plan.days.forEach(d => (d.exercises || []).forEach(e => { e.name = canonEx(e.name); }));
        await env.DB.prepare('INSERT INTO plans (data,created) VALUES (?,?)').bind(JSON.stringify(plan), now()).run();
        planSaved = plan.name || true;
      }
    } catch {}
  }
  const fm = text.match(/<profile>([\s\S]*?)<\/profile>/);
  if (fm) {
    clean = clean.replace(fm[0], '');
    try {
      const upd = JSON.parse(fm[1].trim());
      const p = await getKV(env, 'profile', {});
      await setKV(env, 'profile', { ...p, ...upd });
    } catch {}
  }
  return { clean: clean.trim(), planSaved };
}

async function handleChat(req, env) {
  const { message } = await req.json();
  if (!message || !message.trim()) return json(req, { error: 'empty' }, 400);
  await env.DB.prepare('INSERT INTO chat (role,content,created) VALUES (?,?,?)').bind('user', message.trim(), now()).run();
  const hist = (await env.DB.prepare('SELECT role,content FROM chat ORDER BY id DESC LIMIT 24').all()).results.reverse();
  // Anthropic needs alternating roles starting with user
  const msgs = [];
  for (const m of hist) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n\n' + m.content;
    else msgs.push({ role, content: m.content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const { ctx, profile } = await buildContext(env);
  const onboarding = !profile || Object.keys(profile).length < 3
    ? '\n\nProfil je skoro prázdný: nejdřív se krátce doptej na cíl, věk, výšku, zkušenosti s posilovnou, zranění, počet tréninků týdně a délku tréninku (max 3 otázky naráz). Plán navrhni až budeš mít dost informací.'
    : '';
  const reply = await callAI(env, TRAINER_BASE + '\n\n' + PLAN_FORMAT + onboarding + ctx, msgs);
  const { clean, planSaved } = await extractBlocks(env, reply);
  await env.DB.prepare('INSERT INTO chat (role,content,created) VALUES (?,?,?)').bind('assistant', clean, now()).run();
  const cnt = await env.DB.prepare("SELECT COUNT(*) n FROM chat WHERE role='user'").first();
  if (cnt && cnt.n % 6 === 0) { try { await updateMemory(env); } catch (e) {} }
  return json(req, { reply: clean, planSaved });
}

async function handleCheckin(req, env) {
  const fd = await req.formData();
  const date = fd.get('date') || now().slice(0, 10);
  const weight = fd.get('weight') ? parseFloat(fd.get('weight')) : null;
  const waist = fd.get('waist') ? parseFloat(fd.get('waist')) : null;
  const note = fd.get('note') || '';
  const photos = {};
  const stamp = Date.now();
  for (const angle of ['front', 'side', 'back']) {
    const f = fd.get(angle);
    if (f && typeof f === 'object' && f.size) {
      if (f.size > 8 * 1024 * 1024) return json(req, { error: 'Fotka je moc velká' }, 413);
      const key = `checkins/${date}/${stamp}-${angle}.jpg`;
      await env.PHOTOS.put(key, await f.arrayBuffer(), { metadata: { ct: f.type || 'image/jpeg' } });
      photos[angle] = key;
    }
  }
  const ins = await env.DB.prepare('INSERT INTO checkins (date,weight,waist,note,photos,created) VALUES (?,?,?,?,?,?) RETURNING id')
    .bind(date, weight, waist, note, JSON.stringify(photos), now()).first();
  const id = ins.id;

  let analysis = null, error = null;
  if (Object.keys(photos).length) {
    try {
      const prev = await env.DB.prepare('SELECT date,weight,waist,photos FROM checkins WHERE id<>? AND photos<>? ORDER BY date DESC, id DESC LIMIT 1')
        .bind(id, '{}').first();
      const first = await env.DB.prepare('SELECT date,weight,waist,photos FROM checkins WHERE id<>? AND photos<>? ORDER BY date ASC, id ASC LIMIT 1')
        .bind(id, '{}').first();
      const content = [];
      content.push(...await photoBlocks(env, photos, `AKTUÁLNÍ check-in ${date} (váha ${weight ?? '-'} kg, pas ${waist ?? '-'} cm)`));
      if (prev) content.push(...await photoBlocks(env, JSON.parse(prev.photos), `PŘEDCHOZÍ check-in ${prev.date} (váha ${prev.weight ?? '-'} kg, pas ${prev.waist ?? '-'} cm)`));
      if (first && prev && first.date !== prev.date) content.push({ type: 'text', text: `První check-in byl ${first.date}: váha ${first.weight ?? '-'} kg, pas ${first.waist ?? '-'} cm.` });
      content.push({ type: 'text', text: `Poznámka: ${note || '-'}\n\nUdělej check-in analýzu: 1) co je vidět (postava, svalové partie, držení těla), 2) ${prev ? 'změny oproti předchozímu check-inu' : 'výchozí stav — první check-in'}, 3) slabé partie a co v plánu posílit/upravit, 4) zhodnocení váhy a pasu. Max ~250 slov, bez Markdown nadpisů. Pokud fotky nejsou srovnatelné (světlo, poloha, vzdálenost), řekni to.` });
      const { ctx } = await buildContext(env);
      analysis = await callAI(env, TRAINER_BASE + ctx, [{ role: 'user', content }], 1500, 'checkin');
      analysis = analysis.replace(/<plan>[\s\S]*?<\/plan>|<profile>[\s\S]*?<\/profile>/g, '').trim();
      await env.DB.prepare('UPDATE checkins SET analysis=? WHERE id=?').bind(analysis, id).run();
      await env.DB.prepare('INSERT INTO chat (role,content,created) VALUES (?,?,?)').bind('assistant', `📸 Check-in ${date}\n\n${analysis}`, now()).run();
    } catch (e) { error = String(e.message || e); }
  }
  return json(req, { id, photos, analysis, error });
}

/* ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID), WebCrypto only ---------- */
const b64uEnc = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64uDec = str => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const p = s + '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(p), c => c.charCodeAt(0)); };
const te = new TextEncoder();
const concat = (...arrs) => { const n = arrs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of arrs) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uEnc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEnc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:fitko@example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64uEnc(sig)}, k=${env.VAPID_PUBLIC}`;
}
async function encryptPayload(sub, payload) {
  const uaPub = b64uDec(sub.p256dh), auth = b64uDec(sub.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, data) {
  const body = await encryptPayload(sub, JSON.stringify(data));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Authorization': await vapidAuth(sub.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '86400', 'Urgency': 'normal' },
    body,
  });
  return res.status;
}

const pragueDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
async function pushAll(env, data) {
  const subs = (await env.DB.prepare('SELECT endpoint,p256dh,auth FROM push_subs').all()).results;
  const out = [];
  for (const sub of subs) {
    try {
      const st = await sendPush(env, sub, data);
      if (st === 404 || st === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(sub.endpoint).run();
      out.push(st);
    } catch (e) { out.push('ERR ' + String(e.message || e).slice(0, 80)); }
  }
  return out;
}
const NAG = {
  sad: ['Chybíš mi v posilovně.', 'Dnes by to chtělo trénink, ne?', 'Činky jsou smutné. Já taky.'],
  angry: ['Myslíš, že se svaly postaví samy?', 'Gauč není cvik.', 'Ozvi se, nebo přidám přítahy navíc.', 'Tvoje činky volaly. Prý jsi nezvedal.'],
};
async function attendanceInfo(env) {
  const profile = await getKV(env, 'profile', {});
  const n = parseInt((String(profile.dni_tydne || '').match(/\d+/) || [])[0]) || 3;
  const allowed = Math.ceil(7 / n);
  const last = await env.DB.prepare('SELECT date FROM workouts ORDER BY date DESC LIMIT 1').first();
  if (!last) return { level: 'none', n };
  const gap = Math.round((new Date(pragueDate()) - new Date(last.date)) / 864e5);
  return { gap, n, allowed, level: gap <= allowed ? 'ok' : gap <= allowed + 2 ? 'sad' : 'angry' };
}
async function dailyNag(env, force = false) {
  const a = await attendanceInfo(env);
  if (a.level !== 'sad' && a.level !== 'angry') return { skipped: a.level };
  const today = pragueDate();
  if (!force && (await getKV(env, 'last_nag')) === today) return { skipped: 'already' };
  const pick = NAG[a.level][Math.floor(Math.random() * NAG[a.level].length)];
  const title = a.level === 'angry' ? `Bráška je naštvaný (${a.gap} dní bez tréninku)` : `Bráška se ptá, kde jsi`;
  const res = await pushAll(env, { title, body: pick, tag: 'nag', url: './?v=log' });
  await setKV(env, 'last_nag', today);
  return { sent: res, level: a.level };
}
const e1rm = (kg, reps) => (+kg || 0) * (1 + (+reps || 0) / 30);
async function weeklySummary(env, push = true) {
  const today = pragueDate();
  const from = new Date(today); from.setDate(from.getDate() - 6);
  const fromS = from.toISOString().slice(0, 10);
  const all = (await env.DB.prepare('SELECT date,day_name,data,note FROM workouts ORDER BY date ASC').all()).results.map(w => ({ ...w, data: JSON.parse(w.data || '[]') }));
  const week = all.filter(w => w.date >= fromS), before = all.filter(w => w.date < fromS);
  const bestBefore = {};
  for (const w of before) for (const e of w.data) for (const s of e.sets) if (s.reps) bestBefore[exKey(e.name)] = Math.max(bestBefore[exKey(e.name)] || 0, e1rm(s.kg, s.reps));
  const prs = [], perEx = {};
  let vol = 0, sets = 0;
  for (const w of week) for (const e of w.data) for (const s of e.sets) {
    vol += (+s.kg || 0) * (+s.reps || 0); sets++;
    const v = e1rm(s.kg, s.reps);
    const ek = exKey(e.name);
    if (s.reps && bestBefore[ek] && v > bestBefore[ek] + .01 && (!perEx[ek] || v > perEx[ek].v)) perEx[ek] = { v, kg: s.kg, reps: s.reps, name: canonEx(e.name) };
  }
  for (const [, x] of Object.entries(perEx)) prs.push(`${x.name} ${x.kg}×${x.reps} (e1RM ${x.v.toFixed(1)} kg)`);
  const ck = (await env.DB.prepare('SELECT date,weight,waist FROM checkins WHERE weight IS NOT NULL ORDER BY date DESC LIMIT 2').all()).results;
  const profile = await getKV(env, 'profile', {});
  const n = parseInt((String(profile.dni_tydne || '').match(/\d+/) || [])[0]) || 3;
  const stats = `Období ${fromS} až ${today}. Tréninků: ${week.length} (cíl ${n}). Sérií: ${sets}. Objem: ${Math.round(vol)} kg.
Tréninky: ${week.map(w => w.date + ' ' + (w.day_name || '')).join('; ') || 'žádné'}.
Nové rekordy (e1RM, Epley): ${prs.join('; ') || 'žádné'}.
Váha: ${ck.length ? ck.map(c => `${c.date} ${c.weight} kg${c.waist ? ', pas ' + c.waist + ' cm' : ''}`).join(' | ') : 'bez dat'}.
Poznámky z tréninků: ${week.map(w => w.note).filter(Boolean).join(' | ') || '-'}.`;
  const { ctx } = await buildContext(env);
  const text = (await callAI(env, TRAINER_BASE + ctx, [{ role: 'user', content: `Napiš týdenní souhrn (max ~150 slov, bez Markdown nadpisů): 1) jak dopadl týden vs. cíl, 2) rekordy a pokrok, 3) jedna až dvě konkrétní úpravy na příští týden. Použij jen tato data, nic si nevymýšlej:\n${stats}` }], 900, 'summary'))
    .replace(/<plan>[\s\S]*?<\/plan>|<profile>[\s\S]*?<\/profile>/g, '').trim();
  await env.DB.prepare('INSERT INTO chat (role,content,created) VALUES (?,?,?)').bind('assistant', `🗓️ Týdenní souhrn (${fromS.slice(5).split('-').reverse().join('.')}–${today.slice(5).split('-').reverse().join('.')})\n\n${text}`, now()).run();
  await setKV(env, 'last_summary', { date: today, text });
  let sent = null;
  if (push) sent = await pushAll(env, { title: `Týdenní souhrn: ${week.length}/${n} tréninků${prs.length ? ', ' + prs.length + '× rekord' : ''}`, body: text.slice(0, 140), tag: 'summary', url: './' });
  return { text, sent, stats };
}

async function updateMemory(env) {
  const old = await getKV(env, 'memory', '');
  const hist = (await env.DB.prepare('SELECT role,content FROM chat ORDER BY id DESC LIMIT 16').all()).results.reverse();
  const convo = hist.map(m => (m.role === 'user' ? 'Uživatel: ' : 'Trenér: ') + m.content.slice(0, 800)).join('\n');
  const prompt = `Aktualizuj dlouhodobou paměť trenéra o uživateli. Současná paměť:\n${old || '(prázdná)'}\n\nNová konverzace:\n${convo}\n\nVrať POUZE aktualizovaný seznam odrážek (max 15, každá max ~20 slov) s trvalými fakty: cíle, dohody o plánu, preference a cviky, které nechce, omezení/zranění (jen co uživatel řekl), rozvrh a vybavení, důležité milníky. Nic si nedomýšlej, zastaralé informace přepiš, nepiš dočasné věci. Bez úvodu a závěru.`;
  const txt = (await callAI(env, 'Jsi pečlivý zapisovatel. Píšeš česky, stručně, jen fakta z konverzace.', [{ role: 'user', content: prompt }], 700, 'memory')).trim();
  if (txt) await setKV(env, 'memory', txt.slice(0, 3000));
  return txt;
}
async function exportAll(env) {
  const q = async sql => (await env.DB.prepare(sql).all()).results;
  return {
    app: 'fitko-robutek', exported: now(), version: 1,
    profile: await getKV(env, 'profile', {}), memory: await getKV(env, 'memory', ''),
    plans: (await q('SELECT id,data,created FROM plans ORDER BY id')).map(r => ({ ...r, data: JSON.parse(r.data) })),
    workouts: (await q('SELECT id,date,day_name,data,note,created FROM workouts ORDER BY date,id')).map(r => ({ ...r, data: JSON.parse(r.data || '[]') })),
    checkins: (await q('SELECT id,date,weight,waist,note,photos,analysis,created FROM checkins ORDER BY date,id')).map(r => ({ ...r, photos: JSON.parse(r.photos || '{}') })),
    chat: await q('SELECT role,content,created FROM chat ORDER BY id'),
    usage: await q('SELECT day,kind,model,SUM(input) input,SUM(output) output,COUNT(*) calls FROM usage GROUP BY day,kind,model ORDER BY day'),
  };
}
async function autoBackup(env) {
  const data = await exportAll(env);
  const key = 'backup/' + new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' }) + '.json';
  await env.PHOTOS.put(key, JSON.stringify(data), { metadata: { ct: 'application/json' } });
  const list = await env.PHOTOS.list({ prefix: 'backup/' });
  const keys = list.keys.map(k => k.name).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 8))) await env.PHOTOS.delete(k);
  return key;
}

async function usageReport(env) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
  const month = today.slice(0, 7);
  const since = new Date(today); since.setDate(since.getDate() - 29); const sinceS = since.toISOString().slice(0, 10);
  const rows = (await env.DB.prepare('SELECT day,kind,model,SUM(input) i,SUM(output) o,SUM(cache_read) cr,SUM(cache_write) cw,COUNT(*) n FROM usage WHERE day>=? OR day LIKE ? GROUP BY day,kind,model').bind(sinceS, month + '%').all()).results;
  const agg = f => rows.filter(f).reduce((a, r) => ({ calls: a.calls + r.n, input: a.input + r.i, output: a.output + r.o, usd: a.usd + usdOf(r.model, r.i, r.o, r.cr, r.cw) }), { calls: 0, input: 0, output: 0, usd: 0 });
  const days = []; for (let i = 0; i < 30; i++) { const d = new Date(sinceS); d.setDate(d.getDate() + i); const k = d.toISOString().slice(0, 10); days.push({ day: k, ...agg(r => r.day === k) }); }
  const kinds = ['chat', 'checkin', 'swap', 'summary', 'memory'].map(k => ({ kind: k, ...agg(r => r.day.startsWith(month) && r.kind === k) }));
  const all = await env.DB.prepare('SELECT SUM(input) i,SUM(output) o,COUNT(*) n,MIN(day) first FROM usage').first();
  const mt = agg(r => r.day.startsWith(month));
  const dim = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate(), dom = +today.slice(8, 10);
  return { prices: PRICES[MODEL], model: MODEL, today: agg(r => r.day === today), month: mt, forecast: mt.usd / dom * dim, days, kinds, total: { calls: all?.n || 0, since: all?.first || null }, budget: await getKV(env, 'budget_usd') };
}

async function handleSwap(req, env) {
  const { exercise, day_name, reason, current } = await req.json();
  if (!exercise) return json(req, { error: 'chybí cvik' }, 400);
  const { ctx } = await buildContext(env);
  const prompt = `Uživatel dnes nechce/nemůže cvičit "${exercise.name}" (${exercise.sets || '?'}× ${exercise.reps || '?'}) v tréninku "${day_name || '-'}".
Důvod: ${reason || 'neuveden'}.
Ostatní cviky v tomto tréninku: ${(current || []).filter(n => n !== exercise.name).join(', ') || '-'}.
Navrhni 3 náhrady do plně vybavené posilovny, které cílí na stejné svaly/pohybový vzor, respektují důvod (bolest → šetrnější varianta, obsazený stroj → jiné vybavení) a neduplikují ostatní cviky.
Odpověz POUZE JSON polem bez dalšího textu: [{"name":"...","sets":3,"reps":"8-10","rest":"2 min","note":"krátký tip k technice","why":"proč je to vhodná náhrada (1 věta)"}]`;
  const txt = await callAI(env, TRAINER_BASE + ctx, [{ role: 'user', content: prompt }], 1000, 'swap');
  const mm = txt.match(/\[[\s\S]*\]/);
  let options = [];
  try { options = JSON.parse(mm ? mm[0] : txt); } catch { return json(req, { error: 'AI vrátila neplatný formát', raw: txt.slice(0, 300) }, 502); }
  return json(req, { options: options.slice(0, 3) });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      if (/SUN|\* 1$|\* 7$/.test(event.cron) && !/\* \* \* \*$/.test(event.cron)) { await weeklySummary(env, true); await autoBackup(env); }
      else await dailyNag(env);
    })());
  },
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/health') return json(req, { ok: true, app: 'fitko-robutek' });
    if (!authed(req, env)) return json(req, { error: 'unauthorized' }, 401);
    try {
      await ensureSchema(env);
      if (p === '/state' && req.method === 'GET') {
        const profile = await getKV(env, 'profile', {});
        const plan = await latestPlan(env);
        const checkins = (await env.DB.prepare('SELECT id,date,weight,waist,note,photos,analysis FROM checkins ORDER BY date DESC, id DESC LIMIT 50').all()).results
          .map(c => ({ ...c, photos: JSON.parse(c.photos || '{}') }));
        const workouts = (await env.DB.prepare('SELECT id,date,day_name,data,note FROM workouts ORDER BY date DESC, id DESC LIMIT 60').all()).results
          .map(w => ({ ...w, data: JSON.parse(w.data || '[]') }));
        const chat = (await env.DB.prepare('SELECT id,role,content,created FROM chat ORDER BY id DESC LIMIT 80').all()).results.reverse();
        const mu = await env.DB.prepare('SELECT model,SUM(input) i,SUM(output) o,SUM(cache_read) cr,SUM(cache_write) cw FROM usage WHERE day LIKE ? GROUP BY model').bind(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' }).slice(0, 7) + '%').all();
        const usage = { monthUsd: mu.results.reduce((a, r) => a + usdOf(r.model, r.i, r.o, r.cr, r.cw), 0), budget: await getKV(env, 'budget_usd') };
        return json(req, { profile, plan, checkins, workouts, chat, usage });
      }
      if (p === '/profile' && req.method === 'PUT') {
        const body = await req.json();
        await setKV(env, 'profile', body);
        return json(req, { ok: true });
      }
      if (p === '/chat' && req.method === 'POST') return await handleChat(req, env);
      if (p === '/chat' && req.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM chat').run();
        return json(req, { ok: true });
      }
      if (p === '/checkin' && req.method === 'POST') return await handleCheckin(req, env);
      if (p === '/swap' && req.method === 'POST') return await handleSwap(req, env);
      if (p === '/push/subscribe' && req.method === 'POST') {
        const { subscription: sb } = await req.json();
        if (!sb?.endpoint || !sb?.keys?.p256dh || !sb?.keys?.auth) return json(req, { error: 'bad subscription' }, 400);
        await env.DB.prepare('INSERT INTO push_subs (endpoint,p256dh,auth,created) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth')
          .bind(sb.endpoint, sb.keys.p256dh, sb.keys.auth, now()).run();
        return json(req, { ok: true });
      }
      if (p === '/push/unsubscribe' && req.method === 'POST') {
        const { endpoint } = await req.json();
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(endpoint || '').run();
        return json(req, { ok: true });
      }
      if (p === '/push/test' && req.method === 'POST') {
        return json(req, { sent: await pushAll(env, { title: 'Bráška tě zdraví 💪', body: 'Upozornění fungují. Teď hurá do posilovny.', tag: 'test', url: './' }) });
      }
      if (p === '/export' && req.method === 'GET') return json(req, await exportAll(env));
      if (p === '/backups' && req.method === 'GET') { const l = await env.PHOTOS.list({ prefix: 'backup/' }); return json(req, { backups: l.keys.map(k => k.name).sort().reverse() }); }
      if (p === '/backup/now' && req.method === 'POST') return json(req, { key: await autoBackup(env) });
      if (p.startsWith('/backup/') && req.method === 'GET') { const { value } = await env.PHOTOS.getWithMetadata('backup/' + decodeURIComponent(p.slice(8)), 'text'); return value ? new Response(value, { headers: { 'Content-Type': 'application/json', ...cors(req) } }) : json(req, { error: 'not found' }, 404); }
      if (p === '/memory' && req.method === 'GET') return json(req, { memory: await getKV(env, 'memory', ''), route: env.ANTHROPIC_API_KEY ? 'own-key' : 'robutek' });
      if (p === '/memory' && req.method === 'PUT') { const { memory } = await req.json(); await setKV(env, 'memory', String(memory || '').slice(0, 3000)); return json(req, { ok: true }); }
      if (p === '/memory/refresh' && req.method === 'POST') return json(req, { memory: await updateMemory(env) });
      if (p === '/kb' && req.method === 'GET') return json(req, { sources: KB_SOURCES, items: KB });
      if (p === '/usage' && req.method === 'GET') return json(req, await usageReport(env));
      if (p === '/usage/budget' && req.method === 'PUT') { const { usd } = await req.json(); await setKV(env, 'budget_usd', usd ? +usd : null); return json(req, { ok: true }); }
      if (p === '/push/nag' && req.method === 'POST') return json(req, await dailyNag(env, true));
      if (p === '/summary' && req.method === 'POST') { const r = await weeklySummary(env, false); return json(req, { text: r.text }); }
      let m;
      if ((m = p.match(/^\/checkin\/(\d+)$/)) && req.method === 'DELETE') {
        const c = await env.DB.prepare('SELECT photos FROM checkins WHERE id=?').bind(+m[1]).first();
        if (c) for (const k of Object.values(JSON.parse(c.photos || '{}'))) await env.PHOTOS.delete(k);
        await env.DB.prepare('DELETE FROM checkins WHERE id=?').bind(+m[1]).run();
        return json(req, { ok: true });
      }
      if (p.startsWith('/photo/') && req.method === 'GET') {
        const key = decodeURIComponent(p.slice(7));
        const { value, metadata } = await env.PHOTOS.getWithMetadata(key, 'arrayBuffer');
        if (!value) return json(req, { error: 'not found' }, 404);
        return new Response(value, { headers: { 'Content-Type': metadata?.ct || 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...cors(req) } });
      }
      if (p === '/workout' && req.method === 'POST') {
        const w = await req.json();
        (w.exercises || []).forEach(e => { e.name = canonEx(e.name); });
        const r = await env.DB.prepare('INSERT INTO workouts (date,day_name,data,note,created) VALUES (?,?,?,?,?) RETURNING id')
          .bind(w.date || now().slice(0, 10), w.day_name || '', JSON.stringify(w.exercises || []), w.note || '', now()).first();
        return json(req, { id: r.id });
      }
      if ((m = p.match(/^\/workout\/(\d+)$/)) && req.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM workouts WHERE id=?').bind(+m[1]).run();
        return json(req, { ok: true });
      }
      if (p === '/plan' && req.method === 'PUT') {
        const plan = await req.json();
        await env.DB.prepare('INSERT INTO plans (data,created) VALUES (?,?)').bind(JSON.stringify(plan), now()).run();
        return json(req, { ok: true });
      }
      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: String(e.message || e) }, 500);
    }
  },
};
