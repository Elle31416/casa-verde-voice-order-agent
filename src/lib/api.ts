/**
 * Backend URL helper.
 *
 * Single-service deployments (Render web service, `npm run serve`) host the
 * API on the same origin, so paths are used as-is. For a split deployment
 * (static frontend + separate backend), set VITE_API_BASE_URL at build time,
 * e.g. VITE_API_BASE_URL=https://casa-verde-api.onrender.com — and add the
 * frontend origin to the backend's ALLOWED_ORIGINS.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export function apiUrl(path: string): string {
  return `${BASE}${path}`
}
