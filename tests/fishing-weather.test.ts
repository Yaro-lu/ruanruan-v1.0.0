import assert from 'node:assert/strict';
import test from 'node:test';
import { createFishingWeatherClient, DEFAULT_FISHING_LOCATION, type FishingWeatherInput } from '../src/fishing-weather.js';

const clock = Date.parse('2026-11-05T02:15:00Z');
function forecast() {
  const times = Array.from({ length: 96 }, (_, index) => new Date(Date.UTC(2026, 10, 4) + index * 3_600_000).toISOString().slice(0, 16));
  return {
    timezone: 'Asia/Shanghai',
    current: { time: '2026-11-05T10:15', interval: 900, temperature_2m: 18.4, precipitation: 0,
      wind_speed_10m: 0, wind_direction_10m: 90, wind_gusts_10m: 3.2, surface_pressure: 1008.2, pressure_msl: 1012.4 },
    hourly: { time: times, temperature_2m: times.map((_, i) => 10 + i / 2), precipitation: times.map(() => 0),
      precipitation_probability: times.map(() => 30), wind_speed_10m: times.map(() => 2), wind_direction_10m: times.map(() => 90),
      wind_gusts_10m: times.map(() => 5), surface_pressure: times.map((_, i) => 1000 + i / 10), pressure_msl: times.map((_, i) => 1010 + i / 10) },
    daily: { time: ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'], temperature_2m_min: [1, 2, 3, 4],
      temperature_2m_max: [11, 12, 13, 14], precipitation_sum: [0, 1, 2, 3], precipitation_probability_max: [20, 30, 40, 50],
      wind_speed_10m_max: [2, 3, 4, 5], wind_direction_10m_dominant: [0, 90, 180, 270],
      surface_pressure_mean: [1000, 1001, 1002, 1003], pressure_msl_mean: [1010, 1011, 1012, 1013] },
  };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => handler(new URL(String(input)), init)) as typeof fetch;
}

test('default Pukou fetch retains units, valid times, unknowns and distinct pressure trends', async () => {
  let calls = 0;
  const client = createFishingWeatherClient({ now: () => clock, fetch: mockFetch(url => {
    calls++;
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.get('latitude'), String(DEFAULT_FISHING_LOCATION.latitude));
    assert.equal(url.searchParams.get('longitude'), String(DEFAULT_FISHING_LOCATION.longitude));
    assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai');
    assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
    assert.equal(url.searchParams.get('past_days'), '1');
    assert.match(url.searchParams.get('hourly')!, /surface_pressure,pressure_msl/);
    return response(forecast());
  }) });
  const result = await client();
  assert.equal(calls, 1, 'default position never requires geocoding');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.current.time, '2026-11-05T10:15+08:00');
  assert.equal(result.current.temperatureC, 18.4);
  assert.equal(result.current.windSpeedMs, 0);
  assert.equal(result.current.precipitationMm, 0);
  assert.equal(result.current.precipitationProbabilityPct, null);
  assert.equal(result.current.surfacePressureHpa, 1008.2);
  assert.equal(result.current.seaLevelPressureHpa, 1012.4);
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly[0].time, '2026-11-05T11:00+08:00');
  assert.deepEqual(result.daily.map(row => row.date), ['2026-11-05', '2026-11-06', '2026-11-07']);
  assert.equal(result.daily[0].surfacePressureMeanHpa, 1001);
  assert.equal(result.daily[0].seaLevelPressureMeanHpa, 1011);
  assert.equal(result.trend.past3h?.temperatureChangeC, 1.5);
  assert.equal(result.trend.past3h?.surfacePressureChangeHpa, 0.3);
  assert.equal(result.trend.next6h?.seaLevelPressureChangeHpa, 0.6);
  assert.equal(result.fetchedAt, new Date(clock).toISOString());
  assert.equal(result.source.modelUpdatedAt, null);
  assert.match(result.notes.join('\n'), /不代表鱼口/);
  assert.match(result.notes.join('\n'), /没有水温、溶氧/);
});

