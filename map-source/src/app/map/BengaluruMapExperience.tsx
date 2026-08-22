"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Building2,
  Check,
  Clock3,
  Compass,
  Grid2X2,
  Map as MapIcon,
  MapPin,
  MessageCircle,
  Minus,
  Plus,
  Radar,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  UsersRound,
  Zap,
  X,
} from "lucide-react";
import maplibregl, { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { KnokLogo } from "@/components/KnokLogo";
import { API_BASE } from "@/lib/apiBase";
import { track, trackOnce } from "@/lib/analytics";
import { clusterRadiusForZoom, clusterTierForZoom, companyKey, companyMatchesSearch, dispersedMarkerOffsets, groupProjectedCompanies, jobsForCompany } from "./mapModel";
import styles from "./map.module.css";

type CompanyKind = "startup" | "vc" | "employer";
type LocationPrecision = "exact" | "area";

interface BengaluruCompany {
  id: string;
  name: string;
  kind: CompanyKind;
  status: string;
  area: string;
  stage: string;
  sector: string;
  foundedYear: number | null;
  teamSize: string;
  totalFunding: string;
  founders: string[];
  website: string;
  jobsUrl: string;
  logoPath: string;
  logoDomain: string;
  lat: number;
  lng: number;
  locationPrecision: LocationPrecision;
}

export interface BengaluruMapData {
  meta: {
    city: string;
    recordCount: number;
    exactCoordinateCount: number;
    generatedAt: string;
    sourceRetrievedAt: string | null;
  };
  companies: BengaluruCompany[];
}

interface PublicJob {
  id: string;
  title: string;
  company: string;
  company_canonical_id?: string | null;
  location?: string | null;
  posted_at?: string | null;
  posted_date?: string | null;
  url: string;
}

interface PublicJobsResponse {
  jobs: PublicJob[];
  total: number;
}

type ViewMode = "map" | "grid";
type KindFilter = "all" | CompanyKind;

const ALL_ROLES = "All roles";
const ROLE_OPTIONS = [
  ALL_ROLES,
  "Product Manager",
  "Growth Marketing",
  "Software Engineer",
  "Data Analyst",
  "Designer",
  "Program Manager",
  "Finance",
];

const HOTSPOT_OPTIONS = ["Koramangala", "HSR Layout", "Indiranagar", "Whitefield"];
const MAP_JOBS_ENDPOINT = "/api/map/jobs";
const MAP_STATIC_DATA_BASE = (process.env.NEXT_PUBLIC_MAP_STATIC_DATA_BASE || "").replace(/\/+$/, "");
const PRODUCT_ORIGIN = (process.env.NEXT_PUBLIC_PRODUCT_ORIGIN || "").replace(/\/+$/, "");

const MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";
const CLUSTER_EXPAND_ZOOM = 14.65;
// Once the camera reaches the closest useful street view, every employer is
// rendered as its own target. A final "show every company" interaction made
// the deepest view feel like it was still hiding inventory.
const FULL_DISPERSION_ZOOM = 15.4;
const FEEDBACK_URL = "https://forms.gle/LrQzozP8hGspbawr8";
const roleJobsMemoryCache = new Map<string, { jobs: PublicJob[]; total: number }>();

function roleSnapshotName(role: string) {
  return role === ALL_ROLES
    ? "all-roles"
    : role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const APPROXIMATE_COMPANY_POCKETS = [
  { area: "HSR Layout", lat: 12.9116, lng: 77.6389 },
  { area: "Koramangala", lat: 12.9352, lng: 77.6245 },
  { area: "Indiranagar", lat: 12.9719, lng: 77.6412 },
  { area: "Bellandur", lat: 12.9255, lng: 77.6765 },
  { area: "Whitefield", lat: 12.9698, lng: 77.7499 },
  { area: "Manyata Tech Park", lat: 13.0458, lng: 77.6206 },
  { area: "Electronic City", lat: 12.8399, lng: 77.6770 },
  { area: "JP Nagar", lat: 12.9063, lng: 77.5857 },
  { area: "MG Road", lat: 12.9757, lng: 77.6068 },
  { area: "Yelahanka", lat: 13.1007, lng: 77.5963 },
  { area: "Marathahalli", lat: 12.9569, lng: 77.7011 },
  { area: "Hebbal", lat: 13.0358, lng: 77.5970 },
] as const;

const HIDDEN_BASEMAP_LAYER_PATTERNS = [
  /^building/,
  /railway/i,
  /-hatching$/,
  /^road_oneway/,
  /^poi_/,
  /^airport$/,
  /^label_(other|village)$/,
  /^highway-name-(path|minor)$/,
  /^highway-shield/,
  /^road_shield/,
  /^boundary_/,
];

function simplifyBasemap(map: MapLibreMap) {
  for (const layer of map.getStyle().layers || []) {
    if (HIDDEN_BASEMAP_LAYER_PATTERNS.some((pattern) => pattern.test(layer.id))) {
      map.setLayoutProperty(layer.id, "visibility", "none");
      continue;
    }

    if (layer.type === "background") {
      map.setPaintProperty(layer.id, "background-color", "#f7f7f4");
      continue;
    }
    if (layer.type === "fill") {
      if (/^water($|-)/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "fill-color", "#86ccec");
        map.setPaintProperty(layer.id, "fill-opacity", 1);
      } else if (/(park|grass|wood|forest)/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "fill-color", "#dcefd7");
        map.setPaintProperty(layer.id, "fill-opacity", 0.92);
      } else if (/landuse-(residential|suburb|commercial|industrial)/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "fill-color", "#f2f2ee");
        map.setPaintProperty(layer.id, "fill-opacity", 0.55);
      }
      continue;
    }
    if (layer.type === "line" && /(highway|motorway|trunk|primary|secondary|tertiary|minor|service|street|road|tunnel|bridge)/i.test(layer.id)) {
      const casing = /casing/i.test(layer.id);
      const major = /(motorway|trunk|primary)/i.test(layer.id);
      const secondary = /(secondary|tertiary)/i.test(layer.id);
      map.setLayoutProperty(layer.id, "visibility", "visible");
      map.setPaintProperty(layer.id, "line-color", casing ? "#dedfdb" : major ? "#ffffff" : secondary ? "#f6f6f3" : "#fafaf8");
      map.setPaintProperty(layer.id, "line-opacity", casing ? 0.7 : major ? 0.98 : secondary ? 0.9 : 0.74);
      continue;
    }
    if (layer.type === "symbol" && /highway-name-major/i.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "visible");
      map.setPaintProperty(layer.id, "text-color", "#777b78");
      map.setPaintProperty(layer.id, "text-halo-color", "#fafaf8");
      map.setPaintProperty(layer.id, "text-halo-width", 1.25);
    } else if (layer.type === "symbol" && /label_(city|town)/i.test(layer.id)) {
      map.setPaintProperty(layer.id, "text-color", "#656966");
      map.setPaintProperty(layer.id, "text-halo-color", "#fafaf8");
    }
  }
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function markerTone(value: string) {
  return stableHash(value) % 8;
}

function hasHiringHalo(company: BengaluruCompany, hiringCompanyIds: Set<string>) {
  // Stable buckets keep the same companies highlighted between visits. Seven
  // buckets currently selects 11/114 logo+hiring companies (9.65%).
  return hiringCompanyIds.has(company.id) && hasKnownCompanyLogo(company) && stableHash(company.id) % 100 < 7;
}

function markerLayoutKey(map: MapLibreMap) {
  const compact = map.getContainer().clientWidth <= 720;
  const zoom = map.getZoom();
  // MapLibre already moves every HTML marker continuously with the camera.
  // Rebuilding on arbitrary fractional-zoom buckets caused every trackpad and
  // pinch gesture to flash the whole marker layer. Only the three genuine
  // layout transitions need reconstruction.
  return `${compact ? "compact" : "wide"}:${clusterTierForZoom(zoom)}:${zoom >= FULL_DISPERSION_ZOOM ? "dispersed" : "clustered"}`;
}

