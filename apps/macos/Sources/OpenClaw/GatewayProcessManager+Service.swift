import Foundation

extension GatewayProcessManager {
    enum Installation {
        case managed, external, unreadable

        static let ownershipFailure =
            "Could not read the Gateway service ownership record. Check the Gateway LaunchAgent and retry."
    }

    struct LaunchAgentEnableRequest: Sendable {
        let port: Int
        let allowUnconfigured: Bool
        let generation: UInt64
        let runtimeForUpdate: BundledRuntime?
        let runtimeEnvironment: [String: String]?
        let nodeMigration: ManagedNodeGatewayMigration.Candidate?
        let serviceForRestoration: GatewayLaunchAgentManager.InstalledServiceCLI?
        let mutationCheck: (@MainActor @Sendable () async throws -> Void)?
        var invocationIDs: [UInt64]

        func hasSameConfiguration(as other: LaunchAgentEnableRequest) -> Bool {
            self.port == other.port &&
                self.allowUnconfigured == other.allowUnconfigured &&
                self.generation == other.generation &&
                self.runtimeForUpdate?.root == other.runtimeForUpdate?.root &&
                self.runtimeEnvironment == other.runtimeEnvironment &&
                self.nodeMigration?.cli.prefix == other.nodeMigration?.cli.prefix &&
                self.serviceForRestoration?.prefix == other.serviceForRestoration?.prefix &&
                self.serviceForRestoration?.environment == other.serviceForRestoration?.environment &&
                self.serviceForRestoration?.sqliteLibrary == other.serviceForRestoration?.sqliteLibrary &&
                (self.mutationCheck == nil) == (other.mutationCheck == nil)
        }
    }

    enum LaunchAgentEnableResult: Sendable {
        case skipped
        case installedService
        case failed(String)
        case deferred(String)

        var error: String? {
            if case let .failed(message) = self {
                message
            } else { nil }
        }

        var installed: Bool {
            if case .installedService = self {
                true
            } else {
                false
            }
        }

        var inspectionFailure: String? {
            if case let .deferred(message) = self {
                message
            } else { nil }
        }
    }

    func serviceCLIForResume() throws -> GatewayLaunchAgentManager.InstalledServiceCLI? {
        if let retainedServiceCLI { return retainedServiceCLI }
        guard let stored = AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) else {
            return nil
        }
        guard let data = stored as? Data else {
            throw GatewayHostingError(message: "The retained Gateway command could not be read.")
        }
        return try GatewayLaunchAgentManager.resumeCLI(
            from: data, stateDirectory: AppProfile.current.stateDirectoryURL())
    }

    func loadRetainedServiceForResume() throws {
        guard self.retainedServiceCLI == nil else { return }
        self.retainedServiceCLI = try self.serviceCLIForResume()
    }

    func retainManagedServiceForResume() async throws {
        guard self.installation == .managed,
              let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot()
        else { return }
        let state = AppProfile.current.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: .current)
        guard var cli = GatewayLaunchAgentManager.installedServiceCLI(
            snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper)
        else { return }
        let pin = try await GatewayLaunchAgentManager.runtimePinRecord(stateDirectory: state, profile: .current)
        guard try await GatewayLaunchAgentManager.runtimePinRecord(stateDirectory: state, profile: .current) == pin,
              GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot
        else { throw GatewayHostingError(message: "The Gateway service changed before pausing; retry.") }
        cli.hadRuntimePin = pin != nil
        let data = try GatewayLaunchAgentManager.resumeData(for: cli)
        _ = try GatewayLaunchAgentManager.resumeCLI(from: data, stateDirectory: state)
        self.retainedServiceCLI = cli
    }

    struct PausedServiceUpdate {
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI?
        let record: Data?
    }

    func preparePausedServiceUpdate() throws -> PausedServiceUpdate? {
        guard self.gatewayHosting == .service else { return nil }
        try self.loadRetainedServiceForResume()
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true else {
            throw GatewayHostingError(
                message: "The Gateway service did not finish pausing. Pause it before retrying the update.")
        }
        return PausedServiceUpdate(
            cli: self.retainedServiceCLI,
            record: AppDefaults.standard.data(forKey: GatewayLaunchAgentManager.resumeCommandKey))
    }

    func completePausedServiceUpdate(
        _ update: PausedServiceUpdate?,
        runtime: BundledRuntime,
        checkCurrent: () throws -> Void) async throws
    {
        guard let update else { return }
        let pin = try await GatewayLaunchAgentManager.runtimePinRecord(
            stateDirectory: AppProfile.current.stateDirectoryURL(), profile: .current)
        try checkCurrent()
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true, pin == nil,
              AppDefaults.standard.data(forKey: GatewayLaunchAgentManager.resumeCommandKey) == update.record
        else {
            throw GatewayHostingError(message: "Gateway service or runtime selection changed while updating; retry.")
        }
        guard let cli = update.cli else { return }
        self.retainedServiceCLI = try GatewayLaunchAgentManager.updatedBundledResumeCLI(
            cli, runtime: runtime, stateDirectory: AppProfile.current.stateDirectoryURL())
    }
}
