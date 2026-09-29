import { addAbortListener } from "node:events";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withTimeout } from "../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import {
  nodeWorkerPlanHash,
  nodeWorkerTurnMatchesIdentity,
  validateNodeWorkerLaunchInput,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import {
  buildWorkerProcessTurn,
  type WorkerProcessMessage,
} from "../worker/worker-process-protocol.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import type { NodeWorkerLaunchClaim, NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  nodeWorkerDescriptorSecrets,
} from "./node-worker-output.js";
import {
  clearNodeWorkerRetention,
  createNodeWorkerActiveTurn,
  nodeWorkerEnvironmentBinding,
  nodeWorkerEnvironmentKey,
  type NodeWorkerActiveOwnership,
  type NodeWorkerRunningChild,
  type NodeWorkerTurnLifecycleContext,
} from "./node-worker-supervisor-ownership.js";
import type { NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";

/** Turn operations share the supervisor's live state and physical cleanup owner. */
export function createNodeWorkerTurnLifecycle(context: NodeWorkerTurnLifecycleContext) {
  function idleChildren(): NodeWorkerRunningChild[] {
    return [...context.active.values()]
      .filter(
        (owner): owner is NodeWorkerRunningChild =>
          owner.state === "running" &&
          !owner.turn &&
          !owner.retiring &&
          !owner.stopState &&
          owner.retention?.reason === "idle",
      )
      .toSorted(
        (a, b) =>
          (a.retention?.reason === "idle" ? a.retention.since : 0) -
          (b.retention?.reason === "idle" ? b.retention.since : 0),
      );
  }

  function publishIdle(): void {
    context.capacity.setReclaimableIdle(idleChildren().length);
  }

  async function reclaimIdle(): Promise<boolean> {
    const oldest = idleChildren()[0];
    if (!oldest) {
      return false;
    }
    await context.stopChild(oldest, "interrupted");
    return !context.active.has(oldest.launchId);
  }

  async function retireIdle(): Promise<void> {
    context.advanceIdleGeneration();
    await Promise.allSettled([...context.admissions.values()].map((admission) => admission.done));
    const results = await Promise.allSettled(
      [...context.active.values()].flatMap((owner) =>
        owner.state === "running" && owner.retention?.reason === "idle"
          ? [context.stopChild(owner, "interrupted")]
          : [],
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "node worker idle cleanup failed");
    }
  }

  async function launch(
    rawInput: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    const input = validateNodeWorkerLaunchInput(structuredClone(rawInput));
    const descriptor = completeWorkerLaunchDescriptor(input.descriptor, connectionEndpoint);
    const claimInput: NodeWorkerLaunchClaim = {
      launchId: input.launchId,
      planHash: nodeWorkerPlanHash(input),
      gatewayNamespace: input.gatewayNamespace,
      environmentId: descriptor.admission.environmentId,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: descriptor.assignment.runId,
    };
    if (context.isClosed()) {
      throw new Error("node worker supervisor is closed");
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    const key = nodeWorkerEnvironmentKey(binding);
    if (context.stoppingEnvironments.has(key)) {
      throw new Error("node worker environment is stopping");
    }
    const admission = context.admissions.get(key);
    if (admission) {
      const { launchId, planHash } = admission.identity;
      if (launchId !== input.launchId || planHash !== claimInput.planHash) {
        throw new Error("node worker environment already has a turn being admitted");
      }
      return await admission.done;
    }
    const abort = new AbortController();
    const idleGeneration =
      input.idleRetention &&
      descriptor.admission.handshake.protocolFeatures.includes(
        NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
      )
        ? context.getIdleGeneration()
        : undefined;
    const admissionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const done = (async () => {
      const workspace = await context.workspace.acquirePreparedWorkspace({
        ...binding,
        sessionKey: input.sessionKey,
      });
      try {
        admissionSignal.throwIfAborted();
        if (context.isClosed() || context.stoppingEnvironments.has(key)) {
          throw new Error("node worker environment is stopping");
        }
        return await launchAdmitted(
          input,
          descriptor,
          claimInput,
          admissionSignal,
          workspace?.homeDir,
          idleGeneration,
        );
      } finally {
        workspace?.release();
      }
    })();
    const pending = {
      binding,
      identity: claimInput,
      abort,
      signal: admissionSignal,
      done,
    };
    context.admissions.set(key, pending);
    try {
      return await done;
    } finally {
      if (context.admissions.get(key) === pending) {
        context.admissions.delete(key);
      }
    }
  }

  async function launchAdmitted(
    input: NodeWorkerLaunchInput,
    descriptor: WorkerLaunchDescriptor,
    claimInput: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    homeDir?: string,
    idleGeneration?: number,
  ): Promise<NodeWorkerLaunchReceipt> {
    await context.initialize();
    const supervisor = context.getSupervisorIdentity();
    if (context.isClosed()) {
      throw new Error("node worker supervisor is closed");
    }
    signal.throwIfAborted();
    const previous = await context.turns.get(input.launchId);
    signal.throwIfAborted();
    if (previous) {
      await context.turns.claim({
        claim: claimInput,
        ownerLaunchId: previous.ownerLaunchId,
        supervisor: previous.supervisor,
        worker: previous.worker,
      });
      return (await status(input.launchId)) ?? previous;
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    for (const owner of context.active.values()) {
      if (nodeWorkerEnvironmentKey(owner.binding) !== nodeWorkerEnvironmentKey(binding)) {
        continue;
      }
      if (owner.state === "observed") {
        await context.reconcileActiveTerminal(owner);
        continue;
      }
      await context.statusOwner(owner.launchId);
      signal.throwIfAborted();
      if (owner.retiring) {
        // Shutdown must abort admission before stopping its retiring physical owner.
        const aborted = createDeferredCore();
        const listener = addAbortListener(signal, () => aborted.resolve());
        try {
          await Promise.race([owner.done, aborted.promise]);
        } finally {
          listener[Symbol.dispose]();
        }
      }
      signal.throwIfAborted();
      if (context.active.get(owner.launchId) !== owner) {
        continue;
      }
      if (owner.turn) {
        throw new Error("node worker environment already has an active turn");
      }
      if (owner.stopState || owner.retiring) {
        throw new Error("node worker environment cleanup is incomplete");
      }
      if (JSON.stringify(owner.binding) !== JSON.stringify(binding)) {
        if (
          binding.ownerEpoch < owner.binding.ownerEpoch ||
          (binding.ownerEpoch === owner.binding.ownerEpoch &&
            binding.placementGeneration < owner.binding.placementGeneration)
        ) {
          throw new Error("node worker launch belongs to a replaced environment");
        }
        await context.stopChild(owner, "interrupted");
        if (context.active.get(owner.launchId) === owner) {
          throw new Error("node worker environment cleanup is incomplete");
        }
        signal.throwIfAborted();
        continue;
      }
      return await startTurn(owner, descriptor, claimInput, signal, idleGeneration);
    }
    const claim = await context.capacity.claim(claimInput, supervisor, signal, reclaimIdle);
    if (claim.action === "recover") {
      await context.recoverRunning(claim.receipt);
    }
    if (claim.action !== "start") {
      // A pruned turn can share the first launch's ID. Its physical anchor is
      // cleanup authority, never a substitute receipt for that expired turn.
      throw new Error("node worker turn receipt expired; request a fresh turn");
    }
    try {
      await context.turns.claim(
        { claim: claimInput, ownerLaunchId: input.launchId, supervisor },
        { assertCurrent: () => signal.throwIfAborted() },
      );
    } catch (error) {
      await context.capacity.finish({
        ...claimInput,
        supervisor,
        worker: null,
        state: signal.aborted ? (context.isClosed() ? "interrupted" : "cancelled") : "failed",
        errorText: signal.aborted
          ? "node worker admission closed before its turn was journaled"
          : "node worker turn could not be journaled",
      });
      throw error;
    }
    let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
    const cancelClaimed = () => {
      cancellation ??= Promise.resolve().then(() => cancelTurn(claimInput));
      void cancellation.catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelClaimed, { once: true });
    const startup = context.startChild({
      workerEnv: homeDir ? snapshotNodeWorkerEnv(context.workerEnv, homeDir) : context.workerEnv,
      input,
      descriptor,
      planHash: claimInput.planHash,
      supervisor,
      signal,
      claim: claimInput,
      idleGeneration,
    });
    context.starting.set(input.launchId, startup);
    if (signal?.aborted) {
      cancelClaimed();
    }
    try {
      const receipt = await startup;
      return cancellation ? ((await cancellation) ?? receipt) : receipt;
    } finally {
      signal?.removeEventListener("abort", cancelClaimed);
      if (context.starting.get(input.launchId) === startup) {
        context.starting.delete(input.launchId);
      }
    }
  }

  async function startTurn(
    active: NodeWorkerRunningChild,
    descriptor: WorkerLaunchDescriptor,
    claim: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    idleGeneration?: number,
  ): Promise<NodeWorkerLaunchReceipt> {
    const isCurrent = () => context.active.get(active.launchId) === active && !context.isClosed();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!isCurrent() || active.stopState || active.retiring || active.turn) {
        throw new Error("node worker turn lost its physical owner before admission");
      }
    };
    assertCurrent();
    const admitted = await context.turns.claim(
      {
        claim,
        ownerLaunchId: active.launchId,
        supervisor: active.supervisor,
        worker: active.worker,
      },
      { assertCurrent },
    );
    if (admitted.action === "replay") {
      return admitted.receipt;
    }
    clearNodeWorkerRetention(active);
    active.turn = createNodeWorkerActiveTurn(claim);
    const negotiated = active.idleGeneration !== undefined || idleGeneration !== undefined;
    active.idleGeneration = idleGeneration;
    if (negotiated) {
      publishIdle();
    }
    if (signal.aborted || !isCurrent() || active.stopState || active.retiring) {
      await context.stopChild(active, signal.aborted ? "cancelled" : "interrupted");
      return (await context.turns.get(claim.launchId)) ?? admitted.receipt;
    }
    const secrets = nodeWorkerDescriptorSecrets(descriptor);
    for (const value of secrets) {
      registerSecretValueForRedaction(value);
    }
    // The IPC diagnostic handler shares this object, so rotate its contents rather than its owner.
    Object.assign(active.scrubber, createNodeWorkerCredentialScrubber(secrets));
    active.connectionFailure.errorText = undefined;
    const onAbort = () => {
      void cancelTurn(claim).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await sendNodeWorkerInput(
        active.adapter,
        buildWorkerProcessTurn(descriptor, active.idleGeneration !== undefined),
      );
      if (signal.aborted) {
        await cancelTurn(claim);
      }
    } catch {
      await context.stopChild(active, "interrupted");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return (await context.turns.get(claim.launchId)) ?? admitted.receipt;
  }

  async function status(
    launchId: string,
    options?: { waitMs: number; signal?: AbortSignal },
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    options?.signal?.throwIfAborted();
    let current = await readStatus(launchId);
    if (!options || !current || (current.state !== "pending" && current.state !== "running")) {
      return current;
    }
    const elapsed = createDeferredCore<boolean>();
    const timer = setTimeout(() => elapsed.resolve(false), options.waitMs);
    timer.unref();
    try {
      while (current && (current.state === "pending" || current.state === "running")) {
        const turn: NodeWorkerActiveOwnership["turn"] = context.active.get(
          current.ownerLaunchId,
        )?.turn;
        const admission = context.admissions.get(nodeWorkerEnvironmentKey(current));
        // A journaled turn can precede its live owner. Follow admission into settlement.
        const done: Promise<unknown> | undefined =
          turn?.claim.launchId === launchId
            ? turn.done
            : admission?.identity.launchId === launchId &&
                admission.identity.planHash === current.planHash
              ? admission.done.catch(() => undefined)
              : undefined;
        // Completion can publish between the journal read and capturing the live owner.
        current = await readStatus(launchId);
        if (!current || (current.state !== "pending" && current.state !== "running")) {
          break;
        }
        const notified: boolean = await racePromiseWithAbortSignal(
          done ? Promise.race([done.then(() => true), elapsed.promise]) : elapsed.promise,
          options.signal,
        );
        options.signal?.throwIfAborted();
        // Settlement follows persistence; a timed-out observation also reconciles recovery.
        current = await (notified ? context.turns.get(launchId) : readStatus(launchId));
        if (!notified) {
          break;
        }
      }
      return current;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readStatus(launchId: string): Promise<NodeWorkerTurnReceipt | undefined> {
    if (context.isCloseCompleted()) {
      return context.turns.get(launchId);
    }
    await context.initialize();
    const turn = await context.turns.get(launchId);
    if (turn) {
      const owner = context.active.get(turn.ownerLaunchId);
      if (
        !context.isCloseCompleted() &&
        (!owner ||
          owner.state === "observed" ||
          (owner.state === "running" && owner.deferredOutcome) ||
          turn.state === "pending" ||
          turn.state === "running")
      ) {
        await context.statusOwner(turn.ownerLaunchId);
      }
      return context.turns.get(launchId);
    }
    return undefined;
  }

  async function cancel(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    const admission = [...context.admissions.values()].find((pending) =>
      nodeWorkerTurnMatchesIdentity(pending.identity, expected),
    );
    const cancellation = cancelTurn(expected);
    if (!admission) {
      return cancellation;
    }
    const [cancelled, admitted] = await Promise.allSettled([cancellation, admission.done]);
    if (cancelled.status === "rejected") {
      throw cancelled.reason;
    }
    if (
      admitted.status === "rejected" &&
      (!admission.signal.aborted || admitted.reason !== admission.signal.reason)
    ) {
      throw admitted.reason;
    }
    return context.turns.getMatching(expected);
  }

  async function cancelTurn(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    if (context.isCloseCompleted()) {
      return context.turns.getMatching(expected);
    }
    const afterSettlement = async (settling: Promise<void>) => {
      try {
        await settling;
      } catch {
        return await cancelTurn(expected);
      }
      return context.turns.getMatching(expected);
    };
    let settling: Promise<void> | undefined;
    let matched:
      | {
          owner: NodeWorkerRunningChild;
          turn: NonNullable<NodeWorkerRunningChild["turn"]>;
        }
      | undefined;
    for (const admission of context.admissions.values()) {
      if (nodeWorkerTurnMatchesIdentity(admission.identity, expected)) {
        admission.abort.abort(new Error("node worker turn cancelled"));
      }
    }
    for (const owner of context.active.values()) {
      if (
        owner.state === "running" &&
        owner.turn &&
        nodeWorkerTurnMatchesIdentity(owner.turn.claim, expected)
      ) {
        matched = { owner, turn: owner.turn };
        if (owner.turn.settling) {
          settling = owner.turn.settling;
        } else {
          // The start gate must close before journal admission can yield.
          owner.turn.cancelled = true;
        }
      }
    }
    if (settling) {
      return await afterSettlement(settling);
    }
    await context.initialize();
    const receipt = await context.turns.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
      return receipt ? await status(receipt.launchId) : undefined;
    }
    if (matched?.turn.settling) {
      return await afterSettlement(matched.turn.settling);
    }
    if (
      matched &&
      (context.active.get(matched.owner.launchId) !== matched.owner ||
        matched.owner.turn !== matched.turn)
    ) {
      return status(expected.launchId);
    }
    const active = context.active.get(receipt.ownerLaunchId);
    if (active?.state !== "running" || active.turn?.claim.launchId !== expected.launchId) {
      const owner = await context.store.get(receipt.ownerLaunchId);
      if (owner) {
        await context.cancelOwner(owner);
      }
      return context.turns.getMatching(expected);
    }
    const turn = active.turn;
    if (turn.settling) {
      return await afterSettlement(turn.settling);
    }
    turn.cancelled = true;
    try {
      // A worker that stopped reading can block the write as well as the reply.
      await withTimeout(
        sendNodeWorkerInput(active.adapter, { type: "cancel", turnId: expected.launchId }).then(
          () => turn.done,
        ),
        context.stopTimeoutMs,
        { message: "node worker turn cancellation did not settle" },
      );
    } catch {
      if (context.active.get(active.launchId) === active && active.turn === turn) {
        await context.stopChild(active, "cancelled");
      }
    }
    if (context.active.get(active.launchId)?.state === "observed") {
      return status(expected.launchId);
    }
    return context.turns.getMatching(expected);
  }

  async function settleTurn(
    active: NodeWorkerRunningChild,
    frame: WorkerProcessMessage,
  ): Promise<void> {
    if (frame.type === "result") {
      if (active.stopState) {
        return;
      }
      const turn = active.turn;
      if (!turn || turn.claim.launchId !== frame.turnId || active.retiring) {
        throw new Error("node worker returned a result outside its active turn");
      }
      // Publish this operation before finish can invoke a reentrant cancellation.
      const settling = Promise.resolve()
        .then(async () => {
          const receipt = await context.turns.finish({
            expected: turn.claim,
            ownerLaunchId: active.launchId,
            supervisor: active.supervisor,
            worker: active.worker,
            ...(turn.cancelled
              ? ({
                  state: "cancelled",
                  errorText: active.connectionFailure.errorText ?? "node worker turn cancelled",
                } as const)
              : ({ state: "completed", resultJson: JSON.stringify(frame.result) } as const)),
          });
          if (!receipt || receipt.state === "pending" || receipt.state === "running") {
            throw new Error("node worker turn completion lost its physical owner");
          }
          active.turn = undefined;
          active.retiring = !frame.retainWorker;
          turn.settle();
        })
        .finally(() => {
          if (turn.settling === settling) {
            turn.settling = undefined;
          }
        });
      turn.settling = settling;
      await settling;
    } else if (active.turn || active.retention?.turnId !== frame.turnId) {
      return;
    }
    if (
      active.stopState ||
      active.retiring ||
      active.turn ||
      context.active.get(active.launchId) !== active
    ) {
      return;
    }
    const reason = frame.type === "idle-ready" ? "idle" : frame.retention;
    if (!reason) {
      return;
    }
    if (active.idleGeneration === undefined) {
      throw new Error("node worker reported unnegotiated retention");
    }
    clearNodeWorkerRetention(active);
    if (reason === "background") {
      active.retention = { reason, turnId: frame.turnId };
    } else {
      const timer = setTimeout(() => {
        if (active.retention?.reason === "idle" && active.retention.timer === timer) {
          void context.stopChild(active, "interrupted").catch(() => undefined);
        }
      }, 120_000);
      timer.unref();
      active.retention = { reason, turnId: frame.turnId, since: Date.now(), timer };
      if (context.isClosed() || active.idleGeneration !== context.getIdleGeneration()) {
        void context.stopChild(active, "interrupted").catch(() => undefined);
      } else if (idleChildren().length > 2) {
        void reclaimIdle().catch(() => undefined);
      }
    }
    publishIdle();
  }

  return { launch, status, cancel, settleTurn, retireIdle, idleChildren, publishIdle };
}
