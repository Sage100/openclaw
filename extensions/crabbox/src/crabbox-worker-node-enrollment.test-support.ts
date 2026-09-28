import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { expect } from "vitest";
import type {
  CrabboxWorkerNodeEnrollment,
  CrabboxWorkerNodeRuntimePreparation,
} from "./crabbox-worker-node-enrollment.js";

export function createWorkerArchiveFixture(): CrabboxWorkerNodeRuntimePreparation["workerBundle"] {
  return {
    url: "https://gateway.example.test/__openclaw__/worker-bootstrap/artifacts/worker",
    token: "synthetic-worker-archive-token",
    sha256: "b".repeat(64),
    bytes: 100,
    packageRelativePath: `worker-artifacts/${"b".repeat(64)}.tgz`,
  };
}

export function createNodeBootstrapFixture(
  overrides: Partial<CrabboxWorkerNodeEnrollment["nodeBootstrap"]> = {},
): CrabboxWorkerNodeEnrollment["nodeBootstrap"] {
  return {
    url: "https://gateway.example.test/__openclaw__/node-bootstrap/v1/artifact",
    token: "synthetic-bootstrap-token",
    sha256: "a".repeat(64),
    bytes: 100,
    openclawVersion: "2026.8.1",
    enabledPluginIds: ["demo"],
    ...overrides,
  };
}

export async function readLaunch(stateDir: string) {
  const target = path.join(stateDir, "launch.json");
  // File watchers can miss a fast atomic rename before their subscription is ready.
  await expect.poll(() => fs.existsSync(target), { timeout: 30_000 }).toBe(true);
  return JSON.parse(fs.readFileSync(target, "utf8")) as {
    build: string;
    cli: string;
    args: string[];
    token?: string;
    setupCode?: string;
    tool?: string;
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

export async function createNodePackageFixture(
  makeTempDir: (prefix: string) => string,
  build: string,
  postinstall = "",
): Promise<Buffer> {
  const root = makeTempDir("crabbox-bootstrap-package-");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1",
      scripts: { postinstall: "node install.cjs" },
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "install.cjs"),
    `require("node:fs").writeFileSync("installed.json", JSON.stringify({ token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, scriptsRan: true }));${postinstall}`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "openclaw.mjs"),
    `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw 2026.8.1");
} else if (args[0] === "plugins" && args[1] === "enable") {
  fs.appendFileSync(path.join(state, "activation.jsonl"), JSON.stringify({ runtimePublished: fs.existsSync(path.join(state, "runtime")) }) + "\\n");
  if (${JSON.stringify(build)} === "activation-failed") process.exit(1);
  for (const id of args.slice(2)) {
    if (${JSON.stringify(build)} === "verbose-activation") process.stdout.write("x".repeat(700_000));
    fs.appendFileSync(path.join(state, "enabled"), id + "\\n");
  }
} else {
  process.title = "openclaw-connect";
  const enabledFile = path.join(state, "enabled");
  const enabledPlugins = fs.existsSync(enabledFile) ? fs.readFileSync(enabledFile, "utf8").trim().split("\\n") : [];
  fs.writeFileSync(path.join(state, "launch.json.tmp"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, tool: process.platform !== "win32" ? execFileSync("bootstrap-tool-fixture", {encoding:"utf8"}).trim() : undefined, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins }));
  // Existence signals readiness only after the child publishes complete JSON.
  fs.renameSync(path.join(state, "launch.json.tmp"), path.join(state, "launch.json"));
  setInterval(() => {}, 60000);
}
`,
  );
  const tools = path.join(packageRoot, "dist", "worker-tools", "bin");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "bootstrap-tool-fixture"), "#!/bin/sh\necho verified-tool\n", {
    mode: 0o755,
  });
  const archive = path.join(root, "package.tgz");
  await tar.create({ cwd: root, file: archive, gzip: true }, ["package"]);
  return fs.readFileSync(archive);
}
