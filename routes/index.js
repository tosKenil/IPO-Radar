const express = require('express');
const router = express.Router();
const { getAllIpos } = require('../data/ipoService');
const { checkAllotmentStatus } = require('../data/allotmentService');

// Helper: format date
function formatDate(dateStr) {
  if (!dateStr) return 'TBA';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Helper: extract cutoff or base issue price
function getCutoffPrice(ipo) {
  if (!ipo) return null;
  if (ipo.issuePrice && Number(ipo.issuePrice) > 0) {
    return Number(ipo.issuePrice);
  }
  if (ipo.priceband) {
    const nums = String(ipo.priceband).match(/[\d.]+/g);
    if (nums && nums.length > 0) {
      return parseFloat(nums[nums.length - 1]);
    }
  }
  return null;
}

// Helper: compute 1 lot total amount dynamically on the fly (never stored in cache)
function getOneLotAmount(ipo) {
  if (!ipo || !ipo.lotSize) return null;
  const price = getCutoffPrice(ipo);
  return price ? Math.round(price * Number(ipo.lotSize)) : null;
}

// Helper: compute expected return %
function getExpectedReturn(ipo) {
  if (!ipo) return null;

  // 1. If listed, return actual current return %
  if (ipo.status === 'listed' && ipo.currentReturnPct !== null) {
    const pct = parseFloat(ipo.currentReturnPct);
    return {
      percent: pct.toFixed(1),
      formatted: (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%',
      isPositive: pct >= 0,
      isEstimated: false,
    };
  }

  // 2. If explicit GMP percent
  if (ipo.gmpPercent !== undefined && ipo.gmpPercent !== null) {
    const pct = parseFloat(ipo.gmpPercent);
    return {
      percent: pct.toFixed(1),
      formatted: '~' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%',
      isPositive: pct >= 0,
      isEstimated: true,
    };
  }

  // 3. Compute expected return from live subscription demand
  const sub = parseFloat(ipo.subscriptionTimes || ipo.retailSubscription || 0);
  if (sub > 0) {
    let estPct = 0;
    if (sub >= 150) {
      estPct = Math.min(95, 60 + (sub - 150) * 0.15);
    } else if (sub >= 100) {
      estPct = 45 + (sub - 100) * 0.3;
    } else if (sub >= 50) {
      estPct = 30 + (sub - 50) * 0.3;
    } else if (sub >= 20) {
      estPct = 18 + (sub - 20) * 0.4;
    } else if (sub >= 5) {
      estPct = 6 + (sub - 5) * 0.8;
    } else if (sub >= 1) {
      estPct = (sub - 1) * 1.5;
    } else {
      estPct = 0;
    }
    const rounded = Math.round(estPct);
    return {
      percent: rounded.toString(),
      formatted: '~+' + rounded + '%',
      isPositive: true,
      isEstimated: true,
    };
  }

  return null;
}

// Helper: compute estimate listing gain in % and estimate listing price in ₹
function getEstimateListing(ipo) {
  if (!ipo) return null;

  const cutoff = getCutoffPrice(ipo);

  // 1. If listed and has listing price & issue price (actual listing gain)
  if (ipo.status === 'listed' && ipo.listingPrice && ipo.issuePrice) {
    const iss = Number(ipo.issuePrice);
    const list = Number(ipo.listingPrice);
    const gainPct = (((list - iss) / iss) * 100);
    return {
      isEstimated: false,
      cutoffPrice: iss,
      listingPrice: list,
      listingPriceFormatted: '₹' + list.toLocaleString('en-IN'),
      gainPct: Math.round(gainPct * 100) / 100,
      gainPctFormatted: (gainPct >= 0 ? '+' : '') + gainPct.toFixed(2) + '%',
      gainPerShare: Math.round((list - iss) * 100) / 100,
      isPositive: gainPct >= 0,
      labelPrice: 'Listing Price',
      labelGain: 'Listing Gain',
    };
  }

  // 2. If open/upcoming/allotment: compute estimated listing gain % and estimated listing price
  const exp = getExpectedReturn(ipo);
  if (exp && cutoff) {
    const gainPct = parseFloat(exp.percent);
    const gainPerShare = Math.round((cutoff * (gainPct / 100)) * 100) / 100;
    const estListingPrice = Math.round((cutoff + gainPerShare) * 100) / 100;

    return {
      isEstimated: true,
      cutoffPrice: cutoff,
      listingPrice: estListingPrice,
      listingPriceFormatted: '~₹' + estListingPrice.toLocaleString('en-IN'),
      gainPct,
      gainPctFormatted: '~+' + Math.round(gainPct) + '%',
      gainPerShare,
      isPositive: gainPct >= 0,
      labelPrice: 'Est. Listing Price',
      labelGain: 'Est. Listing Gain',
    };
  }

  return null;
}

// Helper: compute allotment chance out of 100 applications (100 ae ketla ne lagshe)
function getAllotmentChance(ipo) {
  const sub = ipo.retailSubscription || ipo.subscriptionTimes;
  if (!sub || isNaN(sub) || sub <= 0) return null;
  const numSub = parseFloat(sub);
  if (numSub <= 1) {
    return '100 માંથી 100 ને (100%)';
  }
  const per100 = Math.round((100 / numSub) * 10) / 10;
  const chanceInt = per100 >= 1 ? Math.round(per100) : per100.toFixed(1);
  return `100 માંથી ~${chanceInt} ને (1 in ${Math.round(numSub)})`;
}

// Helper: compute profit / total rupees in hand for 1 lot (actual or estimated)
function getInHandAmount(ipo) {
  if (!ipo || !ipo.lotSize) return null;
  const lot = Number(ipo.lotSize);
  const issue = (ipo.issuePrice && Number(ipo.issuePrice) > 0) ? Number(ipo.issuePrice) : null;
  const curr = ipo.currentPrice ? Number(ipo.currentPrice) : (ipo.listingPrice ? Number(ipo.listingPrice) : null);
  
  if (issue && curr) {
    const profit = Math.round((curr - issue) * lot);
    const totalValue = Math.round(curr * lot);
    return {
      profit,
      isPositive: profit >= 0,
      profitFormatted: (profit >= 0 ? '+' : '') + '₹' + profit.toLocaleString('en-IN'),
      totalValue,
      totalFormatted: '₹' + totalValue.toLocaleString('en-IN'),
      isEstimated: false,
    };
  }

  // For unlisted IPOs, compute expected profit in hand using Expected Return %
  const exp = getExpectedReturn(ipo);
  const price = issue || getCutoffPrice(ipo);
  if (exp && price && lot) {
    const lotAmt = price * lot;
    const estProfit = Math.round((parseFloat(exp.percent) / 100) * lotAmt);
    const estTotal = Math.round(lotAmt + estProfit);
    return {
      profit: estProfit,
      isPositive: estProfit >= 0,
      profitFormatted: '~+₹' + estProfit.toLocaleString('en-IN'),
      totalValue: estTotal,
      totalFormatted: '₹' + estTotal.toLocaleString('en-IN'),
      isEstimated: true,
    };
  }

  return null;
}

// Helper: match IPO against search term
function matchIpoSearch(ipo, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const name = (ipo.name || '').toLowerCase();
  const symbol = (ipo.symbol || '').toLowerCase();
  const category = (ipo.category || '').toLowerCase();
  const registrar = (ipo.registrar || '').toLowerCase();
  const status = (ipo.status || '').toLowerCase();
  return name.includes(q) || symbol.includes(q) || category.includes(q) || registrar.includes(q) || status.includes(q);
}

// Helper: compute stats for dashboard
function getDashboardStats(ipoList) {
  const listed = ipoList.filter((i) => i.status === 'listed');
  const withReturn = listed.filter((i) => i.currentReturnPct !== null);
  const avgReturn = withReturn.length
    ? (withReturn.reduce((s, i) => s + parseFloat(i.currentReturnPct), 0) / withReturn.length).toFixed(2)
    : 0;
  const best = withReturn.length
    ? [...withReturn].sort((a, b) => parseFloat(b.currentReturnPct) - parseFloat(a.currentReturnPct))[0]
    : null;
  const totalOpen = ipoList.filter((i) => i.status === 'open').length;
  const totalUpcoming = ipoList.filter((i) => i.status === 'upcoming').length;
  const totalAllotment = ipoList.filter((i) => i.status === 'allotment').length;
  return { totalIPOs: ipoList.length, avgReturn, best, totalOpen, totalUpcoming, totalAllotment };
}

// GET /  — Dashboard
router.get('/', async (req, res, next) => {
  try {
    const filter = (req.query.filter || 'all').toLowerCase().trim();
    const searchQuery = (req.query.q || '').trim();
    const { ipos, stale } = await getAllIpos();
    
    // Status filter
    let filtered = ipos;
    if (filter !== 'all') {
      filtered = ipos.filter((i) => {
        const s = (i.status || '').toLowerCase();
        if (filter === 'allotment') {
          return s === 'allotment' || s === 'closed' || s === 'bidding_closed';
        }
        return s === filter;
      });
    }

    // Search query filter
    if (searchQuery) {
      filtered = filtered.filter((i) => matchIpoSearch(i, searchQuery));
    }

    const stats = getDashboardStats(ipos);
    res.render('index', {
      ipos: filtered,
      allIpos: ipos,
      filter,
      searchQuery,
      stats,
      formatDate,
      dataStale: stale,
      getOneLotAmount,
      getAllotmentChance,
      getInHandAmount,
      getExpectedReturn,
      getEstimateListing,
    });
  } catch (err) {
    next(err);
  }
});

// GET /allotment-status  — Dedicated Allotment Status Checker Page (Like KFintech)
router.get(['/allotment-status', '/allotment'], async (req, res, next) => {
  try {
    const { ipos } = await getAllIpos();
    const selectedSymbol = req.query.ipo || '';
    res.render('allotment-status', {
      ipos,
      selectedSymbol,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/allotment-check — API endpoint to check allotment dynamically
router.post('/api/allotment-check', async (req, res) => {
  try {
    const { ipo, queryType, queryValue } = req.body;
    const { ipos } = await getAllIpos();
    const targetIpo = ipos.find((i) => 
      (i.symbol || '').toUpperCase() === String(ipo || '').toUpperCase() ||
      (i.id || '').toUpperCase() === String(ipo || '').toUpperCase() ||
      (i.name || '').toLowerCase().includes(String(ipo || '').toLowerCase())
    );

    const result = checkAllotmentStatus({
      ipo: targetIpo,
      queryType,
      queryValue,
      allIpos: ipos,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred while querying the registrar database.',
    });
  }
});

// GET /ipo/:id  — Detail page (flexible lookup by symbol, id, or name slug)
router.get('/ipo/:id', async (req, res, next) => {
  try {
    const rawId = decodeURIComponent(req.params.id || '').trim();
    const { ipos } = await getAllIpos();

    // Match by symbol, id, or lowercase slug match
    const ipo = ipos.find((i) => {
      const sym = (i.symbol || '').toUpperCase();
      const id = (i.id || '').toUpperCase();
      const target = rawId.toUpperCase();
      const slug = (i.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return sym === target || id === target || slug === rawId.toLowerCase();
    });

    if (!ipo) {
      return res.status(404).render('404', { 
        message: `IPO '${rawId}' was not found. It might have expired or not yet listed.` 
      });
    }

    res.render('detail', {
      ipo,
      formatDate,
      getOneLotAmount,
      getAllotmentChance,
      getInHandAmount,
      getExpectedReturn,
      getEstimateListing,
    });
  } catch (err) {
    next(err);
  }
});

// GET /upcoming  — Upcoming IPOs
router.get('/upcoming', async (req, res, next) => {
  try {
    const searchQuery = (req.query.q || '').trim();
    const { ipos, stale } = await getAllIpos();
    let upcoming = ipos.filter((i) => i.status === 'upcoming');
    
    // Search query filter
    if (searchQuery) {
      upcoming = upcoming.filter((i) => matchIpoSearch(i, searchQuery));
    }

    res.render('upcoming', {
      ipos: upcoming,
      searchQuery,
      formatDate,
      dataStale: stale,
      getOneLotAmount,
      getAllotmentChance,
      getInHandAmount,
      getExpectedReturn,
      getEstimateListing,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
