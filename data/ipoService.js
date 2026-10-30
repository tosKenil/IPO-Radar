// Builds the IPO list the app renders, sourced live from official public IPO
// endpoints (NSE India, Upstox Live API, Groww Live API) + Yahoo Finance
// for real-time market prices of listed stocks.
// FULLY DYNAMIC — NO HARDCODED OR COMPANY-SPECIFIC STATUS CONDITIONS.

const { nseGet, nseGetOrStale } = require('./nseClient');
const { getLatestPrice, getCloseNear } = require('./yahooClient');
const { fetchGrowwIpos } = require('./growwClient');
const { fetchUpstoxIpos } = require('./upstoxClient');
const { createLimit } = require('./limit');

const RECENT_CLOSED_LIMIT = 14;
const DETAIL_CONCURRENCY = 6;

// Emergency buffer ONLY used if all external networks completely fail
let lastSuccessfulIpos = null;

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseNseDate(str) {
  if (!str || str === '-') return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(str).trim());
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(str).trim())) return String(str).trim();
    return null;
  }
  const [, day, monRaw, year] = m;
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

// Add working business days skipping weekends (Saturday & Sunday)
function addBusinessDays(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }
  return d.toISOString().split('T')[0];
}

// Computes SEBI T+3 compliant dates dynamically for any IPO
function resolveIpoDates(item) {
  let closeDate = item.closeDate;
  if (!closeDate && item.openDate) {
    closeDate = addBusinessDays(item.openDate, 2);
  }
  let allotmentDate = item.allotmentDate;
  if (!allotmentDate && closeDate) {
    allotmentDate = addBusinessDays(closeDate, 1);
  }
  let listingDate = item.listingDate;
  if (!listingDate && closeDate) {
    listingDate = addBusinessDays(closeDate, 3);
  }

  // 100% Dynamic status determination based on current time and dates:
  // If an upstream API already identified it as allotment / closed, preserve it
  let status = item.status;
  if (status === 'closed' || status === 'bidding_closed' || status === 'allotment') {
    status = 'allotment';
  } else {
    const now = new Date();
    if (listingDate && new Date(listingDate) <= now) {
      status = 'listed';
    } else if (closeDate && new Date(closeDate) < now) {
      status = 'allotment';
    } else if (item.openDate && new Date(item.openDate) <= now) {
      status = 'open';
    } else if (item.openDate && new Date(item.openDate) > now) {
      status = 'upcoming';
    }
  }

  return {
    ...item,
    status: status || item.status,
    closeDate: closeDate || item.closeDate,
    allotmentDate: allotmentDate || item.allotmentDate,
    listingDate: listingDate || item.listingDate,
  };
}

function parsePriceband(str) {
  if (!str) return null;
  const m = /Rs\.?\s*([\d.]+)\s*(?:to|-)\s*Rs\.?\s*([\d.]+)/i.exec(str);
  if (m) return `${m[1]} - ${m[2]}`;
  const single = /Rs\.?\s*([\d.]+)/i.exec(str);
  if (single) return single[1];
  return null;
}

function parseFixedIssuePrice(str) {
  return toNumber(str);
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

// ── Merge NSE's live feeds ──────────────────────────────────────────────
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

    const openDate = parseNseDate(row.issueStartDate);
    const closeDate = parseNseDate(row.issueEndDate);
    const allotmentDate = closeDate ? addBusinessDays(closeDate, 1) : null;
    const listingDate = closeDate ? addBusinessDays(closeDate, 3) : null;

    items.push({
      symbol: row.symbol,
      series: row.series,
      name: row.companyName,
      category: categoryFromSeries(row.series),
      status: isActive ? 'open' : 'upcoming',
      priceband: parsePriceband(row.issuePrice),
      issuePrice: null,
      issueSize: formatShareCount(row.issueSize),
      openDate,
      closeDate,
      allotmentDate,
      listingDate,
      listingPrice: null,
      currentPrice: null,
      subscriptionTimes: isActive ? subscriptionBySymbol.get(row.symbol) ?? null : null,
    });
  }
  return items;
}

