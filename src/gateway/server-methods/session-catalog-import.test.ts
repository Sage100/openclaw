import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogImportParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { readSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { buildSessionCatalogImportKey } from "../session-create-key.js";
import { createGatewaySession } from "../session-create-service.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, RespondFn } from "./types.js";

async function withCatalog(
  run: (fixture: Awaited<ReturnType<typeof createCatalog>>) => Promise<void>,
  restricted = false,
) {
  await withOpenClawTestState({ scenario: "minimal", label: "catalog-import" }, async (state) => {
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    let fixture: Awaited<ReturnType<typeof createCatalog>> | undefined;
    try {
      fixture = await createCatalog(restricted);
      await state.writeConfig(fixture.config);
      setRuntimeConfigSnapshot(fixture.config);
      await run(fixture);
    } finally {
      fixture?.projection.dispose();
      setActivePluginRegistry(previousRegistry);
    }
  });
}

async function createCatalog(restricted: boolean) {
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    ...(restricted
      ? {
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  sessions: { others: "view" as const },
                  agents: "*" as const,
                  scopes: ["operator.read", "operator.write"],
                },
              },
            },
          },
        }
      : {}),
  };
  const client = createOperatorClient({
    profileName: "catalog-import",
    scopes: restricted ? ["operator.read", "operator.write"] : ["operator.admin"],
  });
  const other = restricted
    ? createOperatorClient({
        profileName: "other-importer",
        scopes: ["operator.read", "operator.write"],
      })
    : undefined;
  const nativeKey = "agent:main:native-adopted";
  const seedNative = () =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey: nativeKey },
      {
        sessionId: "native-source",
        updatedAt: 1,
        pluginOwnerId: "fixture",
        createdVia: "operator",
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      },
    );
  if (restricted) {
    await seedNative();
  }
  const source: SessionCatalogTranscriptItem[] = [
    { id: "question", type: "userMessage", text: "Synthetic imported question" },
    { type: "agentMessage", text: "Synthetic imported answer" },
  ];
  const read = vi.fn<SessionCatalogProvider["read"]>(
    async ({ hostId, threadId, cursor, limit }) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = source.toReversed().slice(offset, offset + (limit ?? 50));
      const next = offset + items.length;
      return {
        hostId,
        threadId,
        label: "Fixture host label",
        items,
        ...(next < source.length ? { nextCursor: String(next) } : {}),
      };
    },
  );
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
    if (!restricted) {
      throw new Error("Unrestricted import must not enumerate the catalog");
    }
    return [
      {
        hostId: "node:fixture",
        label: "Fixture node",
        kind: "node",
        connected: true,
        sessions: [
          {
            threadId: "thread",
            sourceHomeId: "home-a",
            sessionKey: nativeKey,
            name: "Native source",
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
          },
        ],
      },
    ];
  });
  const provider: SessionCatalogProvider = { id: "claude", label: "Claude", list, read };
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "fixture", source: import.meta.url, provider });
  setActivePluginRegistry(registry);
  const projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
  const context = bindSessionRowProjection(
    {
      ...createContext(),
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [], routeVariants: [] }),
    },
    () => projection,
  );
  const locator: SessionsCatalogImportParams = {
    catalogId: "claude",
    hostId: "node:fixture",
    sourceHomeId: "home-a",
    threadId: "thread",
    agentId: "main",
    displayName: "  Preserved investigation  ",
  };
  const key = buildSessionCatalogImportKey("main", locator);
  const call = async (
    method: "sessions.catalog.import" | "sessions.catalog.continue" = "sessions.catalog.import",
    requestClient: GatewayClient = client,
  ) => {
    const respond = vi.fn<RespondFn>();
    const { displayName: _displayName, ...sourceLocator } = locator;
    await withPluginRuntimeGatewayRequestScope(
      { client: requestClient, pluginRegistry: registry, isWebchatConnect: () => false },
      () =>
        sessionCatalogHandlers[method]!({
          params: method === "sessions.catalog.import" ? locator : sourceLocator,
          client: requestClient,
          respond,
          context,
        } as never),
    );
    return respond;
  };
  const transcript = async () => {
    const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
    return entry
      ? readVisibleSessionTranscriptMessageEntries({
          agentId: "main",
          sessionKey: key,
          sessionId: entry.sessionId,
        })
      : [];
  };
  const precreate = async (owner = client) => {
    const created = await createGatewaySession({
      cfg: config,
      agentId: "main",
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      creation: {
        via: "operator",
        actor: {
          type: "human",
          source: "profile",
          id: owner.authenticatedUserProfile!.profileId,
        },
      },
    });
    expect(created.ok).toBe(true);
    await projection.ensureMaterialized();
    await projection.prepareMembership();
  };
  return {
    other,
    nativeKey,
    seedNative,
    precreate,
    config,
    client,
    source,
    provider,
    list,
    read,
    projection,
    locator,
    key,
    call,
    transcript,
  };
}

