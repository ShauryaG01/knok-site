// Browser requests are same-origin by default and are proxied by Next.js to the
// FastAPI service. A public base URL remains available for deployments that
// intentionally expose the API on a separate origin.
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "");
