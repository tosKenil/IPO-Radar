// Thin client for NSE's public (unauthenticated but Akamai-gated) IPO JSON
// endpoints. NSE requires a browser-like session cookie before it will
// answer /api/* requests, so we grab that from the homepage and reuse it
// until it goes stale.
// Real-time responses without caching delays.

const { createCache } = require('./cache');

const BASE = 'https://www.nseindia.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const COOKIE_TTL_MS = 5 * 60 * 1000; // NSE's Akamai cookies expire quickly
const TIMEOUT_MS = 10000;

const cache = createCache();
let cookieRefresh = null;

async function fetchCookies() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`NSE homepage returned ${res.status}`);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    if (!cookieHeader) throw new Error('NSE homepage returned no session cookies');
    return cookieHeader;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function getCookies({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = cache.get('cookies');
    if (cached) return cached;
  }
  if (!cookieRefresh) {
    cookieRefresh = fetchCookies()
      .then((cookies) => {
        cache.set('cookies', cookies, COOKIE_TTL_MS);
        return cookies;
      })
      .finally(() => {
        cookieRefresh = null;
      });
  }
  return cookieRefresh;
}

// GET an NSE /api/* path and return live parsed JSON without response cache.
async function nseGet(path) {
  async function attempt(forceRefresh) {
    const cookies = await getCookies({ forceRefresh });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: `${BASE}/market-data/all-upcoming-issues-ipo`,
          'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          Cookie: cookies,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  let res = await attempt(false);
  if (res.status === 401 || res.status === 403) {
    res = await attempt(true);
  }
  if (!res.ok) {
    throw new Error(`NSE ${path} returned ${res.status}`);
  }

  const data = await res.json();
  return data;
}

// Same as nseGet, on network error returns null instead of throwing
async function nseGetOrStale(path) {
  try {
    return await nseGet(path);
  } catch (err) {
    return null;
  }
}

module.exports = { nseGet, nseGetOrStale };
