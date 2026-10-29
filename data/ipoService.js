// Builds the IPO list the app renders, sourced live from official public IPO
// endpoints (NSE India, Upstox Live API, Groww Live API) + Yahoo Finance
// for real-time market prices of listed stocks.
// NO STATIC OR FAKE DATA IS USED.

const { nseGet, nseGetOrStale } = require('./nseClient');
const { getLatestPrice, getCloseNear } = require('./yahooClient');
const { fetchGrowwIpos } = require('./growwClient');
const { fetchUpstoxIpos } = require('./upstoxClient');
const { createCache } = require('./cache');
const { createLimit } = require('./limit');

const cache = createCache();
const LIST_TTL_MS = 3 * 60 * 1000;
const RECENT_CLOSED_LIMIT = 14;
const DETAIL_CONCURRENCY = 6;

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

// Computes SEBI T+3 compliant dates if not already present
function resolveIpoDates(item) {
  let closeDate = item.closeDate;
  if (!closeDate && item.openDate) {
    closeDate = addBusinessDays(item.openDate, 2);
  }
  let allotmentDate = item.allotmentDate;
  if (!allotmentDate && closeDate) {
    // SEBI T+1: Basis of Allotment is 1 working day after close
    allotmentDate = addBusinessDays(closeDate, 1);
  }
  let listingDate = item.listingDate;
  if (!listingDate && closeDate) {
    // SEBI T+3: Listing is strictly 3 working days after close
    listingDate = addBusinessDays(closeDate, 3);
  }
  return {
    ...item,
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
    return {
      ...item,
      lotSize: item.lotSize || null,
      registrar: item.registrar || null,
      leadManagers: item.leadManagers || [],
      issueType: item.issueType || null,
      faceValue: item.faceValue || null,
      documents: item.documents || [],
      qibSubscription: item.qibSubscription || 0,
      niiSubscription: item.niiSubscription || 0,
      retailSubscription: item.retailSubscription || 0,
    };
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

async function buildIpoList() {
  let merged = [];

  // 1. Try NSE Live Official APIs
  try {
    const [openUpcoming, recentClosed] = await Promise.all([
      fetchOpenAndUpcoming(),
      fetchRecentClosed(),
    ]);
    merged = [...openUpcoming, ...recentClosed].filter((i) => i.symbol);
  } catch {
    merged = [];
  }

  // 2. If NSE is blocked by network/firewalls, try Upstox live feed
  if (merged.length === 0) {
    try {
      const upstoxItems = await fetchUpstoxIpos();
      if (upstoxItems && upstoxItems.length > 0) {
        merged = upstoxItems;
      }
    } catch {
      merged = [];
    }
  }

  // 3. If still empty, try Groww live feed
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

  // If no live source returned data, do NOT fallback to fake/static data
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
        const withReturns = attachComputedReturns({ ...withPrice, id: withPrice.symbol });
        return resolveIpoDates(withReturns);
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
    const stale = cache.getStale(cacheKey);
    return { ipos: stale || [], stale: Boolean(stale) };
  } catch (err) {
    const stale = cache.getStale(cacheKey);
    return { ipos: stale || [], stale: true };
  }
}

module.exports = { getAllIpos };
