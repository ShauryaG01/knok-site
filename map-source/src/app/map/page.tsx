import type { Metadata } from "next";
import BengaluruMapExperience, { type BengaluruMapData } from "./BengaluruMapExperience";
import { PublicMapAnalytics } from "./PublicMapAnalytics";
import mapData from "@/map-content/bengaluruMap.json";

export const metadata: Metadata = {
  title: "Bengaluru Company Radar — Knok",
  description:
    "Explore Bengaluru tech companies, find live roles for your function, and map the people behind one opening you actually want.",
  alternates: { canonical: "/map" },
  openGraph: {
    title: "Find a company worth pursuing — Knok Company Radar",
    description:
      "Bengaluru companies, live roles and a direct route into the hiring team—mapped by Knok.",
    type: "website",
    url: "/map",
  },
};

export default function MapPage() {
  const data = mapData as BengaluruMapData;
  return (
    <>
      <PublicMapAnalytics totalCompanies={data.companies.length} />
      <BengaluruMapExperience data={data} />
    </>
  );
}
