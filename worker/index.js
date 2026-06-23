const CACHE_SECONDS = 3 * 60 * 60;
const SPORTS_URL = "https://api.the-odds-api.com/v4/sports/";
const API_URL = "https://api.the-odds-api.com/v4/sports";
const ALLOWED_ORIGINS = new Set([
  "https://igordangelo.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765"
]);

function normalize(value = "") {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://igordangelo.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(request, body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request),
      ...(init.headers || {})
    }
  });
}

async function findWorldCupSport(apiKey) {
  const response = await fetch(`${SPORTS_URL}?apiKey=${encodeURIComponent(apiKey)}&all=true`);
  if (!response.ok) throw new Error(`sports_${response.status}`);
  const sports = await response.json();
  return sports.find((sport) => sport.key === "soccer_fifa_world_cup");
}

function aggregateEvent(event) {
  const h2hBooks = [];
  const totalLines = [];
  for (const bookmaker of event.bookmakers || []) {
    const h2h = bookmaker.markets?.find((market) => market.key === "h2h");
    if (h2h?.outcomes?.length) {
      const raw = h2h.outcomes.map((outcome) => ({
        name: outcome.name,
        raw: 1 / Number(outcome.price)
      }));
      const overround = raw.reduce((sum, outcome) => sum + outcome.raw, 0);
      if (overround > 0) {
        h2hBooks.push({
          bookmaker: bookmaker.title,
          probabilities: Object.fromEntries(
            raw.map((outcome) => [normalize(outcome.name), outcome.raw / overround])
          )
        });
      }
    }
    const totals = bookmaker.markets?.find((market) => market.key === "totals");
    const over = totals?.outcomes?.find((outcome) => outcome.name === "Over");
    if (Number.isFinite(Number(over?.point))) totalLines.push(Number(over.point));
  }

  const keys = new Set(h2hBooks.flatMap((book) => Object.keys(book.probabilities)));
  const consensus = {};
  for (const key of keys) {
    const values = h2hBooks.map((book) => book.probabilities[key]).filter(Number.isFinite);
    if (values.length) consensus[key] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return {
    id: event.id,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    homeKey: normalize(event.home_team),
    awayKey: normalize(event.away_team),
    bookmakers: h2hBooks.length,
    consensus,
    totalLine: totalLines.length
      ? totalLines.reduce((sum, value) => sum + value, 0) / totalLines.length
      : null
  };
}

async function fetchOdds(apiKey) {
  const sport = await findWorldCupSport(apiKey);
  if (!sport) {
    return { sportKey: null, events: [], warning: "world_cup_not_available" };
  }
  const url = new URL(`${API_URL}/${sport.key}/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "eu");
  url.searchParams.set("markets", "h2h,totals");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  const response = await fetch(url);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`odds_${response.status}:${detail.slice(0, 160)}`);
  }
  const events = (await response.json()).map(aggregateEvent);
  return {
    sportKey: sport.key,
    events,
    quota: {
      remaining: response.headers.get("x-requests-remaining"),
      used: response.headers.get("x-requests-used"),
      last: response.headers.get("x-requests-last")
    }
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const url = new URL(request.url);
    if (request.method !== "GET") return json(request, { error: "method_not_allowed" }, { status: 405 });
    if (url.pathname === "/health") {
      return json(request, {
        ok: true,
        service: "flipcerto-odds",
        configured: Boolean(env.ODDS_API_KEY),
        cacheSeconds: CACHE_SECONDS
      });
    }
    if (url.pathname !== "/" && url.pathname !== "/odds") {
      return json(request, { error: "not_found" }, { status: 404 });
    }
    if (!env.ODDS_API_KEY) {
      return json(request, { error: "odds_api_key_not_configured" }, { status: 503 });
    }

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/odds?v=3`, request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set("X-FlipCerto-Cache", "HIT");
      Object.entries(corsHeaders(request)).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }

    try {
      const odds = await fetchOdds(env.ODDS_API_KEY);
      const generatedAt = new Date().toISOString();
      const response = json(request, {
        ok: true,
        generatedAt,
        expiresAt: new Date(Date.now() + CACHE_SECONDS * 1000).toISOString(),
        ...odds
      }, {
        headers: {
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
          "X-FlipCerto-Cache": "MISS"
        }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return json(request, {
        ok: false,
        error: "odds_unavailable",
        detail: error.message
      }, { status: 502 });
    }
  }
};