test('short cache coalesces in-flight work, expires and does not leak caller mutations', async () => {
  let calls = 0, time = clock;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = createFishingWeatherClient({ now: () => time, cacheTtlMs: 1000, fetch: mockFetch(async () => {
    calls++;
    await gate;
    return response(forecast());
  }) });
  const first = client(), second = client();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  a.current.temperatureC = -999;
  assert.equal(b.current.temperatureC, 18.4);
  const cached = await client();
  assert.equal(cached.ok && cached.cacheHit, true);
  assert.equal(cached.ok && cached.current.temperatureC, 18.4);
  time += 1001;
  assert.equal((await client()).ok, true);
  assert.equal(calls, 2);
});

test('explicit coordinates bypass geocoding and invalid inputs cannot hit the default cache', async () => {
  const urls: URL[] = [];
  const client = createFishingWeatherClient({ fetch: mockFetch(url => { urls.push(url); return response(forecast()); }) });
  await client();
  for (const input of [{ latitude: NaN }, { latitude: null }, { latitude: 20 }, { latitude: 91, longitude: 118 },
    { latitude: 20, longitude: 181 }, { forecastDays: 0 }, { hourlyHours: 169 }, { location: 123 }]) {
    const result = await client(input as FishingWeatherInput);
    assert.equal(result.ok ? 'unexpected success' : result.error.code, 'invalid_input');
  }
  const result = await client({ location: '河边钓点', latitude: 32.123, longitude: 118.456, hourlyHours: 72, forecastDays: 1 });
  assert.equal(result.ok && result.location.resolution, 'coordinates');
  assert.equal(urls.length, 2);
  assert.equal(urls[1].hostname, 'api.open-meteo.com');
  assert.equal(urls[1].searchParams.get('latitude'), '32.123');
  assert.equal(urls[1].searchParams.get('forecast_days'), '4');
});

test('named places resolve once and ambiguous names return choices without making a forecast', async () => {
  const calls: string[] = [];
  let time = clock;
  const client = createFishingWeatherClient({ now: () => time, cacheTtlMs: 100, fetch: mockFetch(url => {
    calls.push(url.hostname);
    if (url.hostname === 'api.open-meteo.com') return response(forecast());
    const place = { name: '某镇', country: '中国', admin1: '江苏', admin2: '南京', latitude: 32, longitude: 118 };
    const name = url.searchParams.get('name');
    return response({ results: name === '无此地点' ? [] : name === '同名地点' ? [place, { ...place, admin2: '苏州', longitude: 120 }] : [place] });
  }) });
  const first = await client({ location: '南京某镇' });
  assert.equal(first.ok && first.location.name, '中国 · 江苏 · 南京 · 某镇');
  time += 101;
  await client({ location: '南京某镇' });
  assert.deepEqual(calls, ['geocoding-api.open-meteo.com', 'api.open-meteo.com', 'api.open-meteo.com']);
  const ambiguous = await client({ location: '同名地点' });
  assert.equal(ambiguous.ok ? '' : ambiguous.error.code, 'ambiguous_location');
  assert.equal(ambiguous.ok ? 0 : ambiguous.error.candidates?.length, 2);
  const missing = await client({ location: '无此地点' });
  assert.equal(missing.ok ? '' : missing.error.code, 'location_not_found');
  assert.equal(calls.filter(host => host === 'api.open-meteo.com').length, 2);
});

test('network, HTTP, invalid response and timeout failures remain structured and are not cached', async () => {
  for (const [fetcher, expected] of [
    [mockFetch(() => response({}, 503)), 'http_error'],
    [mockFetch(() => { throw new Error('private network detail'); }), 'network_error'],
    [mockFetch(() => response({ timezone: 'UTC' })), 'invalid_response'],
    [mockFetch(() => response({ ...forecast(), hourly: { time: [] } })), 'invalid_response'],
    [mockFetch((_, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))), 'timeout'],
  ] as const) {
    const client = createFishingWeatherClient({ fetch: fetcher, timeoutMs: 5 });
    const result = await client();
    assert.equal(result.ok ? '' : result.error.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /private network detail/);
  }
  let calls = 0;
  const recovering = createFishingWeatherClient({ fetch: mockFetch(() => ++calls === 1 ? response({}, 503) : response(forecast())) });
  assert.equal((await recovering()).ok, false);
  assert.equal((await recovering()).ok, true);
  assert.equal(calls, 2);
});
