import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CheckRequest, EventRequest, ResolvedContext, Verification } from '@krine/protocol';
import type { CheckResult, PendingCheck } from '@krine/server';
import type { PublicAttempt, TrialResult } from './contracts.js';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secret = (): string => randomBytes(32).toString('hex');
export interface Account { id: string; name: string; salt: string; password_hash: string }
export interface Session { user_id: string; csrf: string; expires_at: number }
export interface Attempt {
  id: string;
  user_id: string;
  intent_id: string;
  input_hash: string;
  request: CheckRequest;
  created_at: number;
  state: PublicAttempt['status'];
  context: ResolvedContext | null;
  associated: boolean;
  event_sent: boolean;
  pending: PendingCheck | null;
  evaluation: CheckResult | null;
  verification: Verification | null;
  result: TrialResult | null;
  error: string | null;
  recovery: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dataDir).isDirectory() || (lstatSync(dataDir).mode & 0o077) !== 0) {
      throw new Error('DEMO_DATA_DIR must be a private directory (mode 0700).');
    }
    const path = join(dataDir, 'application.sqlite');
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('The database must be a regular file.');
    this.db = new DatabaseSync(path, { timeout: 0 });
    chmodSync(path, 0o600);
    try {
      // The OS lock spans awaits; process exit or a crash releases it.
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), intent_id TEXT NOT NULL,
          input_hash TEXT NOT NULL, request TEXT NOT NULL, created_at INTEGER NOT NULL,
          state TEXT NOT NULL, progress TEXT NOT NULL, UNIQUE(user_id, intent_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS active_attempt ON attempts(user_id) WHERE state IN ('preparing','checking','pending');
        CREATE TRIGGER IF NOT EXISTS immutable_attempt BEFORE UPDATE OF id,user_id,intent_id,input_hash,request,created_at ON attempts
        BEGIN SELECT RAISE(ABORT, 'Attempt inputs are immutable'); END;
        CREATE TABLE IF NOT EXISTS trials (
          user_id TEXT PRIMARY KEY REFERENCES accounts(id), attempt_id TEXT UNIQUE NOT NULL REFERENCES attempts(id),
          trial_until INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS outbox (
          event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, next_at INTEGER NOT NULL,
          retry_until INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS login_limits (
          key TEXT PRIMARY KEY, window_until INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;
        COMMIT;`);
      chmodSync(`${path}-wal`, 0o600);
      this.provision(dataDir);
    } catch (error) { this.db.close(); throw error; }
  }

  private provision(dataDir: string): void {
    if ((this.db.prepare('SELECT count(*) AS n FROM accounts').get()!.n as number) > 0) return;
    const path = join(dataDir, 'accounts.json');
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(['ada', 'ben', 'cora'].map(name => ({ name, password: secret() })), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!lstatSync(path).isFile() || (lstatSync(path).mode & 0o077) !== 0) throw new Error('accounts.json must be a private regular file.');
    const accounts: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(accounts) || accounts.length !== 3 || accounts.some((a: unknown) => !a || typeof a !== 'object'
      || !('name' in a) || !['ada', 'ben', 'cora'].includes(String(a.name)) || !('password' in a)
      || typeof a.password !== 'string' || a.password.length < 24 || a.password.length > 128)
      || new Set(accounts.map(a => a.name)).size !== 3) throw new Error('Invalid demo accounts.json.');
    this.transaction(() => {
      for (const account of accounts as { name: string; password: string }[]) {
        const salt = secret();
        this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?)').run(randomUUID(), account.name, salt, scryptSync(account.password, salt, 64).toString('hex'));
      }
    });
  }

  account(name: string): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE name=?').get(name) as unknown as Account | undefined;
  }
  accountName(id: string): string { return this.db.prepare('SELECT name FROM accounts WHERE id=?').get(id)!.name as string; }
  trial(id: string): number | null { return (this.db.prepare('SELECT trial_until FROM trials WHERE user_id=?').get(id)?.trial_until as number | undefined) ?? null; }
  attempt(id: string, userId: string): Attempt | null {
    return decode(this.db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(id, userId));
  }
  byIntent(intent: string, userId: string): Attempt | null {
    return decode(this.db.prepare('SELECT * FROM attempts WHERE intent_id=? AND user_id=?').get(intent, userId));
  }
  latest(userId: string): Attempt | null {
    return decode(this.db.prepare('SELECT * FROM attempts WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(userId));
  }
  insert(attempt: Attempt): void {
    this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)').run(attempt.id, attempt.user_id, attempt.intent_id,
      attempt.input_hash, JSON.stringify(attempt.request), attempt.created_at, attempt.state, progress(attempt));
  }
  save(attempt: Attempt): void {
    this.db.prepare('UPDATE attempts SET state=?,progress=? WHERE id=?').run(attempt.state, progress(attempt), attempt.id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(event: EventRequest, now: number): void {
    this.db.prepare('INSERT INTO outbox(event_id,payload,next_at,retry_until) VALUES(?,?,?,?)').run(event.event_id, JSON.stringify(event), now, now + 86_400_000);
  }
  close(): void { this.db.close(); }
}

function progress(a: Attempt): string {
  return JSON.stringify({ context: a.context, associated: a.associated, event_sent: a.event_sent, pending: a.pending,
    evaluation: a.evaluation, verification: a.verification, result: a.result, error: a.error, recovery: a.recovery });
}
function decode(row: Record<string, unknown> | undefined): Attempt | null {
  if (!row) return null;
  return { ...row, request: JSON.parse(row.request as string),
    ...JSON.parse(row.progress as string) } as Attempt;
}
