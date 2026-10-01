// Builds the hosted edition: a static export (./out) that answers API calls
// from the published data set instead of a server. See docs/DEPLOYMENT.md.
import { spawnSync } from "node:child_process";

const result = spawnSync("next", ["build"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    NEXT_PUBLIC_STATIC_API: "1",
    // One-click sign-in for the built-in role accounts.
    NEXT_PUBLIC_ACCOUNT_PASSWORD: process.env.NEXT_PUBLIC_ACCOUNT_PASSWORD ?? "smartcity",
  },
});
process.exit(result.status ?? 1);
