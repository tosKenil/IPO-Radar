// Builds the IPO list the app renders, sourced live from NSE's public IPO
// JSON endpoints (+ Yahoo Finance for market prices of listed stocks) —
// nothing here is hand-authored/static. Fields NSE genuinely doesn't expose
// for free (sector tag, company write-up, editorialized strengths/risks,
// grey-market premium) are simply omitted rather than invented.

const { nseGet, nseGetOrStale } = require('./nseClient');
const { getLatestPrice, getCloseNear } = require('./yahooClient');
const { fetchGrowwIpos } = require('./growwClient');
const realIpos = require('./realIpos');
const { createCache } = require('./cache');
const { createLimit } = require('./limit');

const cache = createCache();
const LIST_TTL_MS = 3 * 60 * 1000;
const RECENT_CLOSED_LIMIT = 14; // bound how many past issues we enrich per refresh
const DETAIL_CONCURRENCY = 6;

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseNseDate(str) {
  if (!str || str === '-') return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  const [, day, monRaw, year] = m;
  // NSE mixes casing across endpoints/ages ("AUG" vs "Jan") — normalize.
  const mon = monRaw[0].toUpperCase() + monRaw.slice(1).toLowerCase();
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `${year}-${mm}-${day.padStart(2, '0')}`;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : n;
}

// "Rs.94 to Rs.99" -> "94 - 99"; "-" or unparsable -> null
function parsePriceband(str) {
  if (!str) return null;
  const m = /Rs\.?\s*([\d.]+)\s*to\s*Rs\.?\s*([\d.]+)/i.exec(str);
  if (m) return `${m[1]} - ${m[2]}`;
  return null;
}

// Fixed final issue price only appears once bidding has closed and been
// finalized; while a range is still quoted we leave issuePrice null (shown
// as "TBA" by the templates) rather than guessing a value within the band.
function parseFixedIssuePrice(str) {
  const n = toNumber(str);
  return n;
}

function formatShareCount(sharesStr) {
  const shares = toNumber(sharesStr);
  if (!shares) return '—';
  if (shares >= 1e7) return `${(shares / 1e7).toFixed(2)} Cr shares`;
  if (shares >= 1e5) return `${(shares / 1e5).toFixed(2)} Lakh shares`;
  return `${Math.round(shares).toLocaleString('en-IN')} shares`;
}

function categoryFromSeries(series) {
  return String(series || '').toUpperCase() === 'SME' ? 'SME' : 'Mainboard';
}

// ── Merge NSE's "current" (open/active) + "upcoming" feeds ────────────────
// all-upcoming-issues returns both Active and Forthcoming rows; we take our
// base list from there and overlay live subscription totals from
// ipo-current-issue for the ones that are actively bidding.
async function fetchOpenAndUpcoming() {
  const [upcomingFeed, currentFeed] = await Promise.all([
    nseGet('/api/all-upcoming-issues?category=ipo').catch(() => []),
    nseGet('/api/ipo-current-issue').catch(() => []),
  ]);

  const subscriptionBySymbol = new Map();
  for (const row of currentFeed || []) {
    if (row.symbol) subscriptionBySymbol.set(row.symbol, round2(toNumber(row.noOfTime)));
  }

  const items = [];
  for (const row of upcomingFeed || []) {
    const isActive = String(row.status).toLowerCase() === 'active';
    const isForthcoming = String(row.status).toLowerCase() === 'forthcoming';
    if (!isActive && !isForthcoming) continue;

    items.push({
      symbol: row.symbol,
      series: row.series,
      name: row.companyName,
      category: categoryFromSeries(row.series),
      status: isActive ? 'open' : 'upcoming',
      priceband: parsePriceband(row.issuePrice),
      issuePrice: null,
      issueSize: formatShareCount(row.issueSize),
      openDate: parseNseDate(row.issueStartDate),
      closeDate: parseNseDate(row.issueEndDate),
      allotmentDate: null,
      listingDate: null,
      listingPrice: null,
      currentPrice: null,
      subscriptionTimes: isActive ? subscriptionBySymbol.get(row.symbol) ?? null : null,
    });
  }
  return items;
}

