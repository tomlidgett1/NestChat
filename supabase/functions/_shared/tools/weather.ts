import type { ToolContract } from './types.ts';
import { getOptionalEnv } from '../env.ts';

const WEATHER_API_BASE = 'https://weather.googleapis.com/v1';
const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ═══════════════════════════════════════════════════════════════
// Current Conditions
// ═══════════════════════════════════════════════════════════════

interface WeatherResult {
  location: string;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

async function getCurrentConditions(
  apiKey: string,
  lat: number,
  lng: number,
  locationName: string,
): Promise<WeatherResult> {
  const url = `${WEATHER_API_BASE}/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}`;

  console.log(`[weather] Current conditions: ${locationName} (${lat}, ${lng})`);

  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[weather] API error ${resp.status}: ${text}`);
    return { location: locationName, error: `Weather API returned ${resp.status}. ${text.slice(0, 200)}` };
  }
  // deno-lint-ignore no-explicit-any
  const data: any = await resp.json();

  if (data.error) {
    return { location: locationName, error: data.error.message ?? `Weather API error: ${data.error.status}` };
  }

  const result: WeatherResult = {
    location: locationName,
    type: 'current_conditions',
    time: data.currentTime,
    timezone: data.timeZone?.id,
    is_daytime: data.isDaytime,
    condition: data.weatherCondition?.description?.text,
    condition_type: data.weatherCondition?.type,
  };

  if (data.temperature) {
    result.temperature_c = data.temperature.degrees;
  }
  if (data.feelsLikeTemperature) {
    result.feels_like_c = data.feelsLikeTemperature.degrees;
  }
  if (data.relativeHumidity !== undefined) {
    result.humidity_percent = data.relativeHumidity;
  }
  if (data.uvIndex !== undefined) {
    result.uv_index = data.uvIndex;
  }
  if (data.precipitation) {
    result.rain_probability_percent = data.precipitation.probability?.percent;
    result.rain_type = data.precipitation.probability?.type;
    result.precipitation_mm = data.precipitation.qpf?.quantity;
  }
  if (data.thunderstormProbability !== undefined) {
    result.thunderstorm_probability = data.thunderstormProbability;
  }
  if (data.wind) {
    result.wind_speed_kmh = data.wind.speed?.value;
    result.wind_direction = data.wind.direction?.cardinal;
    result.wind_gust_kmh = data.wind.gust?.value;
  }
  if (data.windChill) {
    result.wind_chill_c = data.windChill.degrees;
  }
  if (data.visibility) {
    result.visibility_km = data.visibility.distance;
  }
  if (data.cloudCover !== undefined) {
    result.cloud_cover_percent = data.cloudCover;
  }
  if (data.airPressure) {
    result.pressure_hpa = data.airPressure.meanSeaLevelMillibars;
  }
  if (data.currentConditionsHistory) {
    const hist = data.currentConditionsHistory;
    result.last_24h = {
      temp_change_c: hist.temperatureChange?.degrees,
      max_temp_c: hist.maxTemperature?.degrees,
      min_temp_c: hist.minTemperature?.degrees,
      precipitation_mm: hist.qpf?.quantity,
    };
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Daily Forecast
// ═══════════════════════════════════════════════════════════════

async function getDailyForecast(
  apiKey: string,
  lat: number,
  lng: number,
  locationName: string,
  days: number,
): Promise<WeatherResult> {
  const url = `${WEATHER_API_BASE}/forecast/days:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}&days=${days}`;

  console.log(`[weather] Daily forecast (${days}d): ${locationName} (${lat}, ${lng})`);

  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[weather] API error ${resp.status}: ${text}`);
    return { location: locationName, error: `Weather API returned ${resp.status}. ${text.slice(0, 200)}` };
  }
  // deno-lint-ignore no-explicit-any
  const data: any = await resp.json();

  if (data.error) {
    return { location: locationName, error: data.error.message ?? `Weather API error: ${data.error.status}` };
  }

  console.log(`[weather] Daily forecast response keys: ${Object.keys(data).join(', ')}, forecastDays count: ${data.forecastDays?.length ?? 0}`);

  // deno-lint-ignore no-explicit-any
  const forecastDays = (data.forecastDays ?? []).map((day: any) => {
    // deno-lint-ignore no-explicit-any
    const entry: any = {
      date: day.displayDate
        ? `${day.displayDate.year}-${String(day.displayDate.month).padStart(2, '0')}-${String(day.displayDate.day).padStart(2, '0')}`
        : undefined,
      max_temp_c: day.maxTemperature?.degrees,
      min_temp_c: day.minTemperature?.degrees,
      feels_like_max_c: day.feelsLikeMaxTemperature?.degrees,
      feels_like_min_c: day.feelsLikeMinTemperature?.degrees,
    };

    if (day.daytimeForecast) {
      const dt = day.daytimeForecast;
      entry.daytime = {
        condition: dt.weatherCondition?.description?.text,
        condition_type: dt.weatherCondition?.type,
        rain_probability_percent: dt.precipitation?.probability?.percent,
        rain_type: dt.precipitation?.probability?.type,
        precipitation_mm: dt.precipitation?.qpf?.quantity,
        humidity_percent: dt.relativeHumidity,
        uv_index: dt.uvIndex,
        wind_speed_kmh: dt.wind?.speed?.value,
        wind_direction: dt.wind?.direction?.cardinal,
        wind_gust_kmh: dt.wind?.gust?.value,
        cloud_cover_percent: dt.cloudCover,
        thunderstorm_probability: dt.thunderstormProbability,
      };
    }

    if (day.nighttimeForecast) {
      const nt = day.nighttimeForecast;
      entry.nighttime = {
        condition: nt.weatherCondition?.description?.text,
        condition_type: nt.weatherCondition?.type,
        rain_probability_percent: nt.precipitation?.probability?.percent,
        rain_type: nt.precipitation?.probability?.type,
        precipitation_mm: nt.precipitation?.qpf?.quantity,
        humidity_percent: nt.relativeHumidity,
        wind_speed_kmh: nt.wind?.speed?.value,
        wind_direction: nt.wind?.direction?.cardinal,
        cloud_cover_percent: nt.cloudCover,
      };
    }

    if (day.sunEvents) {
      entry.sunrise = day.sunEvents.sunriseTime;
      entry.sunset = day.sunEvents.sunsetTime;
    }

    return entry;
  });

  return {
    location: locationName,
    type: 'daily_forecast',
    timezone: data.timeZone?.id,
    days: forecastDays,
  };
}

