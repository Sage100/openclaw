import Foundation
import OpenClawNativeState
import Testing
@testable import OpenClaw

@MainActor
struct ManagedNodeGatewayMigrationTests {
    private final class Fixture {
        var calls: [String] = []
        var version = "2026.9.6"
        var updateFails = false
        var healthFails = false
        var restoredCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/fixture/runtime/build-one"))

        var candidate: ManagedNodeGatewayMigration.Candidate {
            let command = [
                "/fixture/tools/node/bin/node",
                "/fixture/tools/node/lib/node_modules/openclaw/dist/entry.js",
            ]
            let environment = ["CHANNEL_FIXTURE": "synthetic", "OPENCLAW_LAUNCHD_LABEL": "ai.openclaw.gateway"]
            return .init(
                cli: .init(prefix: command, sqliteLibrary: nil, environment: environment),
                snapshot: .init(
                    programArguments: command + ["gateway", "--port", "29871"],
                    environment: environment,
                    stdoutPath: nil,
                    stderrPath: nil,
                    port: 29871,
                    bind: nil,
                    token: nil,
                    password: nil),
                version: self.version,
                port: 29871,
                allowUnconfigured: false)
        }

        var operations: ManagedNodeGatewayMigration.Operations {
            .init(
                checkCurrent: {},
                updateVersion: { _, version in
                    self.calls.append("update")
                    if self.updateFails { throw ManagedNodeGatewayMigration.Failure(message: "offline") }
                    self.version = version
                },
                recapture: { self.calls.append("capture")
                    return self.candidate
                },
                seed: { self.calls.append("seed")
                    return self.runtime
                },
                setServiceHosting: { self.calls.append("service") },
                install: { _, _ in self.calls.append("bun") },
                restore: { self.calls.append("node")
                    self.restoredCLI = $0.cli
                },
                verifyHealth: {
                    self.calls.append("health")
                    if self.healthFails {
                        self.healthFails = false
                        throw ManagedNodeGatewayMigration.Failure(message: "health failed")
                    }
                })
        }
    }

    @Test func `version changes stay in core updater without starting the runtime switch`() async throws {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        guard case .versionUpdated = outcome else { Issue.record("Expected version-only update")
            return
        }
        #expect(fixture.calls == ["capture", "update", "capture"])
        #expect(fixture.version == "2026.9.6")
    }

