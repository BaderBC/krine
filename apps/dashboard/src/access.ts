import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { Capability } from "./operator";
export function useAccess() {
  const state = useSyncExternalStore(api.subscribe, api.getSnapshot);
  return {
    ...state,
    can: (capability: Capability) =>
      Boolean(state.session?.capabilities.includes(capability)),
  };
}
