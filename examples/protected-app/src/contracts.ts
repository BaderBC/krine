import type { Challenge, Verification } from '@krine/protocol';

export const CHECK = 'can_claim_trial';
export interface TrialRequest { intent_id: string; proof: string }
export interface ContinueRequest { verification?: Verification }
export interface PublicAttempt {
  id: string;
  intent_id: string;
  status: 'preparing' | 'checking' | 'pending' | 'finished' | 'failed';
  challenge: Challenge | null;
  verification_submitted: boolean;
  result: TrialResult | null;
  error: string | null;
}
export interface TrialResult {
  outcome: 'ALLOW' | 'DENY';
  source: 'evaluation' | 'fallback';
  reason: string;
  operation_id: string;
  decision_id: string | null;
  policy_version: number | null;
  recovery: boolean;
  trial_until: number | null;
}
export interface SessionView {
  account: string;
  csrf: string;
  trial_until: number | null;
  attempt: PublicAttempt | null;
}
