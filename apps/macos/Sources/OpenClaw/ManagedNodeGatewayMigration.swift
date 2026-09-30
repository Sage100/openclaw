import Foundation

/// The core updater owns version changes; this owner switches only a same-version service runtime.
@MainActor
enum ManagedNodeGatewayMigration {
    struct Candidate: Sendable {
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let snapshot: LaunchAgentPlistSnapshot
        let version: String
        let port: Int
        let allowUnconfigured: Bool
    }

    enum Outcome {
        case coreRepairRequired
        case versionUpdated
        case migrated(BundledRuntime)
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }

    struct Operations {
        var checkCurrent: () throws -> Void
        var updateVersion: (Candidate, String) async throws -> Void
        var recapture: () async throws -> Candidate
        var seed: () async throws -> BundledRuntime
        var setServiceHosting: () -> Void
        var install: (Candidate, BundledRuntime) async throws -> Void
        var restore: (Candidate) async throws -> Void
        var verifyHealth: () async throws -> Void
    }

    /// launchd can reserve a draining job's label for ExitTimeOut + ten seconds before bootstrap.
    private static let serviceInstallTimeout = GatewayChildSupervisor.shutdownTimeoutSeconds + 10 +
        GatewayLaunchAgentManager.startupMigrationTolerance

    static func shutdownTimeout(candidate: Candidate, targetVersion: String?) -> TimeInterval {
        if candidate.version != targetVersion { return CLIInstaller.managedUpdateTimeout + 45 }
        return 2 * self.serviceInstallTimeout + 2 * GatewayLaunchAgentManager.startupMigrationTolerance + 45
    }

    static func run(
        candidate: Candidate,
        targetVersion: String,
        pendingSetupRecovery: PostAppUpdateReceipt? = nil,
        operations: Operations) async throws -> Outcome
    {
        try operations.checkCurrent()
        // An updated version is not proof that core finished its schema and repair work.
        // PostUpdate must resume that work with the retained Node CLI before switching runtimes.
        if let pendingSetupRecovery, pendingSetupRecovery.setupRecovery,
           pendingSetupRecovery.gatewayUpdateIncomplete
        {
            return .coreRepairRequired
        }
        if candidate.version != targetVersion {
            let current = try await operations.recapture()
            try operations.checkCurrent()
            guard current.version == candidate.version, current.snapshot == candidate.snapshot else {
                throw Failure(message: "The managed Node Gateway changed before its version update; retry.")
            }
            try await Task { @MainActor in
                try await operations.updateVersion(current, targetVersion)
            }.value
            try operations.checkCurrent()
            let updated = try await operations.recapture()
            guard updated.version == targetVersion else {
                throw Failure(
                    message: "The managed Node Gateway did not reach the app's version; its runtime was not changed.")
            }
            // A fresh capture on Retry or next launch separates core's version migration from runtime rollback.
            return .versionUpdated
        }

        let current = try await operations.recapture()
        guard current.version == targetVersion, current.snapshot == candidate.snapshot else {
            throw Failure(message: "The managed Node Gateway changed during migration; retry.")
        }
        let runtime = try await operations.seed()
        try operations.checkCurrent()
        let beforeInstall = try await operations.recapture()
        guard beforeInstall.version == targetVersion, beforeInstall.snapshot == current.snapshot else {
            throw Failure(message: "The managed Node Gateway changed during runtime preparation; retry.")
        }
        try operations.checkCurrent()
        operations.setServiceHosting()
        do {
            try await Task { @MainActor in
                try await operations.install(current, runtime)
            }.value
            try operations.checkCurrent()
            try await operations.verifyHealth()
            try operations.checkCurrent()
            return .migrated(runtime)
        } catch {
            let migrationError = error.localizedDescription
            // Pause/quit may cancel the original operation. Its drain still owns recovery until
            // the previous same-version Node service is restored and verified.
            let restoration = Task { @MainActor in
                try await operations.restore(current)
                try await operations.verifyHealth()
            }
            do {
                try await restoration.value
            } catch {
                throw Failure(
                    message: "Bun migration failed: \(migrationError) " +
                        "Node restoration also failed: \(error.localizedDescription)")
            }
            throw Failure(
                message: "Bun migration failed: \(migrationError) " +
                    "The same-version Node Gateway was restored. Retry to switch to Bun.")
        }
    }

