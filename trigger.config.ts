import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { readFileSync } from "fs";

export default defineConfig({
  project: "<your-trigger-project-ref>",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300, // 5 min — covers Apify scrape + Claude classifier
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["./src/triggers"],
  build: {
    extensions: [
      syncEnvVars(async () => {
        const content = readFileSync(".env", "utf-8");
        const vars: Record<string, string> = {};
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx === -1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (val) vars[key] = val;
        }
        return vars;
      }),
    ],
  },
});
