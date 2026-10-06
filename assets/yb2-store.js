/**
 * Tiny observable store with optional localStorage persistence.
 * Storage is a convenience: every access is guarded so private mode, blocked
 * storage or quota errors never break the builder.
 * @module yb2-store
 */

const STORAGE_VERSION = 1;

/**
 * @template T
 * @param {T} initial
 * @param {{ storageKey?: string }} [options]
 */
export function createStore(initial, { storageKey } = {}) {
  let state = initial;
  /** @type {Set<(state: T, previous: T) => void>} */
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    /** @param {(state: T) => T} updater */
    update(updater) {
      const previous = state;
      state = updater(state);
      if (state === previous) return;
      if (storageKey) save(storageKey, state);
      for (const listener of listeners) listener(state, previous);
    },

    /** @param {(state: T, previous: T) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * @param {string} key
 * @returns {unknown | null}
 */
export function loadSaved(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.version === STORAGE_VERSION ? parsed.state : null;
  } catch {
    return null;
  }
}

/** @param {string} key */
export function clearSaved(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}

/**
 * @param {string} key
 * @param {unknown} state
 */
function save(key, state) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, state }));
  } catch {
    // Storage unavailable or full; the in-memory state still works.
  }
}
