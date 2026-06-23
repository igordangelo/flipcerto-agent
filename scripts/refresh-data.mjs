import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const FIFA_FIXTURES_URL =
  "https://www.fifa.com/pt/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures?country=BR&wtw-filter=ALL";
const OUTPUT_PATH = new URL("../data/intelligence.json", import.meta.url);
const RATINGS_PATH = new URL("../data/team-ratings.json", import.meta.url);
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const MONTHS = {
  janeiro: 1, fevereiro: 2, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pad = (value) => String(value).padStart(2, "0");
const normalize = (value) =>
  value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

function calculateModel(homeRating, awayRating) {
  const diff = homeRating - awayRating;
  const totalGoals = clamp(2.55 + Math.abs(diff) * 0.012, 2.35, 3.25);
  const homeShare = 1 / (1 + Math.exp(-diff / 18));
  return {
    homeXg: clamp(totalGoals * homeShare, 0.22, 3.05),
    awayXg: clamp(totalGoals * (1 - homeShare), 0.22, 3.05)
  };
}

function parseDate(text) {
  const match = text.match(/(\d{1,2})\s+([a-zç]+)\s+(\d{4})/i);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${pad(month)}-${pad(match[1])}`;
}

function isPlaceholder(team) {
  return /^(?:[12][A-L]|[WRU]\d+|\d[A-L]|3[A-L]+)$/i.test(team.trim());
}

async function scrapeFifaFixtures() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
    await page.goto(FIFA_FIXTURES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector('a[href*="match-centre/match/"]', { timeout: 60_000 });
    return await page.locator('a[href*="match-centre/match/"]').evaluateAll((links) =>
      links.map((link) => {
        let section = link.parentElement;
        while (section && !(section.className || "").toString().includes("ff-pb-24")) {
          section = section.parentElement;
        }
        return {
          href: link.href,
          text: (link.innerText || link.textContent || "").trim().replace(/\s+/g, " "),
          sectionText: (section?.innerText || "").trim().replace(/\s+/g, " ")
        };
      })
    );
  } finally {
    await browser.close();
  }
}

function parseFifaFixtures(rawFixtures, ratings) {
  const fixtures = [];
  for (const raw of rawFixtures) {
    const date = parseDate(raw.sectionText);
    const match = raw.text.match(
      /^(.*?)\s+(\d{2}:\d{2})\s+(.*?)\s+(Primeira fase|Segundas de final|Oitavas de final|Quartas de final|Semifinal|Decisão do 3º lugar|Final)\s*·\s*(.*)$/i
    );
    if (!date || !match) continue;
    const [, home, time, away, phase, details] = match;
    if (isPlaceholder(home) || isPlaceholder(away)) continue;
    const groupMatch = details.match(/Grupo\s+([A-L])/i);
    fixtures.push({
      date,
      time,
      home: home.trim(),
      away: away.trim(),
      group: groupMatch?.[1] || phase,
      phase,
      hStr: ratings[home.trim()] ?? 70,
      aStr: ratings[away.trim()] ?? 70,
      stars: [],
      fifaUrl: raw.href
    });
  }
  const unique = new Map(fixtures.map((fixture) => [fixture.fifaUrl, fixture]));
  return [...unique.values()].sort((a, b) =>
    `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)
  );
}

async function fetchOdds(fixtures) {
  if (!ODDS_API_KEY) return { sportKey: null, events: [] };
  const sportsResponse = await fetch(
    `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(ODDS_API_KEY)}`
  );
  if (!sportsResponse.ok) throw new Error(`Odds sports: HTTP ${sportsResponse.status}`);
  const sports = await sportsResponse.json();
  const competition = sports.find((sport) =>
    /world cup/i.test(`${sport.title} ${sport.description}`) && /soccer/i.test(sport.group)
  );
  if (!competition) return { sportKey: null, events: [] };
  const oddsResponse = await fetch(
    `https://api.the-odds-api.com/v4/sports/${competition.key}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`
  );
  if (!oddsResponse.ok) throw new Error(`Odds events: HTTP ${oddsResponse.status}`);
  return { sportKey: competition.key, events: await oddsResponse.json(), fixtures };
}

function findOddsEvent(fixture, events) {
  const home = normalize(fixture.home);
  const away = normalize(fixture.away);
  return events.find((event) => {
    const eventHome = normalize(event.home_team || "");
    const eventAway = normalize(event.away_team || "");
    return (
      (eventHome.includes(home) || home.includes(eventHome)) &&
      (eventAway.includes(away) || away.includes(eventAway))
    );
  });
}

