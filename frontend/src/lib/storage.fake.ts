/** The browser's storage, stood in for: the tests run without a browser, and what the device keeps
 *  is read from `localStorage` wherever the page would find it. */

/** Kept items are own properties, the methods are not, so `Object.keys` lists
 *  what is stored, as it does for the browser's own storage. */
export class MemoryStorage {
  [key: string]: unknown;
  getItem(key: string): string | null {
    return Object.hasOwn(this, key) ? String(this[key]) : null;
  }
  setItem(key: string, value: string): void {
    this[key] = String(value);
  }
  removeItem(key: string): void {
    delete this[key];
  }
}

/** Puts a storage where the page's own would be. A test takes it away again when it is done:
 *  `Reflect.deleteProperty(globalThis, "localStorage")`. */
export function useStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

/** What a browser that keeps no site data does: reaching for the storage at all throws. */
export function blockStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    configurable: true,
  });
}
