import {
  AvailabilityError, Transport, exactKeys, identifier, invalidInput, invalidResponse, ipAddress, jsonBody,
  parseEvaluation, record, string, timestamp, validateCheckRequest,
} from '@krine/protocol';
import type {
  Association, AssociationRequest, AvailabilityReason, CheckRequest, ContextResolutionRequest, Evaluation, EventReceipt,
  EventRequest, ResolvedContext, TransportOptions, Verification,
} from '@krine/protocol';

export { AvailabilityError, HttpError, KrineError } from '@krine/protocol';
export type { Association, AssociationRequest, Challenge, CheckRequest, ContextCredentials, ContextResolutionRequest, Evaluation, EventReceipt, EventRequest, ResolvedContext, Verification } from '@krine/protocol';

export type FallbackOutcome = 'ALLOW' | 'DENY';

export interface ServerOptions extends TransportOptions {
  secretKey: string;
  fallback?: FallbackOutcome;
  checkFallbacks?: Readonly<Record<string, FallbackOutcome>>;
}

/** Persist only in trusted application storage; this context contains the original proof. */
export interface PendingCheck {
  schema_version: 1;
  request: CheckRequest;
  decision_id: string;
  challenge_id: string;
  accepted_at: number;
  retry_until: number;
}

export interface FallbackResult {
  source: 'fallback';
  outcome: FallbackOutcome;
  reason: AvailabilityReason;
  operation_id: string;
  check: string;
}

export type EvaluatedResult = Evaluation extends infer E
  ? E extends { outcome: 'CHALLENGE_REQUIRED' } ? E & { pending: PendingCheck } : E
  : never;
export type CheckResult = EvaluatedResult | FallbackResult;

export class KrineServer {
  private readonly transport: Transport;
  private readonly fallback: FallbackOutcome;
  private readonly checkFallbacks: Readonly<Record<string, FallbackOutcome>>;

  constructor(options: ServerOptions) {
    if (!string(options.secretKey, 4096) || !/^[\x21-\x7e]+$/.test(options.secretKey)) invalidInput();
    this.fallback = options.fallback ?? 'ALLOW';
    this.checkFallbacks = { ...options.checkFallbacks };
    if (!fallbackOutcome(this.fallback) || !Object.entries(this.checkFallbacks)
      .every(([name, outcome]) => identifier(name) && fallbackOutcome(outcome))) invalidInput();
    this.transport = new Transport(options, { Authorization: `Bearer ${options.secretKey}` });
  }

  /** Resolve participation; bind interaction evidence to its proof when supplied. Never authorizes or falls back. */
  async resolveContext(request: ContextResolutionRequest): Promise<ResolvedContext> {
    const credentials: unknown = request;
    if (!record(credentials)) invalidInput();
    if (Object.hasOwn(credentials, 'interaction')) {
      if (!exactKeys(credentials, ['interaction']) || !record(credentials.interaction)
        || !exactKeys(credentials.interaction, ['proof', 'check', 'ip']) || !string(credentials.interaction.proof, 4096)
        || !identifier(credentials.interaction.check) || !ipAddress(credentials.interaction.ip)) invalidInput();
    } else if (!exactKeys(credentials, ['client_token', 'session_token'])
      || !string(credentials.client_token, 4096) || !string(credentials.session_token, 4096)) invalidInput();
    const result = await this.transport.post('/v1/contexts/resolve', jsonBody(credentials));
    if (!record(result) || !identifier(result.client_id) || !identifier(result.session_id)
      || !timestamp(result.expires_at)) invalidResponse();
    return { client_id: result.client_id, session_id: result.session_id, expires_at: result.expires_at };
  }

  /** Start or recover an attempt for which the application has never observed a challenge. */
  async check(request: CheckRequest): Promise<CheckResult> {
    validateCheckRequest(request);
    const body = jsonBody(request);
    const snapshot = JSON.parse(body) as CheckRequest;
    try {
      return withPending(parseEvaluation(await this.transport.post('/v1/checks/evaluate', body), snapshot), snapshot);
    } catch (error) {
      if (!(error instanceof AvailabilityError)) throw error;
      return {
        source: 'fallback', outcome: Object.hasOwn(this.checkFallbacks, snapshot.check)
          ? this.checkFallbacks[snapshot.check]! : this.fallback,
        reason: error.reason, operation_id: snapshot.operation_id, check: snapshot.check,
      };
    }
  }

