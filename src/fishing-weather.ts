// Forecast variables and time semantics: https://open-meteo.com/en/docs
// Named locations: https://open-meteo.com/en/docs/geocoding-api
export interface FishingWeatherInput {
  location?: string;
  latitude?: number;
  longitude?: number;
  forecastDays?: number;
  hourlyHours?: number;
}
export interface FishingWeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
  resolution: 'default-area' | 'coordinates' | 'geocoding';
}
export interface FishingWeatherPoint {
  time: string;
  temperatureC: number | null;
  precipitationMm: number | null;
  precipitationProbabilityPct: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  windGustsMs: number | null;
  surfacePressureHpa: number | null;
  seaLevelPressureHpa: number | null;
}
interface WeatherChange {
  from: string;
  to: string;
  temperatureChangeC: number | null;
  surfacePressureChangeHpa: number | null;
  seaLevelPressureChangeHpa: number | null;
}
export interface FishingWeatherSuccess {
  ok: true;
  location: FishingWeatherLocation;
  timezone: 'Asia/Shanghai';
  fetchedAt: string;
  source: { name: 'Open-Meteo'; url: string; documentation: string; modelUpdatedAt: null };
  cacheHit: boolean;
  current: FishingWeatherPoint & { intervalSeconds: number | null };
  hourly: FishingWeatherPoint[];
  daily: Array<{
    date: string; temperatureMinC: number | null; temperatureMaxC: number | null;
    precipitationSumMm: number | null; precipitationProbabilityMaxPct: number | null;
    windSpeedMaxMs: number | null; windDirectionDominantDeg: number | null;
    surfacePressureMeanHpa: number | null; seaLevelPressureMeanHpa: number | null;
  }>;
  trend: { basis: 'hourly-model-data'; asOf: string; past3h: WeatherChange | null; next6h: WeatherChange | null };
  notes: string[];
}
export interface FishingWeatherFailure {
  ok: false;
  error: { code: 'invalid_input' | 'location_not_found' | 'ambiguous_location' | 'timeout' | 'http_error' | 'network_error' | 'invalid_response';
    message: string; status?: number; candidates?: FishingWeatherLocation[] };
}
export type FishingWeatherResult = FishingWeatherSuccess | FishingWeatherFailure;

// WGS84 reference point, not a waterbody or the user's exact fishing spot.
// https://api.openstreetmap.org/api/0.6/node/9638821219 (浦口区人民政府)
export const DEFAULT_FISHING_LOCATION: FishingWeatherLocation = {
  name: '江苏省南京市浦口区（区政府附近区域参考点）', latitude: 32.061976, longitude: 118.621616, resolution: 'default-area',
};
const defaults = new Set(['浦口', '浦口区', '南京浦口', '南京浦口区', '南京市浦口区', '江苏南京浦口', '江苏省南京市浦口区']);
const variables = ['temperature_2m', 'precipitation', 'precipitation_probability', 'wind_speed_10m',
  'wind_direction_10m', 'wind_gusts_10m', 'surface_pressure', 'pressure_msl'];
const dailyVariables = ['temperature_2m_min', 'temperature_2m_max', 'precipitation_sum', 'precipitation_probability_max',
  'wind_speed_10m_max', 'wind_direction_10m_dominant', 'surface_pressure_mean', 'pressure_msl_mean'];
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const localTime = (value: unknown): string => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(string(value)) ? `${value}+08:00` : '';
const at = (data: JsonObject, field: string, index: number) => number(Array.isArray(data[field]) ? data[field][index] : null);
const fail = (code: FishingWeatherFailure['error']['code'], message: string, extra: Partial<FishingWeatherFailure['error']> = {}): FishingWeatherFailure =>
  ({ ok: false, error: { code, message, ...extra } });