// ═══════════════════════════════════════════════════════════════
// Hourly Forecast
// ═══════════════════════════════════════════════════════════════

async function getHourlyForecast(
  apiKey: string,
  lat: number,
  lng: number,
  locationName: string,
  hours: number,
): Promise<WeatherResult> {
  const url = `${WEATHER_API_BASE}/forecast/hours:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}&hours=${hours}`;

  console.log(`[weather] Hourly forecast (${hours}h): ${locationName} (${lat}, ${lng})`);

  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[weather] API error ${resp.status}: ${text}`);
    return { location: locationName, error: `Weather API returned ${resp.status}. ${text.slice(0, 200)}` };
  }
  // deno-lint-ignore no-explicit-any
  const data: any = await resp.json();

  if (data.error) {
    return { location: locationName, error: data.error.message ?? `Weather API error: ${data.error.status}` };
  }

  // deno-lint-ignore no-explicit-any
  const forecastHours = (data.forecastHours ?? []).map((hour: any) => {
    // deno-lint-ignore no-explicit-any
    const entry: any = {
      time: hour.displayDateTime
        ? `${hour.displayDateTime.hours}:00`
        : undefined,
      is_daytime: hour.isDaytime,
      condition: hour.weatherCondition?.description?.text,
      condition_type: hour.weatherCondition?.type,
      temperature_c: hour.temperature?.degrees,
      feels_like_c: hour.feelsLikeTemperature?.degrees,
      rain_probability_percent: hour.precipitation?.probability?.percent,
      rain_type: hour.precipitation?.probability?.type,
      precipitation_mm: hour.precipitation?.qpf?.quantity,
      humidity_percent: hour.relativeHumidity,
      wind_speed_kmh: hour.wind?.speed?.value,
      wind_direction: hour.wind?.direction?.cardinal,
      wind_gust_kmh: hour.wind?.gust?.value,
      cloud_cover_percent: hour.cloudCover,
      uv_index: hour.uvIndex,
    };

    return entry;
  });

  return {
    location: locationName,
    type: 'hourly_forecast',
    timezone: data.timeZone?.id,
    hours: forecastHours,
  };
}

// ═══════════════════════════════════════════════════════════════
// Geocoding — resolve location name to lat/lng via Places API
// ═══════════════════════════════════════════════════════════════

async function geocodeLocation(
  apiKey: string,
  location: string,
): Promise<{ lat: number; lng: number; name: string } | null> {
  // Primary: Places Text Search API (Geocoding API may not be enabled)
  const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(location)}&key=${apiKey}`;
  try {
    const resp = await fetchWithTimeout(placesUrl);
    // deno-lint-ignore no-explicit-any
    const data: any = await resp.json();
    if (data.status === 'OK' && data.results?.length) {
      const r = data.results[0];
      return {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        name: r.formatted_address ?? location,
      };
    }
    console.warn(`[weather] Places API returned ${data.status} for "${location}" — trying Nominatim fallback`);
  } catch (e) {
    console.warn(`[weather] Places API failed: ${(e as Error).message} — trying Nominatim fallback`);
  }

  // Fallback: Nominatim (OpenStreetMap) — no key required
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const resp = await fetchWithTimeout(nomUrl, { headers: { 'User-Agent': 'NestApp/1.0' } });
    // deno-lint-ignore no-explicit-any
    const data: any = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        name: data[0].display_name ?? location,
      };
    }
  } catch (e) {
    console.warn(`[weather] Nominatim fallback failed: ${(e as Error).message}`);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const weatherTool: ToolContract = {
  name: 'weather_lookup',
  description:
    'Get weather information for a location. Supports current conditions, daily forecast (up to 10 days), and hourly forecast (up to 24 hours). Use for "what\'s the weather", "will it rain", "temperature in X", "forecast for the week", "is it going to be hot tomorrow", "should I bring an umbrella".',
  namespace: 'weather.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      location: {
        type: 'string',
        description: 'Location name, city, suburb, or address (e.g. "Melbourne", "Sydney CBD", "Bondi Beach"). If the user hasn\'t specified a location, use their known home city or default to their timezone region.',
      },
      type: {
        type: 'string',
        enum: ['current', 'daily_forecast', 'hourly_forecast'],
        description: "Type of weather data. 'current' for right now, 'daily_forecast' for multi-day outlook, 'hourly_forecast' for hour-by-hour detail. Default 'current'. Use 'daily_forecast' for questions about tomorrow, this week, next few days. Use 'hourly_forecast' for questions about rain timing, when it will clear up, next few hours.",
      },
      days: {
        type: 'number',
        description: 'Number of days for daily forecast (1-10, default 3). Only used with type "daily_forecast".',
      },
      hours: {
        type: 'number',
        description: 'Number of hours for hourly forecast (1-24, default 12). Only used with type "hourly_forecast".',
      },
    },
    required: ['location'],
  },
  inputExamples: [
    { location: 'Melbourne', type: 'current' },
    { location: 'Sydney', type: 'daily_forecast', days: 5 },
    { location: 'Brisbane', type: 'hourly_forecast', hours: 12 },
    { location: 'Perth', type: 'daily_forecast', days: 3 },
  ],

  handler: async (input) => {
    const location = input.location as string | undefined;
    if (!location) {
      const error = { error: "'location' is required." };
      return { content: JSON.stringify(error), structuredData: error };
    }

    const apiKey = getOptionalEnv('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      const error = {
        error: 'Google Maps API key not configured. Use web_search as fallback.',
        fallback_query: `weather in ${location}`,
      };
      return {
        content: JSON.stringify(error),
        structuredData: error,
      };
    }

    try {
      const geo = await geocodeLocation(apiKey, location);
      console.log(`[weather] Geocode result for "${location}":`, geo ? `${geo.name} (${geo.lat}, ${geo.lng})` : 'null');
      if (!geo) {
        const error = {
          error: `Could not find location: "${location}". Try a more specific place name.`,
          fallback_query: `weather in ${location}`,
        };
        return {
          content: JSON.stringify(error),
          structuredData: error,
        };
      }

      const type = (input.type as string) ?? 'current';

      let result: WeatherResult;

      switch (type) {
        case 'daily_forecast': {
          const days = Math.min(Math.max((input.days as number) ?? 3, 1), 10);
          result = await getDailyForecast(apiKey, geo.lat, geo.lng, geo.name, days);
          break;
        }
        case 'hourly_forecast': {
          const hours = Math.min(Math.max((input.hours as number) ?? 12, 1), 24);
          result = await getHourlyForecast(apiKey, geo.lat, geo.lng, geo.name, hours);
          break;
        }
        default: {
          result = await getCurrentConditions(apiKey, geo.lat, geo.lng, geo.name);
          break;
        }
      }

      console.log(`[weather] Final result keys: ${Object.keys(result).join(', ')}, has error: ${'error' in result}`);
      return { content: JSON.stringify(result), structuredData: result };
    } catch (e) {
      console.error('[weather] error:', (e as Error).message);
      const error = {
        error: (e as Error).message,
        fallback_query: `weather in ${location}`,
      };
      return {
        content: JSON.stringify(error),
        structuredData: error,
      };
    }
  },
};
