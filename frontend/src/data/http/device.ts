import type { DeviceStore } from "../contract";

/** The browser's own storage. It is reached for at each call, never kept: a page may not be allowed
 *  it at all (private browsing, blocked site data, a sandboxed frame), and then even reaching for it
 *  throws. Every failure is swallowed: the page goes on without what would have been kept. */
export const device: DeviceStore = {
  ready: Promise.resolve(),
  suggestedLocale: null,

  get(key) {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  set(key, value) {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      /* quota exceeded or storage disabled: it is not kept, and that is all */
    }
  },

  remove(key) {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      /* storage this site may not use has nothing to clear */
    }
  },

  keys(prefix) {
    try {
      return Object.keys(globalThis.localStorage).filter((key) => key.startsWith(prefix));
    } catch {
      return [];
    }
  },

  onChange(listener) {
    const heard = (event: StorageEvent) => {
      // A key of null is everything cleared at once, which nothing here does.
      if (event.key !== null) listener(event.key, event.oldValue, event.newValue);
    };
    globalThis.addEventListener?.("storage", heard);
    return () => globalThis.removeEventListener?.("storage", heard);
  },
};