function point(data: JsonObject, index?: number): FishingWeatherPoint {
  const value = (key: string) => index === undefined ? number(data[key]) : at(data, key, index);
  return { time: localTime(index === undefined ? data.time : (data.time as unknown[])[index]),
    temperatureC: value('temperature_2m'), precipitationMm: value('precipitation'), precipitationProbabilityPct: value('precipitation_probability'),
    windSpeedMs: value('wind_speed_10m'), windDirectionDeg: value('wind_direction_10m'), windGustsMs: value('wind_gusts_10m'),
    surfacePressureHpa: value('surface_pressure'), seaLevelPressureHpa: value('pressure_msl') };
}
function change(from?: FishingWeatherPoint, to?: FishingWeatherPoint): WeatherChange | null {
  if (!from || !to) return null;
  const delta = (a: number | null, b: number | null) => a === null || b === null ? null : Math.round((b - a) * 10) / 10;
  return { from: from.time, to: to.time, temperatureChangeC: delta(from.temperatureC, to.temperatureC),
    surfacePressureChangeHpa: delta(from.surfacePressureHpa, to.surfacePressureHpa), seaLevelPressureChangeHpa: delta(from.seaLevelPressureHpa, to.seaLevelPressureHpa) };
}

/** A separate client makes mocked network/clock tests independent of production caches. */
export function createFishingWeatherClient(options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; cacheTtlMs?: number } = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? 5 * 60_000;
  const cache = new Map<string, { until: number; value: FishingWeatherSuccess }>();
  const locations = new Map<string, { until: number; value: FishingWeatherLocation }>();
  const pending = new Map<string, Promise<FishingWeatherResult>>();

  async function json(url: URL): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
    try {
      const response = await request(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw fail('http_error', '天气服务暂时不可用', { status: response.status });
      let body: JsonObject;
      try { body = object(await response.json()); } catch { throw fail('invalid_response', '天气服务返回了无法解析的数据'); }
      if (body.error) throw fail('invalid_response', '天气服务未返回所请求的数据');
      return body;
    } catch (error) {
      if (controller.signal.aborted || ['AbortError', 'TimeoutError'].includes((error as Error)?.name)) throw fail('timeout', '天气查询超时，当前天气未知');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function resolve(input: FishingWeatherInput): Promise<FishingWeatherLocation> {
    if (input.latitude !== undefined || input.longitude !== undefined) {
      return { name: input.location?.trim() || '指定坐标', latitude: input.latitude!, longitude: input.longitude!, resolution: 'coordinates' };
    }
    const name = input.location?.trim() ?? '';
    if (!name || defaults.has(name)) return { ...DEFAULT_FISHING_LOCATION };
    if (name.length < 2 || name.length > 120) throw fail('invalid_input', '地点名称应为2～120个字符，或直接提供经纬度');
    const cached = locations.get(name);
    if (cached && cached.until > now()) return cached.value;
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '5', language: 'zh', format: 'json' }).toString();
    const data = await json(url);
    const matches = (Array.isArray(data.results) ? data.results : []).map(object)
      .filter(value => number(value.latitude) !== null && number(value.longitude) !== null)
      .map(value => ({ name: [...new Set([value.country, value.admin1, value.admin2, value.name].map(string).filter(Boolean))].join(' · '),
        latitude: value.latitude as number, longitude: value.longitude as number, resolution: 'geocoding' as const }));
    if (!matches.length) throw fail('location_not_found', '未找到这个地点，请补充城市、行政区或经纬度');
    if (matches.length > 1) throw fail('ambiguous_location', '这个地名对应多个地点，请确认行政区或使用经纬度', { candidates: matches });
    if (locations.size >= 64) locations.delete(locations.keys().next().value!);
    locations.set(name, { until: now() + 60 * 60_000, value: matches[0] });
    return matches[0];
  }

  async function load(input: FishingWeatherInput): Promise<FishingWeatherResult> {
    try {
      const days = input.forecastDays ?? 3, hours = input.hourlyHours ?? 24;
      const location = await resolve(input);
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude),
        timezone: 'Asia/Shanghai', temperature_unit: 'celsius', wind_speed_unit: 'ms', precipitation_unit: 'mm',
        current: variables.join(','), hourly: variables.join(','), daily: dailyVariables.join(','), past_days: '1',
        forecast_days: String(Math.max(days, Math.ceil(hours / 24) + 1)) }).toString();
      const body = await json(url), currentData = object(body.current), hourlyData = object(body.hourly), dailyData = object(body.daily);
      if (body.timezone !== 'Asia/Shanghai' || !localTime(currentData.time) || !Array.isArray(hourlyData.time) || !hourlyData.time.length || !Array.isArray(dailyData.time) || !dailyData.time.length)
        return fail('invalid_response', '天气服务缺少时间或预报数据');
      const current = { ...point(currentData), intervalSeconds: number(currentData.interval) };
      const allHours = hourlyData.time.map((_, index) => point(hourlyData, index)).filter(row => row.time);
      const currentMs = Date.parse(current.time);
      const anchor = allHours.filter(row => Date.parse(row.time) <= currentMs).at(-1);
      const hourAt = (offset: number) => anchor && allHours.find(row => Date.parse(row.time) === Date.parse(anchor.time) + offset * 3_600_000);
      const today = current.time.slice(0, 10);
      return { ok: true, location, timezone: 'Asia/Shanghai', fetchedAt: new Date(now()).toISOString(), cacheHit: false,
        source: { name: 'Open-Meteo', url: url.toString(), documentation: 'https://open-meteo.com/en/docs', modelUpdatedAt: null },
        current, hourly: allHours.filter(row => Date.parse(row.time) >= currentMs).slice(0, hours),
        daily: dailyData.time.map((date, index) => ({ date: string(date), temperatureMinC: at(dailyData, 'temperature_2m_min', index),
          temperatureMaxC: at(dailyData, 'temperature_2m_max', index), precipitationSumMm: at(dailyData, 'precipitation_sum', index),
          precipitationProbabilityMaxPct: at(dailyData, 'precipitation_probability_max', index), windSpeedMaxMs: at(dailyData, 'wind_speed_10m_max', index),
          windDirectionDominantDeg: at(dailyData, 'wind_direction_10m_dominant', index), surfacePressureMeanHpa: at(dailyData, 'surface_pressure_mean', index),
          seaLevelPressureMeanHpa: at(dailyData, 'pressure_msl_mean', index) })).filter(row => row.date >= today).slice(0, days),
        trend: { basis: 'hourly-model-data', asOf: anchor?.time ?? current.time, past3h: change(hourAt(-3), anchor), next6h: change(anchor, hourAt(6)) },
        notes: ['当前天气是气象模式估计；抓取时间不是模式发布时间，接口未提供单一模式更新时间。',
          '温度为空气温度；地面气压与海平面气压分别提供，不能混作同一数值。',
          '逐小时降水量与概率对应该时刻之前一小时；概率是降水超过0.1毫米的可能性，不代表鱼口或上鱼保证。',
          '没有水温、溶氧或现场水情数据，不能据天气伪造这些数值；默认位置只代表浦口城区附近，实际钓点可指定坐标。'] };
    } catch (error) {
      if (error && typeof error === 'object' && 'ok' in error && (error as FishingWeatherFailure).ok === false) return error as FishingWeatherFailure;
      return fail('network_error', '天气服务连接失败，当前天气未知');
    }
  }

  return async (input: FishingWeatherInput = {}): Promise<FishingWeatherResult> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.location !== undefined && typeof input.location !== 'string')) return fail('invalid_input', '地点参数格式不正确');
    if ((input.latitude !== undefined || input.longitude !== undefined)
      && (number(input.latitude) === null || number(input.longitude) === null || Math.abs(input.latitude!) > 90 || Math.abs(input.longitude!) > 180))
      return fail('invalid_input', '请同时提供有效纬度（-90～90）和经度（-180～180）');
    const days = input.forecastDays ?? 3, hours = input.hourlyHours ?? 24;
    if (!Number.isInteger(days) || days < 1 || days > 7 || !Number.isInteger(hours) || hours < 1 || hours > 168)
      return fail('invalid_input', 'forecastDays须为1～7，hourlyHours须为1～168');
    const key = JSON.stringify([input.location?.trim() ?? '', input.latitude, input.longitude, input.forecastDays ?? 3, input.hourlyHours ?? 24]);
    const entry = cache.get(key);
    if (entry && entry.until > now()) return { ...structuredClone(entry.value), cacheHit: true };
    if (pending.has(key)) return structuredClone(await pending.get(key)!);
    const work = load(input);
    pending.set(key, work);
    try {
      const result = await work;
      if (result.ok) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(key, { until: now() + ttl, value: structuredClone(result) });
      }
      return result;
    } finally { pending.delete(key); }
  };
}

export const fetchFishingWeather = createFishingWeatherClient();
