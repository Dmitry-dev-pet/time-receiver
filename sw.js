const VERSION = "c418f63d77a9a221";
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

async function cacheAllAnnualPacks(cache) {
  for (const indexUrl of [appUrl("schedule-packs/index.json"), appUrl("reconstruction-packs/index.json")]) {
    const response = await cache.match(indexUrl);
    if (!response) throw new Error(`Annual pack index is missing: ${indexUrl}`);
    const index = await response.json();
    for (const entry of index.years) {
      await putResponse(cache, entry.path, await fetch(new Request(entry.path, { cache: "reload" })));
    }
  }
}

async function offlineStatus() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await cache.match(appUrl("schedule-packs/index.json"));
  if (!indexResponse) return { type: "OFFLINE_STATUS", yearsCached: 0 };
  const index = await indexResponse.json();
  const cached = await Promise.all(index.years.map((entry) => cache.match(entry.path)));
  return { type: "OFFLINE_STATUS", yearsCached: cached.filter(Boolean).length };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheShell(cache);
    await cacheAllAnnualPacks(cache);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("time-receiver-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    const status = await offlineStatus();
    for (const client of clients) client.postMessage(status);
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
