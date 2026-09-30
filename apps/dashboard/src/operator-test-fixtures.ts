import { api, type Api } from "./api";
import { ownedStorage, roleCapabilities } from "./operator";
import type { AuthMethods, OperatorSession, Role } from "./operator";
export const methodsFixture: AuthMethods = {
  installation_id: "install_fixture",
  local: true,
  bootstrap: false,
  recovery: true,
  oidc: false,
};
export function sessionFixture(
  role: Role = "admin",
  id = "op_fixture",
): OperatorSession {
  return {
    actor_id: id,
    session_id: "os_fixture",
    authentication_method: "local",
    capabilities: [...roleCapabilities[role]],
    csrf_token: "fixture_csrf",
    expires_at: Date.now() + 28_800_000,
    recovery_reason: null,
    operator: {
      id,
      name: "Fixture Operator",
      sign_in_name: "fixture",
      role,
      state: "active",
      revision: 1,
      authentication_method: "local",
      created_at: 1,
      last_sign_in_at: 1,
    },
  };
}
export function authenticateFixture(
  client: Api = api,
  session = sessionFixture(),
) {
  client.clear();
  client.methods = { ...methodsFixture };
  client.acceptSession(session);
}
export const operatorStorage: Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> = {
  getItem: (key) =>
    ownedStorage(sessionStorage, api.requireOwner()).getItem(key),
  setItem: (key, value) =>
    ownedStorage(sessionStorage, api.requireOwner()).setItem(key, value),
  removeItem: (key) =>
    ownedStorage(sessionStorage, api.requireOwner()).removeItem(key),
};
