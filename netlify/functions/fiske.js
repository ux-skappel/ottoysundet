// netlify/functions/fiske.js
// Ottøysundet, Sandsfjorden — koordinater
const LAT = 59.485;
const LON = 6.245;

export default async (req) => {
  try {
    const now = new Date();
    const fromTime = new Date(now);
    fromTime.setHours(0, 0, 0, 0);
    const toTime = new Date(fromTime);
    toTime.setDate(toTime.getDate() + 8);

    const fmt = (d) => d.toISOString().slice(0, 16);

    // --- Tidevann: Kartverket ---
    const tideUrl =
      `https://api.sehavniva.no/tideapi.php` +
      `?lat=${LAT}&lon=${LON}` +
      `&fromtime=${fmt(fromTime)}&totime=${fmt(toTime)}` +
      `&datatype=TAB&refcode=CD&interval=60` +
      `&lang=nn&dst=1&tzone=UTC&tide_request=locationdata`;

    // --- Vær: Open-Meteo ---
    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}` +
      `&hourly=temperature_2m,precipitation,windspeed_10m,winddirection_10m,weathercode` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max` +
      `&timezone=Europe%2FOslo&forecast_days=8`;

    const [tideRes, weatherRes] = await Promise.all([
      fetch(tideUrl).catch(e => ({ ok: false, text: async () => '', _err: e.message })),
      fetch(weatherUrl),
    ]);

    if (!weatherRes.ok) throw new Error(`Open-Meteo ${weatherRes.status}`);
    const weather = await weatherRes.json();

    // Parse tidevann-XML (graceful fallback hvis Kartverket feiler)
    let tideData = [];
    if (tideRes.ok) {
      const tideXml = await tideRes.text();
      tideData = parseTideXml(tideXml);
    }

    // Beregn fiskeindeks per time
    const hourlyScores = calcHourlyScores(weather, tideData, now);

    // 7-dagers daglig oppsummering
    const daily = (weather.daily?.time ?? []).map((date, i) => ({
      date,
      tempMax: weather.daily.temperature_2m_max?.[i] ?? null,
      tempMin: weather.daily.temperature_2m_min?.[i] ?? null,
      rain: weather.daily.precipitation_sum?.[i] ?? null,
      wcode: weather.daily.weathercode?.[i] ?? null,
      windMax: weather.daily.windspeed_10m_max?.[i] ?? null,
      bestScore: getBestScoreForDay(hourlyScores, date),
      bestHour: getBestHourForDay(hourlyScores, date),
    }));

    const currentHour = now.getHours();
    const currentScore = hourlyScores[currentHour] ?? null;

    return new Response(
      JSON.stringify({
        ok: true,
        currentScore,
        hourlyScores,
        tideData,
        daily,
        weather: {
          temp: weather.hourly?.temperature_2m?.[currentHour] ?? null,
          wind: weather.hourly?.windspeed_10m?.[currentHour] ?? null,
          windDir: weather.hourly?.winddirection_10m?.[currentHour] ?? null,
          rain: weather.hourly?.precipitation?.[currentHour] ?? null,
          wcode: weather.hourly?.weathercode?.[currentHour] ?? null,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "max-age=1800",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

function parseTideXml(xml) {
  const entries = [];
  const regex = /<waterlevel[^>]*time="([^"]+)"[^>]*value="([^"]+)"[^>]*flag="([^"]*)"[^>]*/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    entries.push({
      time: m[1],
      value: parseFloat(m[2]),
      flag: m[3], // "high" | "low" | ""
    });
  }
  return entries;
}

function calcHourlyScores(weather, tideData, now) {
  const scores = {};
  const hours = weather.hourly?.time ?? [];

  // Finn tidevanns-høyvann/lavvann-tidspunkter
  const extremes = tideData.filter((t) => t.flag === "high" || t.flag === "low");

  hours.forEach((timeStr, i) => {
    const hour = new Date(timeStr).getHours();
    const date = timeStr.slice(0, 10);
    const key = `${date}T${String(hour).padStart(2, "0")}`;

    // Tidevann-score: høy poengsum nær høy/lavvann (±2 timer)
    let tideScore = 30;
    const hourMs = new Date(timeStr).getTime();
    for (const ex of extremes) {
      const exMs = new Date(ex.time).getTime();
      const diffH = Math.abs(hourMs - exMs) / 3600000;
      if (diffH <= 2) {
        tideScore = Math.max(tideScore, Math.round(100 - diffH * 25));
      }
    }

    // Vind-score
    const wind = weather.hourly?.windspeed_10m?.[i] ?? 10;
    const windScore =
      wind <= 3 ? 100 :
      wind <= 6 ? 80 :
      wind <= 10 ? 55 :
      wind <= 15 ? 30 : 10;

    // Nedbør-score
    const rain = weather.hourly?.precipitation?.[i] ?? 0;
    const rainScore = rain === 0 ? 100 : rain < 1 ? 80 : rain < 3 ? 55 : 30;

    // Tid-score (morgen/kveld best)
    const timeScore =
      (hour >= 5 && hour <= 8) ? 100 :
      (hour >= 19 && hour <= 22) ? 95 :
      (hour >= 9 && hour <= 11) ? 75 :
      (hour >= 15 && hour <= 18) ? 70 :
      (hour >= 12 && hour <= 14) ? 55 : 40;

    const total = Math.round(
      tideScore * 0.40 +
      windScore * 0.30 +
      timeScore * 0.20 +
      rainScore * 0.10
    );

    scores[key] = { total, tideScore, windScore, rainScore, timeScore, wind, rain };
  });

  return scores;
}

function getBestScoreForDay(hourlyScores, date) {
  const entries = Object.entries(hourlyScores).filter(([k]) => k.startsWith(date));
  if (!entries.length) return null;
  return Math.max(...entries.map(([, v]) => v.total));
}

function getBestHourForDay(hourlyScores, date) {
  const entries = Object.entries(hourlyScores).filter(([k]) => k.startsWith(date));
  if (!entries.length) return null;
  const best = entries.reduce((a, b) => (b[1].total > a[1].total ? b : a));
  return parseInt(best[0].slice(11, 13));
}

export const config = { path: "/api/fiske" };
