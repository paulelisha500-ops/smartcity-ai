/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
