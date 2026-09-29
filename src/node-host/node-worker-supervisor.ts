import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type {
  NodeWorkerEnvironmentStopInput,
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import {
  observeNodeWorkerChild,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import { startNodeWorkerChild } from "./node-worker-launch-start.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  clearNodeWorkerRetention,
  createNodeWorkerObservedTerminal,
  nodeWorkerEnvironmentKey,
  nodeWorkerEnvironmentMatches,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
  type NodeWorkerPendingAdmission,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
  type NodeWorkerSupervisorOptions,
} from "./node-worker-supervisor-ownership.js";
import {
  createNodeWorkerLaunchRecovery,
  type NodeWorkerRecovery,
} from "./node-worker-supervisor-recovery.js";
import { stopOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import { createNodeWorkerTurnLifecycle } from "./node-worker-turn-lifecycle.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const NODE_WORKER_STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, NodeWorkerActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly recoveries = new Map<string, NodeWorkerRecovery>();
  private readonly recoverRunning: ReturnType<typeof createNodeWorkerLaunchRecovery>;
  private readonly bundleRoot: string;
  private readonly journal: NodeWorkerJournalWorker;
  private readonly store: NodeWorkerLaunchStore;
  private readonly turns: NodeWorkerTurnStore;
  private readonly turnLifecycle: ReturnType<typeof createNodeWorkerTurnLifecycle>;
  private readonly admissions = new Map<string, NodeWorkerPendingAdmission>();
  private readonly retentions = new Set<Promise<NodeWorkerWorkspaceRetainResult>>();
  private readonly stoppingEnvironments = new Map<string, number>();
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly engineEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
  private readonly containerEngine?: NodeWorkerContainerEngine;
  private readonly containerLifecycle?: NodeWorkerContainerLifecycle;
  private readonly containerImage?: string;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private initializationPromise?: Promise<void>;
  private closed = false;
  private closeCompleted = false;
  private closePromise?: Promise<void>;
  private idleGeneration = 0;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.journal = new NodeWorkerJournalWorker({ env });
    this.store = new NodeWorkerLaunchStore(this.journal);
    this.turns = new NodeWorkerTurnStore(this.journal);
    this.workerEnv = snapshotNodeWorkerEnv(env);
    this.engineEnv = { ...process.env, ...env };
    this.containerEngine = options.containerEngine;
    this.containerLifecycle = options.containerEngine
      ? new NodeWorkerContainerLifecycle(options.containerEngine, this.bundleRoot, this.store)
      : undefined;
    this.containerImage = options.containerImage;
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: this.bundleRoot, env: this.workerEnv });
    this.capacity = new NodeWorkerCapacity(this.store, options);
    this.recoverRunning = createNodeWorkerLaunchRecovery({
      store: this.store,
      capacity: this.capacity,
      containerLifecycle: this.containerLifecycle,
      recoveries: this.recoveries,
      isRecoveryActive: () => !this.closed,
    });
    this.turnLifecycle = createNodeWorkerTurnLifecycle({
      active: this.active,
      admissions: this.admissions,
      starting: this.starting,
      stoppingEnvironments: this.stoppingEnvironments,
      store: this.store,
      turns: this.turns,
      capacity: this.capacity,
      workspace: this.workspace,
      workerEnv: this.workerEnv,
      stopTimeoutMs: NODE_WORKER_STOP_GRACE_MS + FORCE_STOP_WAIT_MS,
      isClosed: () => this.closed,
      isCloseCompleted: () => this.closeCompleted,
      getIdleGeneration: () => this.idleGeneration,
      advanceIdleGeneration: () => {
        this.idleGeneration++;
      },
      getSupervisorIdentity: () =>
        (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid)),
      initialize: () => this.initialize(),
      statusOwner: (launchId) => this.statusOwner(launchId),
      reconcileActiveTerminal: (active) => this.reconcileActiveTerminal(active),
      recoverRunning: (receipt) => this.recoverRunning(receipt),
      cancelOwner: (expected) => this.cancelOwner(expected),
      stopChild: (active, state) => this.stopChild(active, state),
      startChild: (params) =>
        startNodeWorkerChild(
          {
            active: this.active,
            bundleRoot: this.bundleRoot,
            capacity: this.capacity,
            containerEngine: this.containerEngine,
            containerImage: this.containerImage,
            containerLifecycle: this.containerLifecycle,
            engineEnv: this.engineEnv,
            store: this.store,
            turns: this.turns,
            isClosed: () => this.closed,
            observeChild: (active) => this.observeChild(active),
            stopChild: (active, state) => this.stopChild(active, state),
            requireContainerLifecycle: () => this.requireContainerLifecycle(),
          },
          params,
        ),
    });
  }

  initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    const initialization = (async () => {
      if (this.containerLifecycle) {
        await this.containerLifecycle.initialize();
      }
      await this.capacity.initialize(async (receipt) => {
        await this.recoverRunning(receipt, false);
      });
    })().catch((error: unknown) => {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = undefined;
      }
      throw error;
    });
    return (this.initializationPromise = initialization);
  }

  async hasActiveWork(): Promise<boolean> {
    const hasLocalWork = () =>
      !this.capacity.isInitialized() ||
      this.admissions.size > 0 ||
      this.starting.size > 0 ||
      this.recoveries.size > 0 ||
      this.retentions.size > 0 ||
      this.active.size > this.turnLifecycle.idleChildren().length ||
      this.stoppingEnvironments.size > 0 ||
      this.workspace.processes.hasActiveWork();
    if (hasLocalWork()) {
      return true;
    }
    const count = await this.store.nonterminalCount();
    return count > this.turnLifecycle.idleChildren().length || hasLocalWork();
  }

  retireIdle(): Promise<void> {
    return this.turnLifecycle.retireIdle();
  }

  launch(
    rawInput: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    return this.turnLifecycle.launch(rawInput, connectionEndpoint, signal);
  }

  status(
    launchId: string,
    options?: { waitMs: number; signal?: AbortSignal },
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    return this.turnLifecycle.status(launchId, options);
  }

  /** External cancellation joins admission; startup invokes only the turn primitive. */
  cancel(expected: NodeWorkerSupervisorIdentity): Promise<NodeWorkerLaunchReceipt | undefined> {
    return this.turnLifecycle.cancel(expected);
  }

  private async statusOwner(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const active = this.active.get(launchId);
    if (active?.state === "observed") {
      return this.reconcileActiveTerminal(active);
    }
    if (active?.state === "running") {
      if (active.deferredOutcome && !active.container) {
        await this.reconcileDeferredOutcome(active);
        return this.store.get(launchId);
      }
      if (active.container) {
        const lifecycle = this.requireContainerLifecycle();
        const inspection = await lifecycle.inspect(active.container, active);
        if (inspection === "unknown") {
          return this.store.get(launchId);
        }
        if (inspection === "reused") {
          throw new Error(`node worker launch ${launchId} lost its container ownership`);
        }
        if (inspection === "live") {
          const clientState = inspectNodeWorkerProcessIdentity(active.worker);
          if (clientState !== "dead" && clientState !== "reused") {
            return this.store.get(launchId);
          }
          // Observe the dead attach client's result before fencing its still-running owner.
          await active.done;
          if (this.active.get(launchId) === active) {
            await this.stopChild(active, "interrupted");
          }
        } else {
          await this.cleanupChildContainer(active);
          await active.done;
          await this.reconcileDeferredOutcome(active);
        }
      } else {
        const workerState = inspectNodeWorkerProcessIdentity(active.worker);
        if (workerState === "dead" || workerState === "reused") {
          await stopOwnedNodeWorkerTree(
            active.worker,
            NODE_WORKER_STOP_GRACE_MS,
            FORCE_STOP_WAIT_MS,
          );
          await active.done;
        }
      }
      const observed = this.active.get(launchId);
      return observed?.state === "observed"
        ? this.reconcileActiveTerminal(observed)
        : this.store.get(launchId);
    }
    const receipt = await this.store.get(launchId);
    return receipt?.state === "running" ? await this.recoverRunning(receipt) : receipt;
  }

  async retainWorkspaces(
    input: NodeWorkerWorkspaceRetainInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult> {
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const operation = (async () => {
      await this.initialize();
      return await this.workspace.applyRetainSnapshot(
        input,
        () => this.store.listNonterminal(),
        signal,
      );
    })();
    this.retentions.add(operation);
    try {
      return await operation;
    } finally {
      this.retentions.delete(operation);
    }
  }

  async stopEnvironment(expected: NodeWorkerEnvironmentStopInput): Promise<void> {
    const key = nodeWorkerEnvironmentKey(expected);
    this.stoppingEnvironments.set(key, (this.stoppingEnvironments.get(key) ?? 0) + 1);
    try {
      const errors: unknown[] = [];
      const admission = this.admissions.get(key);
      const matchingAdmission =
        admission && nodeWorkerEnvironmentMatches(admission.binding, expected)
          ? admission
          : undefined;
      matchingAdmission?.abort.abort(new Error("node worker environment stopped"));
      await this.workspace.processes
        .stopEnvironment(expected)
        .catch((error: unknown) => errors.push(error));
      await this.initialize().catch((error: unknown) => errors.push(error));
      let durableStops: Promise<void>[] = [];
      try {
        durableStops = (await this.store.listNonterminal()).map(async (owner) => {
          if (!nodeWorkerEnvironmentMatches(owner, expected)) {
            return;
          }
          if (
            matchingAdmission?.identity.launchId === owner.launchId &&
            matchingAdmission.identity.planHash === owner.planHash
          ) {
            await matchingAdmission.done.catch(() => undefined);
          }
          const active = this.active.get(owner.launchId);
          if (active && nodeWorkerEnvironmentMatches(active.binding, expected)) {
            return;
          }
          await this.cancelOwner(owner, true);
          const remaining = await this.store.get(owner.launchId);
          if (remaining?.state === "pending" || remaining?.state === "running") {
            throw new Error("node worker environment is still owned by another supervisor");
          }
        });
      } catch (error) {
        errors.push(error);
      }
      const durableResults = Promise.allSettled(durableStops);
      // Admission owns its cancellation order and can materialize a child after abort.
      await matchingAdmission?.done.catch(() => undefined);
      for (const owner of this.active.values()) {
        if (!nodeWorkerEnvironmentMatches(owner.binding, expected)) {
          continue;
        }
        try {
          if (owner.state === "running") {
            await this.stopChild(owner, "interrupted");
          }
          const observed = this.active.get(owner.launchId);
          if (observed?.state === "observed") {
            await this.reconcileActiveTerminal(observed);
          } else if (observed) {
            throw new Error("node worker environment cleanup is incomplete");
          }
        } catch (error) {
          errors.push(error);
        }
      }
      errors.push(
        ...(await durableResults).flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      );
      if (errors.length > 0) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "node worker environment cleanup failed");
      }
    } finally {
      const remaining = this.stoppingEnvironments.get(key)! - 1;
      if (remaining === 0) {
        this.stoppingEnvironments.delete(key);
      } else {
        this.stoppingEnvironments.set(key, remaining);
      }
    }
  }

  private async cancelOwner(
    expected: NodeWorkerSupervisorIdentity,
    awaitCleanup = false,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    const receipt = await this.store.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
      return receipt;
    }
    const active = this.active.get(expected.launchId);
    if (active) {
      if (
        active.planHash !== expected.planHash ||
        !nodeWorkerReceiptMatchesOwner(receipt, active.supervisor, active.worker, active.container)
      ) {
        return receipt;
      }
      if (active.state === "running") {
        await this.stopChild(active, "cancelled");
      }
      const observed = this.active.get(expected.launchId);
      if (observed?.state === "observed") {
        return this.reconcileActiveTerminal(observed);
      }
      return this.store.getMatching(expected);
    }
    const startup = this.starting.get(expected.launchId);
    if (startup && receipt.supervisor.pid === process.pid) {
      if (receipt.container || (receipt.state === "pending" && this.containerEngine)) {
        // Startup may already own a container while its create/start client is
        // in flight; retain the durable slot until normal cancellation fences it.
        await startup;
        return await this.cancelOwner(expected, awaitCleanup);
      }
      if (receipt.state === "pending") {
        const cancelled = await this.capacity.finishCancelled({
          expected,
          supervisor: receipt.supervisor,
          worker: null,
        });
        await startup;
        return (await this.store.getMatching(expected)) ?? cancelled;
      }
    }
    return await this.recoverRunning(receipt, true, "cancelled", awaitCleanup);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.capacity.close();
    for (const admission of this.admissions.values()) {
      admission.abort.abort(new Error("node worker supervisor is closed"));
    }
    const operation = this.settleClose().then(() => {
      this.closeCompleted = true;
    });
    const closePromise = operation.finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
      }
    });
    return (this.closePromise = closePromise);
  }

  /** Join accepted work and physical cleanup before sealing the journal. */
  private async settleClose(): Promise<void> {
    const initialization = this.initializationPromise;
    const errors: unknown[] = [];
    await this.workspace.processes.close().catch((error: unknown) => errors.push(error));
    await initialization?.catch((error: unknown) => errors.push(error));
    await Promise.allSettled([...this.admissions.values()].map((admission) => admission.done));
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled(this.retentions);
    const stopped = await Promise.allSettled([
      ...[...this.recoveries.values()].map((recovery) => recovery.done),
      ...[...this.active.values()]
        .filter((active): active is NodeWorkerRunningChild => active.state === "running")
        .map((active) => this.stopChild(active, "interrupted")),
    ]);
    errors.push(
      ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    for (const active of this.active.values()) {
      if (active.state !== "observed") {
        continue;
      }
      try {
        await this.reconcileActiveTerminal(active);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.journal
      .drain({ close: errors.length === 0 })
      .catch((error: unknown) => errors.push(error));
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "node worker terminal reconciliation failed");
    }
  }

  private reconcileActiveTerminal(
    active: NodeWorkerObservedTerminal,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (active.reconciliation) {
      return active.reconciliation;
    }
    const operation = (async () => {
      if (active.cancelledTurn) {
        // Gateway authority may close before worker finishing. The physical failure
        // remains separate, and neither journal can settle before process cleanup.
        const turn = await this.turns.finish({
          expected: active.cancelledTurn,
          ownerLaunchId: active.launchId,
          supervisor: active.supervisor,
          worker: active.worker,
          state: "cancelled",
          errorText: active.outcome.errorText ?? "node worker turn cancelled",
        });
        if (!turn || turn.state === "pending" || turn.state === "running") {
          throw new Error("node worker cancellation lost its physical owner");
        }
      }
      const receipt = await this.capacity.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        ...active.outcome,
      });
      if (receipt.state === "pending" || receipt.state === "running") {
        throw new Error(`node worker launch ${active.launchId} terminal state was not persisted`);
      }
      active.turn?.settle();
      active.turn = undefined;
      if (this.active.get(active.launchId) === active) {
        this.active.delete(active.launchId);
      }
      return receipt;
    })();
    const pending = operation.finally(() => {
      if (active.reconciliation === pending) {
        active.reconciliation = undefined;
      }
    });
    active.reconciliation = pending;
    return pending;
  }

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const observation = await observeNodeWorkerChild(
      active,
      (frame) => this.turnLifecycle.settleTurn(active, frame),
      () => active.turn?.claim.launchId,
      active.container ? () => this.cleanupChildContainer(active) : undefined,
    );
    if (observation.kind === "deferred") {
      active.deferredOutcome = observation.outcome;
      return;
    }
    active.adapter.dispose();
    await this.observeTerminalOutcome(active, observation.outcome);
  }

  private async observeTerminalOutcome(
    active: NodeWorkerRunningChild,
    outcome: NodeWorkerTerminalOutcome,
  ): Promise<void> {
    const observed = createNodeWorkerObservedTerminal(active, outcome);
    if (this.active.get(active.launchId) !== active) {
      return;
    }
    this.active.set(active.launchId, observed);
    clearNodeWorkerRetention(active);
    if (active.idleGeneration !== undefined) {
      this.turnLifecycle.publishIdle();
    }
    try {
      await this.reconcileActiveTerminal(observed);
    } catch {
      // The observed outcome stays owned in memory for the next supervisor operation.
      return;
    }
    active.turn = undefined;
  }

  private async reconcileDeferredOutcome(active: NodeWorkerRunningChild): Promise<void> {
    if (!active.deferredOutcome) {
      return;
    }
    if (!active.container && !active.adapter.confirmExtinction?.()) {
      throw new Error(
        "node worker process cleanup remains unconfirmed; retry status after cleanup finishes",
        { cause: active.deferredOutcome.errorText },
      );
    }
    active.adapter.dispose();
    await this.observeTerminalOutcome(active, active.deferredOutcome);
  }

  private requireContainerLifecycle(): NodeWorkerContainerLifecycle {
    const lifecycle = this.containerLifecycle;
    if (!lifecycle) {
      throw new Error("node worker container isolation has no available engine");
    }
    return lifecycle;
  }

  private async cleanupChildContainer(active: NodeWorkerRunningChild): Promise<void> {
    if (!active.container) {
      return;
    }
    const cleanup = (active.containerCleanup ??= this.requireContainerLifecycle()
      .remove(active.container, active)
      .finally(() => {
        if (active.containerCleanup === cleanup) {
          active.containerCleanup = undefined;
        }
      }));
    await cleanup;
  }

  private async stopChild(
    active: NodeWorkerRunningChild,
    state?: NodeWorkerStopState,
  ): Promise<void> {
    const stopping = (async () => {
      active.retiring = true;
      if (active.retention?.reason === "idle") {
        clearTimeout(active.retention.timer);
      }
      active.stopState ??= state;
      if (active.container) {
        // The attach client owns no workload; fence the container and prove its
        // removal before its launch can become terminal or release capacity.
        await this.cleanupChildContainer(active);
      }
      active.adapter.kill("SIGTERM");
      const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), NODE_WORKER_STOP_GRACE_MS);
      forceKill.unref?.();
      try {
        await active.done;
      } finally {
        clearTimeout(forceKill);
      }
    })();
    if (active.idleGeneration !== undefined) {
      this.turnLifecycle.publishIdle();
    }
    await stopping.catch((error: unknown) => {
      if (active.retention?.reason === "idle" && !this.closed) {
        clearTimeout(active.retention.timer);
        active.retention.timer = setTimeout(() => {
          void this.stopChild(active, state).catch(() => undefined);
        }, 120_000).unref();
      }
      throw error;
    });
    await this.reconcileDeferredOutcome(active);
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
