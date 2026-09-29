import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

// Ordinary child Workers inherit this preload but do not own a Vitest environment.
const entry = process.argv[1];
if (
  entry &&
  /[/\\]vitest[/\\]dist[/\\]workers[/\\](?:forks|threads|vmForks|vmThreads)\.js$/.test(entry)
) {
  // Match the worker's Vitest instance, including package-local pnpm peer graphs.
  const require = process.getBuiltinModule("module").createRequire(entry);
  const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");
  installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
}
