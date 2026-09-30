import { validOptionalActor } from "./ActorAttribution";
import { checkPath } from "./addresses";
import { api, ApiError, definitiveMutationFailure, mutation } from "./api";
import type { Mutation } from "./api";
import type { Provider, Version } from "./types";

export interface ProviderFields {
  siteKey: string;
  secret: string;
  clearSecret: boolean;
}
export interface ProviderCandidate {
  revision: number;
  provider: Provider["provider"];
  enabled: boolean;
  config: { site_key?: string; secret?: string | null };
}
export interface ProviderTest {
  status: string;
  checked_at: number;
  message: string;
  test_token: string | null;
}
export interface ProviderReview {
  enabled: boolean;
  dependentsToken: string;
  checks: { name: string; version: Version }[];
}
interface ProviderFormState {
  server: Provider;
  fields: ProviderFields;
  test: ProviderTest | null;
  review: ProviderReview | null;
  phase: "idle" | "testing" | "reviewing" | "saving" | "refreshing";
  pending: Mutation | null;
  error: string | null;
  notice: string | null;
  conflict: boolean;
  conflictLoaded: boolean;
  needsRefresh: boolean;
}
function fields(provider: Provider): ProviderFields {
  return {
    siteKey:
      typeof provider.config.site_key === "string"
        ? provider.config.site_key
        : "",
    secret: "",
    clearSecret: false,
  };
}
function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "revision_conflict")
      return "This provider was changed elsewhere. Review its latest configuration before continuing.";
    if (
      error.code === "dependent_checks_changed" ||
      error.code === "dependent_checks"
    )
      return "The affected published checks changed. Review their current policies before saving.";
    if (error.status === 401)
      return "Sign in again, then retry. Your entered configuration remains here.";
    if (error.status === 400 || error.status === 422)
      return "The configuration or its test was rejected. Check the entered values and test again.";
    if (error.status === 429)
      return "Too many requests. Wait briefly, then retry.";
  }
  // Never display request bodies or arbitrary exception text around secret fields.
  return "Could not complete the request. Your entered configuration remains here.";
}
function validProvider(value: unknown): value is Provider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Provider;
  return (
    ((provider.capability === "verification" &&
      provider.provider === "turnstile") ||
      (provider.capability === "ip_intelligence" &&
        provider.provider === "proxycheck")) &&
    validOptionalActor(provider.created_by) &&
    typeof provider.enabled === "boolean" &&
    Number.isSafeInteger(provider.revision) &&
    provider.revision >= 0 &&
    provider.config !== null &&
    typeof provider.config === "object" &&
    !Array.isArray(provider.config) &&
    Object.entries(provider.config).every(
      ([key, value]) =>
        provider.capability === "verification" &&
        key === "site_key" &&
        typeof value === "string",
    ) &&
    typeof provider.has_secret === "boolean" &&
    typeof provider.status === "string" &&
    typeof provider.message === "string" &&
    (provider.checked_at === null ||
      Number.isSafeInteger(provider.checked_at)) &&
    Array.isArray(provider.dependent_checks) &&
    provider.dependent_checks.every((name) => typeof name === "string") &&
    Array.isArray(provider.dependent_versions) &&
    provider.dependent_versions.every(
      (check) =>
        check &&
        typeof check.check === "string" &&
        Number.isSafeInteger(check.version) &&
        check.version > 0,
    ) &&
    typeof provider.dependents_token === "string" &&
    Boolean(provider.dependents_token)
  );
}