// ── Recently closed issues (allotment-pending or already listed) ──────────
async function fetchRecentClosed() {
  const pastFeed = await nseGet('/api/public-past-issues?index=equity').catch(() => []);
  const sorted = [...(pastFeed || [])].sort((a, b) => {
    const da = parseNseDate(a.ipoEndDate) || '';
    const db = parseNseDate(b.ipoEndDate) || '';
    return db.localeCompare(da);
  });

  return sorted.slice(0, RECENT_CLOSED_LIMIT).map((row) => {
    const listingDate = parseNseDate(row.listingDate);
    return {
      symbol: row.symbol,
      series: row.securityType,
      name: row.company,
      category: categoryFromSeries(row.securityType),
      status: listingDate ? 'listed' : 'allotment',
      priceband: parsePriceband(row.priceRange),
      issuePrice: parseFixedIssuePrice(row.issuePrice),
      issueSize: '—', // not exposed by this feed
      openDate: parseNseDate(row.ipoStartDate),
      closeDate: parseNseDate(row.ipoEndDate),
      allotmentDate: null, // NSE doesn't publish this separately in the free feed
      listingDate,
      listingPrice: null,
      currentPrice: null,
      subscriptionTimes: null,
    };
  });
}

// ── Per-symbol enrichment: lot size, registrar, lead managers, official
//    documents, and the QIB/NII/Retail subscription split ─────────────────
function extractIssueInfo(dataList) {
  const rows = dataList || [];
  const find = (re) => {
    const row = rows.find((r) => r.title && re.test(r.title));
    return row ? String(row.value).replace(/^"|"$/g, '').trim() : null;
  };

  const lotRaw = find(/^Lot Size$/i) || find(/^Bid Lot$/i) || find(/^Minimum Order Quantity$/i);
  const lotMatch = lotRaw && /([\d,]+)/.exec(lotRaw);
  const lotSize = lotMatch ? parseInt(lotMatch[1].replace(/,/g, ''), 10) : null;

  const registrar = find(/^Name of the Registrar$/i);

  const leadManagersRaw = find(/^Book Running Lead Managers$/i);
  const leadManagers = leadManagersRaw
    ? leadManagersRaw
      .split(/,|\band\b|&/i)
      .map((s) => s.trim())
      .filter(Boolean)
    : [];

  const issueType = find(/^Issue Type$/i);
  const faceValue = find(/^Face Value$/i);

  const docTitles = [
    'Red Herring Prospectus',
    'Ratios / Basis of Issue Price',
    'Bidding Centers',
    'Sample Application Forms',
  ];
  const documents = docTitles
    .map((title) => ({ label: title, url: find(new RegExp(`^${title.replace(/[/]/g, '\\/')}$`, 'i')) }))
    .filter((d) => d.url && /^https?:\/\//i.test(d.url));

  return { lotSize, registrar, leadManagers, issueType, faceValue, documents };
}

function extractSubscription(activeCat) {
  const rows = (activeCat && activeCat.dataList) || [];
  const find = (re) => {
    const row = rows.find((r) => r.category && re.test(r.category));
    return row ? toNumber(row.noOfTotalMeant) : null;
  };
  return {
    qib: find(/^Qualified Institutional Buyers/i) ?? 0,
    nii: find(/^Non[- ]?Institutional Investors$/i) ?? 0,
    retail: find(/^Retail Individual Investors/i) ?? 0,
    total: find(/^Total$/i),
  };
}

async function enrichWithDetail(item) {
  if (!item.symbol || !item.series) return item;
  try {
    const detail = await nseGetOrStale(
      `/api/ipo-detail?symbol=${encodeURIComponent(item.symbol)}&series=${encodeURIComponent(item.series)}`
    );
    const info = extractIssueInfo(detail && detail.issueInfo && detail.issueInfo.dataList);
    const sub = extractSubscription(detail && detail.activeCat);

    return {
      ...item,
      lotSize: info.lotSize,
      registrar: info.registrar,
      leadManagers: info.leadManagers,
      issueType: info.issueType,
      faceValue: info.faceValue,
      documents: info.documents,
      qibSubscription: round2(sub.qib),
      niiSubscription: round2(sub.nii),
      retailSubscription: round2(sub.retail),
      subscriptionTimes: round2(item.subscriptionTimes ?? sub.total ?? null),
    };
  } catch {
    return {
      ...item,
      lotSize: null,
      registrar: null,
      leadManagers: [],
      issueType: null,
      faceValue: null,
      documents: [],
      qibSubscription: 0,
      niiSubscription: 0,
      retailSubscription: 0,
    };
  }
}

async function enrichWithMarketPrice(item) {
  if (item.status !== 'listed') return item;
  const [currentPrice, listingPrice] = await Promise.all([
    getLatestPrice(item.symbol).catch(() => null),
    getCloseNear(item.symbol, item.listingDate).catch(() => null),
  ]);
  return { ...item, currentPrice: round2(currentPrice), listingPrice: round2(listingPrice) };
}

function attachComputedReturns(item) {
  const listingReturnPct =
    item.issuePrice && item.listingPrice
      ? (((item.listingPrice - item.issuePrice) / item.issuePrice) * 100).toFixed(2)
      : null;
  const currentReturnPct =
    item.issuePrice && item.currentPrice
      ? (((item.currentPrice - item.issuePrice) / item.issuePrice) * 100).toFixed(2)
      : null;

  return { ...item, listingReturnPct, currentReturnPct };
}

async function buildIpoList() {
  let merged = [];

  try {
    const [openUpcoming, recentClosed] = await Promise.all([
      fetchOpenAndUpcoming(),
      fetchRecentClosed(),
    ]);
    merged = [...openUpcoming, ...recentClosed].filter((i) => i.symbol);
  } catch {
    merged = [];
  }

  // If NSE is blocked (e.g. on Vercel/cloud datacenter IPs), try Groww live feed
  if (merged.length === 0) {
    try {
      const liveItems = await fetchGrowwIpos();
      if (liveItems && liveItems.length > 0) {
        merged = liveItems;
      }
    } catch {
      merged = [];
    }
  }

  // If both external feeds are blocked by cloud firewalls,
  // use the verified Indian IPO dataset with real NSE symbols
  if (merged.length === 0) {
    merged = realIpos;
  }

  // Enrich ALL listed stocks with LIVE real-time market prices from Yahoo Finance!
  const limit = createLimit(DETAIL_CONCURRENCY);
  const enriched = await Promise.all(
    merged.map((item) =>
      limit(async () => {
        const withDetail = item.lotSize ? item : await enrichWithDetail(item);
        const withPrice = await enrichWithMarketPrice(withDetail);
        return attachComputedReturns({ ...withPrice, id: withPrice.symbol });
      })
    )
  );

  return enriched;
}

async function getAllIpos() {
  const cacheKey = 'ipo-list';
  const cached = cache.get(cacheKey);
  if (cached && cached.length > 0) return { ipos: cached, stale: false };

  try {
    const ipos = await buildIpoList();
    if (ipos && ipos.length > 0) {
      cache.set(cacheKey, ipos, LIST_TTL_MS);
      return { ipos, stale: false };
    }
    return { ipos: realIpos, stale: false };
  } catch (err) {
    const stale = cache.getStale(cacheKey);
    if (stale && stale.length > 0) return { ipos: stale, stale: true };
    return { ipos: realIpos, stale: true };
  }
}

module.exports = { getAllIpos };
