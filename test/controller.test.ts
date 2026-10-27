import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardController } from '../src/host/controller.js';
import { createDemoSnapshot } from '../src/shared/demo.js';

class FakeClock {
  tick = 1_000;
  tasks = new Map<number, { at: number; fn: () => void }>();
  id = 0;
  now = () => this.tick;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.tick + ms, fn }); return id; };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) {
    this.tick += ms;
    for (const [id, task] of [...this.tasks]) if (task.at <= this.tick) { this.tasks.delete(id); task.fn(); }
  }
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('coalesces refresh and rejects late results from a previous repository', async () => {
  const pending: { repo: string; signal: AbortSignal; resolve: (value: ReturnType<typeof createDemoSnapshot>) => void }[] = [];
  const controller = new DashboardController((repo, viewer, signal) => new Promise(resolve => pending.push({ repo, signal, resolve })), () => {});
  controller.setRepository('first/repo');
  const first = controller.refresh();
  const repeated = controller.refresh();
  await flush();
  assert.equal(pending.length, 1);
  controller.setRepository('second/repo');
  assert.equal(pending[0].signal.aborted, true);
  const second = controller.refresh();
  await flush();
  pending[1].resolve({ ...createDemoSnapshot(), demo: false, repository: 'second/repo' });
  await second;
  pending[0].resolve({ ...createDemoSnapshot(), demo: false, repository: 'first/repo' });
  await Promise.all([first, repeated]);
  assert.equal(controller.state.snapshot?.repository, 'second/repo');
  assert.equal(controller.state.loading, false);
  controller.dispose();
});

test('auto refresh requires visibility and focus, pauses while hidden and resumes when stale', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async repository => { calls++; return { ...createDemoSnapshot(), repository, demo: false }; }, () => {}, 'en', clock);
  controller.setRepository('owner/repo');
  clock.advance(500_000); await flush();
  assert.equal(calls, 0);
  controller.setVisibility(true, false);
  assert.equal(clock.tasks.size, 0);
  controller.setVisibility(true, true);
  clock.advance(0); await flush();
  assert.equal(calls, 1);
  clock.advance(119_000); await flush();
  assert.equal(calls, 1);
  controller.setVisibility(false, true);
  clock.advance(300_000); await flush();
  assert.equal(calls, 1);
  controller.setVisibility(true, true);
  clock.advance(0); await flush();
  assert.equal(calls, 2);
  controller.configure(false, 60);
  assert.equal(clock.tasks.size, 0);
  controller.dispose();
});

test('rate-limit backoff covers manual refresh and keeps the last successful snapshot', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async repository => {
    calls++;
    if (calls > 1) throw Object.assign(new Error('API rate limited'), { status: 429, retryAt: clock.now() + 90_000 });
    return { ...createDemoSnapshot(), repository, demo: false };
  }, () => {}, 'en', clock);
  controller.setRepository('owner/repo');
  await controller.refresh();
  const snapshot = controller.state.snapshot;
  await controller.refresh();
  assert.equal(controller.state.snapshot, snapshot);
  assert.match(controller.state.error!, /rate limited/);
  await controller.refresh();
  assert.equal(calls, 2);
  clock.advance(90_000);
  await controller.refresh();
  assert.equal(calls, 3);
  controller.dispose();
});

test('changing session clears private snapshot even for the same GitHub login', async () => {
  const controller = new DashboardController(async () => ({ ...createDemoSnapshot(), demo: false }), () => {});
  controller.setRepository('owner/repo');
  controller.setIdentity('alice', 'session-1');
  await controller.refresh();
  assert.ok(controller.state.snapshot);
  controller.setIdentity('alice', 'session-2');
  assert.equal(controller.state.snapshot, null);
  controller.showDemo(createDemoSnapshot('alice'));
  assert.equal((controller.state.snapshot as ReturnType<typeof createDemoSnapshot> | null)?.demo, true);
  controller.setIdentity(null);
  assert.equal((controller.state.snapshot as ReturnType<typeof createDemoSnapshot> | null)?.demo, true);
  controller.dispose();
});

test('demo never causes automatic or manual GitHub collection', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async () => { calls++; return createDemoSnapshot(); }, () => {}, 'en', clock);
  controller.setVisibility(true, true);
  controller.showDemo(createDemoSnapshot());
  clock.advance(999_999); await flush();
  await controller.refresh();
  assert.equal(calls, 0);
  controller.setRepository('owner/repo');
  assert.equal(controller.state.snapshot, null);
  controller.dispose();
});

test('ordinary network failure delays automatic retry but allows immediate manual retry', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async () => {
    if (++calls === 1) throw new Error('Offline');
    return { ...createDemoSnapshot(), demo: false };
  }, () => {}, 'en', clock);
  controller.setRepository('owner/repo');
  controller.setVisibility(true, true);
  await controller.refresh();
  assert.equal(controller.state.retryAt, null);
  clock.advance(30_000); await flush();
  assert.equal(calls, 1);
  await controller.refresh();
  assert.equal(calls, 2);
  assert.equal(controller.state.error, null);
  controller.dispose();
});

test('successful final allowance preserves snapshot and exposes server cooldown', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async () => { calls++; return { ...createDemoSnapshot(), demo: false }; }, () => {}, 'en', clock, () => clock.now() + 60_000);
  controller.setRepository('owner/repo');
  await controller.refresh();
  assert.ok(controller.state.snapshot);
  assert.equal(controller.state.retryAt, clock.now() + 60_000);
  await controller.refresh();
  assert.equal(calls, 1);
  controller.dispose();
});

test('a delayed silent identity restore cannot exit the offline demo or start collection', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const controller = new DashboardController(async () => { calls++; return createDemoSnapshot(); }, () => {}, 'en', clock);
  controller.setVisibility(true, true);
  controller.showDemo(createDemoSnapshot());
  controller.setIdentity('alice', 'restored-session:2');
  clock.advance(300_000); await flush();
  assert.equal(controller.state.snapshot?.demo, true);
  assert.equal(controller.state.account, 'alice');
  assert.equal(calls, 0);
  controller.dispose();
});