  /** Resume trusted, persisted pending state. Availability failures throw; this never falls back. */
  async continueCheck(pending: PendingCheck, verification?: Verification): Promise<EvaluatedResult> {
    validatePending(pending);
    if (verification !== undefined && (!record(verification)
      || !exactKeys(verification, ['challenge_id', 'token'])
      || verification.challenge_id !== pending.challenge_id || !string(verification.token, 2048))) invalidInput();
    const body = jsonBody(verification === undefined ? pending.request : { ...pending.request, verification });
    const snapshot = JSON.parse(jsonBody(pending)) as PendingCheck;
    const result = parseEvaluation(await this.transport.post('/v1/checks/evaluate', body), snapshot.request);
    if (result.decision_id !== snapshot.decision_id || result.accepted_at !== snapshot.accepted_at
      || result.retry_until !== snapshot.retry_until) invalidResponse();
    return withPending(result, snapshot.request);
  }

  async event(request: EventRequest): Promise<EventReceipt> {
    if (!record(request) || !exactKeys(request, ['event_id', 'name', 'occurred_at', 'user_id', 'client_id', 'session_id', 'ip', 'properties'])
      || !identifier(request.event_id) || !identifier(request.name)
      || (request.occurred_at !== undefined && !timestamp(request.occurred_at))
      || (request.user_id !== undefined && !string(request.user_id, 256))
      || (request.client_id !== undefined && !identifier(request.client_id))
      || (request.session_id !== undefined && (!identifier(request.session_id) || request.client_id === undefined))
      || (request.ip !== undefined && !ipAddress(request.ip))
      || !(request.user_id || request.client_id || request.session_id || request.ip)) invalidInput();
    if (request.properties !== undefined) {
      if (!record(request.properties)) invalidInput();
      jsonBody(request.properties, 16_384, 1024);
    }
    const body = jsonBody(request);
    const expectedId = request.event_id;
    const result = await this.transport.post('/v1/events', body);
    if (!record(result) || result.event_id !== expectedId || !timestamp(result.accepted_at)
      || typeof result.duplicate !== 'boolean') invalidResponse();
    return result as unknown as EventReceipt;
  }

  async associate(request: AssociationRequest): Promise<Association> {
    if (!record(request) || !exactKeys(request, ['association_id', 'client_id', 'user_id', 'metadata', 'session_id'])
      || !identifier(request.association_id) || !identifier(request.client_id) || !string(request.user_id, 256)
      || (request.session_id != null && !identifier(request.session_id))) invalidInput();
    if (request.metadata !== undefined) {
      if (!record(request.metadata)) invalidInput();
      jsonBody(request.metadata, 16_384, 1024);
    }
    const body = jsonBody(request);
    const snapshot = JSON.parse(body) as AssociationRequest;
    const result = await this.transport.post('/v1/associations', body);
    if (!record(result) || result.association_id !== snapshot.association_id || result.client_id !== snapshot.client_id
      || result.user_id !== snapshot.user_id || !timestamp(result.created_at)
      || (result.revoked_at !== null && (!timestamp(result.revoked_at) || result.revoked_at < result.created_at))
      || (result.session_id != null && !identifier(result.session_id))
      || (snapshot.session_id != null && result.session_id !== snapshot.session_id)
      || (snapshot.session_id == null && result.session_id != null)
      || (result.credential_id != null && !identifier(result.credential_id))
      || (result.revision !== undefined && (!Number.isSafeInteger(result.revision) || (result.revision as number) < 1))
      || (result.revocation_reason != null && !string(result.revocation_reason, 512))
      || (result.revoked_by != null && !string(result.revoked_by, 128))
      || result.provenance !== 'backend' || !record(result.metadata)) invalidResponse();
    try { jsonBody(result.metadata, 16_384, 1024); } catch { invalidResponse(); }
    return result as unknown as Association;
  }
}

function fallbackOutcome(value: unknown): value is FallbackOutcome {
  return value === 'ALLOW' || value === 'DENY';
}

function validatePending(value: unknown): asserts value is PendingCheck {
  if (!record(value) || !exactKeys(value, ['schema_version', 'request', 'decision_id', 'challenge_id', 'accepted_at', 'retry_until'])
    || value.schema_version !== 1 || !identifier(value.decision_id) || !identifier(value.challenge_id)
    || !timestamp(value.accepted_at) || !timestamp(value.retry_until) || value.retry_until <= value.accepted_at) invalidInput();
  validateCheckRequest(value.request);
}

function withPending(result: Evaluation, request: CheckRequest): EvaluatedResult {
  if (result.outcome !== 'CHALLENGE_REQUIRED') return result;
  return {
    ...result,
    pending: {
      schema_version: 1 as const, request, decision_id: result.decision_id, challenge_id: result.challenge.challenge_id,
      accepted_at: result.accepted_at, retry_until: result.retry_until,
    },
  };
}
