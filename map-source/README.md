# Knok Bengaluru map release source

This directory preserves the exact map-specific source used to build the
static release under `output/map/`. It is an overlay from the Knok product web
application, not a second independently maintained product.

The public build is compiled with:

```sh
NEXT_PUBLIC_MAP_STATIC_DATA_BASE=/map/data \
NEXT_PUBLIC_PRODUCT_ORIGIN=https://hey.knok.work \
npm run build
```

`scripts/refresh_map_snapshot.py` refreshes the role snapshots without
rebuilding the application. GitHub Actions publishes those snapshots and the
static map through the existing `knok.work` Pages deployment.

The public map performs no normal job-corpus reads against RackNerd. Map tiles
come directly from OpenFreeMap and all Knok-owned HTML, JavaScript, logos and
hiring JSON are served from the static site CDN.
