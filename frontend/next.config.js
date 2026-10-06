/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The hosted edition (npm run build:static) is exported as plain files and
  // served with no Node process, so there is no image optimiser to call.
  ...(process.env.NEXT_PUBLIC_STATIC_API === "1" && {
    output: "export",
    images: { unoptimized: true },
    // Set when the host serves the site under a path rather than at its root
    // (GitHub Pages: /<repository>).
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  }),

  webpack: (config, { dev }) => {
    // Docker Desktop on Windows shares the source directory through a
    // filesystem that does not deliver inotify events into the Linux
    // container, so webpack's watcher never fires and edits appear to be
    // ignored until the container is restarted. Polling costs a little CPU
    // but is the only thing that reliably picks up host edits here.
    if (dev) {
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
        ignored: ["**/node_modules/**", "**/.next/**"],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
