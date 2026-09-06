/* ============================================================
   Familie Nadig – Service Worker
   ============================================================
   Aufgabe: Die App startet auch ohne Internetverbindung, bleibt online
   aber immer aktuell.

   Strategie:
   - Dokument (HTML): zuerst Netz, bei Zeitüberschreitung oder Fehler der
     Zwischenspeicher. So gibt es nie eine veraltete Fassung, solange eine
     Verbindung besteht.
   - Eigene Dateien (gleiche Herkunft): zuerst Zwischenspeicher, Aktualisierung
     im Hintergrund.
   - Fremde Server (Microsoft Graph, OpenStreetMap, CDNs): niemals abfangen.
     Anmeldedaten und Kartenkacheln gehören nicht in den Zwischenspeicher.

   Wichtig: Eine neue Fassung übernimmt NICHT von selbst. Sie wartet, bis die
   App die Nachricht "jetztUebernehmen" schickt – ausgelöst durch den
   Nutzer über den Hinweis "Neue Version verfügbar".
   ============================================================ */

const VERSION    = "2.11.0";
const CACHE_NAME = "familie-nadig-" + VERSION;
const NETZ_TIMEOUT_MS = 4000;

// Beim Installieren die App-Hülle vorab ablegen.
// Das Manifest ist als data:-URI im HTML eingebettet und daher keine eigene Datei.
const VORRAT = ["./", "./index.html"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Einzeln ablegen: fehlt eine optionale Datei, soll die Installation
    // trotzdem gelingen (addAll bricht sonst komplett ab).
    await Promise.all(VORRAT.map(pfad =>
      cache.add(new Request(pfad, { cache: "reload" })).catch(() => {})
    ));
    // NICHT skipWaiting: die neue Fassung wartet auf die Freigabe des Nutzers.
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const namen = await caches.keys();
    await Promise.all(
      namen.filter(n => n.startsWith("familie-nadig-") && n !== CACHE_NAME)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// Übernahme auf ausdrückliche Anforderung der App
self.addEventListener("message", e => {
  const daten = e.data || {};
  if (daten === "skipWaiting" || daten.typ === "jetztUebernehmen") {
    self.skipWaiting();
  }
});

function istDokument(request) {
  return request.mode === "navigate" ||
         (request.headers.get("accept") || "").includes("text/html");
}

async function netzZuerst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const steuerung = new AbortController();
    const uhr = setTimeout(() => steuerung.abort(), NETZ_TIMEOUT_MS);
    // cache:"reload" umgeht den HTTP-Zwischenspeicher des Browsers.
    // GitHub Pages liefert index.html mit max-age=600 aus; ohne diesen Zusatz
    // koennte hier bis zu zehn Minuten lang die alte Fassung zurueckkommen.
    const antwort = await fetch(request, { signal: steuerung.signal, cache: "reload" });
    clearTimeout(uhr);
    if (antwort && antwort.ok) cache.put(request, antwort.clone());
    return antwort;
  } catch (e) {
    const gespeichert = await cache.match(request) ||
                        await cache.match("./index.html") ||
                        await cache.match("./");
    if (gespeichert) return gespeichert;
    return new Response(
      "<!doctype html><meta charset='utf-8'>" +
      "<div style=\"font-family:system-ui;padding:40px;text-align:center;color:#172033\">" +
      "<h2>Keine Verbindung</h2>" +
      "<p>Die App konnte nicht geladen werden. Bitte die Internetverbindung prüfen.</p></div>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function speicherZuerst(request) {
  const cache = await caches.open(CACHE_NAME);
  const gespeichert = await cache.match(request);
  const ausDemNetz = fetch(request).then(antwort => {
    if (antwort && antwort.ok) cache.put(request, antwort.clone());
    return antwort;
  }).catch(() => gespeichert);
  return gespeichert || ausDemNetz;
}

self.addEventListener("fetch", e => {
  const request = e.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Fremde Herkunft nie abfangen: Microsoft Graph, Anmeldung, Kartenkacheln,
  // Nominatim, OSRM und die CDNs sollen unverändert durchlaufen.
  if (url.origin !== self.location.origin) return;

  // Bereichsanfragen (z. B. Medien) nicht anfassen
  if (request.headers.has("range")) return;

  e.respondWith(istDokument(request) ? netzZuerst(request) : speicherZuerst(request));
});
