import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Resend SDK lazily imports the optional "@react-email/render" package.
  // We only ever send pre-rendered HTML strings, so keep Resend out of the
  // server bundle and let Node resolve it (and skip that optional import).
  serverExternalPackages: ["resend"],
  async redirects() {
    return [
      { source: "/resident-login", destination: "/login", permanent: true },
      { source: "/resident/login", destination: "/login", permanent: true },
      { source: "/resident-portal/login", destination: "/login", permanent: true },
      { source: "/portal/login", destination: "/login", permanent: true },
      { source: "/portal", destination: "/resident-portal", permanent: true },
      { source: "/reset-password", destination: "/resident-portal/change-password", permanent: false },
      { source: "/change-password", destination: "/resident-portal/change-password", permanent: false },
      { source: "/forgot-password", destination: "/login", permanent: false },
    ];
  },
};

export default nextConfig;
