import { clusterRadiusForZoom, clusterTierForZoom, companyKey, companyMatchesSearch, dispersedMarkerOffsets, groupProjectedCompanies, jobsForCompany, roleRouteLabels } from "./mapModel";

describe("Bengaluru company-first discovery model", () => {
  it("joins common company naming variants without mixing unrelated employers", () => {
    const company = { id: "visa-india", name: "Visa India" } as Parameters<typeof jobsForCompany>[0];
    const jobs = [
      { id: "visa-1", company: "Visa" },
      { id: "meesho-1", company: "Meesho" },
    ] as Parameters<typeof jobsForCompany>[1];

    expect(companyKey("Visa India Pvt Ltd")).toBe("visa");
    expect(jobsForCompany(company, jobs).map((job) => job.id)).toEqual(["visa-1"]);
  });

  it("prefers a canonical company id when the display name differs", () => {
    const company = { id: "sarvam-ai", name: "Sarvam AI" } as Parameters<typeof jobsForCompany>[0];
    const jobs = [
      { id: "sarvam-1", company: "Sarvam Studio", company_canonical_id: "sarvam-ai" },
    ] as Parameters<typeof jobsForCompany>[1];

    expect(jobsForCompany(company, jobs)).toHaveLength(1);
  });

  it("joins known legal and former-brand aliases without creating duplicate employers", () => {
    expect(companyKey("VISA CONSOLIDATED SUPPORT SERVICES (INDIA) PVT LTD")).toBe("visa");
    expect(companyKey("KrazyBee")).toBe("kreditbee");
    expect(jobsForCompany(
      { id: "visa", name: "Visa India" },
      [{ id: "visa-legal", company: "VISA CONSOLIDATED SUPPORT SERVICES (INDIA) PVT LTD" }],
    )).toHaveLength(1);
  });

  it("never nests a short employer name inside an unrelated longer company", () => {
    const jobs = [
      { id: "itc-1", company: "ITC", company_canonical_id: "itc-canonical" },
      { id: "snitch-1", company: "Snitch", company_canonical_id: "snitch-canonical" },
    ];

    expect(jobsForCompany({ id: "snitch", name: "Snitch" }, jobs).map((job) => job.id)).toEqual(["snitch-1"]);
    expect(jobsForCompany({ id: "itc", name: "ITC" }, jobs).map((job) => job.id)).toEqual(["itc-1"]);
  });

  it("changes the route preview to the candidate's selected function", () => {
    expect(roleRouteLabels("Growth Marketing")[0]).toMatch(/Growth/);
    expect(roleRouteLabels("Software Engineer")[0]).toMatch(/Engineering/);
    expect(roleRouteLabels("Product Manager")[2]).toMatch(/Talent partner/);
  });

  it("searches brands, sectors, locations, acronyms and small typos without substring collisions", () => {
    const razorpay = { name: "Razorpay", area: "Koramangala", sector: "Fintech", stage: "Series C+", founders: ["Harshil Mathur"] };
    const snitch = { name: "Snitch", area: "Koramangala", sector: "D2C", stage: "Series B", founders: [] as string[] };
    const itc = { name: "ITC", area: "Hebbal", sector: "Consumer", stage: "Public", founders: [] as string[] };
    const unrelatedInitial = { name: "Infosys", area: "Electronic City", sector: "Other", stage: "Public", founders: ["N. R. Narayana Murthy"] };

    expect(companyMatchesSearch(razorpay, "razor pay")).toBe(true);
    expect(companyMatchesSearch(razorpay, "fin tech")).toBe(true);
    expect(companyMatchesSearch(razorpay, "koramngala")).toBe(true);
    expect(companyMatchesSearch(razorpay, "bangalore fintech")).toBe(true);
    expect(companyMatchesSearch(snitch, "ITC")).toBe(false);
    expect(companyMatchesSearch(itc, "ITC")).toBe(true);
    expect(companyMatchesSearch(unrelatedInitial, "Razorpay")).toBe(false);
  });

  it("groups nearby projected companies while leaving distant ones independent", () => {
    const companies = [
      { id: "a", lat: 12.93, lng: 77.6 },
      { id: "b", lat: 12.931, lng: 77.601 },
      { id: "c", lat: 13.02, lng: 77.7 },
    ];
    const groups = groupProjectedCompanies([
      { company: companies[0], x: 100, y: 100 },
      { company: companies[1], x: 126, y: 112 },
      { company: companies[2], x: 280, y: 220 },
    ], 52);

    expect(groups.map((group) => group.companies.map((company) => company.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps the selected company outside a nearby stack", () => {
    const companies = [
      { id: "a", lat: 12.93, lng: 77.6 },
      { id: "b", lat: 12.931, lng: 77.601 },
      { id: "c", lat: 12.932, lng: 77.602 },
    ];
    const groups = groupProjectedCompanies(companies.map((company, index) => ({
      company,
      x: 100 + index * 8,
      y: 100,
    })), 52, "b");

    expect(groups.find((group) => group.companies.some((company) => company.id === "b"))?.companies).toHaveLength(1);
  });

  it("merges residual centroid collisions after the greedy grouping pass", () => {
    const companies = ["a", "b", "c", "d"].map((id, index) => ({ id, lat: 12.9 + index * .001, lng: 77.6 }));
    const groups = groupProjectedCompanies([
      { company: companies[0], x: 0, y: 0 },
      { company: companies[1], x: 40, y: 0 },
      { company: companies[2], x: 95, y: 0 },
      { company: companies[3], x: 135, y: 0 },
    ], 60);

    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        expect(Math.hypot(groups[left].x - groups[right].x, groups[left].y - groups[right].y)).toBeGreaterThan(60);
      }
    }
  });

  it("represents every company exactly once at city-scale density", () => {
    const companies = Array.from({ length: 240 }, (_, index) => ({
      id: `company-${index}`,
      lat: 12.82 + (index % 20) * .01,
      lng: 77.48 + Math.floor(index / 20) * .015,
    }));
    const groups = groupProjectedCompanies(companies.map((company, index) => ({
      company,
      x: 60 + (index % 20) * 18,
      y: 80 + Math.floor(index / 20) * 18,
    })), 96);
    const representedIds = groups.flatMap((group) => group.companies.map((company) => company.id));

    expect(representedIds).toHaveLength(companies.length);
    expect(new Set(representedIds).size).toBe(companies.length);
    expect([...representedIds].sort()).toEqual(companies.map((company) => company.id).sort());
  });

  it("keeps a dense city overview distributed without turning it into marker noise", () => {
    const companies = Array.from({ length: 400 }, (_, index) => ({
      id: `dense-${index}`,
      lat: 12.8 + Math.floor(index / 25) * .005,
      lng: 77.48 + (index % 25) * .005,
    }));
    const groups = groupProjectedCompanies(companies.map((company, index) => ({
      company,
      x: 20 + (index % 25) * 20,
      y: 20 + Math.floor(index / 25) * 20,
    })), clusterRadiusForZoom(11.5, true));

    expect(groups.length).toBeGreaterThanOrEqual(12);
    expect(groups.length).toBeLessThanOrEqual(32);
    expect(Math.max(...groups.map((group) => group.companies.length))).toBeLessThan(60);
  });

  it("reveals the map in three deliberate zoom tiers", () => {
    expect(clusterTierForZoom(11.5)).toBe("city");
    expect(clusterTierForZoom(12.8)).toBe("area");
    expect(clusterTierForZoom(14.3)).toBe("street");
    expect(clusterRadiusForZoom(11.5, false)).toBeGreaterThan(clusterRadiusForZoom(12.8, false));
    expect(clusterRadiusForZoom(12.8, false)).toBeGreaterThan(clusterRadiusForZoom(14.3, false));
    expect(clusterRadiusForZoom(11.5, true)).toBeGreaterThan(clusterRadiusForZoom(12.8, true));
  });

  it("gives every company a separate clickable position when one chosen cluster expands", () => {
    const offsets = dispersedMarkerOffsets(17, true);
    expect(offsets).toHaveLength(17);
    expect(new Set(offsets.map(([x, y]) => `${x.toFixed(3)}:${y.toFixed(3)}`)).size).toBe(17);
    expect(offsets.every(([x, y]) => Math.hypot(x, y) >= 40)).toBe(true);
  });
});