    static func candidate(
        profile: AppProfile = .current,
        onboardingSeen: Bool,
        installPolicy: String?,
        gatewayUpdateChannel: String? = nil) async throws -> Candidate?
    {
        guard !profile.isActive, self.policyAllowsMigration(
            onboardingSeen: onboardingSeen, installPolicy: installPolicy, gatewayUpdateChannel: gatewayUpdateChannel)
        else { return nil }
        return try await self.capture(profile: profile)
    }

    private static func policyAllowsMigration(
        onboardingSeen: Bool,
        installPolicy: String?,
        gatewayUpdateChannel: String?) -> Bool
    {
        onboardingSeen && installPolicy == "exact" &&
            !["extended-stable", "beta", "dev"].contains(gatewayUpdateChannel ?? "") &&
            !GatewayLaunchAgentManager.isLaunchAgentWriteDisabled()
    }

    private static func recaptureEligibleCandidate() async throws -> Candidate {
        guard self.policyAllowsMigration(
            onboardingSeen: AppStateStore.shared.onboardingSeen,
            installPolicy: CLIInstallPolicy.storedPolicy(),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel()),
            let candidate = try await self.capture(profile: .current)
        else { throw Failure(message: "The Gateway is no longer an eligible app-managed Node service.") }
        return candidate
    }

    private static func checkCandidateAtDispatch(
        _ expected: Candidate,
        custody: ServiceCustody,
        checkCurrent: @MainActor @Sendable () throws -> Void) async throws
    {
        try checkCurrent()
        guard PostAppUpdateReceiptStore.pendingSetupRecovery() == nil else {
            throw Failure(message: "The managed Node Gateway update needs repair before switching runtimes.")
        }
        let current = try await self.recaptureEligibleCandidate()
        guard current.version == expected.version, current.snapshot == expected.snapshot,
              try await self.captureServiceCustody() == custody
        else { throw Failure(message: "The Node Gateway changed before dispatch; the newer selection was preserved.") }
        try checkCurrent()
        guard PostAppUpdateReceiptStore.pendingSetupRecovery() == nil,
              self.policyAllowsMigration(
                  onboardingSeen: AppStateStore.shared.onboardingSeen,
                  installPolicy: CLIInstallPolicy.storedPolicy(),
                  gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel()),
              GatewayLaunchAgentManager.launchdConfigSnapshot() == expected.snapshot
        else { throw Failure(message: "The Node Gateway update policy changed before dispatch; retry.") }
    }

