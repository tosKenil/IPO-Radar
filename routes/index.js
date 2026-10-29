const express = require('express');
const router = express.Router();
const { getAllIpos } = require('../data/ipoService');

// Helper: format date
function formatDate(dateStr) {
  if (!dateStr) return 'TBA';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Helper: compute 1 lot total amount dynamically on the fly (never stored in cache)
function getOneLotAmount(ipo) {
  if (!ipo || !ipo.lotSize) return null;
  let price = null;
  if (ipo.issuePrice && Number(ipo.issuePrice) > 0) {
    price = Number(ipo.issuePrice);
  } else if (ipo.priceband) {
    const nums = String(ipo.priceband).match(/[\d.]+/g);
    if (nums && nums.length > 0) {
      price = parseFloat(nums[nums.length - 1]);
    }
  }
  return price ? Math.round(price * Number(ipo.lotSize)) : null;
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
  return { totalIPOs: ipoList.length, avgReturn, best, totalOpen, totalUpcoming };
}

// GET /  — Dashboard
router.get('/', async (req, res, next) => {
  try {
    const filter = req.query.filter || 'all';
    const { ipos, stale } = await getAllIpos();
    const filtered = filter !== 'all' ? ipos.filter((i) => i.status === filter) : ipos;
    const stats = getDashboardStats(ipos);
    res.render('index', {
      ipos: filtered,
      allIpos: ipos,
      filter,
      stats,
      formatDate,
      dataStale: stale,
      getOneLotAmount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /ipo/:id  — Detail page (id is the NSE trading symbol)
router.get('/ipo/:id', async (req, res, next) => {
  try {
    const { ipos } = await getAllIpos();
    const ipo = ipos.find((i) => i.symbol.toUpperCase() === req.params.id.toUpperCase());
    if (!ipo) return res.status(404).render('404', { message: 'IPO not found' });
    res.render('detail', { ipo, formatDate, getOneLotAmount });
  } catch (err) {
    next(err);
  }
});

// GET /upcoming  — Upcoming IPOs
router.get('/upcoming', async (req, res, next) => {
  try {
    const { ipos, stale } = await getAllIpos();
    const upcoming = ipos.filter((i) => i.status === 'upcoming');
    res.render('upcoming', { ipos: upcoming, formatDate, dataStale: stale, getOneLotAmount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
