import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityCoordinator, type IdentitySession, type IdentityRequestOptions } from '../src/host/identity.js';

const session = (id = 'one', token = `token-${id}`, login = 'alice'): IdentitySession => ({
  id, accessToken: token, account: { id: login, label: login },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const options = { interactive: true, privateAccess: false };

test('switch account clears the preference instead of forcing the old account to reauthenticate', async () => {
  const requests: Array<{ scopes: string[]; options: IdentityRequestOptions }> = [];
  const bindings: Array<{ login: string | null; generation: number }> = [];
  const identity = new IdentityCoordinator({
    requestSession: async (scopes, request) => { requests.push({ scopes, options: request }); return session(); },
    verify: async () => 'alice',
    apply: (_session, login, generation) => bindings.push({ login, generation }),
  });
  await identity.connect({ ...options, switchAccount: true });
  assert.deepEqual(requests, [{ scopes: ['read:user'], options: { createIfNone: true, clearSessionPreference: true } }]);
  assert.equal(bindings[0]?.login, 'alice');
  identity.dispose();
});

test('silent restore never requests an interactive login and private scope is explicit', async () => {
  const requests: Array<{ scopes: string[]; options: IdentityRequestOptions }> = [];
  const identity = new IdentityCoordinator({
    requestSession: async (scopes, request) => { requests.push({ scopes, options: request }); return undefined; },
    verify: async () => { throw new Error('Should not verify'); },
    apply: () => {},
  });
  await identity.connect({ interactive: false, privateAccess: false });
  await identity.connect({ interactive: true, privateAccess: true });
  assert.deepEqual(requests, [
    { scopes: ['read:user'], options: { silent: true } },
    { scopes: ['read:user', 'repo'], options: { createIfNone: true } },
  ]);
  identity.dispose();
});

test('a removed session cannot be committed after a pending session request resolves', async () => {
  const requested = deferred<IdentitySession | undefined>();
  const original = session();
  const applied: Array<string | null> = [];
  let requests = 0;
  let verifies = 0;
  const identity = new IdentityCoordinator({
    requestSession: async () => ++requests === 1 ? requested.promise : undefined,
    verify: async () => { verifies++; return 'alice'; },
    apply: (_session, login) => applied.push(login),
  });
  const connection = identity.connect(options);
  identity.sessionsChanged({ removed: [original] });
  requested.resolve(original);
  await connection;
  assert.equal(verifies, 0);
  assert.deepEqual(applied, [null]);
  assert.equal(requests, 2);
  identity.dispose();
});

test('removing a session during verification cancels it immediately and rejects late verification', async () => {
  const verify = deferred<string>();
  const original = session();
  const applied: Array<string | null> = [];
  let signal!: AbortSignal;
  let requests = 0;
  const identity = new IdentityCoordinator({
    requestSession: async () => ++requests === 1 ? original : undefined,
    verify: async (_token, nextSignal) => { signal = nextSignal; return verify.promise; },
    apply: (_session, login) => applied.push(login),
  });
  const connection = identity.connect(options);
  await flush();
  identity.sessionsChanged({ removed: [original] });
  assert.equal(signal.aborted, true);
  assert.deepEqual(applied, [null]);
  verify.resolve('alice');
  await connection;
  assert.ok(applied.every(login => login === null));
  identity.dispose();
});

test('signing out an established session clears its identity before the silent check resolves', async () => {
  const next = deferred<IdentitySession | undefined>();
  const original = session();
  const applied: Array<string | null> = [];
  let requests = 0;
  const identity = new IdentityCoordinator({
    requestSession: async () => ++requests === 1 ? original : next.promise,
    verify: async () => 'alice',
    apply: (_session, login) => applied.push(login),
  });
  await identity.connect(options);
  identity.sessionsChanged({ removed: [original] });
  assert.deepEqual(applied, ['alice', null]);
  next.resolve(undefined);
  await flush();
  assert.equal(applied.at(-1), null);
  identity.dispose();
});

test('token changes during verification cancel old verification and verify the updated token silently', async () => {
  const original = session('one', 'old');
  const updated = session('one', 'new');
  const verified = deferred<string>();
  const calls: string[] = [];
  const applied: Array<{ token: string | null; login: string | null }> = [];
  const requests: IdentityRequestOptions[] = [];
  const identity = new IdentityCoordinator({
    requestSession: async (_scopes, request) => { requests.push(request); return requests.length === 1 ? original : updated; },
    verify: async (token, signal) => {
      calls.push(token);
      if (token === 'old') {
        signal.addEventListener('abort', () => verified.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
        return verified.promise;
      }
      return 'alice';
    },
    apply: (next, login) => applied.push({ token: next?.accessToken ?? null, login }),
  });
  const connection = identity.connect(options);
  await flush();
  identity.sessionsChanged({ changed: [updated] });
  await connection;
  assert.deepEqual(calls, ['old', 'new']);
  assert.deepEqual(requests, [{ createIfNone: true }, { silent: true }]);
  assert.deepEqual(applied, [{ token: null, login: null }, { token: 'new', login: 'alice' }]);
  identity.dispose();
});

test('normal added events during login do not cause duplicate authorization or repeated verification', async () => {
  const original = session();
  let identity!: IdentityCoordinator;
  let requests = 0;
  let verifies = 0;
  identity = new IdentityCoordinator({
    requestSession: async () => { requests++; identity.sessionsChanged({ added: [original] }); return original; },
    verify: async () => { verifies++; return 'alice'; },
    apply: () => {},
  });
  await identity.connect(options);
  assert.equal(requests, 1);
  assert.equal(verifies, 1);
  identity.dispose();
});

test('provider-only login events are reconciled once through a silent session check', async () => {
  const original = session();
  let identity!: IdentityCoordinator;
  const requests: IdentityRequestOptions[] = [];
  const applied: Array<string | null> = [];
  identity = new IdentityCoordinator({
    requestSession: async (_scopes, request) => {
      requests.push(request);
      if (requests.length === 1) identity.sessionsChanged();
      return original;
    },
    verify: async () => 'alice',
    apply: (_session, login) => applied.push(login),
  });
  await identity.connect(options);
  assert.deepEqual(requests, [{ createIfNone: true }, { silent: true }]);
  assert.deepEqual(applied, [null, 'alice']);
  identity.dispose();
});

test('provider-only logout during a pending login cannot restore a stale session', async () => {
  const requested = deferred<IdentitySession | undefined>();
  let requests = 0;
  let verified = 0;
  const applied: Array<string | null> = [];
  const identity = new IdentityCoordinator({
    requestSession: async () => ++requests === 1 ? requested.promise : undefined,
    verify: async () => { verified++; return 'alice'; },
    apply: (_session, login) => applied.push(login),
  });
  const connection = identity.connect(options);
  identity.sessionsChanged();
  requested.resolve(session());
  await connection;
  assert.equal(verified, 0);
  assert.ok(applied.every(login => login === null));
  identity.dispose();
});

test('failed verification never publishes an unverified session and clears the old identity', async () => {
  const original = session();
  const applied: Array<string | null> = [];
  let fail = false;
  const identity = new IdentityCoordinator({
    requestSession: async () => original,
    verify: async () => { if (fail) throw new Error('Verification failed'); return 'alice'; },
    apply: (_session, login) => applied.push(login),
  });
  await identity.connect(options);
  fail = true;
  await assert.rejects(identity.connect(options), /Verification failed/);
  assert.deepEqual(applied, ['alice', null]);
  identity.dispose();
});

test('reconnecting the same session publishes a new binding generation', async () => {
  const generations: number[] = [];
  const identity = new IdentityCoordinator({
    requestSession: async () => session(),
    verify: async () => 'alice',
    apply: (_session, login, generation) => { if (login) generations.push(generation); },
  });
  await identity.connect(options);
  await identity.connect(options);
  assert.equal(generations.length, 2);
  assert.ok(generations[1]! > generations[0]!);
  identity.dispose();
});

test('a newer connection supersedes pending verification without publishing a late identity', async () => {
  const pending = deferred<string>();
  let requests = 0;
  const applied: Array<string | null> = [];
  const identity = new IdentityCoordinator({
    requestSession: async () => ++requests === 1 ? session('old') : session('new', 'new-token', 'bob'),
    verify: async token => token === 'token-old' ? pending.promise : 'bob',
    apply: (_session, login) => applied.push(login),
  });
  const old = identity.connect(options);
  await flush();
  await identity.connect({ ...options, switchAccount: true });
  pending.resolve('alice');
  await old;
  assert.deepEqual(applied, ['bob']);
  identity.dispose();
});

test('unrelated session changes do not clear the connected account', async () => {
  let requests = 0;
  const applied: Array<string | null> = [];
  const identity = new IdentityCoordinator({
    requestSession: async () => { requests++; return session(); },
    verify: async () => 'alice',
    apply: (_session, login) => applied.push(login),
  });
  await identity.connect(options);
  identity.sessionsChanged({ removed: [session('other', 'other-token', 'bob')] });
  await flush();
  assert.equal(requests, 1);
  assert.deepEqual(applied, ['alice']);
  identity.dispose();
});

test('a repeatedly changing provider is bounded and never repeatedly prompts for login', async () => {
  let identity!: IdentityCoordinator;
  const requests: IdentityRequestOptions[] = [];
  identity = new IdentityCoordinator({
    requestSession: async (_scopes, request) => { requests.push(request); identity.sessionsChanged(); return session(); },
    verify: async () => 'alice',
    apply: () => {},
  });
  await assert.rejects(identity.connect(options), /session kept changing/);
  assert.deepEqual(requests, [{ createIfNone: true }, { silent: true }, { silent: true }]);
  identity.dispose();
});

test('dispose cancels pending verification and clears bindings without allowing late commits', async () => {
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const applied: Array<string | null> = [];
  const identity = new IdentityCoordinator({
    requestSession: async () => session(),
    verify: async (_token, nextSignal) => { signal = nextSignal; return pending.promise; },
    apply: (_session, login) => applied.push(login),
  });
  const connection = identity.connect(options);
  await flush();
  identity.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve('alice');
  await connection;
  identity.sessionsChanged();
  assert.deepEqual(applied, [null]);
});
