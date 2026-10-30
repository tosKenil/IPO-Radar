// Live client for Groww's public IPO API.
// Fetches real-time updated data on every request (No in-memory cache delay).

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function parseDate(val) {
  if (!val || val === '-') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) {
    return String(val).trim();
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function formatIssueSize(item) {
  if (item.issueSizeInCr || item.issueSize) {
    const sz = item.issueSizeInCr || item.issueSize;
    if (typeof sz === 'number') return `₹${sz} Cr`;
    if (String(sz).includes('Cr') || String(sz).includes('₹')) return String(sz);
    return `₹${sz} Cr`;
  }
  return '—';
}

function mapGrowwItem(raw, defaultStatus) {
  const symbol = (raw.symbol || raw.searchId || raw.nseScriptCode || '').toUpperCase().trim();
  const name = raw.companyName || raw.name || symbol;
  const isSme = Boolean(raw.isSme || raw.category === 'SME' || String(raw.series || '').toUpperCase() === 'SME');
  const category = isSme ? 'SME' : 'Mainboard';

  let status = defaultStatus;
  const openDate = parseDate(raw.biddingStartDate || raw.startDate || raw.openDate);
  const closeDate = parseDate(raw.biddingEndDate || raw.endDate || raw.closeDate);
  const listingDate = parseDate(raw.listingDate);
  const allotmentDate = parseDate(raw.allotmentDate);

  const now = new Date();
  if (listingDate && new Date(listingDate) <= now) {
    status = 'listed';
  } else if (closeDate && new Date(closeDate) < now) {
    status = 'allotment';
  } else if (openDate && new Date(openDate) <= now) {
    status = 'open';
  } else if (openDate && new Date(openDate) > now) {
    status = 'upcoming';
  }

  // Priceband & Issue Price
  const minPrice = parseNumber(raw.minPrice);
  const maxPrice = parseNumber(raw.maxPrice || raw.cutOffPrice);
  let priceband = null;
  if (minPrice && maxPrice) {
    priceband = minPrice === maxPrice ? `${minPrice}` : `${minPrice} - ${maxPrice}`;
  } else if (maxPrice) {
    priceband = `${maxPrice}`;
  } else if (raw.priceBand || raw.issuePrice) {
    priceband = String(raw.priceBand || raw.issuePrice);
  }

  const issuePrice = parseNumber(raw.issuePrice) || (status === 'listed' ? maxPrice : null);
  const lotSize = parseNumber(raw.lotSize || raw.minBidQuantity || raw.retailLotSize);
  const subscriptionTimes = parseNumber(raw.subscriptionRate || raw.subscriptionTimes || raw.totalSubscription);

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
    issueSize: formatIssueSize(raw),
    openDate,
    closeDate,
    allotmentDate,
    listingDate,
    listingPrice: parseNumber(raw.listingPrice || raw.listingRate),
    currentPrice: parseNumber(raw.currentPrice || raw.cmp || raw.marketPrice),
    subscriptionTimes,
    qibSubscription: parseNumber(raw.qibSubscription || raw.qib) || 0,
    niiSubscription: parseNumber(raw.niiSubscription || raw.nii || raw.hni) || 0,
    retailSubscription: parseNumber(raw.retailSubscription || raw.retail) || 0,
    registrar: raw.registrarName || raw.registrar || null,
    leadManagers: raw.leadManagers || [],
    issueType: raw.issueType || (isSme ? 'SME IPO' : 'Book Built Issue'),
    faceValue: raw.faceValue ? `₹${raw.faceValue}` : null,
    documents: [],
    listingReturnPct: null,
    currentReturnPct: null,
  };
}

let lastGrowwData = [];

async function fetchGrowwIpos() {
  const urls = [
    'https://groww.in/v1/api/stocks_data/v1/all_ipos',
    'https://groww.in/v1/api/stocks_data/v1/ipo/v1/all',
    'https://groww.in/v1/api/stocks_data/v1/ipo/v2/active',
    'https://groww.in/v1/api/stocks_data/v1/ipo/v2/upcoming',
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) continue;
      const data = await res.json();
      if (!data) continue;

      const items = [];
      if (Array.isArray(data)) {
        for (const item of data) {
          items.push(mapGrowwItem(item, 'open'));
        }
      } else {
        const openList = Array.isArray(data.openIpos) ? data.openIpos : (Array.isArray(data.active) ? data.active : []);
        const upcomingList = Array.isArray(data.upcomingIpos) ? data.upcomingIpos : (Array.isArray(data.upcoming) ? data.upcoming : []);
        const closedList = Array.isArray(data.closedIpos) ? data.closedIpos : (Array.isArray(data.closed) ? data.closed : (Array.isArray(data.listed) ? data.listed : []));

        for (const item of openList) items.push(mapGrowwItem(item, 'open'));
        for (const item of upcomingList) items.push(mapGrowwItem(item, 'upcoming'));
        for (const item of closedList.slice(0, 15)) items.push(mapGrowwItem(item, 'listed'));
      }

      if (items.length > 0) {
        lastGrowwData = items;
        return items;
      }
    } catch (err) {
      clearTimeout(timer);
    }
  }

  return lastGrowwData || [];
}

module.exports = { fetchGrowwIpos };