describe("sessions.catalog.import with durable Gateway owners", () => {
  it("creates and syncs an ordinary durable session through real creation, projection, and transcript owners", async () => {
    await withCatalog(async (fixture) => {
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 2,
        totalItems: 2,
        complete: true,
        created: true,
      });
      const first = await fixture.transcript();
      expect(first).toHaveLength(3);
      expect(JSON.stringify(first)).toContain("Synthetic imported question");
      expect(JSON.stringify(first)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.displayName,
      ).toBe("Preserved investigation");
      fixture.locator.displayName = "Changed source title";
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 0,
        totalItems: 2,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toEqual(first);
      fixture.source.push({ type: "agentMessage", text: "A later preserved reply" });
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 1,
        totalItems: 3,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toHaveLength(4);
      const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key });
      expect(entry?.displayName).toBe("Preserved investigation");
      for (const binding of [
        "pluginOwnerId",
        "modelSelectionLocked",
        "cliSessionBindings",
        "execNode",
      ]) {
        expect(entry).not.toHaveProperty(binding);
      }
      expect(fixture.list).not.toHaveBeenCalled();
      expect(fixture.read).not.toHaveBeenCalledWith(
        expect.objectContaining({ displayName: expect.anything() }),
      );
      expect(readSessionUpstreamLink(fixture.key, "main")).toBeUndefined();
      expect(
        listSessionStateEventsSince(fixture.key, "main", 0).events.filter(
          (event) => event.kind === "imported",
        ),
      ).toMatchObject([
        {
          kind: "imported",
          payload: {
            catalogId: "claude",
            hostId: "node:fixture",
            threadId: "thread",
            sourceHomeId: "home-a",
          },
        },
      ]);
      await fixture.seedNative();
      const continueSession = vi.fn(async () => ({ sessionKey: fixture.nativeKey }));
      fixture.provider.continueSession = continueSession;
      expect(await fixture.call("sessions.catalog.continue")).toHaveBeenCalledWith(true, {
        sessionKey: fixture.nativeKey,
      });
      expect(continueSession).toHaveBeenCalledOnce();
      expect(fixture.nativeKey).not.toBe(fixture.key);
      expect(await fixture.transcript()).toHaveLength(4);
    });
  });

  it.each([undefined, "   "])(
    "uses a generic title instead of the host label when displayName is %j",
    async (displayName) => {
      await withCatalog(async (fixture) => {
        fixture.locator.displayName = displayName;
        expect(await fixture.call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ created: true, importedItems: 2 }),
        );
        expect(
          loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.displayName,
        ).toBe("Imported Claude session");
      });
    },
  );

  it("appends to a pre-existing import target while its ordinary projection publications advance", async () => {
    await withCatalog(async (fixture) => {
      await fixture.precreate();

      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 2,
        totalItems: 2,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toHaveLength(3);
    });
  });

  it.each(["owner", "other"] as const)(
    "respects existing-target write access in a restricted multi-user Gateway (%s target)",
    async (targetOwner) => {
      await withCatalog(async (fixture) => {
        await fixture.precreate(targetOwner === "owner" ? fixture.client : fixture.other!);
        const response = await fixture.call();
        if (targetOwner === "owner") {
          expect(response).toHaveBeenCalledWith(true, {
            sessionKey: fixture.key,
            importedItems: 2,
            totalItems: 2,
            complete: true,
            created: false,
          });
          expect(await fixture.transcript()).toHaveLength(3);
        } else {
          expect(response).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: "session is shared for this connection",
            }),
          );
          expect(await fixture.transcript()).toEqual([]);
        }
      }, true);
    },
  );
});
