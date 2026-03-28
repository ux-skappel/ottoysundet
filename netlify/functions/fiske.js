// netlify/functions/fiske.js
// Ottøysundet, Sandsfjorden — koordinater
const LAT = 59.485;
const LON = 6.245;

// -------------------------------------------------------------------
// Harmonisk tidevannsberegning for Stavanger (nærmeste hovudstasjon)
// Konstanter frå Kartverket / IHO-datablad for Stavanger
// -------------------------------------------------------------------
const TIDE_CONSTITUENTS = [
  { name: 'M2',  amp: 0.295, speed: 28.9841042, phase: 78.0  },
  { name: 'S2',  amp: 0.091, speed: 30.0000000, phase: 102.0 },
  { name: 'N2',  amp: 0.055, speed: 28.4397295, phase: 55.0  },
  { name: 'K2',  amp: 0.025, speed: 30.0821373, phase: 108.0 },
  { name: 'K1',  amp: 0.038, speed: 15.0410686, phase: 210.0 },
  { name: 'O1',  amp: 0.020, speed: 13.9430356, phase: 195.0 },
  { name: 'P1',  amp: 0.012, speed: 14.9589314, phase: 208.0 },
  { name: 'Q1',  amp: 0.006, speed: 13.3986609, phase: 180.0 },
  { name: 'M4',  amp: 0.012, speed: 57.9682084, phase: 160.0 },
];
const TIDE_MEAN = 0.72; // middelvannstand over CD (cm → m, Stavanger ~72cm)

function calcTideHeight(dateMs) {
  const t = (dateMs - Date.UTC(1900, 0, 1)) / 3600000; // timar sidan 1900-01-01
  return TIDE_MEAN + TIDE_CONSTITUENTS.reduce((sum, c) => {
    const rad = (c.speed * t - c.phase) * Math.PI / 180;
    return sum + c.amp * Math.cos(rad);
  }, 0);
}

function buildTideData(fromMs, hoursCount) {
  const entries = [];
  for (let i = 0; i <= hoursCount; i++) {
    const ms = fromMs + i * 3600000;
    entries.push({ time: new Date(ms).toISOString(), value: calcTideHeight(ms) * 100, flag: '' });
  }
  // Finn lokale minimum/maksimum og merk dei
  for (let i = 1; i < entries.length - 1; i++) {
    const prev = entries[i - 1].value;
    const cur  = entries[i].value;
    const next = entries[i + 1].value;
    if (cur > prev && cur > next) entries[i].flag = 'high';
    else if (cur < prev && cur < next) entries[i].flag = 'low';
  }
  return entries;
}

export default async (req) => {
  try {
    const now = new Date();
    const fromTime = new Date(now);
    fromTime.setHours(0, 0, 0, 0);

    // --- Tidevann: harmonisk beregning (ingen ekstern API) ---
    const tideData = buildTideData(fromTime.getTime(), 8 * 24);

    // --- Vær: Open-Meteo ---
    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}` +
      `&hourly=temperature_2m,precipitation,windspeed_10m,winddirection_10m,weathercode` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max` +
      `&timezone=Europe%2FOslo&forecast_days=8`;

    const weatherRes = await fetch(weatherUrl);
    if (!weatherRes.ok) throw new Error(`Open-Meteo ${weatherRes.status}`);
    const weather = await weatherRes.json();

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
