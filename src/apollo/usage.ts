import type { ApolloClient } from './client.js';

export interface EndpointUsage {
  endpoint: string;
  action: string;
  minute?: unknown;
  hour?: unknown;
  day?: unknown;
}

export interface UsageStatsResult {
  endpoints: EndpointUsage[];
  rateLimitHeaders: Record<string, string>;
  note: string;
}

interface UsageWindows {
  minute?: unknown;
  hour?: unknown;
  day?: unknown;
}

/**
 * Wraps POST /usage_stats/api_usage_stats (master API key required; free).
 * Apollo keys the response by a stringified JSON array per endpoint+action —
 * decoded here into a flat list. Apollo has no API for the remaining credit
 * balance; that lives in the UI (Settings > Billing and credits).
 */
export async function getUsageStats(client: ApolloClient): Promise<UsageStatsResult> {
  const response = await client.post<Record<string, unknown>>('/api/v1/usage_stats/api_usage_stats');

  const endpoints: EndpointUsage[] = [];
  for (const [key, value] of Object.entries(response ?? {})) {
    const parsed = parseUsageKey(key);
    const windows = (value ?? {}) as UsageWindows;
    endpoints.push({
      endpoint: parsed.endpoint,
      action: parsed.action,
      minute: windows.minute,
      hour: windows.hour,
      day: windows.day,
    });
  }

  return {
    endpoints,
    rateLimitHeaders: client.rateLimitSnapshot(),
    note: 'Per-endpoint rate-limit usage (minute/hour/day). Apollo exposes no API for the remaining credit balance — check Settings > Billing and credits in the Apollo UI.',
  };
}

function parseUsageKey(key: string): { endpoint: string; action: string } {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (Array.isArray(parsed)) {
      return { endpoint: String(parsed[0] ?? key), action: String(parsed[1] ?? '') };
    }
  } catch {
    // fall through — key was not the documented stringified-array format
  }
  return { endpoint: key, action: '' };
}
