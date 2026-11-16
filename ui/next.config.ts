import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const uiRoot = dirname(fileURLToPath(import.meta.url));
const desktopDistDir = process.env.AIFIOS_NEXT_DIST_DIR?.trim();
const productVersion = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

const nextConfig: NextConfig = {
  outputFileTracingRoot: uiRoot,
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_ECHO_FOUNDER_VERSION: productVersion,
  },
  // Desktop packaging uses Next's traced standalone server instead of copying
  // the full development node_modules tree into every .app bundle.
  ...(desktopDistDir ? { output: "standalone" } : {}),
  ...(desktopDistDir ? { distDir: desktopDistDir } : {}),
  // A signed desktop bundle is immutable. Keep runtime route responses in
  // Next's memory cache instead of promoting build seeds into the App tree.
  ...(desktopDistDir ? { experimental: { isrFlushToDisk: false } } : {}),
};

export default nextConfig;
