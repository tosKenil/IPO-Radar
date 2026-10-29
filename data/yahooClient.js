// Thin client for Yahoo Finance's public chart API — used only to fill in
// market prices for already-listed stocks, since NSE's own quote API
// (api/quote-equity) is blocked at the CDN for unauthenticated callers.
// No API key required; not an official/contractual data source, so every
// call is best-effort and failures degrade to "price unavailable".

const { createCache } = require('./cache');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const QUOTE_TTL_MS = 2 * 60 * 1000;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // historical closes don't change

const cache = createCache();
const EXCHANGE_SUFFIXES = ['.NS', '.BO']; // NSE, then BSE as fallback

async function fetchChart(symbol, params = '') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.chart?.result?.[0] || null;
}

// Latest traded price for a listed NSE symbol, or null if unavailable.
async function getLatestPrice(symbol) {
  const cacheKey = `quote:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let price = null;
  for (const suffix of EXCHANGE_SUFFIXES) {
    try {
      const result = await fetchChart(`${symbol}${suffix}`);
      const p = result?.meta?.regularMarketPrice;
      if (typeof p === 'number') {
        price = p;
        break;
      }
    } catch {
      // try next exchange suffix
    }
  }
  cache.set(cacheKey, price, QUOTE_TTL_MS);
  return price;
}

// Approximate "listing price" as the closing price on (or shortly after)
// the given ISO listing date. This is a real traded close, not the exact
// first-trade price NSE shows on its own site, but it's the closest thing
// obtainable from a free historical feed.
async function getCloseNear(symbol, isoDate) {
  if (!isoDate) return null;
  const cacheKey = `close:${symbol}:${isoDate}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const period1 = Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
  const period2 = period1 + 7 * 24 * 60 * 60;
  let close = null;

  for (const suffix of EXCHANGE_SUFFIXES) {
    try {
      const result = await fetchChart(
        `${symbol}${suffix}`,
        `?period1=${period1}&period2=${period2}&interval=1d`
      );
      const closes = result?.indicators?.quote?.[0]?.close;
      if (Array.isArray(closes)) {
        const first = closes.find((c) => typeof c === 'number');
        if (first !== undefined) {
          close = first;
          break;
        }
      }
    } catch {
      // try next exchange suffix
    }
  }
  cache.set(cacheKey, close, HISTORY_TTL_MS);
  return close;
}

module.exports = { getLatestPrice, getCloseNear };