/** Candidate secrets and frozen retries live only in this mounted form's memory. */
export class ProviderForm {
  private state: ProviderFormState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private alive = true;
  constructor(provider: Provider) {
    this.state = {
      server: provider,
      fields: fields(provider),
      test: null,
      review: null,
      phase: "idle",
      pending: null,
      error: null,
      notice: null,
      conflict: false,
      conflictLoaded: false,
      needsRefresh: false,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  private update(change: Partial<ProviderFormState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  get dirty() {
    const initial = fields(this.state.server);
    return (
      this.state.fields.siteKey !== initial.siteKey ||
      this.state.fields.secret !== "" ||
      this.state.fields.clearSecret ||
      this.state.test !== null ||
      this.state.pending !== null
    );
  }
  get locked() {
    return (
      this.state.pending !== null ||
      this.state.needsRefresh ||
      this.state.phase === "refreshing"
    );
  }
  observe(provider: Provider) {
    if (provider.revision <= this.state.server.revision) return;
    ++this.generation;
    const dirty = this.dirty;
    this.update({
      server: provider,
      test: null,
      review: null,
      ...(!this.state.pending ? { phase: "idle" } : {}),
      ...(dirty
        ? { conflict: true, conflictLoaded: true }
        : { fields: fields(provider) }),
    });
  }
  edit(change: Partial<ProviderFields>) {
    if (this.locked) return;
    ++this.generation;
    this.update({
      fields: { ...this.state.fields, ...change },
      test: null,
      review: null,
      phase: "idle",
      error: null,
      notice: null,
    });
  }
  candidate(enabled = true): ProviderCandidate {
    const { server, fields } = this.state;
    return {
      revision: server.revision,
      provider: server.provider,
      enabled,
      config: {
        ...(server.capability === "verification"
          ? { site_key: fields.siteKey }
          : {}),
        ...(fields.clearSecret
          ? { secret: null }
          : fields.secret
            ? { secret: fields.secret }
            : {}),
      },
    };
  }
  validation(): string | null {
    const { server, fields } = this.state;
    if (
      server.capability === "verification" &&
      !/^[a-zA-Z0-9_-]{1,256}$/.test(fields.siteKey)
    )
      return "Enter a Turnstile site key using letters, numbers, underscores or hyphens.";
    if (
      server.capability === "verification" &&
      !fields.secret &&
      !server.has_secret
    )
      return "Enter the Turnstile secret key.";
    if (fields.secret && !/^[\x21-\x7e]{1,1024}$/.test(fields.secret))
      return "Use a secret key of up to 1,024 characters without spaces.";
    return null;
  }
  get tested() {
    const test = this.state.test;
    return Boolean(
      test?.test_token &&
        ["ready", "configuration_checked"].includes(test.status) &&
        test.checked_at + 600_000 > Date.now(),
    );
  }
  async test() {
    if (this.locked || this.state.conflict) return;
    const error = this.validation();
    if (error) {
      this.update({ error });
      return;
    }
    const generation = ++this.generation;
    const operation = mutation(
      `/providers/${this.state.server.capability}/tests`,
      this.candidate(),
    );
    this.update({
      phase: "testing",
      test: null,
      review: null,
      error: null,
      notice: null,
    });
    try {
      const result = await api.run<ProviderTest>(operation);
      if (generation !== this.generation) return;
      this.update({ phase: "idle", test: result });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.update({
        phase: "idle",
        error: message(cause),
        conflict:
          cause instanceof ApiError && cause.code === "revision_conflict",
        conflictLoaded: false,
      });
    }
  }
  private async current(): Promise<Provider> {
    const result = await api.get<{ items: Provider[] }>("/providers");
    const provider = result?.items?.find(
      (item) => item.capability === this.state.server.capability,
    );
    if (!validProvider(provider))
      throw new Error("Provider review contract unavailable");
    return provider;
  }
  async review(enabled: boolean) {
    if (this.locked || this.state.conflict) return;
    if (enabled && !this.tested) {
      this.update({
        test: null,
        review: null,
        error:
          "Test this configuration before saving. Tests expire after 10 minutes.",
      });
      return;
    }
    const generation = ++this.generation;
    const revision = this.state.server.revision;
    this.update({
      phase: "reviewing",
      review: null,
      error: null,
      notice: null,
    });
    try {
      const current = await this.current();
      if (generation !== this.generation) return;
      if (current.revision !== revision) {
        this.update({
          server: current,
          phase: "idle",
          test: null,
          conflict: true,
          conflictLoaded: true,
          error:
            "This provider was changed elsewhere. Review its latest configuration before continuing.",
        });
        return;
      }
      const checks: ProviderReview["checks"] = [];
      for (
        let offset = 0;
        offset < current.dependent_versions.length;
        offset += 4
      ) {
        const batch = await Promise.all(
          current.dependent_versions
            .slice(offset, offset + 4)
            .map(async (check) => {
              const version = await api.get<Version>(
                checkPath(check.check, `/versions/${check.version}`),
              );
              if (version.version !== check.version)
                throw new Error("Unexpected policy version");
              return { name: check.check, version };
            }),
        );
        if (generation !== this.generation) return;
        checks.push(...batch);
      }
      this.update({
        server: current,
        phase: "idle",
        review: { enabled, checks, dependentsToken: current.dependents_token },
      });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.update({
        phase: "idle",
        review: null,
        error:
          "Could not load the affected published policies. Retry the review before saving.",
      });
    }
  }
  cancelReview() {
    if (this.locked) return;
    ++this.generation;
    this.update({ phase: "idle", review: null, error: null });
  }
  async save() {
    if (this.state.phase === "saving" || this.state.needsRefresh) return;
    let operation = this.state.pending;
    if (!operation) {
      const review = this.state.review;
      if (!review || this.state.conflict) return;
      if (review.enabled && !this.tested) {
        this.update({
          test: null,
          review: null,
          error:
            "This test has expired. Test the configuration again before saving.",
        });
        return;
      }
      operation = mutation(
        `/providers/${this.state.server.capability}`,
        {
          ...(review.enabled
            ? this.candidate()
            : {
                revision: this.state.server.revision,
                provider: this.state.server.provider,
                enabled: false,
                config: {},
              }),
          ...(review.enabled
            ? { test_token: this.state.test!.test_token }
            : {}),
          acknowledge_dependents: true,
          reviewed_dependents_token: review.dependentsToken,
        },
        "PUT",
      );
    }
    ++this.generation;
    this.update({
      phase: "saving",
      pending: operation,
      error: null,
      notice: null,
    });
    let saved: Provider;
    try {
      const result = await api.run<unknown>(operation);
      const candidate = operation.body as ProviderCandidate;
      if (
        !validProvider(result) ||
        result.capability !== this.state.server.capability ||
        result.provider !== candidate.provider ||
        result.revision !== candidate.revision + 1 ||
        result.enabled !== candidate.enabled
      )
        throw new ApiError(
          200,
          "invalid_response",
          "The save acknowledgement could not be read.",
        );
      saved = result;
    } catch (cause) {
      const certain = definitiveMutationFailure(cause);
      const conflict =
        cause instanceof ApiError && cause.code === "revision_conflict";
      const changed =
        cause instanceof ApiError &&
        ["dependent_checks_changed", "dependent_checks"].includes(cause.code);
      this.update({
        phase: "idle",
        error:
          cause instanceof ApiError && cause.status === 401
            ? "Sign in again, then retry this same save. Its original configuration remains here."
            : certain
              ? message(cause)
              : "The save result is unknown. Retry this same save to recover its result before making another change.",
        ...(certain
          ? {
              pending: null,
              review: null,
              conflict,
              conflictLoaded: false,
              ...(!changed ? { test: null } : {}),
            }
          : {}),
      });
      return;
    }
    if (!this.alive) return;
    // A replay may acknowledge an older revision. Never present it as current.
    const known =
      saved.revision >= this.state.server.revision ? saved : this.state.server;
    this.update({
      server: known,
      fields: fields(known),
      pending: null,
      test: null,
      review: null,
      phase: "refreshing",
      conflict: false,
      conflictLoaded: false,
      needsRefresh: true,
      notice: "Change saved. Checking the current configuration…",
    });
    try {
      const current = await this.current();
      if (current.revision < known.revision)
        throw new Error("Stale configuration read");
      const latest = current.revision >= known.revision ? current : known;
      this.update({
        server: latest,
        fields: fields(latest),
        phase: "idle",
        needsRefresh: false,
        notice:
          latest.revision > saved.revision
            ? "Your change was saved, then replaced by a newer configuration. The current configuration is shown."
            : latest.enabled
              ? "Configuration saved for new attempts."
              : "Provider disconnected for new attempts.",
      });
    } catch {
      this.update({
        phase: "idle",
        notice:
          "Your change was saved, but the current configuration could not be refreshed.",
        error:
          "Refresh the current configuration before making another change.",
      });
    }
  }
  async refresh() {
    if (this.state.pending || this.state.phase === "refreshing") return;
    const generation = ++this.generation;
    this.update({ phase: "refreshing", error: null });
    try {
      const current = await this.current();
      if (generation !== this.generation) return;
      if (current.revision < this.state.server.revision)
        throw new Error("Stale configuration read");
      this.update({
        server: current,
        phase: "idle",
        needsRefresh: false,
        test: null,
        review: null,
        conflict: this.dirty,
        conflictLoaded: true,
        ...(this.dirty ? {} : { fields: fields(current) }),
        notice: null,
      });
    } catch {
      if (generation !== this.generation) return;
      this.update({
        phase: "idle",
        error:
          "Could not refresh the current provider configuration. Retry when Krine is available.",
      });
    }
  }
  reconcile(keepEntered: boolean) {
    if (this.locked || (this.state.conflict && !this.state.conflictLoaded))
      return;
    ++this.generation;
    this.update({
      conflict: false,
      test: null,
      review: null,
      error: null,
      notice: null,
      ...(!keepEntered ? { fields: fields(this.state.server) } : {}),
    });
  }
  discard() {
    if (this.state.pending) return;
    ++this.generation;
    this.update({
      fields: fields(this.state.server),
      test: null,
      review: null,
      phase: "idle",
      error: null,
      notice: null,
    });
  }
  activate() {
    this.alive = true;
  }
  dispose() {
    this.alive = false;
    this.state = { ...this.state, fields: fields(this.state.server), pending: null, test: null, review: null };
    ++this.generation;
    this.listeners.clear();
  }
}
