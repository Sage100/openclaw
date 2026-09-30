import Foundation

extension GatewayProcessManager {
    func clearCompletedServiceResumeCommand(pid: Int32?, generation: UInt64) async {
        guard self.isCurrentGatewayStart(generation),
              self.retainedServiceCLI != nil, self.installation == .managed,
              let pid,
              pid != self.childSupervisor.processIdentifier,
              let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot()
        else { return }
        let state = AppProfile.current.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: .current)
        guard let cli = GatewayLaunchAgentManager.installedServiceCLI(
            snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper),
            GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                appManaged: true, installedRuntimePath: cli.prefix.first, stateDirectory: state) == nil
        else { return }
        guard await GatewayLaunchAgentManager.runningGatewayPID() == pid,
              self.isCurrentGatewayStart(generation),
              GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot
        else { return }
        self.retainedServiceCLI = nil
    }

    func attemptManagedNodeMigration(generation: UInt64) async {
        guard BundledRuntime.isBundledApp, !self.nodeMigrationAttempted,
              self.isCurrentGatewayStart(generation)
        else { return }
        self.nodeMigrationAttempted = true
        do {
            guard let candidate = try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: AppStateStore.shared.onboardingSeen,
                installPolicy: CLIInstallPolicy.storedPolicy(),
                gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel())
            else { return }
            guard self.isCurrentGatewayStart(generation) else { return }
            self.retainedServiceCLI = candidate.cli
            let result = await self.enableLaunchAgentIfNeeded(
                port: candidate.port, generation: generation, nodeMigration: candidate)
            if self.isCurrentGatewayStart(generation), let error = result.error {
                self.nodeMigrationFailure = error
            }
        } catch {
            if self.isCurrentGatewayStart(generation) {
                self.nodeMigrationFailure = error.localizedDescription
            }
        }
    }

    func performManagedNodeMigration(
        _ candidate: ManagedNodeGatewayMigration.Candidate,
        generation: UInt64) async -> LaunchAgentEnableResult
    {
        do {
            guard let targetVersion = GatewayEnvironment.appVersionString() else {
                throw GatewayHostingError(message: "The bundled Gateway version could not be read.")
            }
            let operations = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: {
                    guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
                },
                verifyHealth: {
                    await (self.connection).shutdown()
                    let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(
                        port: candidate.port, allowUnconfigured: candidate.allowUnconfigured)
                    let context = self.gatewayReadinessContext(
                        purpose: .launchd,
                        port: candidate.port,
                        generation: generation,
                        readinessPID: pid,
                        launchAgentInstalled: true,
                        migrationDrain: true)
                    let terminal = await self.observeGatewayReadiness(
                        context: context,
                        deadlinePolicy: .fixed(timeout: GatewayLaunchAgentManager.startupMigrationTolerance),
                        clock: self.readinessClock)
                    guard case let .ready(instance, _, _) = terminal,
                          let pid, instance?.pid == pid
                    else { throw GatewayHostingError(message: "The migrated Gateway did not become healthy.") }
                },
                setServiceHosting: { self.storeHosting(.service) },
                statusHandler: { self.appendLog("[gateway] \($0)\n") })
            switch try await ManagedNodeGatewayMigration.run(
                candidate: candidate,
                targetVersion: targetVersion,
                pendingSetupRecovery: PostAppUpdateReceiptStore.pendingSetupRecovery(),
                operations: operations)
            {
            case .coreRepairRequired:
                break
            case .versionUpdated:
                self.nodeMigrationVersionUpdated = true
            case .migrated:
                self.nodeMigrationVersionUpdated = false
                self.nodeMigrationCompleted = true
                self.retainedServiceCLI = nil
                do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
                    self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
                }
            }
            return .installedService
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    func retryManagedNodeMigration() async throws {
        await self.waitForStartupAttempt()
        guard !self.isTerminating, self.desiredActive else { throw CancellationError() }
        self.nodeMigrationAttempted = false
        self.nodeMigrationFailure = nil
        self.nodeMigrationVersionUpdated = false
        self.nodeMigrationCompleted = false
        self.status = .stopped
        self.startIfNeeded()
        await self.waitForStartupAttempt()
        if let failure = self.nodeMigrationFailure { throw GatewayHostingError(message: failure) }
    }

    func storeHosting(_ hosting: GatewayHosting) {
        if hosting == .app { self.retainedServiceCLI = nil }
        AppDefaults.standard.set(hosting.rawValue, forKey: GatewayHosting.defaultsKey)
        self.hostingRevision &+= 1
    }

    func appHostedEnvironment(runtime: BundledRuntime) throws -> [String: String] {
        let profile = AppProfile.current
        let retained = try GatewayLaunchAgentManager.retainedServiceEnvironment(
            stateDirectory: profile.stateDirectoryURL(), profile: profile)
        return Self.appHostedEnvironment(
            runtime: runtime,
            profile: profile,
            processEnvironment: ProcessInfo.processInfo.environment,
            inlineEnvironment: self.appHostedInlineEnvironment,
            retainedEnvironment: retained,
            searchPaths: CommandResolver.preferredPaths())
    }

    static func appHostedEnvironment(
        runtime: BundledRuntime,
        profile: AppProfile,
        processEnvironment: [String: String],
        inlineEnvironment: [String: String],
        retainedEnvironment: [String: String],
        searchPaths: [String]) -> [String: String]
    {
        var environment = processEnvironment.merging(inlineEnvironment) { _, service in service }
        environment.merge(retainedEnvironment) { _, retained in retained }
        let servicePaths = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        environment.merge(runtime.environment) { _, runtimeValue in runtimeValue }
        var seen = Set<String>()
        environment["PATH"] = ([runtime.bun.deletingLastPathComponent().path] + servicePaths + searchPaths)
            .filter { seen.insert($0).inserted }.joined(separator: ":")
        environment["OPENCLAW_PROFILE"] = profile.name ?? "default"
        environment["OPENCLAW_STATE_DIR"] = profile.stateDirectoryURL().path
        environment["OPENCLAW_CONFIG_PATH"] = profile.stateDirectoryURL().appendingPathComponent("openclaw.json").path
        return environment
    }

    func startAppHostedGateway(startGeneration: UInt64) async {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.installation == .managed else {
            let reason = self.installation == .unreadable
                ? Installation.ownershipFailure
                : "This Gateway is externally managed. Start it with its installation owner."
            self.status = .failed(reason)
            self.lastFailureReason = reason
            return
        }
        do {
            let runtime = try await BundledRuntime.seed()
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            let port = GatewayEnvironment.gatewayPort()
            if await PortGuardian.shared.describe(port: port) != nil {
                _ = await self.attachExistingGatewayIfAvailable(port: port, startGeneration: startGeneration)
                return
            }
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            let environment = try self.appHostedEnvironment(runtime: runtime)
            let pid = try await self.childSupervisor.start(configuration: .init(
                bun: runtime.bun,
                packageRoot: runtime.packageRoot,
                environment: environment,
                logPath: GatewayLaunchAgentManager.launchdGatewayLogPath(),
                port: port,
                allowUnconfigured: self.hostsLocalGatewayWithRemotePrimary))
            { [weak self] event in
                self?.handleChildEvent(event, port: port)
            }
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            await self.observeChildReadiness(pid: pid, port: port, generation: startGeneration)
        } catch {
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            self.status = .failed(error.localizedDescription)
            self.lastFailureReason = error.localizedDescription
            self.appendLog("[gateway] \(error.localizedDescription)\n")
            self.logger.error("gateway child launch failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func handleChildEvent(_ event: GatewayChildSupervisor.Event, port: Int) {
        // A readiness retry can attach the same child. Its supervisor remains the event owner
        // until stop drains it, independently of which readiness attempt created the child.
        let generation = self.gatewayStartGeneration
        guard self.isCurrentGatewayStart(generation), self.launchAgentDisableTask == nil else { return }
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.gatewayStartTask?.cancel()
        switch event {
        case let .started(pid):
            self.status = .starting
            self.beginGatewayStartTask(generation: generation) { [weak self] in
                await self?.observeChildReadiness(pid: pid, port: port, generation: generation)
            }
        case let .restarting(delay):
            self.status = .starting
            self.appendLog("[gateway] child exited; restarting in \(delay)\n")
        case let .failed(reason):
            self.status = .failed(reason)
            self.lastFailureReason = reason
            self.appendLog("[gateway] \(reason)\n")
        }
    }

    private func observeChildReadiness(pid: Int32, port: Int, generation: UInt64) async {
        let context = self.gatewayReadinessContext(
            purpose: .child, port: port, generation: generation, readinessPID: pid)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .migration(window: 6, tolerance: GatewayLaunchAgentManager.startupMigrationTolerance),
            clock: self.readinessClock)
        if await self.publishGatewayReadinessTerminal(terminal, context: context) {
            do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
                self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
            }
        }
    }

    func shutdownAppHostedGateway() async {
        self.isTerminating = true
        _ = try? await self.hostingChangeTask?.value
        // Already-admitted service writes and a pending pause settle before app exit.
        // Quitting otherwise leaves the always-on service alone.
        _ = await self.launchAgentEnableTask?.value
        await self.waitForPendingLaunchAgentDisable()
        guard self.childSupervisor.isActive || self.gatewayStartTask != nil || self.bundledUpdateTask != nil else {
            return
        }
        guard self.gatewayHosting == .app || self.childSupervisor.isActive else { return }
        let updateTask = self.bundledUpdateTask
        updateTask?.cancel()
        self.desiredActive = false
        self.gatewayStartGeneration &+= 1
        self.gatewayStartTask?.cancel()
        await self.childSupervisor.stop()
        await self.gatewayStartTask?.value
        _ = try? await updateTask?.value
        self.status = .stopped
    }

    func prepareBundledRuntimeAfterUpdate() async throws {
        guard !self.isTerminating else { throw CancellationError() }
        if let task = self.bundledUpdateTask { return try await task.value }
        _ = try? await self.hostingChangeTask?.value
        guard !self.isTerminating else { throw CancellationError() }
        if let task = self.bundledUpdateTask { return try await task.value }
        let task = Task { @MainActor in try await self.performBundledRuntimeUpdate() }
        self.bundledUpdateTask = task
        defer {
            self.bundledUpdateTask = nil
            self.startIfNeeded()
        }
        try await task.value
    }

    private func performBundledRuntimeUpdate() async throws {
        await self.waitForStartupAttempt()
        guard !self.isTerminating, !Task.isCancelled else { throw CancellationError() }
        let updateGeneration = self.gatewayStartGeneration
        try self.loadRetainedServiceForResume()
        guard self.usesSeededGateway else { return }
        let pausedUpdate = AppStateStore.shared.isPaused ? try self.preparePausedServiceUpdate() : nil
        let runtime = try await BundledRuntime.seed()
        guard !self.isTerminating, !Task.isCancelled,
              self.gatewayStartGeneration == updateGeneration else { throw CancellationError() }
        if AppStateStore.shared.isPaused {
            try await self.completePausedServiceUpdate(pausedUpdate, runtime: runtime) {
                guard !self.isTerminating, !Task.isCancelled,
                      self.gatewayStartGeneration == updateGeneration, AppStateStore.shared.isPaused
                else { throw CancellationError() }
            }
            return
        }
        if self.gatewayHosting == .app {
            // Recovery may request activation while the old child drains. Keep that intent,
            // but let this transition own the restart just as a hosting-mode change does.
            self.hostingChangeInProgress = true
            defer { self.hostingChangeInProgress = false }
            self.stop(preservingActivationIntent: true)
            let stopGeneration = self.gatewayStartGeneration
            await self.waitForPendingLaunchAgentDisable()
            guard !self.isTerminating, !Task.isCancelled,
                  self.gatewayStartGeneration == stopGeneration else { throw CancellationError() }
            if AppStateStore.shared.isPaused { return }
            self.hostingChangeInProgress = false
            self.startIfNeeded()
        } else {
            self.desiredActive = true
            self.gatewayStartGeneration &+= 1
            let generation = self.gatewayStartGeneration
            self.status = .starting
            let result = await self.enableLaunchAgentIfNeeded(
                port: GatewayEnvironment.gatewayPort(), generation: generation, runtimeForUpdate: runtime)
            guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
            if let error = result.error {
                self.status = .failed(error)
                self.lastFailureReason = error
                throw GatewayHostingError(message: error)
            }
        }
        guard await self.waitForGatewayReady(timeout: GatewayLaunchAgentManager.startupMigrationTolerance) else {
            throw GatewayHostingError(message: self.lastFailureReason ?? "The updated Gateway did not become ready.")
        }
        do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
            self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
        }
    }
}
