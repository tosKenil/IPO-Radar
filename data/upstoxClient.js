// Live client for Upstox's public IPO API.
// Endpoint: https://api.upstox.com/v2/ipo
// Returns actual live real-time IPO data on every request (No in-memory cache delay).

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseDate(val) {
  if (!val || val === '-') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) {
    return String(val).trim();
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function formatIssueSize(sz) {
  const num = parseNumber(sz);
  if (!num) return typeof sz === 'string' && sz ? sz : '—';
  if (num >= 1e7) return `₹${(num / 1e7).toFixed(2)} Cr`;
  if (num >= 100000) return `₹${(num / 100000).toFixed(2)} Lakh`;
  return `₹${num} Cr`;
}

function mapUpstoxItem(raw) {
  const symbol = (raw.symbol || raw.company_key || '').toUpperCase().trim();
  const name = raw.company_name || symbol;
  const isSme = Boolean(raw.is_sme || raw.category === 'SME');
  const category = isSme ? 'SME' : 'Mainboard';

  let status = 'upcoming';
  const openDate = parseDate(raw.start_date || raw.open_date);
  const closeDate = parseDate(raw.end_date || raw.close_date);
  const listingDate = parseDate(raw.listing_date);
  const allotmentDate = parseDate(raw.allotment_date);

  const now = new Date();
  if (listingDate && new Date(listingDate) <= now) {
    status = 'listed';
  } else if (closeDate && new Date(closeDate) < now) {
    status = 'allotment';
  } else if (openDate && new Date(openDate) <= now) {
    status = 'open';
  } else {
    status = 'upcoming';
  }

  const minPrice = parseNumber(raw.min_price);
  const maxPrice = parseNumber(raw.max_price || raw.cutOffPrice || raw.cut_off_price);
  let priceband = null;
  if (minPrice && maxPrice) {
    priceband = minPrice === maxPrice ? `${minPrice}` : `${minPrice} - ${maxPrice}`;
  } else if (maxPrice) {
    priceband = `${maxPrice}`;
  }

  const issuePrice = parseNumber(raw.issue_price) || (status === 'listed' ? maxPrice : null);
  const lotSize = parseNumber(raw.lot_size || raw.min_bid_quantity);
  const subscriptionTimes = parseNumber(raw.subscription_rate || raw.subscription_times);

  return {
    id: symbol || name.replace(/\s+/g, '-').toLowerCase(),
    symbol: symbol || name.substring(0, 8).toUpperCase(),
    series: isSme ? 'SME' : 'EQ',
    name,
    category,
    status,
    priceband,
    issuePrice,
    lotSize,
    issueSize: formatIssueSize(raw.issue_size || raw.issue_size_in_cr),
    openDate,
    closeDate,
    allotmentDate,
    listingDate,
    listingPrice: parseNumber(raw.listing_price),
    currentPrice: parseNumber(raw.current_price || raw.cmp),
    subscriptionTimes: subscriptionTimes || null,
    qibSubscription: parseNumber(raw.qib_subscription) || 0,
    niiSubscription: parseNumber(raw.nii_subscription) || 0,
    retailSubscription: parseNumber(raw.retail_subscription) || 0,
    registrar: raw.registrar_name || raw.registrar || null,
    leadManagers: Array.isArray(raw.lead_managers) ? raw.lead_managers : [],
    issueType: isSme ? 'SME IPO' : 'Book Built Issue',
    faceValue: raw.face_value ? `₹${raw.face_value}` : null,
    documents: [],
    listingReturnPct: null,
    currentReturnPct: null,
  };
}

let lastUpstoxData = [];

async function fetchUpstoxIpos() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch('https://api.upstox.com/v2/ipo', {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return lastUpstoxData;
    const json = await res.json();
    const rawList = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
    if (!rawList || rawList.length === 0) return lastUpstoxData;

    const items = rawList.map(mapUpstoxItem).filter((i) => i.symbol);
    if (items.length > 0) {
      lastUpstoxData = items;
      return items;
    }
  } catch (err) {
    clearTimeout(timer);
  }

  return lastUpstoxData || [];
}

module.exports = { fetchUpstoxIpos };
