import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct BundledGatewayPreparationTests {
    private struct Fixture {
        let root: URL
        let nodeRoot: URL
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let plist: URL

        init(home: URL) throws {
            let state = AppProfile.current.stateDirectoryURL()
            let id = UUID().uuidString
            self.root = state.appendingPathComponent("onboarding-\(id)")
            self.nodeRoot = state.appendingPathComponent("tools/node-\(id)")
            let node = self.nodeRoot.appendingPathComponent("bin/node")
            self.cli = .init(
                prefix: [node.path, self.root.appendingPathComponent("openclaw.mjs").path],
                sqliteLibrary: nil)
            self.plist = GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
            for directory in [self.root, node.deletingLastPathComponent(), self.plist.deletingLastPathComponent()] {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            try "2026.8.1\n".write(to: self.root.appendingPathComponent("version"), atomically: true, encoding: .utf8)
            try """
            #!/bin/sh
            for argument in "$@"; do
              if [ "$argument" = --version ]; then
                read -r version < "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
                printf 'OpenClaw %s\n' "$version"
                exit 0
              fi
            done
            printf '%s\n' "$*" >> "$OPENCLAW_PREPARATION_FIXTURE_ROOT/updates"
            if [ -f "$OPENCLAW_PREPARATION_FIXTURE_ROOT/advance" ]; then
              printf '%s\n' '2026.9.1' > "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
            fi
            if [ -f "$OPENCLAW_PREPARATION_FIXTURE_ROOT/fail" ]; then
              printf '%s\n' '{"status":"error","reason":"fixture offline"}'
              exit 1
            fi
            printf '%s\n' '2026.9.1' > "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
            printf '%s\n' '{"status":"ok","before":{"version":"2026.8.1"},"after":{"version":"2026.9.1"}}'
            """.write(to: node, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
            try PropertyListSerialization.data(
                fromPropertyList: [
                    "ProgramArguments": self.cli.prefix + ["gateway", "--port", "29873"],
                    "EnvironmentVariables": ["OPENCLAW_PREPARATION_FIXTURE_ROOT": self.root.path],
                ],
                format: .xml,
                options: 0).write(to: self.plist)
        }

        func remove() {
            try? FileManager.default.removeItem(at: self.root)
            try? FileManager.default.removeItem(at: self.nodeRoot)
        }
    }

    @Test(arguments: ["initial", "seeded-retry", "paused-retry", "partial-ready"])
    func `bundled setup updates the actual legacy service and retries through its updater`(
        scenario: String) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
            lastLaunchedAppVersionKey: nil, "openclaw.lastLaunchedRuntimeBuildID": nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previousRetained }
            manager.retainedServiceCLI = nil
            if scenario == "paused-retry" {
                var retained = fixture.cli
                retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
                manager.retainedServiceCLI = retained
                try FileManager.default.removeItem(at: fixture.plist)
            }
            let current = AppProfile.current.stateDirectoryURL().appendingPathComponent("runtime/current")
            if scenario != "initial" {
                try FileManager.default.createDirectory(
                    at: current.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(atPath: current.path, withDestinationPath: "existing-build")
            }
            defer { if scenario != "initial" { try? FileManager.default.removeItem(at: current) } }
            let original = GatewayLaunchAgentManager.launchdConfigSnapshot()
            let failure = fixture.root.appendingPathComponent("fail")
            if scenario == "partial-ready" { try Data().write(to: fixture.root.appendingPathComponent("advance")) }
            try Data().write(to: failure)
            do {
                _ = try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: scenario != "paused-retry", statusHandler: { _ in })
                Issue.record("Failed updater must leave setup retryable")
            } catch {
                #expect(error.localizedDescription.contains("fixture offline"))
            }
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == original)
            #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                (scenario == "partial-ready" ? "2026.9.1\n" : "2026.8.1\n"))
            #expect(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", currentRuntimeBuildID: "next-build", onboardingSeen: false) == nil)
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery()?.gatewayUpdateIncomplete == true)
            try FileManager.default.removeItem(at: failure)
            let location = try await CLIInstaller.prepareBundledGateway(
                targetVersion: "2026.9.1", restartGateway: scenario != "paused-retry", statusHandler: { _ in })
            #expect(location == fixture.cli.prefix.last)
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == original)
            let updates = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                .split(separator: "\n")
            #expect(updates.count == 2)
            let entrypoint = try #require(fixture.cli.prefix.last)
            for (index, command) in updates.enumerated() {
                #expect(command.contains(scenario == "partial-ready" && index == 1
                        ? "update repair" : "update --tag 2026.9.1"))
                #expect(command.contains(entrypoint))
                #expect(command.contains("--no-restart") == (scenario == "paused-retry"))
            }
            CLIInstaller.completeBundledSetup(
                after: .failed(reason: "not healthy"), currentVersion: "2026.9.1", mode: .local, paused: false)
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() != nil)
            CLIInstaller.completeBundledSetup(
                after: scenario == "paused-retry" ? .deferred : .ready,
                currentVersion: "2026.9.1",
                mode: .local,
                paused: scenario == "paused-retry")
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == nil)
        }
    }

    @Test(arguments: ["service", "policy", "termination", "retained-pin"])
    func `bundled setup rechecks ownership after its progress callback`(_ change: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            let previousTerminating = manager.isTerminating
            defer {
                manager.retainedServiceCLI = previousRetained
                manager.isTerminating = previousTerminating
            }
            manager.isTerminating = false
            manager.retainedServiceCLI = nil
            if change == "retained-pin" {
                var retained = fixture.cli
                retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
                manager.retainedServiceCLI = retained
                try FileManager.default.removeItem(at: fixture.plist)
            }
            let changed = fixture.root.appendingPathComponent("callback-changed")
            await #expect(throws: GatewayHostingError.self) {
                try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1",
                    restartGateway: false,
                    statusHandler: { _ in
                        guard !FileManager.default.fileExists(atPath: changed.path) else { return }
                        do {
                            try Data().write(to: changed)
                            switch change {
                            case "service":
                                try Data("operator replacement".utf8).write(to: fixture.plist)
                            case "termination":
                                manager.isTerminating = true
                            case "retained-pin":
                                manager.retainedServiceCLI?.hadRuntimePin = true
                            default:
                                AppDefaults.standard.set("beta", forKey: cliInstallPolicyKey)
                            }
                        } catch { Issue.record(error) }
                    })
            }
            #expect(FileManager.default.fileExists(atPath: changed.path))
            #expect(AppDefaults.standard.object(forKey: postAppUpdateReceiptKey) == nil)
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
            #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                "2026.8.1\n")
        }
    }

    @Test(arguments: ["beta", "pinned"])
    func `bundled setup reports excluded incompatible services without replacing them`(_ policy: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: policy == "beta" ? "beta" : "exact",
            GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previousRetained }
            var retained = fixture.cli
            retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
            retained.hadRuntimePin = policy == "pinned"
            manager.retainedServiceCLI = retained
            try FileManager.default.removeItem(at: fixture.plist)
            do {
                _ = try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: false, statusHandler: { _ in })
                Issue.record("Operator-owned update intent must remain actionable")
            } catch {
                #expect(error.localizedDescription.contains("operator-managed"))
            }
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
            #expect(manager.retainedServiceCLI?.prefix == retained.prefix)
        }
    }

    @Test(arguments: ["beta", "extended-stable"], [false, true])
    func `bundled setup preserves policies on installed and retained seeded services`(
        policy: String,
        retained: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        try Data((policy == "extended-stable" ? "{\"update\":{\"channel\":\"extended-stable\"}}" : "{}").utf8)
            .write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_STATE_DIR": home.appendingPathComponent("state").path],
            defaults: [
                cliInstallPolicyKey: policy == "beta" ? "beta" : "exact",
                GatewayLaunchAgentManager.resumeCommandKey: nil,
                postAppUpdateReceiptKey: nil,
            ]) {
                let manager = GatewayProcessManager.shared
                let previous = manager.retainedServiceCLI
                defer { manager.retainedServiceCLI = previous }
                let runtime = BundledRuntime(root: AppProfile.current.stateDirectoryURL()
                    .appendingPathComponent("runtime/old"))
                let cli = GatewayLaunchAgentManager.InstalledServiceCLI(prefix: runtime.cliCommand, sqliteLibrary: nil)
                manager.retainedServiceCLI = retained ? cli : nil
                if !retained {
                    let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
                    try FileManager.default.createDirectory(
                        at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try PropertyListSerialization.data(
                        fromPropertyList: ["ProgramArguments": cli.prefix + ["gateway"]],
                        format: .xml,
                        options: 0).write(to: plist)
                }
                do {
                    _ = try await CLIInstaller.prepareBundledGateway(statusHandler: { _ in })
                    Issue.record("Setup must preserve the service update policy")
                } catch {
                    #expect(error.localizedDescription.contains("update policy is operator-managed"))
                }
                #expect(AppDefaults.standard.object(forKey: postAppUpdateReceiptKey) == nil)
            }
    }

    @Test func `paused post update retries unfinished core repair without resuming or migrating`() async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previous = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previous }
            var cli = fixture.cli
            cli.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
            manager.retainedServiceCLI = cli
            try FileManager.default.removeItem(at: fixture.plist)
            let failure = fixture.root.appendingPathComponent("fail")
            try Data().write(to: failure)
            try Data().write(to: fixture.root.appendingPathComponent("advance"))
            await #expect(throws: GatewayHostingError.self) {
                try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: false, statusHandler: { _ in })
            }
            let pending = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery())
            #expect(!PostUpdateController.allowsNodeMigration(paused: true, canActivate: false, receipt: pending))
            #expect(!PostUpdateController.allowsNodeMigration(paused: false, canActivate: true, receipt: pending))
            let context = try PostUpdateController.captureRuntimeContext(
                connectionMode: .local, bundledApp: true, usesSeededGateway: false)
            #expect(context.hasService)
            #expect(context.ownsManagedRuntime)
            #expect(context.installedCLI?.prefix == cli.prefix)
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: context, gatewayUpdateIncomplete: pending.gatewayUpdateIncomplete)
            {
                await CLIInstaller.managedStatus(
                    expectedVersion: "2026.9.1", installedCLI: context.installedCLI, usesBundledRuntime: false)
            }
            try #require(resolution.action == .repair)
            let failedRepair = await CLIInstaller.updateManaged(
                targetVersion: "2026.9.1",
                restartGateway: false,
                repair: true,
                installedCLI: resolution.installedCLI,
                statusHandler: { _ in })
            guard case .failure = failedRepair else {
                Issue.record("Failed core repair must remain retryable")
                return
            }
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == pending)
            #expect(!PostUpdateController.allowsNodeMigration(
                paused: false, canActivate: true, receipt: PostAppUpdateReceiptStore.pendingSetupRecovery()))
            try FileManager.default.removeItem(at: failure)
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: "2026.9.1",
                restartGateway: false,
                repair: true,
                installedCLI: resolution.installedCLI,
                statusHandler: { _ in })
            #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
            #expect(!FileManager.default.fileExists(atPath: fixture.plist.path))
            let updates = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                .split(separator: "\n")
            #expect(updates.count == 3)
            #expect(updates.allSatisfy { $0.contains("--no-restart") })
            #expect(updates.dropFirst().allSatisfy { $0.contains("update repair") })
            CLIInstaller.completeBundledSetup(
                after: .deferred, currentVersion: "2026.9.1", mode: .local, paused: true)
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == nil)
            #expect(!PostUpdateController.allowsNodeMigration(paused: true, canActivate: false, receipt: nil))
            #expect(manager.retainedServiceCLI?.prefix == cli.prefix)
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `bundled setup joins the seeded service update owner before returning its package`(
        retained: Bool,
        updateFails: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let state = AppProfile.current.stateDirectoryURL()
            let runtime = BundledRuntime(root: state.appendingPathComponent("runtime/preparation-\(UUID().uuidString)"))
            let current = state.appendingPathComponent("runtime/current")
            defer {
                try? FileManager.default.removeItem(at: runtime.root)
                if !updateFails { try? FileManager.default.removeItem(at: current) }
            }
            let manager = GatewayProcessManager.shared
            let previousTask = manager.bundledUpdateTask
            let previousRetained = manager.retainedServiceCLI
            let previousTerminating = manager.isTerminating
            defer {
                manager.bundledUpdateTask = previousTask
                manager.retainedServiceCLI = previousRetained
                manager.isTerminating = previousTerminating
            }
            manager.isTerminating = false
            let old = BundledRuntime(root: state.appendingPathComponent("runtime/previous-build"))
            var cli = GatewayLaunchAgentManager.InstalledServiceCLI(
                prefix: [updateFails ? "/operator/bin/bun" : old.bun.path, old.cliCommand[1]],
                sqliteLibrary: old.sqliteLibrary.path)
            cli.hadRuntimePin = true
            manager.retainedServiceCLI = retained ? cli : nil
            if !retained {
                let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
                try FileManager.default.createDirectory(
                    at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                try PropertyListSerialization.data(
                    fromPropertyList: ["ProgramArguments": cli.prefix + ["gateway"]],
                    format: .xml,
                    options: 0).write(to: plist)
            }
            let ownerWarning = "Gateway service uses an operator-pinned runtime; update it yourself"
            manager.bundledUpdateTask = Task { @MainActor in
                if updateFails { throw GatewayHostingError(message: ownerWarning) }
                try self.publishRuntime(runtime, current: current)
            }
            do {
                let location = try await CLIInstaller.prepareBundledGateway(statusHandler: { _ in })
                #expect(!updateFails)
                #expect(location == runtime.packageRoot.path)
            } catch {
                #expect(updateFails)
                #expect(error.localizedDescription == ownerWarning)
            }
        }
    }

    private func publishRuntime(_ runtime: BundledRuntime, current: URL) throws {
        for directory in [runtime.bun.deletingLastPathComponent(), runtime.packageRoot.appendingPathComponent("dist")] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: runtime.bun)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: runtime.bun.path)
        try Data().write(to: runtime.sqliteLibrary)
        try Data().write(to: runtime.packageRoot.appendingPathComponent("openclaw.mjs"))
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.9.1", "commit": "fixture", "builtAt": "fixture", "buildId": runtime.root.lastPathComponent,
        ]).write(to: runtime.packageRoot.appendingPathComponent("dist/build-info.json"))
        try FileManager.default.createSymbolicLink(
            atPath: current.path,
            withDestinationPath: runtime.root.lastPathComponent)
    }
}