    private static func capture(profile: AppProfile) async throws -> Candidate? {
        guard let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot() else { return nil }
        let state = profile.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        guard CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: snapshot.programArguments),
              let cli = GatewayLaunchAgentManager.installedServiceCLI(
                  snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper),
              let executable = cli.prefix.first,
              GatewayLaunchAgentManager.isManagedNode(executable, stateDirectory: state)
        else { return nil }
        guard let entrypoint = cli.prefix.last,
              GatewayLaunchAgentManager.isWithinState(entrypoint, stateDirectory: state),
              snapshot.environment["OPENCLAW_STATE_DIR"].map({
                  URL(fileURLWithPath: $0).standardizedFileURL == state.standardizedFileURL
              }) ?? true,
              snapshot.environment["OPENCLAW_CONFIG_PATH"].map({
                  URL(fileURLWithPath: $0).standardizedFileURL == state.appendingPathComponent("openclaw.json")
                      .standardizedFileURL
              }) ?? true
        else { return nil }
        if snapshot.programArguments.first == "/bin/sh" || snapshot.programArguments.first == artifacts.wrapper.path {
            guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
                  FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
            else {
                throw Failure(
                    message: "The managed Node service environment could not be read; repair it before migration.")
            }
        }
        guard let port = snapshot.port ?? snapshot.environment["OPENCLAW_GATEWAY_PORT"].flatMap(Int.init),
              (1...65535).contains(port)
        else { throw Failure(message: "The managed Node service port could not be inspected.") }
        guard try await !GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: state, profile: profile)
        else { return nil }
        let version = try await self.installedVersion(cli: cli, profile: profile)
        guard GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot,
              try await !GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: state, profile: profile)
        else {
            throw Failure(message: "The managed Node service changed during inspection; retry.")
        }
        return Candidate(
            cli: cli,
            snapshot: snapshot,
            version: version,
            port: port,
            allowUnconfigured: snapshot.programArguments.contains("--allow-unconfigured"))
    }

    private static func installedVersion(
        cli: GatewayLaunchAgentManager.InstalledServiceCLI,
        profile: AppProfile) async throws -> String
    {
        let environment = GatewayLaunchAgentManager.daemonEnvironment(
            runtime: nil,
            installedCLI: cli,
            environment: ProcessInfo.processInfo.environment,
            profile: profile,
            searchPaths: CommandResolver.preferredPaths())
        let response = await ShellExecutor.runDetailed(
            command: cli.prefix + ["--version"], cwd: nil, env: environment, timeout: 15)
        guard response.success,
              let version = GatewayEnvironment.normalizeGatewayVersionOutput(response.stdout),
              Semver.parse(version) != nil
        else { throw Failure(message: "The installed Node Gateway version could not be verified.") }
        return version
    }

    static func liveOperations(
        checkCurrent: @escaping @MainActor @Sendable () throws -> Void,
        verifyHealth: @escaping () async throws -> Void,
        setServiceHosting: @escaping () -> Void,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void) -> Operations
    {
        let custody = RestorationCustody()
        return Operations(
            checkCurrent: checkCurrent,
            updateVersion: { candidate, version in
                let original = try await self.captureServiceCustody()
                try checkCurrent()
                let outcome = await CLIInstaller.updateManaged(
                    targetVersion: version,
                    installedCLI: candidate.cli,
                    checkCurrent: {
                        try await self.checkCandidateAtDispatch(
                            candidate,
                            custody: original,
                            checkCurrent: checkCurrent)
                    },
                    statusHandler: statusHandler)
                if case let .failure(message, details) = outcome {
                    throw Failure(message: [message, details].compactMap(\.self).joined(separator: " "))
                }
            },
            recapture: { try await self.recaptureEligibleCandidate() },
            seed: { try await BundledRuntime.seed() },
            setServiceHosting: setServiceHosting,
            install: { candidate, runtime in
                let original = try await self.captureServiceCustody()
                guard original.runtimePin == nil,
                      GatewayLaunchAgentManager.launchdConfigSnapshot() == candidate.snapshot
                else { throw Failure(message: "The Node Gateway changed before installation; it was preserved.") }
                custody.original = original
                try checkCurrent()
                let installError = await GatewayLaunchAgentManager.runDaemonCommand(
                    GatewayLaunchAgentManager.installArguments(
                        port: candidate.port,
                        allowUnconfigured: candidate.allowUnconfigured,
                        runtime: runtime,
                        launchAgentExists: true,
                        replaceRuntime: true),
                    timeout: self.serviceInstallTimeout,
                    runtime: runtime,
                    checkCurrent: {
                        try await self.checkCandidateAtDispatch(
                            candidate,
                            custody: original,
                            checkCurrent: checkCurrent)
                    })
                try await custody.finishInstall(error: installError) {
                    try await self.installedServiceCustody(
                        runtime: runtime,
                        port: candidate.port,
                        allowUnconfigured: candidate.allowUnconfigured,
                        allowMissingRuntimePin: installError != nil)
                }
            },
            restore: { candidate in
                let current = try await self.captureServiceCustody()
                if try custody.action(current: current) == .verifyOriginalNode { return }
                guard try await self.installedVersion(cli: candidate.cli, profile: .current) == candidate.version else {
                    throw Failure(message: "The retained Node Gateway version changed during migration. " +
                        "The current service was preserved; inspect it before retrying.")
                }
                let verified = try await self.captureServiceCustody()
                if try custody.action(current: verified) == .verifyOriginalNode { return }
                // --runtime node clears the newly selected Bun pin. PATH starts with the captured
                // Node directory; the retained package and environment are from the same version.
                var arguments = ["install", "--force", "--port", String(candidate.port), "--runtime", "node"]
                if candidate.allowUnconfigured { arguments.append("--allow-unconfigured") }
                if let error = await GatewayLaunchAgentManager
                    .runDaemonCommand(
                        arguments,
                        timeout: self.serviceInstallTimeout,
                        installedCLI: candidate.cli,
                        checkCurrent: {
                            guard try await self.installedVersion(cli: candidate.cli, profile: .current) == candidate
                                .version,
                                try await self.captureServiceCustody() == verified
                            else {
                                throw Failure(message: "The Node recovery target changed before dispatch; " +
                                    "the newer selection was preserved.")
                            }
                        })
                {
                    throw Failure(message: error)
                }
            },
            verifyHealth: verifyHealth)
    }
}
