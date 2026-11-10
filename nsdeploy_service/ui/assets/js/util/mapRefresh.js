/** Maximum time the Map view may wait between graph fetches. */
export const MAX_MAP_REFRESH_SECONDS = 60;

/**
 * Accept a faster server recommendation, but never let an absent, invalid or disabled
 * value remove the one-minute freshness guarantee promised by the console.
 */
export function mapRefreshSeconds(recommendation) {
  const seconds = Number(recommendation);
  return Number.isFinite(seconds) && seconds >= 5
    ? Math.min(seconds, MAX_MAP_REFRESH_SECONDS)
    : MAX_MAP_REFRESH_SECONDS;
}
