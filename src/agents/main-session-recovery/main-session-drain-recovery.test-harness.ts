import path from "node:path";
import { expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { waitForFast, type SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import { makeAssistantTextMessage } from "./main-session-restart-recovery-transcript.test-support.js";
import {
  markRestartAbortedMainSessions,
  type scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

type DrainMarkedRecoveryFixture = {
  tmpDir: string;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  writeStore: (sessionsDir: string, store: Record<string, SessionEntryFixture>) => Promise<void>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  runningSessionEntry: (sessionId: string, overrides?: SessionEntryFixture) => SessionEntry;
  resolveGatewayContext: GatewayContextResolver;
  scheduleRestartAbortedMainSessionRecovery: (
    params: Omit<Parameters<typeof scheduleRestartAbortedMainSessionRecovery>[0], "gatewayRuntime">,
  ) => ReturnType<typeof scheduleRestartAbortedMainSessionRecovery>;
  gatewayParams: () => Record<string, unknown>;
};

export function registerDrainMarkedRecoveryCase(
  getFixture: () => DrainMarkedRecoveryFixture,
): void {
  it("resumes a drain-marked turn that settles normally before the replacement starts", async () => {
    const {
      tmpDir,
      makeSessionsDir,
      writeStore,
      writeTranscript,
      runningSessionEntry,
      resolveGatewayContext,
      scheduleRestartAbortedMainSessionRecovery,
      gatewayParams,
    } = getFixture();
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const runId = "drain-overlap-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      [sessionKey]: runningSessionEntry("main-session"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish the admitted work after the restart" },
    ]);

    const rootAdmission = tryBeginGatewayRootWorkAdmission();
    expect(rootAdmission).not.toBeNull();
    await rootAdmission?.run(async () => {
      await expect(
        markRestartAbortedMainSessions({
          resolveGatewayContext,
          stateDir: tmpDir,
          activeRuns: [{ runId, lifecycleGeneration, sessionKey, sessionId: "main-session" }],
          reason: "gateway restart drain",
        }),
      ).resolves.toEqual({ marked: 1, skipped: 0 });
      markGatewayRestartDraining();
      await expect(
        runWithGatewayIndependentRootWorkAdmission(async () => undefined),
      ).rejects.toBeInstanceOf(GatewayDrainingError);
      await writeTranscript(sessionsDir, "main-session", [
        {
          role: "toolResult",
          toolName: "sessions_spawn",
          isError: true,
          content: [{ type: "text", text: "Gateway restart admission is closed." }],
        },
        makeAssistantTextMessage("The Gateway is restarting; retry after it comes back."),
      ]);
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          agentId: "main",
          event: {
            ts: Date.now(),
            sessionId: "main-session",
            runId,
            lifecycleGeneration,
            data: { phase: "end", stopReason: "stop" },
          },
        });
      });
    });
    rootAdmission?.release();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.restartRecoveryRuns).toBeUndefined();

    resetGatewayWorkAdmission();
    rotateAgentEventLifecycleGeneration();
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      getConfig: () => ({}),
      maxRetries: 1,
      stateDir: tmpDir,
    });
    try {
      await waitForFast(() => expect(callGateway).toHaveBeenCalledOnce());
    } finally {
      await recovery.stop();
    }

    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "main-session",
      inputProvenance: {
        kind: "internal_system",
        sourceSessionKey: sessionKey,
        sourceTool: "main_session_restart_recovery",
      },
      sessionKey,
    });
    expect(gatewayParams().idempotencyKey).not.toBe(runId);
  });
}
