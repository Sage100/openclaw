import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../server-constants.js";
import type { GatewayClientRegistry } from "./client-registry.js";

function hasAuthenticatedControlUiIdentity(clients: GatewayClientRegistry): boolean {
  return [...clients].some(
    (client) =>
      !client.invalidated &&
      client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
      client.internal?.authenticatedControlUi === true &&
      Boolean(client.authenticatedUserId || client.authenticatedUserProfile) &&
      authorizeOperatorScopesForMethod(
        "sessions.create",
        Array.isArray(client.connect.scopes) ? client.connect.scopes : [],
      ).allowed &&
      isBrowserOperatorUiClient(client.connect.client),
  );
}

/** Projects the live authenticated Control UI identity set independently of TTL presence rows. */
export function createAuthenticatedControlUiPresenceProjection(
  clients: GatewayClientRegistry,
  onChanged: (present: boolean) => void,
) {
  let present = hasAuthenticatedControlUiIdentity(clients);
  const unsubscribe = clients.subscribe(() => {
    const next = hasAuthenticatedControlUiIdentity(clients);
    if (next !== present) {
      present = next;
      onChanged(next);
    }
  });
  return { current: () => present, stop: unsubscribe };
}