function approximateCompanyLocation(value: string) {
  const hash = stableHash(value);
  const pocket = APPROXIMATE_COMPANY_POCKETS[hash % APPROXIMATE_COMPANY_POCKETS.length];
  return {
    area: pocket.area,
    lat: pocket.lat + (((hash >>> 19) % 1001) / 1000 - .5) * .014,
    lng: pocket.lng + (((hash >>> 8) % 1001) / 1000 - .5) * .018,
  };
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("en-IN");
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function displayCompanyName(name: string) {
  const clean = name.trim();
  if (!clean || clean !== clean.toLocaleLowerCase("en-IN")) return clean;
  return clean
    .split(/\s+/)
    .map((word) => word ? `${word[0].toLocaleUpperCase("en-IN")}${word.slice(1)}` : word)
    .join(" ");
}

function operating(company: BengaluruCompany) {
  const status = normalized(company.status);
  return status !== "closed" && status !== "acquired";
}

function hasKnownCompanyLogo(company: BengaluruCompany) {
  return Boolean(company.logoPath || company.logoDomain || company.website);
}

function logoCandidates(company: BengaluruCompany) {
  const candidates = [];
  if (company.logoPath) candidates.push(company.logoPath);
  const explicitDomain = company.logoDomain.trim();
  // Domain-bound providers are fast, stable and cannot substitute a different
  // company: the domain was verified during dataset generation.
  if (explicitDomain) {
    candidates.push(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(explicitDomain)}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(explicitDomain)}.ico`,
    );
  }
  try {
    if (company.website) {
      const website = new URL(company.website);
      candidates.push(`${website.origin}/apple-touch-icon.png`, `${website.origin}/favicon.ico`);
    }
  } catch {
    // Invalid source websites are rejected by the dataset generator.
  }
  // The product logo endpoint is a useful final recovery source, but it must
  // never hold up the verified-domain fallbacks when the API is cold or down.
  candidates.push(`${API_BASE}/api/company-logo/${encodeURIComponent(company.id)}?external_only=true`);
  return [...new Set(candidates)];
}

function dateLabel(value?: string | null) {
  if (!value) return "Verified recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Verified recently";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
}

function CompanyMark({ company, large = false }: { company: BengaluruCompany; large?: boolean }) {
  const candidates = useMemo(() => logoCandidates(company), [company]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  useEffect(() => setCandidateIndex(0), [company.id]);
  const logo = candidates[candidateIndex] || "";
  if (logo) {
    return (
      <span className={`${styles.companyMark} ${large ? styles.companyMarkLarge : ""}`} data-marker-tone={markerTone(company.id)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setCandidateIndex((current) => current + 1)}
        />
      </span>
    );
  }
  return (
    <span className={`${styles.companyMark} ${large ? styles.companyMarkLarge : ""}`} data-marker-tone={markerTone(company.id)} aria-hidden="true">
      {initials(company.name)}
    </span>
  );
}

function MapCanvas({
  companies,
  hiringCompanyIds,
  selected,
  onSelect,
  visible,
}: {
  companies: BengaluruCompany[];
  hiringCompanyIds: Set<string>;
  selected: BengaluruCompany | null;
  onSelect: (company: BengaluruCompany) => void;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const markerElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const expandedGroupRef = useRef<string | null>(null);
  const renderedZoomRef = useRef<number | null>(null);
  const renderedViewportRef = useRef("");
  const discoveryCameraRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const previousSelectedIdRef = useRef<string | null>(selected?.id || null);
  const renderedLayoutKeyRef = useRef("");
  const companiesRef = useRef(companies);
  companiesRef.current = companies;
  const hiringCompanyIdsRef = useRef(hiringCompanyIds);
  hiringCompanyIdsRef.current = hiringCompanyIds;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const cameraPadding = (map: MapLibreMap, focused: boolean) => {
    const compact = map.getContainer().clientWidth <= 720;
    if (compact) {
      return focused
        ? { top: 76, right: 14, bottom: 350, left: 14 }
        : { top: 76, right: 14, bottom: 98, left: 14 };
    }
    return focused
      ? { top: 94, right: 520, bottom: 20, left: 20 }
      : { top: 94, right: 20, bottom: 20, left: 20 };
  };

  const rebuildMarkers = useCallback((map: MapLibreMap, nextCompanies: BengaluruCompany[]) => {
    // Build the next marker layer before removing the current one. The old
    // implementation cleared the map first, which created a visible white
    // flash after every zoom and made company selection feel like a refresh.
    const previousMarkers = new Set(markersRef.current.values());
    const nextMarkers = new Map<string, Marker>();
    const nextMarkerElements = new Map<string, HTMLButtonElement>();
    const identityReadiness: Array<Promise<void>> = [];
    const transitioningLayer = previousMarkers.size > 0;

    const mapContainer = map.getContainer();
    const viewportWidth = mapContainer.clientWidth;

    // Stable marker input prevents clusters from reshuffling merely because a
    // hiring signal or saved-company rank changed.
    const orderedCompanies = [...nextCompanies].sort((left, right) => left.id.localeCompare(right.id));
    const zoom = map.getZoom();
    const highlightEveryHiringLogo = zoom >= FULL_DISPERSION_ZOOM;
    // At close zoom only companies in (or just outside) the viewport need DOM
    // markers. Every visible company remains clickable, while off-screen logos
    // no longer consume layout, decoding and event-listener work on phones.
    const bounds = map.getBounds();
    const viewportPad = zoom >= 13.2 ? 0.006 : 0.015;
    const visibleCompanies = zoom >= 12.2 && orderedCompanies.length > 24
      ? orderedCompanies.filter((company) => (
          company.lng >= bounds.getWest() - viewportPad
          && company.lng <= bounds.getEast() + viewportPad
          && company.lat >= bounds.getSouth() - viewportPad
          && company.lat <= bounds.getNorth() + viewportPad
        ))
      : orderedCompanies;
    renderedViewportRef.current = visibleCompanies.map((company) => company.id).join("|");

    const appendCompanyIdentity = (target: HTMLElement, company: BengaluruCompany) => {
      target.dataset.markerTone = String(markerTone(company.id));
      const candidates = logoCandidates(company);
      if (!candidates.length) {
        target.textContent = initials(company.name);
        return;
      }
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      let candidateIndex = 0;
      identityReadiness.push(new Promise<void>((resolve) => {
        image.onload = () => {
          image.decode().catch(() => undefined).finally(resolve);
        };
        image.onerror = () => {
          candidateIndex += 1;
          const next = candidates[candidateIndex];
          if (next) image.src = next;
          else {
            image.remove();
            target.textContent = initials(company.name);
            resolve();
          }
        };
      }));
      image.src = candidates[candidateIndex];
      target.appendChild(image);
    };

    const addCompanyMarker = (company: BengaluruCompany, offset: [number, number] = [0, 0], spider = false) => {
      const markerButton = document.createElement("button");
      markerButton.type = "button";
      markerButton.className = styles.companyMapMarker;
      if (transitioningLayer) markerButton.style.opacity = "0";
      if (spider) markerButton.classList.add(styles.companyMapMarkerSpider);
      markerButton.title = `${displayCompanyName(company.name)} · ${company.area}`;
      markerButton.setAttribute("aria-label", `${displayCompanyName(company.name)}, ${company.area}`);
      markerButton.dataset.companyId = company.id;
      markerButton.dataset.label = company.name;
      markerButton.dataset.representedCount = "1";
      markerButton.dataset.locationPrecision = company.locationPrecision;
      if (selectedRef.current?.id === company.id) {
        markerButton.classList.add(styles.companyMapMarkerSelected);
      } else if (selectedRef.current) {
        markerButton.classList.add(styles.companyMapMarkerMuted);
      }

      appendCompanyIdentity(markerButton, company);
      if (highlightEveryHiringLogo && hiringCompanyIdsRef.current.has(company.id)) {
        markerButton.classList.add(styles.companyMapMarkerHalo);
        markerButton.dataset.hiringHalo = "all";
      } else if (hasHiringHalo(company, hiringCompanyIdsRef.current)) {
        markerButton.classList.add(styles.companyMapMarkerHalo);
        markerButton.dataset.hiringHalo = "pulse";
      }

      markerButton.addEventListener("click", (event) => {
        event.stopPropagation();
        expandedGroupRef.current = null;
        onSelectRef.current(company);
      });
      const marker = new maplibregl.Marker({ element: markerButton, anchor: "center", offset })
        .setLngLat([company.lng, company.lat])
        .addTo(map);
      nextMarkers.set(company.id, marker);
      nextMarkerElements.set(company.id, markerButton);
    };

    renderedZoomRef.current = zoom;
    const compact = viewportWidth <= 720;
    const clusterTier = clusterTierForZoom(zoom);
    const fullyDispersed = zoom >= FULL_DISPERSION_ZOOM;
    // Overview density remains bounded for scanning and phone performance.
    // At the closest useful zoom, grouped coordinates are fanned out below so
    // every employer remains individually visible and clickable.
    const densityTarget = compact ? 92 : 190;
    const densityScale = Math.min(compact ? 1.16 : 1.12, Math.max(1, Math.sqrt(visibleCompanies.length / densityTarget)));
    const groupRadius = clusterRadiusForZoom(zoom, compact) * densityScale;
    const points = visibleCompanies
      .map((company) => ({ company, ...map.project([company.lng, company.lat]) }));
    const groups = groupProjectedCompanies(points, groupRadius, selectedRef.current?.id || null);
    const namedAreaAnchors = visibleCompanies.filter((company) => normalized(company.area) !== "bengaluru");

    for (const group of groups) {
      if (group.companies.length === 1) {
        addCompanyMarker(group.companies[0]);
        continue;
      }

      const groupKey = group.companies.map((company) => company.id).sort().join("|");
      const sameAddress = group.companies.every((company) => (
        Math.abs(company.lat - group.companies[0].lat) < 0.00001 &&
        Math.abs(company.lng - group.companies[0].lng) < 0.00001
      ));

      if (fullyDispersed) {
        const offsets = dispersedMarkerOffsets(group.companies.length, compact);
        group.companies.forEach((company, index) => addCompanyMarker(company, offsets[index], true));
        continue;
      }

      if (expandedGroupRef.current === groupKey) {
        const offsets = dispersedMarkerOffsets(group.companies.length, compact);
        group.companies.forEach((company, index) => addCompanyMarker(company, offsets[index], true));
        continue;
      }

      const groupButton = document.createElement("button");
      groupButton.type = "button";
      groupButton.className = styles.companyMapGroup;
      if (transitioningLayer) groupButton.style.opacity = "0";
      groupButton.dataset.groupSize = String(group.companies.length);
      groupButton.dataset.representedCount = String(group.companies.length);
      groupButton.dataset.clusterTier = clusterTier;
      groupButton.dataset.exactGroup = String(sameAddress);
      const hiringCount = group.companies.filter((company) => hiringCompanyIdsRef.current.has(company.id)).length;
      groupButton.dataset.hiringCount = String(hiringCount);
      if (hiringCount) groupButton.classList.add(styles.companyMapGroupHiring);
      const representativeCompanies = [...group.companies]
        .sort((left, right) => (
          Number(hasKnownCompanyLogo(right)) - Number(hasKnownCompanyLogo(left))
          || Number(hiringCompanyIdsRef.current.has(right.id)) - Number(hiringCompanyIdsRef.current.has(left.id))
          || left.name.localeCompare(right.name)
        ))
        .slice(0, clusterTier === "city" ? 2 : 1);
      groupButton.dataset.companyNames = representativeCompanies.map((company) => displayCompanyName(company.name)).join(" · ");
      const areaCounts = new Map<string, number>();
      for (const company of group.companies) areaCounts.set(company.area, (areaCounts.get(company.area) || 0) + 1);
      const dominantArea = [...areaCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || group.companies[0].area;
      const genericArea = normalized(dominantArea) === "bengaluru";
      const nearestNamedArea = genericArea
        ? namedAreaAnchors.reduce<BengaluruCompany | null>((nearest, company) => {
            if (!nearest) return company;
            const candidateDistance = Math.hypot(company.lng - group.lng, company.lat - group.lat);
            const nearestDistance = Math.hypot(nearest.lng - group.lng, nearest.lat - group.lat);
            return candidateDistance < nearestDistance ? company : nearest;
          }, null)?.area
        : dominantArea;
      const areaLabel = nearestNamedArea || "Central Bengaluru";
      const clusterPlace = `near ${areaLabel}`;
      groupButton.setAttribute("aria-label", `${group.companies.length} companies ${clusterPlace}. ${sameAddress || clusterTier === "street" ? "Show every company" : "Zoom in"}`);

      const stack = document.createElement("span");
      stack.className = styles.companyMapGroupStack;
      representativeCompanies.forEach((company, index) => {
        const tile = document.createElement("span");
        tile.className = styles.companyMapGroupTile;
        tile.style.setProperty("--stack-index", String(index));
        appendCompanyIdentity(tile, company);
        stack.appendChild(tile);
      });
      const count = document.createElement("b");
      count.className = styles.companyMapGroupCount;
      count.textContent = String(group.companies.length);
      const label = document.createElement("span");
      label.className = styles.companyMapGroupLabel;
      label.textContent = clusterTier === "city"
        ? areaLabel
        : `${group.companies.length} companies`;
      groupButton.append(stack, count, label);
      const groupCanSignalHiring = group.companies.some((company) => hiringCompanyIdsRef.current.has(company.id) && hasKnownCompanyLogo(company));
      if (groupCanSignalHiring && stableHash(groupKey) % 100 < 10) {
        groupButton.classList.add(styles.companyMapGroupHalo);
        groupButton.dataset.hiringHalo = "pulse";
      }

      groupButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const currentTier = clusterTierForZoom(map.getZoom());
        if (sameAddress || (currentTier === "street" && map.getZoom() >= CLUSTER_EXPAND_ZOOM)) {
          expandedGroupRef.current = groupKey;
          rebuildMarkers(map, companiesRef.current);
          return;
        }
        expandedGroupRef.current = null;
        const compactMotion = map.getContainer().clientWidth <= 720;
        const targetZoom = currentTier === "city"
          ? Math.max(map.getZoom() + 1.35, 12.7)
          : currentTier === "area"
            ? Math.max(map.getZoom() + 1.15, 13.9)
            : Math.max(map.getZoom() + .75, CLUSTER_EXPAND_ZOOM);
        map.easeTo({
          center: [group.lng, group.lat],
          zoom: Math.min(map.getMaxZoom(), targetZoom),
          duration: compactMotion ? 110 : 170,
        });
      });

      const marker = new maplibregl.Marker({ element: groupButton, anchor: "center" })
        .setLngLat([group.lng, group.lat])
        .addTo(map);
      for (const company of group.companies) {
        nextMarkers.set(company.id, marker);
        nextMarkerElements.set(company.id, groupButton);
      }
    }
    markersRef.current = nextMarkers;
    markerElementsRef.current = nextMarkerElements;
    renderedLayoutKeyRef.current = markerLayoutKey(map);
    if (!transitioningLayer) return;

    // Keep the previous layer visible until the incoming logo images have
    // decoded (or a short safety deadline expires). This prevents the blank
    // frame people saw after pinch, wheel and cluster zooms while still
    // keeping marker updates responsive on slower phones.
    const ready = Promise.race([
      Promise.all(identityReadiness),
      new Promise<void>((resolve) => window.setTimeout(resolve, 240)),
    ]);
    ready.then(() => {
      if (mapRef.current !== map) return;
      window.requestAnimationFrame(() => {
        for (const element of new Set(nextMarkerElements.values())) {
          element.style.transition = "opacity 110ms ease-out";
          element.style.opacity = "";
        }
        window.setTimeout(() => {
          for (const marker of previousMarkers) marker.remove();
          for (const element of new Set(nextMarkerElements.values())) element.style.transition = "";
        }, 130);
      });
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let settleFrame = 0;
    let settleTimer: number | null = null;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [77.6225, 12.945],
      zoom: 11.5,
      minZoom: 9.2,
      maxZoom: 17,
      maxBounds: [[77.34, 12.7], [77.98, 13.22]],
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    map.on("load", () => {
      map.resize();
      simplifyBasemap(map);
      rebuildMarkers(map, companiesRef.current);
      settleFrame = window.requestAnimationFrame(() => map.resize());
      settleTimer = window.setTimeout(() => map.resize(), 250);
      map.on("moveend", () => {
        if (!selectedRef.current) {
          const center = map.getCenter();
          discoveryCameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
        }
        if (map.getZoom() >= 12.2) {
          const bounds = map.getBounds();
          const viewportPad = map.getZoom() >= 13.2 ? 0.006 : 0.015;
          const nextViewport = companiesRef.current
            .filter((company) => (
              company.lng >= bounds.getWest() - viewportPad
              && company.lng <= bounds.getEast() + viewportPad
              && company.lat >= bounds.getSouth() - viewportPad
              && company.lat <= bounds.getNorth() + viewportPad
            ))
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((company) => company.id)
            .join("|");
          if (nextViewport && nextViewport !== renderedViewportRef.current) {
            const renderedIds = new Set(renderedViewportRef.current.split("|").filter(Boolean));
            const nextIds = nextViewport.split("|").filter(Boolean);
            const newlyVisible = nextIds.filter((id) => !renderedIds.has(id)).length;
            const materiallyDifferent = renderedIds.size === 0 || newlyVisible >= Math.max(6, Math.ceil(nextIds.length * .12));
            if (materiallyDifferent) rebuildMarkers(map, companiesRef.current);
          }
        }
      });
      map.on("zoomend", () => {
        if (renderedLayoutKeyRef.current === markerLayoutKey(map)) return;
        expandedGroupRef.current = null;
        rebuildMarkers(map, companiesRef.current);
      });
      map.on("click", (event) => {
        const target = event.originalEvent.target as HTMLElement | null;
        if (target?.closest("button")) return;
        if (!expandedGroupRef.current) return;
        expandedGroupRef.current = null;
        rebuildMarkers(map, companiesRef.current);
      });

      const currentSelection = selectedRef.current;
      if (currentSelection) {
        map.easeTo({
          center: [currentSelection.lng, currentSelection.lat],
          zoom: Math.max(map.getZoom(), 13),
          padding: cameraPadding(map, true),
          duration: 0,
        });
      } else {
        const currentCompanies = companiesRef.current;
        if (currentCompanies.length > 1) {
          const bounds = new maplibregl.LngLatBounds();
          for (const company of currentCompanies) bounds.extend([company.lng, company.lat]);
          map.fitBounds(bounds, { padding: cameraPadding(map, false), maxZoom: 13.5, duration: 0 });
        } else {
          map.easeTo({ padding: cameraPadding(map, false), duration: 0 });
        }
        const center = map.getCenter();
        discoveryCameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
      }

    });
    mapRef.current = map;
    return () => {
      window.cancelAnimationFrame(settleFrame);
      if (settleTimer != null) window.clearTimeout(settleTimer);
      for (const marker of new Set(markersRef.current.values())) marker.remove();
      markersRef.current.clear();
      markerElementsRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [rebuildMarkers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let previousWidth = container.clientWidth;
    let previousCompact = previousWidth <= 720;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (Math.abs(width - previousWidth) < 1) return;
      const nextCompact = width <= 720;
      const crossedBreakpoint = nextCompact !== previousCompact;
      previousWidth = width;
      previousCompact = nextCompact;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const map = mapRef.current;
        if (!map) return;
        map.resize();
        if (crossedBreakpoint && map.isStyleLoaded()) rebuildMarkers(map, companiesRef.current);
      });
    });
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rebuildMarkers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    rebuildMarkers(map, companies);
    if (companies.length === 1) {
      map.easeTo({ center: [companies[0].lng, companies[0].lat], zoom: 14, duration: map.getContainer().clientWidth <= 720 ? 100 : 160 });
    } else if (companies.length > 1 && companies.length <= 250) {
      // Searches and meaningful filter cuts should reveal their whole result
      // set. Large mode changes keep the user's camera untouched.
      const bounds = new maplibregl.LngLatBounds();
      for (const company of companies) bounds.extend([company.lng, company.lat]);
      map.fitBounds(bounds, { padding: cameraPadding(map, false), maxZoom: 13.5, duration: map.getContainer().clientWidth <= 720 ? 100 : 160 });
    }
  }, [companies, rebuildMarkers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const selectedMarkerElement = selected ? markerElementsRef.current.get(selected.id) : null;
    for (const markerElement of new Set(markerElementsRef.current.values())) {
      markerElement.classList.toggle(styles.companyMapMarkerSelected, !!selected && markerElement === selectedMarkerElement);
      markerElement.classList.toggle(styles.companyMapMarkerMuted, !!selected && markerElement !== selectedMarkerElement);
    }
    const previousSelectedId = previousSelectedIdRef.current;
    if (selected) {
      if (!previousSelectedId) {
        const center = map.getCenter();
        discoveryCameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
      }
      const selectedMarkerPosition = markersRef.current.get(selected.id)?.getLngLat();
      map.easeTo({
        center: selectedMarkerPosition ? [selectedMarkerPosition.lng, selectedMarkerPosition.lat] : [selected.lng, selected.lat],
        zoom: Math.max(map.getZoom(), 13),
        padding: cameraPadding(map, true),
        duration: map.getContainer().clientWidth <= 720 ? 120 : 190,
      });
    } else if (previousSelectedId) {
      const discoveryCamera = discoveryCameraRef.current;
      map.easeTo({
        center: discoveryCamera?.center || [77.6225, 12.945],
        zoom: discoveryCamera?.zoom || 11.5,
        padding: cameraPadding(map, false),
        duration: map.getContainer().clientWidth <= 720 ? 120 : 190,
      });
    } else {
      map.easeTo({ padding: cameraPadding(map, false), duration: map.getContainer().clientWidth <= 720 ? 90 : 140 });
    }
    previousSelectedIdRef.current = selected?.id || null;
  }, [selected]);

  useEffect(() => {
    if (!visible) return;
    window.setTimeout(() => {
      mapRef.current?.resize();
    }, 50);
  }, [visible]);

  const changeZoom = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const nextZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + delta));
    map.easeTo({ zoom: nextZoom, duration: map.getContainer().clientWidth <= 720 ? 80 : 120 });
  };

  const fitCurrentView = () => {
    const map = mapRef.current;
    if (!map) return;
    const currentSelection = selectedRef.current;
    if (currentSelection) {
      const selectedMarkerPosition = markersRef.current.get(currentSelection.id)?.getLngLat();
      map.easeTo({
        center: selectedMarkerPosition ? [selectedMarkerPosition.lng, selectedMarkerPosition.lat] : [currentSelection.lng, currentSelection.lat],
        zoom: 13,
        padding: cameraPadding(map, true),
        duration: 220,
      });
      return;
    }
    const currentCompanies = companiesRef.current;
    if (currentCompanies.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      for (const company of currentCompanies) bounds.extend([company.lng, company.lat]);
      map.fitBounds(bounds, { padding: cameraPadding(map, false), maxZoom: 13.5, duration: 220 });
      return;
    }
    map.easeTo({
      center: [77.6225, 12.945],
      zoom: 11.5,
      padding: cameraPadding(map, false),
      duration: 220,
    });
  };

  return <>
    <div ref={containerRef} className={styles.mapCanvas} data-company-total={companies.length} aria-label="Map of Bengaluru startups and investors" />
    <div className={styles.mapZoomControls} role="group" aria-label="Map zoom controls">
      <button type="button" onClick={() => changeZoom(1)} aria-label="Zoom in"><Plus /></button>
      <button type="button" onClick={() => changeZoom(-1)} aria-label="Zoom out"><Minus /></button>
      <button type="button" onClick={fitCurrentView} aria-label="Fit current results"><Radar /></button>
    </div>
  </>;
}

function CompanyCard({
  company,
  selected,
  jobs,
  onSelect,
}: {
  company: BengaluruCompany;
  selected: boolean;
  jobs: PublicJob[];
  onSelect: (company: BengaluruCompany) => void;
}) {
  const newest = jobs[0];
  return (
    <button
      type="button"
      className={`${styles.companyCard} ${selected ? styles.companyCardSelected : ""}`}
      onClick={() => onSelect(company)}
      aria-pressed={selected}
    >
      <CompanyMark company={company} />
      <span className={styles.companyCardCopy}>
        <strong>{displayCompanyName(company.name)}</strong>
        <span>{company.sector !== "Unknown" ? company.sector : company.kind === "vc" ? "Venture capital" : "Technology"} · {company.locationPrecision === "exact" ? company.area : `Around ${company.area}`}</span>
        <small className={jobs.length ? styles.companyHiringSignal : undefined}>
          {jobs.length ? <><Activity />{jobs.length} live {jobs.length === 1 ? "role" : "roles"}{newest ? ` · ${dateLabel(newest.posted_at || newest.posted_date)}` : ""}</> : <><Radar />Monitoring for {company.kind === "vc" ? "opportunities" : "roles"}</>}
        </small>
      </span>
    </button>
  );
}

function CompanyDetail({
  company,
  role,
  corpusJobs,
  jobSignalsAvailable,
  onClose,
}: {
  company: BengaluruCompany;
  role: string;
  corpusJobs: PublicJob[];
  jobSignalsAvailable: boolean;
  onClose: () => void;
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const jobs = useMemo(() => jobsForCompany(company, corpusJobs), [company, corpusJobs]);
  const allRoles = role === ALL_ROLES;

  useEffect(() => {
    setSelectedJobId(jobs[0]?.id || null);
  }, [company.id, jobs, role]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) || jobs[0] || null;
  const companyType = company.kind === "vc"
    ? "Investor"
    : company.kind === "employer"
      ? "Employer"
      : company.stage !== "Unknown"
        ? company.stage
        : "Startup";
  const hiringLevel = !jobSignalsAvailable ? "Unavailable" : jobs.length >= 4 ? "High" : jobs.length > 0 ? "Active" : "Watching";

  return (
    <aside className={styles.detailPanel} aria-label={`${displayCompanyName(company.name)} details`}>
      <div className={`${styles.detailStatusStrip} ${jobs.length ? styles.detailStatusHiring : ""}`}>
        <span><i />{jobs.length ? allRoles ? "HIRING NOW" : `HIRING ${role.toLocaleUpperCase("en-IN")} NOW` : jobSignalsAvailable ? allRoles ? "MONITORING LIVE ROLES" : `MONITORING ${role.toLocaleUpperCase("en-IN")}` : "HIRING CHECK TEMPORARILY UNAVAILABLE"}</span>
        <b>{jobs.length ? `${jobs.length} live ${jobs.length === 1 ? "role" : "roles"}` : jobSignalsAvailable ? "No exact opening today" : "Company discovery still works"}</b>
      </div>

      <div className={styles.detailHero}>
        <button type="button" className={styles.detailClose} onClick={onClose} aria-label="Close company details"><X /></button>
        <div className={styles.detailEyebrow}>COMPANY RADAR <span>· BENGALURU</span></div>
        <div className={styles.detailIdentity}>
          <CompanyMark company={company} large />
          <div><p>{companyType}</p><h2>{displayCompanyName(company.name)}</h2><span><MapPin />{company.area}<em className={styles.locationConfidence}>{company.locationPrecision === "exact" ? "Verified office" : "Approximate map placement"}</em></span></div>
        </div>
        <div className={styles.detailHeroActions}>
          {company.jobsUrl ? <a href={company.jobsUrl} target="_blank" rel="noreferrer">Company careers <ArrowUpRight /></a> : company.website ? <a href={company.website} target="_blank" rel="noreferrer">Company website <ArrowUpRight /></a> : null}
        </div>
      </div>

      <div className={styles.detailBody}>
        <section className={styles.companyOverview}>
          <div className={styles.roleLens}><span>YOUR ROLE LENS</span><b>{role}</b></div>
          <div className={styles.hiringPulse}>
            <span><Activity /><small>Hiring activity</small><strong>{hiringLevel}</strong></span>
            <span><BriefcaseBusiness /><small>Relevant roles</small><strong>{jobSignalsAvailable ? jobs.length : "—"}</strong></span>
            <span><Zap /><small>Best move</small><strong>{jobs.length ? "Pick one" : jobSignalsAvailable ? "Save" : "Explore"}</strong></span>
          </div>
        </section>

        <section className={styles.jobsWorkspace}>
          <header>
            <p>{jobs.length ? "LIVE OPPORTUNITIES" : jobSignalsAvailable ? "YOUR COMPANY WATCHLIST" : "COMPANY DISCOVERY"}</p>
            <h3>{jobs.length ? "Choose the role you actually want." : jobSignalsAvailable ? `Keep ${company.name} on your radar.` : `Explore ${company.name} while live hiring recovers.`}</h3>
            <span>{jobs.length ? "Open the original posting on the company’s own careers or application page." : jobSignalsAvailable ? allRoles ? "We have not verified a live opening today." : `We have not verified a live ${role} opening today.` : "Knok could not refresh the role corpus. Company discovery remains available."}</span>
          </header>
          {jobs.length ? (
            <div className={styles.selectableJobs}>
              {jobs.map((job) => (
                <div key={job.id} className={selectedJob?.id === job.id ? styles.selectableJobActive : undefined}>
                  <button type="button" className={styles.jobChoice} onClick={() => {
                    setSelectedJobId(job.id);
                    track("map_job_opened", { job_id: job.id, company_canonical_id: job.company_canonical_id || "" });
                  }} aria-pressed={selectedJob?.id === job.id}>
                    <span className={styles.jobRadio}>{selectedJob?.id === job.id ? <Check /> : null}</span>
                    <span><b>{job.title}</b><small>{job.location || "Bengaluru"} · {dateLabel(job.posted_at || job.posted_date)}</small></span>
                  </button>
                  <a href={job.url} target="_blank" rel="noreferrer" aria-label={`Open ${job.title} posting`}><ArrowUpRight /></a>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.noRolesCompact}>
              <p>No verified opening is available for this company in the current view.</p>
            </div>
          )}
        </section>

        <section className={styles.snapshotSection} aria-label="Company snapshot">
          <div className={styles.detailSectionTitle}><span>COMPANY SNAPSHOT</span><b>{operating(company) ? "Operating" : company.status}</b></div>
          <div className={styles.detailFacts}>
            <span><Building2 /><small>Focus</small><b>{company.sector !== "Unknown" ? company.sector : company.kind === "vc" ? "Venture capital" : "Technology"}</b></span>
            <span><BriefcaseBusiness /><small>{company.kind === "vc" ? "Type" : "Stage"}</small><b>{company.kind === "vc" ? "Investor" : company.stage !== "Unknown" ? company.stage : "Operating"}</b></span>
            {company.teamSize ? <span><UsersRound /><small>Team</small><b>{company.teamSize}</b></span> : null}
            {company.foundedYear ? <span><Clock3 /><small>Founded</small><b>{company.foundedYear}</b></span> : null}
          </div>
        </section>
        <div className={styles.externalLinks}>
          {company.jobsUrl ? <a href={company.jobsUrl} target="_blank" rel="noreferrer">Company careers <ArrowUpRight /></a> : null}
          <button type="button" onClick={onClose}><ArrowLeft />Back to map</button>
        </div>
      </div>

      {selectedJob ? (
        <div className={styles.detailActionDock}>
          <span><small>ORIGINAL POSTING</small><b>{selectedJob.title}</b></span>
          <a href={selectedJob.url} target="_blank" rel="noreferrer" onClick={() => track("map_opportunity_clicked", { company_slug: company.id, role, job_id: selectedJob.id })}>Open company page <ArrowUpRight /></a>
          <p>Opens the employer’s original careers or application page.</p>
        </div>
      ) : null}
    </aside>
  );
}

export default function BengaluruMapExperience({ data }: { data: BengaluruMapData }) {
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState(ROLE_OPTIONS[0]);
  const [area, setArea] = useState("All areas");
  const [stage, setStage] = useState("All stages");
  const [sector, setSector] = useState("All sectors");
  const [kind, setKind] = useState<KindFilter>("all");
  const [operatingOnly, setOperatingOnly] = useState(true);
  const [hiringOnly, setHiringOnly] = useState(false);
  const [view, setView] = useState<ViewMode>("map");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roleJobs, setRoleJobs] = useState<PublicJob[]>([]);
  const [roleJobsTotal, setRoleJobsTotal] = useState<number | null>(null);
  const [roleJobsLoading, setRoleJobsLoading] = useState(true);
  const [roleJobsRefreshKey, setRoleJobsRefreshKey] = useState(0);
  const [gridVisibleCount, setGridVisibleCount] = useState(48);
  const [showFilters, setShowFilters] = useState(false);
  const didHydrateQuery = useRef(false);
  const filterTrackTimer = useRef<number | null>(null);

  const areas = useMemo(() => ["All areas", ...new Set(data.companies.map((company) => company.area))].sort((a, b) => a === "All areas" ? -1 : b === "All areas" ? 1 : a.localeCompare(b)), [data.companies]);
  const stages = useMemo(() => ["All stages", ...new Set(data.companies.map((company) => company.stage).filter((value) => value !== "Unknown"))].sort((a, b) => a === "All stages" ? -1 : b === "All stages" ? 1 : a.localeCompare(b)), [data.companies]);
  const sectors = useMemo(() => ["All sectors", ...new Set(data.companies.map((company) => company.sector).filter((value) => value !== "Unknown"))].sort((a, b) => a === "All sectors" ? -1 : b === "All sectors" ? 1 : a.localeCompare(b)), [data.companies]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryKind = params.get("kind");
    const queryView = params.get("view");
    const queryRole = params.get("role") || ROLE_OPTIONS[0];
    setSearch(params.get("q") || "");
    setRole(queryRole);
    setArea(params.get("area") || "All areas");
    setStage(params.get("stage") || "All stages");
    setSector(params.get("sector") || "All sectors");
    setKind(queryKind === "startup" || queryKind === "vc" ? queryKind : "all");
    setOperatingOnly(params.get("status") !== "all");
    setHiringOnly(params.get("hiring") === "now" || queryRole !== ALL_ROLES);
    setView(queryView === "grid" ? "grid" : "map");
    setSelectedId(params.get("company"));
    didHydrateQuery.current = true;
    trackOnce("map_viewed", { city: "bengaluru", total: data.companies.length });
  }, [data.companies.length]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const cached = roleJobsMemoryCache.get(role);
    if (cached) {
      setRoleJobs(cached.jobs);
      setRoleJobsTotal(cached.total);
      setRoleJobsLoading(false);
    } else {
      // During a cold role change, keep the company map usable and label the
      // live layer as refreshing. Never show jobs from the previous role.
      setRoleJobs([]);
      setRoleJobsTotal(null);
      setRoleJobsLoading(true);
    }
    // Keep the last good hiring layer on screen while a new role is loading.
    // Clearing it here made the tab look broken and forced a full-screen wait.
    const pageSize = role === ALL_ROLES ? 2000 : 500;
    const params = new URLSearchParams({
      location: "Bengaluru",
      per_page: String(pageSize),
      sort: "posted_date",
      order: "desc",
      exclude_junk: "true",
    });
    if (role !== ALL_ROLES) params.set("search", role);
    const loadPage = async (page: number) => {
      const pageParams = new URLSearchParams(params);
      pageParams.set("page", String(page));
      const requestUrl = MAP_STATIC_DATA_BASE
        ? `${MAP_STATIC_DATA_BASE}/${roleSnapshotName(role)}.json`
        : `${MAP_JOBS_ENDPOINT}?${pageParams.toString()}`;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(requestUrl, { signal: controller.signal });
          if (!response.ok) throw new Error("role corpus unavailable");
          return await response.json() as PublicJobsResponse;
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      }
      throw lastError;
    };
    const loadJobs = async () => {
      // Render the first 2,000 live roles as soon as page one arrives. The
      // remaining corpus pages fill in quietly instead of leaving Hiring on a
      // blank loading surface until the slowest request completes.
      const firstPage = await loadPage(1);
      if (active) {
        setRoleJobs(firstPage.jobs || []);
        setRoleJobsTotal(Number(firstPage.total || 0));
        setRoleJobsLoading(false);
      }
      const pageCount = MAP_STATIC_DATA_BASE ? 1 : role === ALL_ROLES ? Math.ceil(firstPage.total / pageSize) : 1;
      // One slow or failed corpus page must not blank the pages that already
      // loaded successfully. This was the main cause of Hiring appearing to
      // crash after a filter change on a cold server.
      const remainingResults = pageCount > 1
        ? await Promise.allSettled(Array.from({ length: pageCount - 1 }, (_, index) => loadPage(index + 2)))
        : [];
      const remainingPages = remainingResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const uniqueJobs = new Map<string, PublicJob>();
      for (const job of [firstPage, ...remainingPages].flatMap((result) => result.jobs || [])) uniqueJobs.set(job.id, job);
      return { jobs: [...uniqueJobs.values()], total: firstPage.total };
    };
    loadJobs()
      .then((result) => {
        if (!active) return;
        roleJobsMemoryCache.set(role, { jobs: result.jobs || [], total: Number(result.total || 0) });
        setRoleJobs(result.jobs || []);
        setRoleJobsTotal(Number(result.total || 0));
      })
      .catch(() => {
        if (!active) return;
        // A transient upstream failure must not erase a previously rendered
        // Hiring layer. Cold failures retain the exploratory company map and
        // expose the explicit retry state.
        if (!cached) {
          setRoleJobs([]);
          setRoleJobsTotal(null);
        }
      })
      .finally(() => {
        if (active) setRoleJobsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [role, roleJobsRefreshKey]);

  const mappedJobsByCompany = useMemo(() => {
    const result = new Map<string, PublicJob[]>();
    const jobsByCanonicalId = new Map<string, PublicJob[]>();
    const jobsByNameKey = new Map<string, PublicJob[]>();
    for (const job of roleJobs) {
      if (job.company_canonical_id) {
        jobsByCanonicalId.set(job.company_canonical_id, [...(jobsByCanonicalId.get(job.company_canonical_id) || []), job]);
      }
      const key = companyKey(job.company);
      if (key) jobsByNameKey.set(key, [...(jobsByNameKey.get(key) || []), job]);
    }
    for (const company of data.companies) {
      const companyNameKey = companyKey(company.name);
      const matches = new Map<string, PublicJob>();
      for (const job of jobsByCanonicalId.get(company.id) || []) matches.set(job.id, job);
      for (const job of jobsByNameKey.get(companyNameKey) || []) matches.set(job.id, job);
      if (matches.size) result.set(company.id, [...matches.values()]);
    }
    return result;
  }, [data.companies, roleJobs]);

  const hiringUniverse = useMemo(() => {
    const jobsByCompany = new Map(mappedJobsByCompany);
    const matchedJobIds = new Set([...mappedJobsByCompany.values()].flatMap((jobs) => jobs.map((job) => job.id)));
    const unmatchedGroups = new Map<string, PublicJob[]>();

    for (const job of roleJobs) {
      if (matchedJobIds.has(job.id)) continue;
      const key = job.company_canonical_id || companyKey(job.company) || job.company;
      unmatchedGroups.set(key, [...(unmatchedGroups.get(key) || []), job]);
    }

    const approximateEmployers: BengaluruCompany[] = [];
    for (const [key, jobs] of unmatchedGroups) {
      const name = jobs[0].company.trim();
      if (!name) continue;
      const id = jobs[0].company_canonical_id || `corpus-${key}`;
      const location = approximateCompanyLocation(id);
      approximateEmployers.push({
        id,
        name,
        kind: "employer",
        status: "Operating",
        area: location.area,
        stage: "Unknown",
        sector: "Employer",
        foundedYear: null,
        teamSize: "",
        totalFunding: "",
        founders: [],
        website: "",
        jobsUrl: "",
        logoPath: "",
        logoDomain: "",
        lat: location.lat,
        lng: location.lng,
        locationPrecision: "area",
      });
      jobsByCompany.set(id, jobs);
    }

    return { companies: [...data.companies, ...approximateEmployers], jobsByCompany };
  }, [data.companies, mappedJobsByCompany, roleJobs]);

  const jobsByCompany = hiringUniverse.jobsByCompany;

  const discoverCompanies = useMemo(() => {
    const sourceCompanies = hiringOnly ? hiringUniverse.companies : data.companies;
    return sourceCompanies
      .filter((company) => !operatingOnly || operating(company))
      .filter((company) => kind === "all" || company.kind === kind)
      .filter((company) => area === "All areas" || company.area === area)
      .filter((company) => stage === "All stages" || company.stage === stage)
      .filter((company) => sector === "All sectors" || company.sector === sector)
      .filter((company) => companyMatchesSearch(company, search))
      .sort((a, b) => {
        const aJobs = jobsByCompany.get(a.id)?.length || 0;
        const bJobs = jobsByCompany.get(b.id)?.length || 0;
        const logoPriority = Number(hasKnownCompanyLogo(b)) - Number(hasKnownCompanyLogo(a));
        const startupPriority = Number(b.kind === "startup") - Number(a.kind === "startup");
        return logoPriority || (hiringOnly ? bJobs - aJobs : 0) || startupPriority || a.name.localeCompare(b.name);
      });
  }, [area, data.companies, hiringOnly, hiringUniverse.companies, jobsByCompany, kind, operatingOnly, search, sector, stage]);

  const filteredCompanies = useMemo(() => (
    hiringOnly
      ? roleJobsTotal === null
        ? roleJobsLoading ? discoverCompanies : []
        : discoverCompanies.filter((company) => (jobsByCompany.get(company.id)?.length || 0) > 0)
      : discoverCompanies
  ), [discoverCompanies, hiringOnly, jobsByCompany, roleJobsLoading, roleJobsTotal]);
  // Marker reconstruction is intentionally deferred so rapidly changing two
  // or three filters cannot lock up or crash the map on lower-memory phones.
  const deferredFilteredCompanies = useDeferredValue(filteredCompanies);

  useEffect(() => {
    if (selectedId && !filteredCompanies.some((company) => company.id === selectedId)) setSelectedId(null);
  }, [filteredCompanies, selectedId]);

  useEffect(() => setGridVisibleCount(48), [area, hiringOnly, kind, operatingOnly, role, search, sector, stage]);

  const selected = selectedId
    ? hiringUniverse.companies.find((company) => company.id === selectedId) || null
    : null;

  useEffect(() => {
    if (!didHydrateQuery.current) return;
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (role !== ROLE_OPTIONS[0]) params.set("role", role);
    if (area !== "All areas") params.set("area", area);
    if (stage !== "All stages") params.set("stage", stage);
    if (sector !== "All sectors") params.set("sector", sector);
    if (kind !== "all") params.set("kind", kind);
    if (!operatingOnly) params.set("status", "all");
    if (hiringOnly) params.set("hiring", "now");
    if (view !== "map") params.set("view", view);
    if (selectedId) params.set("company", selectedId);
    const next = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    // These are client-only map controls. Next router navigation remounted the
    // route and looked like a refresh after every marker click or search key.
    window.history.replaceState(window.history.state, "", next);
  }, [area, hiringOnly, kind, operatingOnly, pathname, role, search, sector, selectedId, stage, view]);

  useEffect(() => {
    if (!didHydrateQuery.current) return;
    if (filterTrackTimer.current) window.clearTimeout(filterTrackTimer.current);
    filterTrackTimer.current = window.setTimeout(() => {
      const filtersCount = [search.trim(), role !== ALL_ROLES, area !== "All areas", stage !== "All stages", sector !== "All sectors", kind !== "all", !operatingOnly].filter(Boolean).length;
      track("map_filter_applied", {
        city: "bengaluru",
        filter_kind: filtersCount ? "combined" : "default",
        result_count: filteredCompanies.length,
      });
    }, 600);
    return () => {
      if (filterTrackTimer.current) window.clearTimeout(filterTrackTimer.current);
    };
  }, [area, filteredCompanies.length, hiringOnly, kind, operatingOnly, role, search, sector, stage]);

  const chooseCompany = useCallback((company: BengaluruCompany) => {
    setSelectedId(company.id);
    track("map_company_opened", {
      company_slug: company.id,
      area: company.area,
      sector: company.sector,
    });
  }, []);

  const startupCount = data.companies.filter((company) => company.kind === "startup").length;
  const hiringCompanyCount = jobsByCompany.size;
  const hiringCompanyIds = useMemo(() => new Set(jobsByCompany.keys()), [jobsByCompany]);
  const discoverHiringCompanyCount = discoverCompanies.filter((company) => jobsByCompany.has(company.id)).length;
  const visibleHiringCompanyCount = filteredCompanies.filter((company) => jobsByCompany.has(company.id)).length;
  const visibleMappedRoleJobCount = useMemo(() => new Set(filteredCompanies.flatMap((company) => (jobsByCompany.get(company.id) || []).map((job) => job.id))).size, [filteredCompanies, jobsByCompany]);
  const railCompanies = filteredCompanies.slice(0, gridVisibleCount);
  const allRolesSelected = role === ALL_ROLES;
  const activeFilterCount = [role !== ALL_ROLES, area !== "All areas", stage !== "All stages", sector !== "All sectors", kind !== "all", !operatingOnly].filter(Boolean).length;
  const hasNarrowingFilter = Boolean(search.trim() || area !== "All areas" || stage !== "All stages" || sector !== "All sectors" || kind !== "all" || !operatingOnly);
  const clearNarrowingFilters = () => { setSearch(""); setArea("All areas"); setStage("All stages"); setSector("All sectors"); setKind("all"); setOperatingOnly(true); setSelectedId(null); };

  return (
    <main className={`${styles.page} ${view === "grid" ? styles.pageGridMode : ""} ${selected ? styles.pageCompanyOpen : ""}`}>
      <header className={styles.siteHeader}>
        <Link href="/" prefetch={false} className={styles.wordmark} aria-label="Knok home"><KnokLogo size={30} /><span>knok</span></Link>
        <div className={styles.headerTitle}><Radar /><span><b>Company radar</b><small>Bengaluru · live research beta</small></span></div>
        <nav>
          <a href={`${PRODUCT_ORIGIN}/matches?scope=all`}>Browse jobs</a>
          <a href={`${PRODUCT_ORIGIN}/login`} className={styles.headerCta}>Open my workspace <ArrowRight /></a>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><Sparkles /> KNOK COMPANY RADAR · BENGALURU</p>
          <h1>See who is hiring across Bengaluru.</h1>
          <p className={styles.heroDescription}>Explore companies, inspect their current openings, and continue directly to the original company page when something looks right.</p>
          <div className={styles.quickExplore} aria-label="Popular startup neighbourhoods">
            <span>Jump to</span>
            {HOTSPOT_OPTIONS.map((hotspot) => (
              <button key={hotspot} type="button" onClick={() => setArea(hotspot)} aria-pressed={area === hotspot}>
                {hotspot}
              </button>
            ))}
          </div>
        </div>
        <dl className={styles.heroStats}>
          <div><dt>{allRolesSelected ? "Live roles" : `${role} roles`}</dt><dd>{roleJobsLoading ? "…" : roleJobsTotal == null ? "—" : roleJobsTotal.toLocaleString("en-IN")}</dd></div>
          <div><dt>Companies hiring</dt><dd>{roleJobsLoading ? "…" : hiringCompanyCount.toLocaleString("en-IN")}</dd></div>
          <div><dt>Companies mapped</dt><dd>{startupCount.toLocaleString("en-IN")}</dd></div>
          <div><dt>Neighbourhoods</dt><dd>{areas.length - 1}</dd></div>
        </dl>
      </section>

      <section className={styles.controlDeck} aria-label="Map controls">
        <div className={styles.commandBrand}>
          <Link href="/" prefetch={false} aria-label="Knok home"><KnokLogo size={28} /><span className={styles.commandWordmark}>knok</span></Link>
        </div>
        <label className={styles.searchField}>
          <Search />
          <span className={styles.visuallyHidden}>Search companies, sectors or neighbourhoods</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={hiringOnly ? allRolesSelected ? "Search hiring companies" : `Search ${role} companies` : "Search companies, sectors or locations"} />
          {search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X /></button> : null}
        </label>

        <button type="button" className={styles.filterToggle} onClick={() => setShowFilters((current) => !current)} aria-expanded={showFilters}>
          <SlidersHorizontal /> Filters
          {activeFilterCount ? <b>{activeFilterCount}</b> : null}
        </button>

        <div className={styles.viewSwitch} role="group" aria-label="View">
          <button type="button" onClick={() => setView("map")} aria-pressed={view === "map"}><MapIcon />Map</button>
          <button type="button" onClick={() => setView("grid")} aria-pressed={view === "grid"}><Grid2X2 />Companies</button>
        </div>

        <button
          type="button"
          className={styles.mobileViewToggle}
          onClick={() => setView((current) => current === "map" ? "grid" : "map")}
          aria-label={view === "map" ? "Show companies" : "Show map"}
        >
          {view === "map" ? <Grid2X2 /> : <MapIcon />}
        </button>

        {showFilters ? (
          <div className={styles.filterTray}>
            <header className={styles.filterHeader}>
              <span><b>Refine the map</b><small>Every choice updates the map live</small></span>
              <button type="button" onClick={() => { setSearch(""); setRole(ALL_ROLES); setArea("All areas"); setStage("All stages"); setSector("All sectors"); setKind("all"); setOperatingOnly(true); setSelectedId(null); }}>Clear all</button>
              <button type="button" onClick={() => setShowFilters(false)} aria-label="Close filters"><X /></button>
            </header>

            <section className={styles.filterSection}>
              <span>What do you want to work on?</span>
              <div className={styles.roleFilterGrid} role="group" aria-label="Role target">
                {ROLE_OPTIONS.map((option) => <button key={option} type="button" aria-pressed={role === option} onClick={() => {
                  setRole(option);
                  if (option !== ALL_ROLES) setHiringOnly(true);
                  setSelectedId(null);
                }}>{option === ALL_ROLES ? "Every role" : option}</button>)}
              </div>
            </section>

            <section className={styles.filterSection}>
              <span>Organization</span>
              <div className={styles.filterChoices}>
                <button type="button" onClick={() => setKind("all")} aria-pressed={kind === "all"}><Building2 /><b>All companies</b></button>
                <button type="button" onClick={() => setKind("startup")} aria-pressed={kind === "startup"}><Zap /><b>Startups</b></button>
                <button type="button" onClick={() => setKind("vc")} aria-pressed={kind === "vc"}><Target /><b>Investors</b></button>
              </div>
            </section>

            <section className={`${styles.filterSection} ${styles.filterDetails}`}>
              <span>Where and what</span>
              <label><small>Neighbourhood</small><select value={area} onChange={(event) => setArea(event.target.value)}>{areas.map((option) => <option key={option}>{option}</option>)}</select></label>
              <label><small>Stage</small><select value={stage} onChange={(event) => setStage(event.target.value)}>{stages.map((option) => <option key={option}>{option}</option>)}</select></label>
              <label><small>Sector</small><select value={sector} onChange={(event) => setSector(event.target.value)}>{sectors.map((option) => <option key={option}>{option}</option>)}</select></label>
              <div className={styles.filterHotspots} aria-label="Popular neighbourhoods">
                {HOTSPOT_OPTIONS.map((hotspot) => <button key={hotspot} type="button" aria-pressed={area === hotspot} onClick={() => setArea(area === hotspot ? "All areas" : hotspot)}>{hotspot}</button>)}
              </div>
            </section>

            <label className={styles.operatingToggle}><input type="checkbox" checked={operatingOnly} onChange={(event) => setOperatingOnly(event.target.checked)} /><span><b>Operating companies only</b><small>Hide acquired and closed companies</small></span></label>
            <div className={styles.filterResultPreview}><span><b>{filteredCompanies.length.toLocaleString("en-IN")}</b><small>{hiringOnly ? "hiring companies in view" : "companies in view"}</small></span><small>{roleJobsLoading && hiringOnly ? "Refreshing live roles…" : "Map updated"}</small></div>
            <button type="button" className={styles.applyFilters} onClick={() => setShowFilters(false)}>Show {filteredCompanies.length.toLocaleString("en-IN")} companies</button>
          </div>
        ) : null}
      </section>

      <section className={styles.resultsBar}>
        <div><strong>{hiringOnly ? allRolesSelected ? "Hiring now" : `Hiring · ${role}` : "Explore Bengaluru"}</strong><span>{hiringOnly ? "Live jobs across exact and approximate company locations" : "Company directory"}</span></div>
        <p>{hiringOnly ? roleJobsLoading ? "Checking the current Knok corpus" : roleJobsTotal == null ? "Hiring data temporarily unavailable" : <><span className={styles.exactDot} />{discoverHiringCompanyCount.toLocaleString("en-IN")} companies · {visibleMappedRoleJobCount.toLocaleString("en-IN")} live roles</> : <>Choose a company to inspect its original job pages</>}</p>
      </section>

      <section className={`${styles.workspace} ${view === "grid" ? styles.workspaceGridMode : ""}`}>
        {view === "grid" ? <div className={styles.companyRail} aria-label="Companies in current view">
          <header className={styles.railHeader}>
            <span>{hiringOnly ? allRolesSelected ? "HIRING NOW" : "HIRING FOR YOUR ROLE" : "EXPLORE BENGALURU"}</span>
            <div><h2>{hiringOnly ? allRolesSelected ? "Companies with live roles" : role : "Bengaluru companies"}</h2></div>
            <p>{hiringOnly ? roleJobsTotal == null ? "Hiring signals are temporarily unavailable; known companies remain visible." : "Every company below has a current matching opening. Approximate pins indicate company-level coverage without a verified office coordinate." : allRolesSelected ? "Companies with verified logos are prioritised. Live hiring activity is shown as it loads." : `Companies hiring ${role} appear first. Other operating startups follow.`}</p>
          </header>
          {hiringOnly && roleJobsLoading ? <div className={styles.inlineLoadingState}><Activity /><span><b>Refreshing live roles</b><small>Keeping the last verified company layer visible.</small></span></div> : null}
          {filteredCompanies.length ? railCompanies.map((company) => (
            <CompanyCard key={company.id} company={company} jobs={jobsByCompany.get(company.id) || []} selected={selectedId === company.id} onSelect={chooseCompany} />
          )) : (
            <div className={styles.emptyState}>
              <Search />
              <h2>{hiringOnly ? roleJobsTotal == null ? "Hiring data is temporarily unavailable" : allRolesSelected ? "No current opening in this view" : `No current ${role} opening in this view` : "No companies match this view"}</h2>
              <p>{hiringOnly ? roleJobsTotal == null ? "Knok could not load the live corpus. Explore remains available while we retry." : "The company may still be mapped. Explore monitored companies without losing your search." : "Try another neighbourhood, stage or sector."}</p>
              <button type="button" onClick={() => {
                if (hiringOnly && roleJobsTotal == null) setRoleJobsRefreshKey((current) => current + 1);
                else if (hiringOnly && hasNarrowingFilter) clearNarrowingFilters();
                else if (hiringOnly) setHiringOnly(false);
                else { clearNarrowingFilters(); setRole(ALL_ROLES); }
              }}>{hiringOnly ? roleJobsTotal == null ? "Try hiring data again" : hasNarrowingFilter ? "Clear location and company filters" : "Show Explore" : "Clear filters"}</button>
            </div>
          )}
          {railCompanies.length < filteredCompanies.length ? (
            <button type="button" className={styles.loadCompanies} onClick={() => setGridVisibleCount((current) => Math.min(filteredCompanies.length, current + 48))}>
              Show more companies <span>Continue the directory</span>
            </button>
          ) : null}
        </div> : null}

        <div className={`${styles.mapStage} ${selected ? styles.mapStageFocused : ""}`} aria-hidden={view !== "map"}>
          <MapCanvas companies={deferredFilteredCompanies} hiringCompanyIds={hiringCompanyIds} selected={selected} onSelect={chooseCompany} visible={view === "map"} />
          {!roleJobsLoading && hiringOnly && roleJobsTotal === null ? (
            <div className={styles.mapEmptyOverlay}>
              <Activity />
              <h2>Hiring data is temporarily unavailable</h2>
              <p>Explore still works. Retry the live corpus without leaving the map.</p>
              <button type="button" onClick={() => setRoleJobsRefreshKey((current) => current + 1)}>Try again</button>
            </div>
          ) : !roleJobsLoading && !filteredCompanies.length && roleJobsTotal !== null ? (
            <div className={styles.mapEmptyOverlay}>
              <Search />
              <h2>{hiringOnly ? allRolesSelected ? "No current opening in this view" : `No current ${role} opening in this view` : "No mapped company matches this search"}</h2>
              <p>{hiringOnly ? hasNarrowingFilter ? "The role may be live elsewhere in Bengaluru. Clear the company and location filters to see the full Hiring map." : "Keep the company in view even when the right role is not open yet." : "Clear the search or broaden the filters."}</p>
              <button type="button" onClick={() => {
                if (hiringOnly && hasNarrowingFilter) clearNarrowingFilters();
                else if (hiringOnly) setHiringOnly(false);
                else { clearNarrowingFilters(); setRole(ALL_ROLES); }
              }}>{hiringOnly ? hasNarrowingFilter ? "Clear location and company filters" : "Show monitored companies" : "Clear filters"}</button>
            </div>
          ) : null}
          {!selected && hiringOnly ? <div className={styles.mapStats} aria-label="Current hiring coverage">
            <>
              {roleJobsLoading ? <span className={styles.mapHiringStat}><Activity /><b>Refreshing</b> live roles</span> : null}
              <span className={styles.mapHiringStat}><Activity /><b>{visibleHiringCompanyCount.toLocaleString("en-IN")}</b> employers</span>
              <span><BriefcaseBusiness /><b>{visibleMappedRoleJobCount.toLocaleString("en-IN")}</b> live roles</span>
            </>
          </div> : null}
        </div>

        {selected ? <CompanyDetail company={selected} role={role} corpusJobs={roleJobs} jobSignalsAvailable={roleJobsTotal !== null} onClose={() => setSelectedId(null)} /> : null}
      </section>

      <nav className={styles.bottomNav} aria-label="Primary map navigation">
        <button type="button" onClick={() => { setHiringOnly(false); setSelectedId(null); track("map_navigation_clicked", { destination: "explore" }); }} aria-current={!hiringOnly ? "page" : undefined}><Compass /><span>Explore</span></button>
        <button type="button" onClick={() => { setHiringOnly(true); setSelectedId(null); track("map_navigation_clicked", { destination: "hiring", role }); }} aria-current={hiringOnly ? "page" : undefined}><BriefcaseBusiness /><span>Hiring</span></button>
      </nav>

      <a className={styles.feedbackButton} href={FEEDBACK_URL} target="_blank" rel="noreferrer" aria-label="Request or share feedback" onClick={() => track("map_feedback_clicked", { mode: hiringOnly ? "hiring" : "explore" })}>
        <span className={styles.feedbackIcon}><MessageCircle /></span><span className={styles.feedbackCopy}>Feedback</span>
      </a>

      <footer className={styles.footer}>
        <span>Independent research beta · company facts require ongoing verification</span>
        <span>Map data © OpenStreetMap contributors</span>
      </footer>
    </main>
  );
}
