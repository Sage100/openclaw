import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inject } from "vitest";

/** Resolve the emitted implementation, including when optimization removes its facade. */
export function controlUiE2eBuiltModuleRequest(modulePath: string): RegExp {
  const buildRoot = inject("controlUiE2eBuildRoot");
  if (!buildRoot) {
    throw new Error("Built module requests require the bundled Control UI E2E server");
  }
  const assetsDir = path.join(buildRoot, "assets");
  const sourceSuffix = `/${modulePath.replaceAll("\\", "/")}`;
  const chunks = readdirSync(assetsDir).filter((file) => {
    if (!file.endsWith(".js.map")) {
      return false;
    }
    const sourceMap: { sources: string[] } = JSON.parse(
      readFileSync(path.join(assetsDir, file), "utf8"),
    );
    return sourceMap.sources.some((source) => source.replaceAll("\\", "/").endsWith(sourceSuffix));
  });
  if (chunks.length !== 1) {
    throw new Error(`Expected one built chunk for ${modulePath}, found ${chunks.length}`);
  }
  const file = chunks[0]!.slice(0, -".map".length).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`/assets/${file}(?:\\?.*)?$`, "u");
}
