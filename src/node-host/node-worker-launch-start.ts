import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildWorkerProcessTurn } from "../worker/worker-process-protocol.js";
import type { NodeWorkerCleanupMode } from "./node-worker-launch-receipt.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchReceipt,
} from "./node-worker-launch-store.js";
import {
  prepareNodeWorkerLaunchTransport,
  sendNodeWorkerInput,
  type NodeWorkerChildAdapter,
} from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  nodeWorkerDescriptorSecrets,
  sanitizeNodeWorkerDiagnostic,
} from "./node-worker-output.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  createNodeWorkerActiveTurn,
  nodeWorkerEnvironmentBinding,
  type NodeWorkerChildStartContext,
  type NodeWorkerChildStartParams,
  type NodeWorkerRunningChild,
} from "./node-worker-supervisor-ownership.js";

/** Starts one physical owner behind the durable journal gate, independent of turn reuse. */
export async function startNodeWorkerChild(
  context: NodeWorkerChildStartContext,
  params: NodeWorkerChildStartParams,
): Promise<NodeWorkerLaunchReceipt> {
  const sensitiveValues = nodeWorkerDescriptorSecrets(params.descriptor);
  const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
  // Turn cancellation can beat the child's admission retry deadline. Retain the
  // producer's latest cause so the durable terminal receipt does not become generic.
  const connectionFailure: { errorText?: string } = {};
  for (const value of sensitiveValues) {
    registerSecretValueForRedaction(value);
  }
  const finishFailed = (errorText: string) =>
    context.capacity.finish({
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      state: "failed",
      errorText,
    });
  let adapter: NodeWorkerChildAdapter;
  let container: NodeWorkerContainerIdentity | undefined;
  let cleanupMode: NodeWorkerCleanupMode | null;
  try {
    const prepared = await prepareNodeWorkerLaunchTransport({
      bundleRoot: context.bundleRoot,
      workerEnv: params.workerEnv,
      engineEnv: context.engineEnv,
      input: params.input,
      descriptor: params.descriptor,
      planHash: params.planHash,
      supervisor: params.supervisor,
      connectionFailure,
      scrubber,
      store: context.store,
      containerEngine: context.containerEngine,
      containerLifecycle: context.containerLifecycle,
      containerImage: context.containerImage,
    });
    if (prepared.kind === "terminal") {
      return prepared.receipt;
    }
    adapter = prepared.adapter;
    container = prepared.container;
    cleanupMode = prepared.cleanupMode;
  } catch (error) {
    return finishFailed(
      sanitizeNodeWorkerDiagnostic(error, "node worker spawn failed", scrubber.scrub),
    );
  }
  if (!adapter.pid) {
    if (container) {
      await context.requireContainerLifecycle().remove(container, params.input);
    }
    adapter.kill("SIGKILL");
    adapter.dispose();
    return finishFailed("node worker spawn did not return a process id");
  }
  let worker: NodeWorkerProcessIdentity;
  try {
    worker = requireNodeWorkerProcessIdentity(adapter.pid);
  } catch (error) {
    if (container) {
      await context.requireContainerLifecycle().remove(container, params.input);
    }
    adapter.kill("SIGKILL");
    await adapter.wait().catch(() => undefined);
    adapter.dispose();
    return finishFailed(
      sanitizeNodeWorkerDiagnostic(
        error,
        "node worker process identity unavailable",
        scrubber.scrub,
      ),
    );
  }
  const { promise: journalReady, resolve: releaseJournal } = createDeferredCore();
  const active = {
    state: "running",
    binding: nodeWorkerEnvironmentBinding(params.input),
    turn: createNodeWorkerActiveTurn(params.claim),
    retiring: false,
    idleGeneration: params.idleGeneration,
    adapter,
    journalReady,
    gatewayNamespace: params.input.gatewayNamespace,
    launchId: params.input.launchId,
    planHash: params.planHash,
    scrubber,
    connectionFailure,
    supervisor: params.supervisor,
    worker,
    ...(container ? { container } : {}),
  } as NodeWorkerRunningChild; // SAFETY: done is assigned synchronously below; observation waits on journalReady before publishing state.
  active.done = context.observeChild(active);
  context.active.set(active.launchId, active);
  void active.done.catch(() => undefined);
  let running: NodeWorkerLaunchReceipt;
  try {
    running = await context.store.markRunning({
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: params.supervisor,
      worker,
      cleanupMode,
      ...(container ? { container } : {}),
    });
  } catch (error) {
    releaseJournal();
    if (container) {
      await context.stopChild(active, "interrupted");
      context.active.delete(active.launchId);
      await finishFailed(
        sanitizeNodeWorkerDiagnostic(
          error,
          "node worker container identity could not be persisted",
          scrubber.scrub,
        ),
      );
    } else {
      await context.stopChild(active, "interrupted").catch(() => undefined);
    }
    throw error;
  }
  releaseJournal();
  if (running.state === "cancelled" || running.state === "interrupted") {
    await context.stopChild(active, running.state);
    return (await context.store.get(active.launchId)) ?? running;
  }
  if (running.state !== "running") {
    if (container) {
      await context.stopChild(active, "interrupted");
    } else {
      adapter.closeStartGate?.();
    }
    return running;
  }
  if (context.isClosed() || params.signal?.aborted || active.turn?.cancelled) {
    await context.stopChild(active, context.isClosed() ? "interrupted" : "cancelled");
    return (await context.store.get(active.launchId)) ?? running;
  }
  try {
    const isCurrent = () =>
      context.active.get(active.launchId) === active &&
      !context.isClosed() &&
      !params.signal?.aborted &&
      active.turn?.cancelled === false;
    if (!isCurrent()) {
      throw new Error("node worker admission closed before startup");
    }
    if (!container) {
      await adapter.openStartGate?.();
    }
    if (!isCurrent()) {
      throw new Error("node worker admission closed before descriptor dispatch");
    }
    await sendNodeWorkerInput(
      adapter,
      buildWorkerProcessTurn(params.descriptor, params.idleGeneration !== undefined),
    );
  } catch {
    // Only cancellation and shutdown override the child's observed exit.
    const stopState = context.isClosed()
      ? "interrupted"
      : params.signal?.aborted || active.turn?.cancelled
        ? "cancelled"
        : undefined;
    await context.stopChild(active, stopState);
    return (await context.store.get(active.launchId)) ?? running;
  }
  return (await context.turns.get(params.input.launchId)) ?? running;
}
