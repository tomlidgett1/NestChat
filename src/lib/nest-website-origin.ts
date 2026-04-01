/**
 * Base URL for the Vite marketing site (Moment V2 admin, etc.).
 * Set NEST_WEBSITE_ORIGIN in .env to override (e.g. http://localhost:5174).
 * When unset: local Nest dev uses the default Vite port; production uses nest.expert.
 */
export function getNestWebsiteOrigin(): string {
  const fromEnv = process.env.NEST_WEBSITE_ORIGIN?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') return 'https://nest.expert';
  return 'http://localhost:5173';
}