async function fetchRecentClosed() {
  const pastFeed = await nseGet('/api/public-past-issues?index=equity').catch(() => []);
  const sorted = [...(pastFeed || [])].sort((a, b) => {
    const da = parseNseDate(a.ipoEndDate) || '';
    const db = parseNseDate(b.ipoEndDate) || '';
    return db.localeCompare(da);
  });

  return sorted.slice(0, RECENT_CLOSED_LIMIT).map((row) => {
    const closeDate = parseNseDate(row.ipoEndDate);
    const listingDate = parseNseDate(row.listingDate) || (closeDate ? addBusinessDays(closeDate, 3) : null);
    const allotmentDate = closeDate ? addBusinessDays(closeDate, 1) : null;

    return {
      symbol: row.symbol,
      series: row.securityType,
      name: row.company,
      category: categoryFromSeries(row.securityType),
      status: listingDate ? 'listed' : 'allotment',
      priceband: parsePriceband(row.priceRange),
      issuePrice: parseFixedIssuePrice(row.issuePrice),
      issueSize: '—',
      openDate: parseNseDate(row.ipoStartDate),
      closeDate,
      allotmentDate,
      listingDate,
      listingPrice: null,
      currentPrice: null,
      subscriptionTimes: null,
    };
  });
}

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

  const allotmentRaw = find(/allotment/i) || find(/basis of allotment/i);
  const listingRaw = find(/listing/i) || find(/commencement of trading/i);
  const allotmentDate = parseNseDate(allotmentRaw);
  const listingDate = parseNseDate(listingRaw);

  const docTitles = [
    'Red Herring Prospectus',
    'Ratios / Basis of Issue Price',
    'Bidding Centers',
    'Sample Application Forms',
  ];
  const documents = docTitles
    .map((title) => ({ label: title, url: find(new RegExp(`^${title.replace(/[/]/g, '\\/')}$`, 'i')) }))
    .filter((d) => d.url && /^https?:\/\//i.test(d.url));

  return { lotSize, registrar, leadManagers, issueType, faceValue, documents, allotmentDate, listingDate };
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
      lotSize: info.lotSize || item.lotSize || null,
      allotmentDate: info.allotmentDate || item.allotmentDate || null,
      listingDate: info.listingDate || item.listingDate || null,
      registrar: info.registrar || item.registrar || null,
      leadManagers: info.leadManagers && info.leadManagers.length ? info.leadManagers : (item.leadManagers || []),
      issueType: info.issueType || item.issueType || null,
      faceValue: info.faceValue || item.faceValue || null,
      documents: info.documents && info.documents.length ? info.documents : (item.documents || []),
      qibSubscription: round2(sub.qib) || item.qibSubscription || 0,
      niiSubscription: round2(sub.nii) || item.niiSubscription || 0,
      retailSubscription: round2(sub.retail) || item.retailSubscription || 0,
      subscriptionTimes: round2(item.subscriptionTimes ?? sub.total ?? null),
    };
  } catch {
    return item;
  }
}

async function enrichWithMarketPrice(item) {
  if (item.status !== 'listed') return item;
  const [currentPrice, listingPrice] = await Promise.all([
    getLatestPrice(item.symbol).catch(() => null),
    getCloseNear(item.symbol, item.listingDate).catch(() => null),
  ]);
  return {
    ...item,
    currentPrice: currentPrice ? round2(currentPrice) : item.currentPrice,
    listingPrice: listingPrice ? round2(listingPrice) : item.listingPrice,
  };
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

  const res = { ...item, listingReturnPct, currentReturnPct };
  delete res.cutoffPrice;
  delete res.lotAmount;
  return res;
}

