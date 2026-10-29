// Tiny in-memory TTL cache used by the live data clients.
// Not persisted — it just smooths out repeated requests within a short window
// so we don't hammer upstream APIs (NSE/Yahoo) on every page load.

function createCache() {
  const store = new Map();

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) return undefined;
      return hit.value;
    },
    // Returns the last stored value even if expired — used as a fallback
    // when a live refetch fails, so the UI can keep showing something.
    getStale(key) {
      const hit = store.get(key);
      return hit ? hit.value : undefined;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expires: Date.now() + ttlMs });
    },
    delete(key) {
      store.delete(key);
    },
  };
}

module.exports = { createCache };
