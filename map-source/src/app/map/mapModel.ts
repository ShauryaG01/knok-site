export interface CompanyIdentity {
  id: string;
  name: string;
}

export interface CompanyJob {
  id: string;
  company: string;
  company_canonical_id?: string | null;
}

export interface ProjectedCompany<T> {
  company: T;
  x: number;
  y: number;
}

export interface ProjectedCompanyGroup<T extends { lat: number; lng: number }> {
  companies: T[];
  x: number;
  y: number;
  lat: number;
  lng: number;
}

export type MapClusterTier = "city" | "area" | "street";

export function clusterTierForZoom(zoom: number): MapClusterTier {
  if (zoom < 12.1) return "city";
  if (zoom < 14.15) return "area";
  return "street";
}

export function clusterRadiusForZoom(zoom: number, compact: boolean) {
  const tier = clusterTierForZoom(zoom);
  // Projection already spreads companies as the camera moves closer. A
  // modest, progressively smaller collision radius reveals inventory across
  // several wheel steps instead of exploding one tier into hundreds of pins.
  if (tier === "city") return compact ? 56 : 62;
  if (tier === "area") return compact ? 48 : 54;
  return compact ? 38 : 44;
}

export interface SearchableCompany {
  name: string;
  area: string;
  sector: string;
  stage: string;
  founders: string[];
}

function searchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-IN")
    .replace(/bangalore/g, "bengaluru")
    .trim();
}

function oneEditAway(left: string, right: string) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shorter.length === longer.length) shortIndex += 1;
    longIndex += 1;
  }
  return true;
}

export function companyMatchesSearch(company: SearchableCompany, query: string) {
  const value = searchText(query);
  if (!value) return true;
  const fields = [company.name, company.area, company.sector, company.stage, ...company.founders, "bengaluru"].map(searchText);
  const fieldTokens = fields.flatMap((field) => field.split(/[^a-z0-9]+/).filter(Boolean));
  const queryTokens = value.split(/[^a-z0-9]+/).filter(Boolean);

  // Short queries are usually acronyms. Exact token matching keeps ITC from
  // surfacing Snitch while still finding an employer named ITC.
  if (value.replace(/[^a-z0-9]/g, "").length <= 3) return fieldTokens.includes(value);

  // Users naturally type brand and sector names with or without spaces:
  // Razor Pay -> Razorpay, fin tech -> fintech.
  const compactQuery = value.replace(/[^a-z0-9]/g, "");
  if (fields.some((field) => field.replace(/[^a-z0-9]/g, "").includes(compactQuery))) return true;

  // Require every word, but tolerate one typo in meaningful words. This
  // catches Koramngala without turning short fragments into broad matches.
  return queryTokens.every((token) => fieldTokens.some((fieldToken) => (
    fieldToken.startsWith(token)
    || (fieldToken.length >= 3 && token.startsWith(fieldToken))
    || (token.length >= 5 && fieldToken.length >= 5 && oneEditAway(token, fieldToken))
  )));
}

export function dispersedMarkerOffsets(count: number, compact: boolean): Array<[number, number]> {
  if (count <= 1) return [[0, 0]];
  const perRing = 8;
  const offsets: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const ring = Math.floor(index / perRing);
    const ringStart = ring * perRing;
    const ringCount = Math.min(perRing, count - ringStart);
    const angle = -Math.PI / 2 + ((index - ringStart) / ringCount) * Math.PI * 2;
    const radius = (compact ? 43 : 52) + ring * (compact ? 34 : 41);
    offsets.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return offsets;
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("en-IN");
}

const COMPANY_NAME_ALIASES: Record<string, string> = {
  krazybee: "kreditbee",
  visaconsolidatedsupportservices: "visa",
};

export function companyKey(value: string) {
  const key = normalized(value)
    .replace(/\b(private|pvt|limited|ltd|technologies|technology|solutions|india)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return COMPANY_NAME_ALIASES[key] || key;
}

export function roleRouteLabels(role: string) {
  const value = normalized(role);
  if (value.includes("product")) return ["Head of Product", "Product lead on the hiring team", "Talent partner · Product"];
  if (value.includes("growth") || value.includes("marketing")) return ["Head of Growth / Marketing", "Growth lead closest to the role", "Talent partner · Growth"];
  if (value.includes("software") || value.includes("engineer")) return ["Engineering leader", "Engineering manager on the team", "Technical recruiter"];
  if (value.includes("data")) return ["Head of Data", "Analytics / Data manager", "Technical recruiter"];
  if (value.includes("design")) return ["Head of Design", "Design manager on the team", "Talent partner · Design"];
  if (value.includes("finance")) return ["Finance leader", "Manager closest to the role", "Talent partner"];
  if (value.includes("program")) return ["Function leader", "Program leader on the team", "Talent partner"];
  return ["Function leader", "Team manager", "Talent partner"];
}

export function jobsForCompany<T extends CompanyJob>(company: CompanyIdentity, jobs: T[]): T[] {
  const key = companyKey(company.name);
  return jobs.filter((job) => {
    if (job.company_canonical_id && job.company_canonical_id === company.id) return true;
    const jobKey = companyKey(job.company);
    // Company names are identities, not search terms. Substring matching made
    // short employers leak into longer names (for example ITC -> Snitch).
    // Legal suffixes and known aliases are already handled by companyKey, so
    // anything left must be an exact identity match.
    return jobKey === key;
  });
}

/**
 * Groups markers in screen space rather than geographic degrees. That keeps
 * the visual hierarchy consistent across zoom levels while retaining a real
 * geographic centroid for the resulting marker.
 *
 * The selected company is deliberately kept out of every group so opening a
 * company drawer never makes the active marker disappear into a stack.
 */
export function groupProjectedCompanies<T extends { id: string; lat: number; lng: number }>(
  points: ProjectedCompany<T>[],
  radius: number,
  standaloneId: string | null = null,
): ProjectedCompanyGroup<T>[] {
  const groups: ProjectedCompanyGroup<T>[] = [];

  for (const point of points) {
    if (point.company.id === standaloneId) {
      groups.push({
        companies: [point.company],
        x: point.x,
        y: point.y,
        lat: point.company.lat,
        lng: point.company.lng,
      });
      continue;
    }

    let nearest: ProjectedCompanyGroup<T> | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      if (group.companies.some((company) => company.id === standaloneId)) continue;
      const distance = Math.hypot(group.x - point.x, group.y - point.y);
      if (distance <= radius && distance < nearestDistance) {
        nearest = group;
        nearestDistance = distance;
      }
    }

    if (!nearest) {
      groups.push({
        companies: [point.company],
        x: point.x,
        y: point.y,
        lat: point.company.lat,
        lng: point.company.lng,
      });
      continue;
    }

    const nextCount = nearest.companies.length + 1;
    nearest.x = (nearest.x * nearest.companies.length + point.x) / nextCount;
    nearest.y = (nearest.y * nearest.companies.length + point.y) / nextCount;
    nearest.lat = (nearest.lat * nearest.companies.length + point.company.lat) / nextCount;
    nearest.lng = (nearest.lng * nearest.companies.length + point.company.lng) / nextCount;
    nearest.companies.push(point.company);
  }

  return groups;
}