// ── Merge Multiple Sources and Deduplicate Dynamically ───────────────────
function mergeIpoSources(items) {
  const map = new Map();

  for (const item of items) {
    if (!item) continue;
    const key = (item.symbol || item.name || '').toUpperCase().trim();
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, { ...item });
    } else {
      // Merge best fields: keep non-null and richer data
      const existing = map.get(key);
      map.set(key, {
        ...existing,
        ...item,
        status: item.status || existing.status,
        priceband: item.priceband || existing.priceband,
        issuePrice: item.issuePrice || existing.issuePrice,
        lotSize: item.lotSize || existing.lotSize,
        issueSize: (item.issueSize && item.issueSize !== '—') ? item.issueSize : existing.issueSize,
        openDate: item.openDate || existing.openDate,
        closeDate: item.closeDate || existing.closeDate,
        allotmentDate: item.allotmentDate || existing.allotmentDate,
        listingDate: item.listingDate || existing.listingDate,
        subscriptionTimes: item.subscriptionTimes || existing.subscriptionTimes,
        retailSubscription: item.retailSubscription || existing.retailSubscription,
        registrar: item.registrar || existing.registrar,
        leadManagers: (item.leadManagers && item.leadManagers.length) ? item.leadManagers : existing.leadManagers,
      });
    }
  }

  return Array.from(map.values());
}

// ── 100% Dynamic Live Build: Fetches Groww, Upstox, and NSE simultaneously ───────────
async function buildIpoList() {
  const [growwRes, upstoxRes, nseRes] = await Promise.allSettled([
    fetchGrowwIpos(),
    fetchUpstoxIpos(),
    Promise.all([fetchOpenAndUpcoming(), fetchRecentClosed()]),
  ]);

  const rawList = [];

  // 1. Groww Live Feed
  if (growwRes.status === 'fulfilled' && Array.isArray(growwRes.value)) {
    rawList.push(...growwRes.value);
  }

  // 2. Upstox Live Feed
  if (upstoxRes.status === 'fulfilled' && Array.isArray(upstoxRes.value)) {
    rawList.push(...upstoxRes.value);
  }

  // 3. NSE Official Live Feed
  if (nseRes.status === 'fulfilled' && Array.isArray(nseRes.value)) {
    const [openUpcoming, recentClosed] = nseRes.value;
    if (Array.isArray(openUpcoming)) rawList.push(...openUpcoming);
    if (Array.isArray(recentClosed)) rawList.push(...recentClosed);
  }

  // Deduplicate and merge live records dynamically
  const merged = mergeIpoSources(rawList.filter((i) => i && (i.symbol || i.name)));

  if (merged.length === 0) {
    return [];
  }

  // Enrich listed stocks with real-time market prices from Yahoo Finance
  const limit = createLimit(DETAIL_CONCURRENCY);
  const enriched = await Promise.all(
    merged.map((item) =>
      limit(async () => {
        const withDetail = item.lotSize ? item : await enrichWithDetail(item);
        const withPrice = await enrichWithMarketPrice(withDetail);
        const withReturns = attachComputedReturns({ ...withPrice, id: withPrice.symbol || withPrice.id });
        return resolveIpoDates(withReturns);
      })
    )
  );

  return enriched;
}

// Stale-while-revalidate: pages are served instantly from the last snapshot,
// and a single shared background refresh keeps it fresh (live fetch takes seconds).
const FRESH_MS = 60 * 1000;
let lastFetchedAt = 0;
let inflight = null;

function refreshIpos() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ipos = await buildIpoList();
      if (ipos && ipos.length > 0) {
        lastSuccessfulIpos = ipos;
        lastFetchedAt = Date.now();
        return true;
      }
    } catch (err) {
      console.error('Real-time IPO fetch error:', err.message);
    }
    return false;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function getAllIpos() {
  if (lastSuccessfulIpos) {
    const isFresh = Date.now() - lastFetchedAt < FRESH_MS;
    if (!isFresh) refreshIpos(); // background, don't block the response
    return { ipos: lastSuccessfulIpos, stale: !isFresh };
  }
  // Cold start: only the very first request has to wait
  const ok = await refreshIpos();
  return { ipos: lastSuccessfulIpos || [], stale: !ok };
}

module.exports = { getAllIpos, refreshIpos };
