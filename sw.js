const VERSION = "e7377ce8389efdcd";
const CACHE_NAME = `time-receiver-${VERSION}`;
const BASE_PATH = "/time-receiver/";
const appUrl = (path = "") => `${BASE_PATH}${path}`;
const CORE_URLS = [
  appUrl(),
  appUrl("manifest.webmanifest"),
  appUrl("icons/receiver-180.png"),
  appUrl("icons/receiver-192.png"),
  appUrl("icons/receiver-512.png"),
  appUrl("schedule-packs/index.json"),
  appUrl("reconstruction-packs/index.json"),
];

async function putResponse(cache, url, response) {
  if (!response.ok) throw new Error(`Cannot cache ${url}: HTTP ${response.status}`);
  await cache.put(url, response);
}

async function cacheShell(cache) {
  const response = await fetch(new Request(appUrl(), { cache: "reload" }));
  const html = await response.clone().text();
  await putResponse(cache, appUrl(), response);
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/gu)].map((match) => match[1]);
  for (const url of [...CORE_URLS.slice(1), ...assetUrls]) {
    await putResponse(cache, url, await fetch(new Request(url, { cache: "reload" })));
  }
}

async function annualPackIndexes(cache) {
  const indexes = [];
  for (const indexUrl of [appUrl("schedule-packs/index.json"), appUrl("reconstruction-packs/index.json")]) {
    const response = await cache.match(indexUrl);
    if (!response) throw new Error(`Annual pack index is missing: ${indexUrl}`);
    indexes.push(await response.json());
  }
  return indexes;
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) client.postMessage(message);
}

let annualPackJob = null;
function cacheAnnualPacksResumable() {
  annualPackJob ??= (async () => {
    const cache = await caches.open(CACHE_NAME);
    const indexes = await annualPackIndexes(cache);
    const entries = indexes.flatMap((index) => index.years);
    let complete = 0;
    for (const entry of entries) {
      try {
        if (!await cache.match(entry.path)) {
          await putResponse(cache, entry.path, await fetch(new Request(entry.path, { cache: "reload" })));
        }
      } catch {
        // Keep every successfully cached year and retry missing files next time.
      }
      complete += 1;
      await broadcast({ type: "CACHE_PROGRESS", complete, total: entries.length });
    }
    await broadcast(await offlineStatus());
  })().finally(() => { annualPackJob = null; });
  return annualPackJob;
}

async function offlineStatus() {
  const cache = await caches.open(CACHE_NAME);
  let indexes;
  try { indexes = await annualPackIndexes(cache); }
  catch { return { type: "OFFLINE_STATUS", yearsCached: 0, packFilesCached: 0, totalPackFiles: 102 }; }
  const counts = [];
  for (const index of indexes) {
    const cached = await Promise.all(index.years.map((entry) => cache.match(entry.path)));
    counts.push(cached.filter(Boolean).length);
  }
  return {
    type: "OFFLINE_STATUS",
    yearsCached: Math.min(...counts),
    packFilesCached: counts.reduce((sum, count) => sum + count, 0),
    totalPackFiles: indexes.reduce((sum, index) => sum + index.years.length, 0),
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheShell(cache);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("time-receiver-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
    const status = await offlineStatus();
    await broadcast(status);
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (message?.type === "CHECK_OFFLINE_READY") {
    event.waitUntil(offlineStatus().then((status) => event.source?.postMessage(status)));
    return;
  }
  if (message?.type === "CACHE_ANNUAL_PACKS") {
    event.waitUntil(cacheAnnualPacksResumable());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith(appUrl("api/"))) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) (await caches.open(CACHE_NAME)).put(appUrl(), response.clone());
        return response;
      } catch {
        return (await caches.open(CACHE_NAME)).match(appUrl()) ?? new Response("Time Receiver offline", { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  })());
});
