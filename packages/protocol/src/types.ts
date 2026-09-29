export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Scalar = boolean | number | string;

export interface Signals {
  language?: string;
  timezone?: string;
  platform?: string;
  screen_width?: number;
  screen_height?: number;
  hardware_concurrency?: number;
  fingerprint?: string;
  webdriver?: boolean;
}

export interface ContextCredentials {
  client_token: string;
  session_token: string;
}

/** Resolve continuous participation credentials, or the context of an exact protected interaction. */
export type ContextResolutionRequest = (ContextCredentials & { interaction?: never })
  | { interaction: { proof: string; check: string; ip: string }; client_token?: never; session_token?: never };

export interface ResolvedContext {
  client_id: string;
  session_id: string;
  expires_at: number;
}

export interface BrowserContext extends ContextCredentials, ResolvedContext {}

export interface PreparedAction {
  proof: string;
  expires_at: number;
  client_id: string;
  session_id: string;
}

export interface Challenge {
  challenge_id: string;
  provider: 'turnstile';
  site_key: string;
  action: string;
  binding: string;
  expires_at: number;
}

export interface Verification {
  challenge_id: string;
  token: string;
}

export interface CheckRequest {
  operation_id: string;
  check: string;
  proof: string;
  ip: string;
  user_id?: string;
  inputs?: Record<string, Scalar>;
}

export interface DecisionBase {
  operation_id: string;
  decision_id: string;
  source: 'evaluation';
  check: string;
  policy_version: number;
  accepted_at: number;
  retry_until: number;
  reason: string;
}

export type Evaluation = DecisionBase & (
  | { outcome: 'ALLOW' | 'DENY'; challenge?: never }
  | { outcome: 'CHALLENGE_REQUIRED'; challenge: Challenge }
);

export interface EventRequest {
  event_id: string;
  name: string;
  occurred_at?: number;
  user_id?: string;
  client_id?: string;
  session_id?: string;
  ip?: string;
  properties?: Record<string, Json>;
}

export interface EventReceipt {
  event_id: string;
  accepted_at: number;
  duplicate: boolean;
}

export interface AssociationRequest {
  association_id: string;
  client_id: string;
  user_id: string;
  session_id?: string | null;
  metadata?: Record<string, Json>;
}

export interface Association {
  association_id: string;
  client_id: string;
  user_id: string;
  created_at: number;
  revoked_at: number | null;
  session_id?: string | null;
  credential_id?: string | null;
  revision?: number;
  revocation_reason?: string | null;
  revoked_by?: string | null;
  provenance: 'backend';
  metadata: Record<string, Json>;
}
