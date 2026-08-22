/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Local design reviews are sometimes opened through the machine's LAN IP.
  // Keep the extra development origins explicit instead of weakening this in
  // every environment. Example: KNOK_ALLOWED_DEV_ORIGINS=192.168.1.12
  allowedDevOrigins: (process.env.KNOK_ALLOWED_DEV_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Parallel release and E2E sessions must not share Next's mutable build directory.
  // The default remains unchanged; isolated runners provide a private directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The launch hosts have very little disk headroom.  Standalone output keeps
  // only the server files and production dependencies required at runtime, so
  // staging never needs a second 400+ MB node_modules tree on RackNerd.
  output: "standalone",
  // Exact release builders provide the full reviewed Git SHA.  Next otherwise
  // generates a fresh build id on every run, making two builds of the same
  // source differ for reasons unrelated to source or dependency inputs.
  ...(process.env.KNOK_RELEASE_REVISION
    ? { generateBuildId: async () => process.env.KNOK_RELEASE_REVISION }
    : {}),
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000",
  },
};

module.exports = nextConfig;