    @Test(arguments: ["excluded", "replaced"])
    func `queued version migration rechecks its eligible candidate before any update`(_ change: String) async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        let admitted = fixture.candidate
        var operations = fixture.operations
        operations.recapture = {
            fixture.calls.append("capture")
            if change == "excluded" {
                throw ManagedNodeGatewayMigration.Failure(message: "The operator selected a runtime pin.")
            }
            fixture.version = "2026.8.2"
            return fixture.candidate
        }
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: admitted, targetVersion: "2026.9.6", operations: operations)
        }
        #expect(fixture.calls == ["capture"])
        #expect(fixture.version != "2026.9.6")
    }

    @Test func `same version switches to a healthy Bun service and preserves always on hosting`() async throws {
        let fixture = Fixture()
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate, targetVersion: fixture.version, operations: fixture.operations)
        guard case let .migrated(runtime) = outcome else { Issue.record("Expected runtime migration")
            return
        }
        #expect(runtime.root == fixture.runtime.root)
        #expect(fixture.calls == ["capture", "seed", "capture", "service", "bun", "health"])
    }

    @Test func `same version Node migration waits for unfinished core setup repair`() async throws {
        let suite = "ManagedNodeGatewayMigrationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fixture = Fixture()
        PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: fixture.version, defaults: defaults)
        let receipt = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults))
        _ = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate,
            targetVersion: fixture.version,
            pendingSetupRecovery: receipt,
            operations: fixture.operations)
        #expect(fixture.calls.isEmpty)
        #expect(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults) == receipt)
    }

    @Test func `failed version update never seeds or replaces the Node service`() async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        fixture.updateFails = true
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        }
        #expect(fixture.calls == ["capture", "update"])
        #expect(fixture.version == "2026.8.1")
    }

    @Test func `failed Bun health restores the captured same version Node command and checks health`() async {
        let fixture = Fixture()
        fixture.healthFails = true
        let previous = fixture.candidate
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: previous, targetVersion: previous.version, operations: fixture.operations)
        }
        #expect(fixture.calls == ["capture", "seed", "capture", "service", "bun", "health", "node", "health"])
        #expect(fixture.restoredCLI?.prefix == previous.cli.prefix)
        #expect(fixture.restoredCLI?.environment == previous.cli.environment)
        let environment = GatewayLaunchAgentManager.daemonEnvironment(
            runtime: nil,
            installedCLI: fixture.restoredCLI,
            environment: [:],
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "migration-proof"]),
            searchPaths: ["/usr/bin"])
        #expect(environment["CHANNEL_FIXTURE"] == "synthetic")
        #expect(environment["OPENCLAW_LAUNCHD_LABEL"] == nil)
        #expect(environment["OPENCLAW_PROFILE"] == "migration-proof")
    }

    @Test func `version verification failure prevents the runtime switch`() async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        var operations = fixture.operations
        operations.updateVersion = { _, _ in fixture.calls.append("update") }
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: fixture.candidate, targetVersion: "2026.9.6", operations: operations)
        }
        #expect(fixture.calls == ["capture", "update", "capture"])
    }

    @Test func `revoked migration lifecycle cannot dispatch Bun after custody inspection`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: directory) {
            let fixture = Fixture()
            let candidate = fixture.candidate
            let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: directory, profile: .current)
            try FileManager.default.createDirectory(
                at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
            try PropertyListSerialization.data(
                fromPropertyList: [
                    "ProgramArguments": candidate.snapshot.programArguments,
                    "EnvironmentVariables": candidate.snapshot.environment,
                ],
                format: .xml,
                options: 0).write(to: plist)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
            }
            let live = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: { throw CancellationError() },
                verifyHealth: {}, setServiceHosting: {}, statusHandler: { _ in })
            await #expect(throws: CancellationError.self) {
                try await live.install(candidate, fixture.runtime)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == candidate.snapshot)
            // The admitted drain can verify its unchanged original Node service even after pause/quit.
            try await live.restore(candidate)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `pause resume metadata retains Node paths without persisting service credentials`() throws {
        let previous = Fixture().candidate.cli
        let data = try GatewayLaunchAgentManager.resumeData(for: previous)
        let restored = try GatewayLaunchAgentManager.resumeCLI(
            from: data, stateDirectory: URL(fileURLWithPath: "/fixture"))
        #expect(restored.prefix == previous.prefix)
        #expect(restored.environment.isEmpty)
        let encoded = try #require(String(bytes: data, encoding: .utf8))
        #expect(!encoded.contains("CHANNEL_FIXTURE"))
        let external = try JSONSerialization.data(withJSONObject: [
            "prefix": ["/operator/node", "/operator/openclaw.mjs"],
        ])
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.resumeCLI(
                from: external, stateDirectory: URL(fileURLWithPath: "/fixture"))
        }
    }

    @Test func `saved intent excludes app managed Node without database writes`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let profile = AppProfile(environment: [:])
        let configPath = directory.appendingPathComponent("openclaw.json").path
        let key = try GatewayLaunchAgentManager.runtimePinKey(profile: profile, configPath: configPath)
        #expect(try GatewayLaunchAgentManager.runtimePinKey(
            profile: profile, configPath: "/fixture/.openclaw/openclaw.json") ==
            "daemon-runtime-pin:a1802840aaccdcabb68bb73a9cfb580598364ace9d5232d2d10f2446bdb51e35")
        let databaseURL = directory.appendingPathComponent("state/openclaw.sqlite")
        try Self.writePinFixture(databaseURL: databaseURL, key: key)
        let before = try Data(contentsOf: databaseURL)
        #expect(try await GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: directory, profile: profile))
        let pin = try #require(try await GatewayLaunchAgentManager.runtimePinRecord(
            stateDirectory: directory, profile: profile))
        #expect(pin.updatedAtMilliseconds == 1)
        #expect(pin.value.contains(#""path":"/fixture/tools/node/bin/node""#))
        #expect(try Data(contentsOf: databaseURL) == before)
        #expect(try await !GatewayLaunchAgentManager.hasRuntimePin(
            stateDirectory: directory, profile: AppProfile(environment: ["OPENCLAW_PROFILE": "other"])))
    }

    @Test func `rollback preserves external changes to service bytes or runtime intent`() throws {
        func definition(
            workingDirectory: String,
            environment: String = "export FIXTURE='value'",
            wrapper: String = "exec \"$@\"") throws -> ManagedNodeGatewayMigration.ServiceDefinitionDigest
        {
            let plist = try PropertyListSerialization.data(
                fromPropertyList: ["WorkingDirectory": workingDirectory, "ProgramArguments": ["/fixture/bun"]],
                format: .xml,
                options: 0)
            return .init(plist: plist, environment: Data(environment.utf8), wrapper: Data(wrapper.utf8))
        }
        let original = try ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition(workingDirectory: "/fixture/node"), runtimePin: nil)
        let pin = OpenClawNativeStateConfigValue(value: "bundled-pin", updatedAtMilliseconds: 1)
        let installed = try ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition(workingDirectory: "/fixture/bun"), runtimePin: pin)
        let custody = ManagedNodeGatewayMigration.RestorationCustody()
        custody.original = original
        // An installer failure that preserved the original Node service requires only health verification.
        #expect(try custody.action(current: original) == .verifyOriginalNode)
        #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: installed) }
        custody.installed = installed
        #expect(try custody.action(current: installed) == .restoreNode)
        for changed in try [
            ManagedNodeGatewayMigration.ServiceCustody(
                definition: definition(workingDirectory: "/operator/workspace"), runtimePin: pin),
            .init(definition: definition(workingDirectory: "/fixture/bun", environment: "changed"), runtimePin: pin),
            .init(definition: definition(workingDirectory: "/fixture/bun", wrapper: "changed"), runtimePin: pin),
            .init(definition: installed.definition, runtimePin: .init(value: "operator-pin", updatedAtMilliseconds: 1)),
            .init(definition: installed.definition, runtimePin: .init(value: pin.value, updatedAtMilliseconds: 2)),
            .init(definition: installed.definition, runtimePin: nil),
        ] {
            #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: changed) }
        }
    }

    @Test func `installer errors retain custody of a published Bun service before rollback`() async throws {
        let original = ManagedNodeGatewayMigration.ServiceCustody(
            definition: .init(plist: Data("Node".utf8), environment: nil, wrapper: nil), runtimePin: nil)
        let definition = ManagedNodeGatewayMigration.ServiceDefinitionDigest(
            plist: Data("Bun".utf8), environment: Data("synthetic".utf8), wrapper: nil)
        let pins: [OpenClawNativeStateConfigValue?] = [nil, .init(value: "bundled-pin", updatedAtMilliseconds: 1)]
        for pin in pins {
            let published = ManagedNodeGatewayMigration.ServiceCustody(definition: definition, runtimePin: pin)
            let custody = ManagedNodeGatewayMigration.RestorationCustody()
            custody.original = original
            await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
                try await custody.finishInstall(error: "installer timed out after publication") { published }
            }
            #expect(try custody.action(current: published) == .restoreNode)
        }
        let custody = ManagedNodeGatewayMigration.RestorationCustody()
        custody.original = original
        do {
            try await custody.finishInstall(error: "installer failed") {
                throw ManagedNodeGatewayMigration.Failure(message: "capture rejected")
            }
            Issue.record("Expected the installer error")
        } catch {
            #expect(error.localizedDescription == "installer failed")
        }
        #expect(try custody.action(current: original) == .verifyOriginalNode)
        let foreign = ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition, runtimePin: .init(value: "operator-pin", updatedAtMilliseconds: 2))
        #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: foreign) }
    }

    @Test func `missing pin exception still rejects conflicting recorded intent`() throws {
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/fixture/runtime/build"))
        #expect(!ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
            nil, runtime: runtime, definition: "expected", allowMissing: false))
        #expect(ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
            nil, runtime: runtime, definition: "expected", allowMissing: true))
        for (path, binding, accepted) in [
            (runtime.bun.path, "expected", true),
            ("/operator/bin/bun", "expected", false),
            (runtime.bun.path, "other-definition", false),
        ] {
            let value = try JSONSerialization.data(withJSONObject: [
                "version": 1,
                "pin": ["runtime": "bun", "path": path],
                "definition": binding,
            ])
            let record = try OpenClawNativeStateConfigValue(
                value: #require(String(bytes: value, encoding: .utf8)), updatedAtMilliseconds: 1)
            #expect(ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
                record, runtime: runtime, definition: "expected", allowMissing: true) == accepted)
        }
    }

    private static func writePinFixture(databaseURL: URL, key: String) throws {
        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        try database.execute("""
        PRAGMA user_version = 1;
        CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER);
        INSERT INTO schema_meta VALUES ('primary', 'global', 1);
        CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
        """)
        let insert = try database.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
        try insert.bindText(key, at: 1)
        try insert.bindText(
            #"{"version":1,"pin":{"runtime":"node","path":"/fixture/tools/node/bin/node"},"definition":"fixture"}"#,
            at: 2)
        _ = try insert.step()
    }

    @Test func `managed Node ownership excludes external binaries and links`() throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = directory.appendingPathComponent("profile")
        let tools = state.appendingPathComponent("tools")
        let external = directory.appendingPathComponent("operator")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: external.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        try Data().write(to: external.appendingPathComponent("bin/node"))
        try FileManager.default.createSymbolicLink(
            at: tools.appendingPathComponent("node"),
            withDestinationURL: external)
        #expect(!GatewayLaunchAgentManager.isManagedNode(
            tools.appendingPathComponent("node/bin/node").path,
            stateDirectory: state))
        #expect(GatewayLaunchAgentManager.isManagedNode(
            tools.appendingPathComponent("node-26/bin/node").path,
            stateDirectory: state))
        #expect(!GatewayLaunchAgentManager.isManagedNode(
            external.appendingPathComponent("bin/node").path,
            stateDirectory: state))
    }
}
