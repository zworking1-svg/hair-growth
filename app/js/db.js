// Обёртка над IndexedDB. Все данные хранятся только на телефоне.
const DB_NAME = 'hairgrowth';
const VERSION = 2;
export const STORES = ['items', 'logs', 'photos', 'analyses', 'meta'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        const has = (n) => d.objectStoreNames.contains(n);
        if (!has('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!has('logs')) d.createObjectStore('logs', { keyPath: 'key' }).createIndex('date', 'date');
        if (!has('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('date', 'date');
        if (!has('analyses')) d.createObjectStore('analyses', { keyPath: 'id' });
        if (!has('meta')) d.createObjectStore('meta', { keyPath: 'key' }); // v2: профиль пересадки
      };
      r.onsuccess = () => {
        // Отпускаем базу, если её обновляет более новая версия приложения в другой вкладке.
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
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
