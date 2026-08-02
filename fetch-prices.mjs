#!/usr/bin/env node
/**
 * fetch-prices.mjs — hämtar dagens Kaliber Original-priser och skriver prices.json.
 *
 * Kör:
 *   node fetch-prices.mjs            → hämtar allt, skriver prices.json, loggar en tabell
 *   node fetch-prices.mjs --dry-run  → hämtar allt men skriver ingen fil
 *   node fetch-prices.mjs --quiet    → bara sammanfattning
 *
 * Node 24, noll npm-beroenden. Nätverk via `curl` (finns på ubuntu-latest och macOS).
 *
 * SÄKERHET: läser BARA öppna produktsidor + Shopifys publika `.js`-produkt-endpoint.
 * Extraherar aldrig nycklar ur sajters JavaScript och frågar aldrig någon backend/databas.
 * Butiker vars pris inte går att läsa ur den öppna sidan utelämnas (retailers.json → excluded).
 *
 * ROBUSTHET: skriver aldrig över en fungerande prices.json med skräp. Tappar körningen
 * för många butiker jämfört med förra gången behålls föregående fil och ett
 * `stale_warning` sätts. Exit-kod är alltid 0 så att säkra priser hinner committas —
 * workflow-steget fäller sedan bygget om `alarm`-utdatan är satt, vilket får GitHub att
 * mejla repo-ägaren. Larmet går bara vid verkliga haverier: för få butiker, ankarbutiken
 * oläsbar, eller ett pris som hoppat mer än 40 % (troligen felavläst → publiceras inte).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pexec = promisify(execFile)
const DIR = dirname(fileURLToPath(import.meta.url))
const REGISTRY = join(DIR, 'retailers.json')
const OUTFILE = join(DIR, 'prices.json')

// --- affärsregler -----------------------------------------------------------
// Beställs i 10, 20 eller 30 dosor. ALDRIG 50 — tobaken hinner torka först.
// 50 får sparas i prisstegen (framtida bruk) men beräknas ALDRIG som köpalternativ.
const QUANTITIES = [10, 20, 30]
const MAX_CANS = 30            // absolut tak: fler dosor än så beställs aldrig
const MIN_TRUSTED = 3          // absolut golv
const KEEP_RATIO = 0.7         // ...och minst 70 % av förra körningens butiker
const HEARTBEAT_MS = 72 * 3600 * 1000 // ny fetched_at-stämpel även om priserna står still

// --- larmtrösklar -----------------------------------------------------------
// Ett larm som tjuter för ofta slutar man läsa. Enstaka butiker som strular är
// normalt och ska vara tyst; det här är de tre lägen där något faktiskt är sönder.
const ANCHOR_DOMAIN = 'snuslagret.se'  // butiken beställningen brukar landa på — faller den är
                                       // rekommendationen värdelös även om tio andra svarar
const DRIFT_LIMIT = 0.40               // >40 % prisrörelse = nästan alltid fel avläst siffra,
                                       // inte en verklig prisändring. Publicera inte den.
const HEALTHFILE = join(DIR, '.health')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const CONCURRENCY = 6
const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const QUIET = args.includes('--quiet')

const log = (...a) => { if (!QUIET) console.log(...a) }
const round = n => Math.round(n * 100) / 100
const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- nätverk ----------------------------------------------------------------
// `--` sist gör att en URL aldrig kan tolkas som en curl-flagga.
// `-w '\n%{http_code}'` gör att en 404/500/bot-vägg kan skiljas från en riktig
// produktsida — annars rapporteras "ingen läsbar prisstege" när sanningen är
// "URL:en har flyttat", och det är skillnaden mellan ett åtgärdbart fel och brus.
async function fetchUrl(url) {
  let last = { status: 0, body: '' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await pexec('curl', [
        '-sL', '--compressed', '--max-time', '30',
        '-A', UA, '-H', 'Accept-Language: sv-SE,sv;q=0.9',
        '-w', '\n%{http_code}',
        '--', url,
      ], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
      const cut = stdout.lastIndexOf('\n')
      const status = Number(stdout.slice(cut + 1).trim()) || 0
      const body = cut >= 0 ? stdout.slice(0, cut) : ''
      last = { status, body }
      if (status === 200 && body.length > 200) return last
    } catch { /* nätverksfel → retry */ }
    if (attempt === 0) await sleep(700)
  }
  return last
}

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (e) { out[i] = { _crash: String(e && e.message || e) } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// --- parsning ---------------------------------------------------------------
const deent = s => String(s)
  .replace(/&quot;/g, '"').replace(/&#0?34;/g, '"')
  .replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;|&#160;|&#xA0;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

/** "10-pack" / "30-p" / "1 dosa" / "stock" → antal dosor */
function qtyFromLabel(label) {
  const l = String(label).toLowerCase()
  const m = l.match(/(\d+)\s*[-\s]?(?:pack|p\b|st\b|dos|x\b)/)
  if (m) return Number(m[1])
  if (/\b(dosa|stock|1-?p|1\s*st|styck)\b/.test(l) && !/\d/.test(l)) return 1
  const n = l.match(/\d+/)
  return n ? Number(n[0]) : null
}

/** Rimlighetsfilter — skyddar mot att ett sidopris (frakt, kampanj, annan vara) glider in. */
function plausible(qty, total) {
  if (!Number.isFinite(qty) || !Number.isFinite(total)) return false
  if (qty < 1 || qty > 120) return false
  if (total < 10 || total > 6000) return false
  const perCan = total / qty
  return perCan >= 8 && perCan <= 200
}

/** Slår ihop dubbletter: samma paketstorlek → behåll billigaste. */
function normalizeLadder(rows) {
  const byQty = new Map()
  for (const r of rows || []) {
    if (!plausible(r.qty, r.total)) continue
    const prev = byQty.get(r.qty)
    if (prev === undefined || r.total < prev) byQty.set(r.qty, r.total)
  }
  return [...byQty.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([qty, total]) => ({ qty, total: round(total) }))
}

/** WooCommerce: variationerna ligger inbakade i produktformuläret. */
function fromWoo(html) {
  const m = html.match(/data-product_variations=(["'])([\s\S]*?)\1/)
  if (!m) return null
  let arr
  try { arr = JSON.parse(deent(m[2])) } catch { return null }
  if (!Array.isArray(arr)) return null // Woo skickar `false` när variationerna lazy-laddas
  const out = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const label = Object.values(v.attributes || {}).join(' ')
    const qty = qtyFromLabel(label)
    const price = Number(v.display_price)
    if (qty && price > 0 && v.is_in_stock !== false) out.push({ qty, total: price })
  }
  return out.length ? out : null
}

/** Shopify: `<produkt-url>.js` är en publik produkt-endpoint, ingen backend-sondering. */
async function fromShopify(url) {
  const base = url.split(/[?#]/)[0].replace(/\/$/, '')
  const { status, body: js } = await fetchUrl(base + '.js')
  if (status !== 200 || !js || js.trimStart()[0] !== '{') return null
  let data
  try { data = JSON.parse(js) } catch { return null }
  const out = []
  for (const v of data.variants || []) {
    const qty = qtyFromLabel(v.title || v.public_title || '')
    const price = Number(v.price) / 100
    if (qty && price > 0 && v.available !== false) out.push({ qty, total: price })
  }
  return out.length ? out : null
}

/** JSON-LD ger nästan alltid ETT pris utan paketkontext → aldrig betrott, bara en markering. */
function fromJsonLd(html) {
  const out = []
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html))) {
    let data
    try { data = JSON.parse(deent(m[1].trim())) } catch { continue }
    const nodes = data['@graph'] || (Array.isArray(data) ? data : [data])
    for (const n of nodes) {
      if (!n || n['@type'] !== 'Product') continue
      for (const o of [].concat(n.offers || [])) {
        const p = Number(o.price ?? o.lowPrice)
        if (p > 0) out.push(round(p))
      }
    }
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null
}

// --- fel-vara-vakt ----------------------------------------------------------
/**
 * En butik som lägger om sin URL kan låta den gamla länken redirecta till
 * Kaliber Original *White*, *Slim* eller lös — och då skulle en annan varas
 * prisstege skrivas in som vår, med färsk tidsstämpel och utan minsta antydan.
 * Titeln (och og:title) är den enda pålitliga identiteten på sidan.
 */
function pageTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
  if (og) return deent(og[1])
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return t ? deent(t[1]).replace(/\s+/g, ' ').trim() : ''
}

function wrongProduct(html, reg) {
  const title = pageTitle(html).toLowerCase()
  const low = html.toLowerCase()
  const ean = String(reg.product.ean)
  const reject = (reg.product.reject_keywords || []).map(s => String(s).toLowerCase())

  if (title) {
    for (const bad of reject) {
      // ordgräns så att "loss" inte träffar "lös" och "strong" inte träffar "strongest"
      const re = new RegExp('(^|[^a-zåäöé])' + bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-zåäöé])', 'i')
      if (re.test(title)) return `Sidans titel säger "${pageTitle(html).slice(0, 60)}" — det är en annan vara än Kaliber Original 18 g.`
    }
  }
  if (low.includes(ean)) return null              // varunumret på sidan = rätt vara, klart
  if (!low.includes('kaliber')) return 'Sidan nämner inte Kaliber — kan vara fel vara eller flyttad URL.'
  if (!low.includes('original')) return 'Sidan nämner inte Kaliber Original — kan vara fel vara eller flyttad URL.'
  if (title && !title.includes('kaliber')) return `Sidans titel handlar inte om Kaliber ("${pageTitle(html).slice(0, 60)}") — URL:en har troligen flyttat.`
  return null
}

// --- prisberäkning ----------------------------------------------------------
function comboText(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([qty, n]) => (qty === 1 ? (n === 1 ? '1 lös dosa' : `${n} lösa dosor`) : `${n} × ${qty}-pack`))
    .join(' + ')
}

/** Minsta totalkostnad för EXAKT `n` dosor genom valfri kombination av butikens paket. */
function exactly(ladder, n) {
  const packs = ladder.filter(p => p.qty >= 1 && p.qty <= n)
  if (!packs.length) return null
  const dp = Array(n + 1).fill(Infinity)
  const pick = Array(n + 1).fill(null)
  dp[0] = 0
  for (let i = 1; i <= n; i++) {
    for (const p of packs) {
      const prev = dp[i - p.qty]
      if (prev === Infinity) continue
      if (prev + p.total < dp[i] - 1e-9) { dp[i] = prev + p.total; pick[i] = p }
    }
  }
  if (dp[n] === Infinity) return null
  const counts = new Map()
  for (let i = n; i > 0;) {
    const p = pick[i]
    counts.set(p.qty, (counts.get(p.qty) || 0) + 1)
    i -= p.qty
  }
  return { total: round(dp[n]), counts, cans: n }
}

/**
 * Bästa köpet för `target` dosor.
 *
 * Ingen butik säljer 20-pack — @20 blir 2 × 10-pack. Och där 30-paketet är dyrare än
 * 3 × 10-pack (iSnus) väljer DP:n de tre tiopaketen. Därför DP och inte uppslagning.
 *
 * Dessutom: ibland är det BILLIGARE att ta hem fler dosor (ett kampanjat 30-paket kan
 * kosta mindre än 2 × 10-pack). Då föreslås det — men BARA under två villkor:
 *   1. det exakta antalet går också att köpa, och det större kostar FÄRRE kronor totalt.
 *      Alltså mer snus för mindre pengar; aldrig "billigare per dosa men dyrare i kassan".
 *      Går exakt antal inte att pussla ihop får butiken helt enkelt inget pris för det
 *      antalet — annars hade en butik som bara säljer 30-pack vunnit frågan "10 dosor".
 *   2. resultatet stannar på högst MAX_CANS dosor. Han köper aldrig fler än 30 —
 *      tobaken hinner torka. Det gör också ett 50-pack omöjligt att välja, per konstruktion.
 */
function bestFor(ladder, target) {
  const exact = exactly(ladder, target)
  if (!exact) return null
  let over = null
  for (let n = target + 1; n <= MAX_CANS; n++) {
    const r = exactly(ladder, n)
    if (!r || r.total >= exact.total - 1e-9) continue
    if (!over || r.total < over.total - 1e-9) over = r
  }
  const win = over || exact
  return {
    total: win.total,
    perCan: round(win.total / win.cans),
    combo: comboText(win.counts),
    cans: win.cans,
    exact: win.cans === target,
  }
}

// --- en butik ---------------------------------------------------------------
async function scrapeRetailer(r, reg) {
  const base = { retailer: r.retailer, domain: r.domain, url: r.url }
  if (r.cluster) base.cluster = r.cluster
  if (r.cluster_primary) base.cluster_primary = true
  if (r.note) base.note = r.note

  if (r.platform === 'js-rendered') {
    return { ...base, trusted: false, reason: 'Prisstegen renderas av JavaScript — läsbar bara i webbläsare.' }
  }

  const { status, body: html } = await fetchUrl(r.url)
  if (status !== 200) {
    return {
      ...base, trusted: false,
      reason: status ? `HTTP ${status} — URL:en har troligen flyttat.` : 'Ingen respons från butiken.',
    }
  }
  if (!html || html.length < 200) return { ...base, trusted: false, reason: 'Tom sida från butiken.' }

  const wrong = wrongProduct(html, reg)
  if (wrong) return { ...base, trusted: false, reason: wrong }

  let rows = fromWoo(html)
  let method = rows ? 'woocommerce' : null

  if (!rows && (r.platform === 'shopify' || /cdn\.shopify\.com|Shopify\.theme/i.test(html))) {
    rows = await fromShopify(r.url)
    if (rows) method = 'shopify'
  }

  const ladder = normalizeLadder(rows)
  const hasRealPacks = ladder.some(p => p.qty > 1)

  // Tillitsregeln: bara äkta paketdata (Woo-varianter eller Shopify) med minst ett
  // paket > 1 dosa duger. JSON-LD ger ett löspris utan paketkontext → aldrig betrott.
  if (!method || !hasRealPacks) {
    const ld = fromJsonLd(html)
    return {
      ...base,
      trusted: false,
      reason: ld
        ? `Bara löspris utan paketkontext (JSON-LD: ${ld.slice(0, 4).join(', ')} kr) — går inte att räkna volympris på.`
        : 'Ingen läsbar prisstege i sidans HTML.',
    }
  }

  const best = {}
  for (const q of QUANTITIES) {
    const b = bestFor(ladder, q)
    if (b) best[String(q)] = b
  }
  // Räcker att ETT antal går att pussla ihop. En butik som bara säljer 30-pack ska
  // synas på @30 i stället för att kastas bort helt — sidan visar ändå bara de antal
  // butiken klarar. (Tidigare krävdes alla tre, vilket kunde kasta billigaste butiken.)
  const missing = QUANTITIES.filter(q => !best[String(q)])
  if (missing.length === QUANTITIES.length) {
    return {
      ...base,
      trusted: false,
      reason: `Kan inte pussla ihop 10/20/30 dosor ur butikens paket (${ladder.map(p => p.qty).join(', ')}).`,
    }
  }

  const out = { ...base, trusted: true, ladder, best }
  if (missing.length) out.partial = missing.map(Number)
  return out
}

// --- körning ----------------------------------------------------------------
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const startedAt = new Date()

log(`Hämtar Kaliber Original-priser från ${reg.retailers.length} butiker (${CONCURRENCY} parallellt)...\n`)

const results = await pool(reg.retailers, CONCURRENCY, r => scrapeRetailer(r, reg))

for (const r of results) {
  if (r.trusted) {
    const cells = QUANTITIES.map(q => {
      const b = r.best[String(q)]
      return b ? `@${q} ${b.perCan.toFixed(2)}${b.exact ? '' : `(${b.cans}st)`}` : `@${q} —`
    }).join('  ')
    log(`  ok    ${r.retailer.padEnd(18)} ${cells}   [${r.ladder.map(p => p.qty).join('/')}]`)
  } else {
    log(`  --    ${r.retailer.padEnd(18)} ${r.reason}`)
  }
}

// Föregående körning läses FÖRE payload byggs — prisdrift-vakten nedan behöver den.
let previous = null
if (existsSync(OUTFILE)) {
  try { previous = JSON.parse(readFileSync(OUTFILE, 'utf8')) } catch { previous = null }
}
const prevTrustedList = (previous?.retailers || []).filter(r => r.trusted)
const prevTrusted = prevTrustedList.length
const prevBy = new Map(prevTrustedList.map(r => [r.domain, r]))

// --- prisdrift-vakt ---------------------------------------------------------
// Ett pris som rört sig mer än DRIFT_LIMIT sedan i går är nästan aldrig en verklig
// prisändring — det är parsern som fått tag i fel siffra på en ombyggd sida. Ett FEL
// pris som ser färskt ut är farligare än inget pris alls, så butiken plockas ur
// jämförelsen i stället för att publiceras, och körningen larmar.
const drifted = []
const okTrusted = []
for (const r of results.filter(x => x.trusted)) {
  const before = prevBy.get(r.domain)?.best?.['30']?.perCan
  const now = r.best?.['30']?.perCan
  if (before > 0 && now > 0) {
    const change = Math.abs(now - before) / before
    if (change > DRIFT_LIMIT) {
      drifted.push({ retailer: r.retailer, domain: r.domain, before, now, pct: Math.round(change * 100) })
      continue
    }
  }
  okTrusted.push(r)
}

const trusted = okTrusted
const skipped = [
  ...results.filter(r => !r.trusted).map(r => ({ domain: r.domain, reason: r.reason || 'Okänt fel.' })),
  ...drifted.map(d => ({
    domain: d.domain,
    reason: `Priset hoppade ${d.pct} % (${d.before.toFixed(2)} → ${d.now.toFixed(2)} kr/dosa). Troligen fel avläst siffra — utelämnad tills den kontrollerats.`,
  })),
]
const unparsed = skipped.map(s => s.domain)

const payload = {
  fetched_at: startedAt.toISOString(),
  product: {
    name: reg.product.name,
    spec: reg.product.spec,
    ean: reg.product.ean,
  },
  quantities: QUANTITIES,
  // Bara betrodda butiker — filen laddas vid varje sidvisning på hans telefon och
  // otrodd data får ändå aldrig rankas. Orsakerna bor i `skipped` för felsökning.
  retailers: trusted,
  unparsed,
  skipped,
}

// Jämför allt UTOM tidsstämpeln — annars blir varje körning en commit.
const fingerprint = p => JSON.stringify({ ...p, fetched_at: null, stale_warning: null })

const nowDomains = new Set(trusted.map(r => r.domain))
const lost = prevTrustedList.filter(r => !nowDomains.has(r.domain)).map(r => r.retailer)

// Tröskeln är relativ till förra körningen, inte en konstant: går vi från 8 till 3
// butiker är det ett haveri även om 3 är "tillräckligt många".
const floor = Math.max(MIN_TRUSTED, Math.ceil(prevTrusted * KEEP_RATIO))

let final = payload
let outcome = 'fresh'

if (trusted.length < floor) {
  if (previous && prevTrusted >= MIN_TRUSTED) {
    // Skydda sidan: hellre gamla korrekta priser än en tom eller halv jämförelse.
    final = {
      ...previous,
      stale_warning: `Priserna kunde inte uppdateras ${startedAt.toISOString().slice(0, 10)} (bara ${trusted.length} av ${reg.retailers.length} butiker svarade med läsbar prisdata). Visar sparade priser från ${String(previous.fetched_at).slice(0, 10)}.`,
    }
    outcome = 'stale-kept'
  } else {
    final = {
      ...payload,
      stale_warning: `Bara ${trusted.length} butiker gav läsbar prisdata vid den här körningen — jämförelsen är ofullständig.`,
    }
    outcome = 'thin'
  }
} else if (lost.length) {
  // Nog med butiker totalt, men någon som fungerade i går tystnade. Det ska synas —
  // annars kan billigaste butiken försvinna spårlöst bakom en färsk tidsstämpel.
  final = {
    ...payload,
    stale_warning: `Priset hos ${lost.join(' och ')} gick inte att läsa den här gången, så ${lost.length > 1 ? 'de butikerna saknas' : 'den butiken saknas'} i jämförelsen.`,
  }
  outcome = 'partial'
} else if (previous && fingerprint(previous) === fingerprint(payload)) {
  // Inget har ändrats. Behåll gammal tidsstämpel så filen blir byte-identisk och
  // Actions slipper committa — men stämpla om ändå om den börjar bli gammal,
  // så sidan inte möter besökaren med ett datum från förra månaden.
  const age = startedAt - new Date(previous.fetched_at || 0)
  if (Number.isFinite(age) && age < HEARTBEAT_MS) {
    final = { ...payload, fetched_at: previous.fetched_at }
    outcome = 'unchanged'
  } else {
    outcome = 'heartbeat'
  }
}

const json = JSON.stringify(final, null, 2) + '\n'
const changed = !previous || json !== (existsSync(OUTFILE) ? readFileSync(OUTFILE, 'utf8') : '')

if (!DRY) writeFileSync(OUTFILE, json)

log('')
log(`  ${trusted.length} butiker med läsbar prisdata, ${skipped.length} utan.`)
if (unparsed.length) log(`  Utan: ${unparsed.join(', ')}`)
if (lost.length) log(`  TAPPADE sedan förra körningen: ${lost.join(', ')}`)
if (final.stale_warning) log(`  VARNING: ${final.stale_warning}`)

const rank = (final.retailers || []).filter(r => r.trusted && r.best?.['30'])
  .sort((a, b) => a.best['30'].perCan - b.best['30'].perCan)
if (rank.length) {
  const win = rank[0]
  log(`  Billigast @30: ${win.retailer} — ${win.best['30'].perCan.toFixed(2)} kr/dosa (${win.best['30'].total} kr, ${win.best['30'].combo})`)
}
log(`  ${DRY ? 'DRY RUN — inget skrivet' : `prices.json ${changed ? 'uppdaterad' : 'oförändrad'}`} (${outcome})`)

// --- larmbeslut -------------------------------------------------------------
// Tyst: enstaka butiker som strular. Högljutt: skrapningen är trasig, ankarbutiken
// är borta, eller ett pris ser felavläst ut. Bara det sista laget mejlar repo-ägaren.
const alarms = []
if (trusted.length < floor) {
  alarms.push(`Bara ${trusted.length} av ${reg.retailers.length} butiker gav läsbar prisdata (golv: ${floor}). Skrapningen är sannolikt trasig.`)
}
if (prevTrusted > 0 && !nowDomains.has(ANCHOR_DOMAIN)) {
  alarms.push(`${ANCHOR_DOMAIN} gick inte att läsa. Det är butiken rekommendationen brukar landa på — kontrollera att produktsidans URL och HTML inte ändrats.`)
}
for (const d of drifted) {
  alarms.push(`${d.retailer} hoppade ${d.pct} % (${d.before.toFixed(2)} → ${d.now.toFixed(2)} kr/dosa) och utelämnades. Kontrollera om det är en verklig prisändring eller en trasig avläsning — är den verklig, kör om så accepteras det nya priset.`)
}

const health = {
  last_run: startedAt.toISOString(),
  outcome,
  trusted: trusted.length,
  of: reg.retailers.length,
  floor,
  alarm: alarms.length > 0,
  alarms,
  lost,
  drifted,
}
// .health committas varje körning. Två syften: den ger en logg över när skrapningen
// senast fungerade, och den håller repot aktivt så GitHub inte pausar cron-jobbet
// efter 60 dagars stiltje.
if (!DRY) writeFileSync(HEALTHFILE, JSON.stringify(health, null, 2) + '\n')

if (alarms.length) {
  log('')
  for (const a of alarms) log(`  LARM: ${a}`)
}

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, [
    `changed=${changed ? 'yes' : 'no'}`,
    `trusted=${trusted.length}`,
    `alarm=${alarms.length ? 'yes' : 'no'}`,
    `alarm_reason=${alarms.join(' | ').replace(/\n/g, ' ')}`,
    '',
  ].join('\n'), { flag: 'a' })
}

// Alltid 0 härifrån: de säkra priserna ska hinna committas FÖRE jobbet failar.
// Workflow-steget "Larma" läser `alarm`-utdatan och fäller bygget sist av allt,
// så repo-ägaren får GitHubs mejl utan att sidan blir utan uppdatering.
process.exit(0)
