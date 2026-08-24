# Knok Bengaluru map release source

This directory preserves the exact map-specific source used to build the
static release under `output/map/`. It is an overlay from the Knok product web
application, not a second independently maintained product.

The public build is compiled with:

```sh
NEXT_PUBLIC_MAP_STATIC_DATA_BASE=/map/data \
NEXT_PUBLIC_PRODUCT_ORIGIN=https://hey.knok.work \
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-PPJ6D8NBTQ \
NEXT_PUBLIC_CLARITY_PROJECT_ID=xjnqobcrqk \
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=<public-ingestion-token> \
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com \
npm run build
```

The public map measures visitors by default: Google Analytics 4, PostHog and
Microsoft Clarity start for every visitor unless a stored opt-out
(`knok-analytics-consent = "0"` or the legacy declined flag) is present. There
is no consent banner. The map sends an explicit allowlist of product events;
PostHog autocapture and replay are disabled, Clarity inputs are masked, and GA
ad storage/signals stay denied. The job-alert prompt is currently unmounted
(component retained in source for later reinstatement).

`scripts/refresh_map_snapshot.py` refreshes the role snapshots without
rebuilding the application. GitHub Actions publishes those snapshots and the
static map through the existing `knok.work` Pages deployment.

The public map performs no normal job-corpus reads against RackNerd. Map tiles
come directly from OpenFreeMap and all Knok-owned HTML, JavaScript, logos and
hiring JSON are served from the static site CDN.
