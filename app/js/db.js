// Обёртка над IndexedDB. Все данные хранятся только на телефоне.
const DB_NAME = 'hairgrowth';
const VERSION = 1;
export const STORES = ['items', 'logs', 'photos', 'analyses'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('logs', { keyPath: 'key' }).createIndex('date', 'date');
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('date', 'date');
        d.createObjectStore('analyses', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

function wrap(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(name, mode = 'readonly') {
  const d = await open();
  return d.transaction(name, mode).objectStore(name);
}

export const db = {
  all: async (name) => wrap((await store(name)).getAll()),
  get: async (name, key) => wrap((await store(name)).get(key)),
  put: async (name, value) => wrap((await store(name, 'readwrite')).put(value)),
  del: async (name, key) => wrap((await store(name, 'readwrite')).delete(key)),
  clear: async (name) => wrap((await store(name, 'readwrite')).clear()),
};
