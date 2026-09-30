import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMergeGhFixturePrograms } from "./pr-merge-gh-process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("drains native CLI stdout and stderr before preserving a nonzero exit", () => {
  const directory = tempDirs.make("pr-merge-gh-streams-");
  const cli = join(directory, "gh.cjs");
  const payload = "x".repeat(256 * 1024);
  const stdout = `${JSON.stringify({ payload })}\n`;
  const stderr = `${payload}\n`;
  const programs = createMergeGhFixturePrograms(`
console.log(JSON.stringify({ payload: "x".repeat(256 * 1024) }));
console.error("x".repeat(256 * 1024));
process.exit(23);
`);
  writeFileSync(cli, programs.cli);

  const result = spawnSync(requireNodeTool("node"), [...resolveVitestNodeArgs(), cli], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const streamIdentity = (value: string) => ({
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  });

  expect(result.error).toBeUndefined();
  expect({
    status: result.status,
    signal: result.signal,
    stdout: streamIdentity(result.stdout),
    stderr: streamIdentity(result.stderr),
  }).toEqual({
    status: 23,
    signal: null,
    stdout: streamIdentity(stdout),
    stderr: streamIdentity(stderr),
  });
});