function summarizeOdds(event) {
  if (!event) return null;
  const probabilities = [];
  const totals = [];
  for (const bookmaker of event.bookmakers || []) {
    const h2h = bookmaker.markets?.find((market) => market.key === "h2h");
    if (h2h) {
      const prices = h2h.outcomes.map((outcome) => 1 / outcome.price);
      const overround = prices.reduce((sum, price) => sum + price, 0);
      probabilities.push({
        book: bookmaker.title,
        outcomes: h2h.outcomes.map((outcome, index) => ({
          name: outcome.name,
          probability: prices[index] / overround
        }))
      });
    }
    const total = bookmaker.markets?.find((market) => market.key === "totals");
    const over = total?.outcomes?.find((outcome) => outcome.name === "Over");
    if (over?.point) totals.push(Number(over.point));
  }
  const averaged = {};
  for (const book of probabilities) {
    for (const outcome of book.outcomes) {
      const key = normalize(outcome.name);
      averaged[key] ||= [];
      averaged[key].push(outcome.probability);
    }
  }
  const consensusProbability = Object.fromEntries(
    Object.entries(averaged).map(([key, values]) => [
      key,
      values.reduce((sum, value) => sum + value, 0) / values.length
    ])
  );
  return {
    bookmakers: probabilities.length,
    consensus: probabilities,
    consensusProbability,
    totalLine: totals.length
      ? totals.reduce((sum, value) => sum + value, 0) / totals.length
      : null
  };
}

function calibrateModel(fixture, baseModel, marketOdds) {
  if (!marketOdds || marketOdds.bookmakers < 3) return baseModel;
  const homeProbability = marketOdds.consensusProbability[normalize(fixture.home)];
  const awayProbability = marketOdds.consensusProbability[normalize(fixture.away)];
  if (!homeProbability || !awayProbability) return baseModel;
  const directionalShare = homeProbability / (homeProbability + awayProbability);
  const homeShare = clamp(0.5 + (directionalShare - 0.5) * 0.82, 0.16, 0.84);
  const totalGoals = marketOdds.totalLine
    ? clamp(marketOdds.totalLine + 0.10, 1.9, 4.1)
    : baseModel.homeXg + baseModel.awayXg;
  return {
    homeXg: totalGoals * homeShare,
    awayXg: totalGoals * (1 - homeShare)
  };
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return { games: [] };
  }
}

async function main() {
  const ratings = JSON.parse(await readFile(RATINGS_PATH, "utf8"));
  const previous = await readPrevious();
  let fixtures = [];
  let fifaStatus = "ok";
  try {
    fixtures = parseFifaFixtures(await scrapeFifaFixtures(), ratings);
    if (!fixtures.length) throw new Error("FIFA returned no parseable fixtures");
  } catch (error) {
    fifaStatus = `fallback: ${error.message}`;
    fixtures = previous.games || [];
  }

  let odds = { sportKey: null, events: [] };
  let oddsStatus = ODDS_API_KEY ? "ok" : "not-configured";
  try {
    odds = await fetchOdds(fixtures);
    if (ODDS_API_KEY && !odds.sportKey) oddsStatus = "competition-not-found";
  } catch (error) {
    oddsStatus = `fallback: ${error.message}`;
  }

  const games = fixtures.map((fixture) => {
    const marketOdds = summarizeOdds(findOddsEvent(fixture, odds.events));
    const baseModel = calculateModel(fixture.hStr, fixture.aStr);
    const hasConsensus = (marketOdds?.bookmakers || 0) >= 3;
    const model = calibrateModel(fixture, baseModel, marketOdds);
    return {
      ...fixture,
      intelligence: {
        homeXg: model.homeXg,
        awayXg: model.awayXg,
        confidence: hasConsensus ? 82 : 58,
        confidenceLabel: hasConsensus ? "alta" : "média",
        basis: hasConsensus
          ? `Consenso de ${marketOdds.bookmakers} casas + Poisson`
          : "Poisson + força relativa",
        caveat: hasConsensus
          ? "Probabilidade calibrada com consenso de bookmakers."
          : "Sem consenso de casas; use como triagem, não como cotação final.",
        odds: marketOdds
      }
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    timezone: "America/Sao_Paulo",
    sources: {
      fifa: { status: fifaStatus, url: FIFA_FIXTURES_URL },
      odds: { status: oddsStatus, provider: "The Odds API", sportKey: odds.sportKey }
    },
    games
  };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Generated ${games.length} games. FIFA=${fifaStatus}; odds=${oddsStatus}`);
}

await main();
