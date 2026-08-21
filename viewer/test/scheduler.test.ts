/**
 * Admission: who runs now, who waits, and — the part that is easy to get
 * plausibly wrong — who is guaranteed to run eventually.
 *
 * The scheduler is pure bookkeeping with injected clocks and an injected view
 * of the locks on disk, so all of this is exercised without a repo, a child
 * process or a timer that anyone has to wait out.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted, MAX_BYPASS, AGING_MS } = await import('../server/runner/scheduler.ts');
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';

/** Let the microtask `admit()` schedules actually run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Has this admission genuinely not settled — the thing "still queued" means.
 *
 * Raced against a macrotask rather than a resolved promise: `Promise.race`
 * against `Promise.resolve()` reports *every* promise as pending, because an
 * already-fulfilled one still needs a microtask to deliver, and the marker is
 * ready first. That version passes whatever you assert, which is worse than
 * failing.
 */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = promise.then(() => 'settled' as const, () => 'settled' as const);
  const later = new Promise<symbol>((resolve) => setImmediate(() => resolve(marker)));
  return await Promise.race([settled, later]) === marker;
}

function scheduler(options: {
  max?: number; locks?: () => LockView[]; now?: () => number;
  scopeFor?: (slug: string, phase: number) => string[] | undefined;
  guard?: () => boolean;
} = {}) {
  return new Scheduler({
    max: options.max ?? 8,
    locks: options.locks ?? (() => []),
    now: options.now,
    scopeFor: options.scopeFor,
    guard: options.guard,
  });
}

test('two disjoint scopes are admitted together; an intersecting one waits for the release', async () => {
  const s = scheduler();

  const api = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const web = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'] });
  assert.equal(s.snapshot().live, 2, 'disjoint repos have no reason to serialise');

  const alsoApi = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['api'] });
  await tick();
  assert.ok(await pending(alsoApi), 'the same repo must serialise');

  const [entry] = s.snapshot().entries;
  assert.equal(entry.waitingOn[0].kind, 'grant');
  assert.equal(entry.waitingOn[0].slug, 'a', 'the queue says WHO it is waiting on');
  assert.deepEqual(entry.waitingOn[0].overlaps, ['api'], '…and on which token');

  s.release(api);
  assert.equal((await alsoApi).scope[0], 'api');
  s.release(web);
});

test('a blocked head does not stall a disjoint tail', async () => {
  const s = scheduler();
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  // Queued first, and blocked.
  const head = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  // Queued second, and disjoint from everything live.
  const tail = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  await tick();

  assert.ok(await pending(head), 'still behind the api grant');
  assert.equal((await tail).slug, 'c', 'first-fit: the tail is not held hostage by the head');

  s.release(held);
  assert.equal((await head).slug, 'b');
});

test('a bypassed entry ages out and reserves its tokens against everything behind it', async () => {
  const s = scheduler();
  const blocker = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });

  const starved = s.admit({ slug: 'starved', phase: 1, runId: 'rS', scope: ['api', 'web'] });
  await tick();
  assert.ok(await pending(starved));

  // Each of these intersects `starved` (on `web`) and not the live `api` grant,
  // so pure first-fit would let them stream past it forever.
  const bypassers: ScopeGrant[] = [];
  for (let i = 0; i < MAX_BYPASS; i++) {
    const grant = await s.admit({ slug: `w${i}`, phase: 1, runId: `rw${i}`, scope: ['web'] });
    bypassers.push(grant);
    s.release(grant);
  }

  const entry = s.snapshot().entries.find((e) => e.slug === 'starved');
  assert.ok(entry, 'still queued');
  assert.equal(entry.bypassed, MAX_BYPASS, 'every overtaking admission was counted');
  assert.equal(entry.reserving, true, 'and at the bound it starts reserving');

  // Now a later `web` entry must queue behind the reservation rather than
  // overtake it a fifth time.
  const late = s.admit({ slug: 'late', phase: 1, runId: 'rL', scope: ['web'] });
  await tick();
  assert.ok(await pending(late), 'the reservation holds the queue open for the starved entry');
  const lateEntry = s.snapshot().entries.find((e) => e.slug === 'late');
  assert.equal(lateEntry?.waitingOn[0].kind, 'reserved');

  // …and when the thing it was actually waiting for lets go, it goes first.
  s.release(blocker);
  const won = await starved;
  assert.equal(won.slug, 'starved');
  assert.ok(await pending(late), 'still behind it — now on the grant itself, not the reservation');

  // Only once the starved entry is done does the one it held back proceed.
  s.release(won);
  assert.equal((await late).slug, 'late');
  s.close();
});

test('waiting long enough is enough on its own — no bypass required', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  await tick();
  assert.equal(s.snapshot().entries[0].reserving, false);

  clock += AGING_MS;
  s.poll();
  assert.equal(s.snapshot().entries[0].reserving, true, 'ten minutes is its own bound');

  s.release(held);
  assert.equal((await waiting).slug, 'b');
});

test('the cap stops admission even when every scope is disjoint', async () => {
  const s = scheduler({ max: 2 });
  await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'] });

  const third = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  await tick();
  assert.ok(await pending(third), 'nothing collides — the machine is simply full');
  assert.equal(s.snapshot().max, 2);

  s.release(second);
  assert.equal((await third).slug, 'c');
});

test('a live lock on disk blocks an intersecting phase, and an expired one does not', async () => {
  let locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'someone/else', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'a session this console never started still owns the tree');
  assert.equal(s.snapshot().entries[0].waitingOn[0].owner, 'someone/else');

  // The lease elapses; `phase-lock.sh` would let anyone take it over.
  locks = [{ ...locks[0], expired: true }];
  s.poll();
  assert.equal((await blocked).slug, 'mine');
});

test('a scopeless lock is recovered from the plan, and falls back to `all` when the plan is unknown', async () => {
  const locks: LockView[] = [{ slug: 'legacy', phase: 3, owner: 'old/session', expired: false }];
  const known = scheduler({
    locks: () => locks,
    scopeFor: (slug, phase) => (slug === 'legacy' && phase === 3 ? ['docs'] : undefined),
  });

  // Recovered as `docs`, so an `api` phase is free to run beside it.
  const disjoint = await known.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  assert.equal(disjoint.slug, 'mine');
  const overlapping = known.admit({ slug: 'mine', phase: 2, runId: 'r1', scope: ['docs'] });
  await tick();
  assert.ok(await pending(overlapping), 'the recovered scope is a real scope');
  known.close();

  // No plan to recover it from: the safe reading is that it could be anything.
  const unknown = scheduler({ locks: () => locks });
  const anything = unknown.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(anything), 'an unreadable scope must collide with everything');
  unknown.close();
});

test("a run's own lock never blocks its own next lane", async () => {
  const locks: LockView[] = [
    { slug: 'mine', phase: 1, owner: 'autopilot/r1', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  // Phase 2 of the same run, same repo: the lock is ours, so the only thing
  // that may refuse this is a grant — and there is none.
  const next = await s.admit({ slug: 'mine', phase: 2, runId: 'r1', scope: ['api'] });
  assert.equal(next.phase, 2);
});

test('a foreign lock on the very phase being asked for QUEUES behind the holder, and frees on release', async () => {
  // This used to be carved out — admitted, with the runner's belt-check left
  // to refuse it by name. The refusal was a TERMINAL park (`parked` is a
  // settled status), so a phase a person was working by hand never boarded
  // again for the life of the run — observed live on delivery-overhaul
  // phase 8. Now it queues like any other lock conflict, holder named, and
  // admits the moment the lock goes away.
  let locks: LockView[] = [
    { slug: 'mine', phase: 1, owner: 'someone/else', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'a manual session owns this very phase');
  const holder = s.snapshot().entries[0].waitingOn[0];
  assert.equal(holder.kind, 'lock');
  assert.equal(holder.owner, 'someone/else');

  locks = [];
  s.poll();
  assert.equal((await blocked).phase, 1);
  s.close();
});

test('a lease that lapses on the clock stops blocking even when the stored bit is stale', async () => {
  // `LockView.expired` is frozen at store-scan time; the scheduler must judge
  // by the clock, or a dead claim blocks until an unrelated docs change.
  let clock = 1_000;
  const locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'someone/else', expired: false, scope: ['api'], leaseUntil: 5_000 },
  ];
  const s = scheduler({ locks: () => locks, now: () => clock });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'the lease still has four seconds to run');
  assert.equal(s.snapshot().entries[0].waitingOn[0].leaseUntil, 5_000);

  clock = 5_001;
  s.poll();
  assert.equal((await blocked).phase, 1);
  s.close();
});

test('the lock timer wakes the scan at the lease expiry with no external poke', async () => {
  const locks: LockView[] = [
    {
      slug: 'other', phase: 2, owner: 'someone/else', expired: false,
      scope: ['api'], leaseUntil: Date.now() + 60,
    },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'the lease has not lapsed yet');
  // No poll(), no release, no docs event — the armed timer must do it alone.
  const grant = await Promise.race([
    blocked,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('the lock timer never fired')), 2_000).unref?.();
    }),
  ]);
  assert.equal(grant.phase, 1);
  s.close();
});

test('a throttle holds every admission until it expires', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });

  s.throttle(clock + 60_000);
  const waiting = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting), 'the usage window is account-wide, so nothing starts');
  assert.equal(s.snapshot().throttledUntil, 61_000);

  clock += 60_001;
  s.poll();
  assert.equal((await waiting).slug, 'a');
  assert.equal(s.snapshot().throttledUntil, null);
});

test('a throttle is per ACCOUNT: the limited login queues, everyone else keeps flowing', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });

  s.throttle(clock + 60_000, 'work');
  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'work' });
  await tick();
  assert.ok(await pending(held), 'the account that hit the wall waits');

  // A DIFFERENT account — and the unnamed machine login — sail through, on
  // scopes that do not even collide with the throttled entry's.
  const other = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'spare' });
  assert.equal(other.slug, 'b');
  const machine = await s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  assert.equal(machine.slug, 'c');

  const snap = s.snapshot();
  assert.deepEqual(snap.throttledAccounts, [{ accountId: 'work', until: 61_000 }]);
  assert.equal(snap.throttledUntil, 61_000, 'the legacy field still says "something is throttled"');

  // The queued entry says WHY it waits, in holder vocabulary.
  const entry = snap.entries.find((e) => e.slug === 'a');
  assert.equal(entry?.waitingOn[0]?.owner, 'account work');

  clock += 60_001;
  s.poll();
  assert.equal((await held).slug, 'a', 'the reset admits it on that very scan');
  assert.equal(s.snapshot().throttledUntil, null);
});

test('the unnamed machine login and `default` are the same throttle key', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  s.throttle(clock + 30_000);   // no accountId — the machine login
  const waiting = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting));
  assert.deepEqual(s.wouldBlock({ slug: 'x', phase: 2, runId: 'r9', scope: ['web'] })[0]?.owner, 'the account');
  assert.equal(
    s.wouldBlock({ slug: 'x', phase: 2, runId: 'r9', scope: ['web'], accountId: 'spare' }).length,
    0,
    'a named account is not the machine login',
  );
  clock += 30_001;
  s.poll();
  await waiting;
});

test('two throttled accounts wake independently, soonest first', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  s.throttle(clock + 10_000, 'fast');
  s.throttle(clock + 60_000, 'slow');
  const fast = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'fast' });
  const slow = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'slow' });
  await tick();
  assert.equal(s.snapshot().throttledUntil, 11_000, 'min over the map');

  clock += 10_001;
  s.poll();
  assert.equal((await fast).slug, 'a');
  await tick();
  assert.ok(await pending(slow), 'the other account is still inside its window');
  assert.deepEqual(s.snapshot().throttledAccounts.map((t) => t.accountId), ['slow']);

  clock += 50_000;
  s.poll();
  await slow;
});

test('stopping a run cancels the admissions it was still waiting on', async () => {
  const s = scheduler();
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  const controller = new AbortController();
  const waiting = s.admit({
    slug: 'b', phase: 1, runId: 'r2', scope: ['api'], signal: controller.signal,
  });
  await tick();
  assert.ok(await pending(waiting));

  controller.abort();
  await assert.rejects(waiting, (error: Error) => error instanceof AdmissionAborted);
  assert.equal(s.snapshot().queued, 0, 'a cancelled admission leaves nothing behind');

  s.release(held);
});

test('releaseRun drops the grants AND the queue entries of a run that ended', async () => {
  const s = scheduler();
  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  await tick();
  assert.equal(s.snapshot().live, 1);
  assert.equal(s.snapshot().queued, 1);

  s.releaseRun('r1');
  await assert.rejects(second, (error: Error) => error instanceof AdmissionAborted);
  assert.equal(s.snapshot().live, 0, 'a grant is bookkeeping — the loop that made it real is gone');
  assert.equal(s.snapshot().queued, 0);
  s.release(first); // already gone; must not throw
});

test('an admission that names no repos is treated as `all`', async () => {
  const s = scheduler();
  const wide = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: [] });
  assert.deepEqual(wide.scope, ['all']);

  const anything = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['some-repo'] });
  await tick();
  assert.ok(await pending(anything), 'saying nothing must not read as colliding with nothing');
  s.release(wide);
  assert.equal((await anything).slug, 'b');
});

test('the snapshot reports what the queue page and the run header render', async () => {
  const s = scheduler({ max: 4 });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  s.admit({ slug: 'b', phase: 7, runId: 'r2', scope: ['api', 'web'] });
  await tick();

  const snap = s.snapshot();
  assert.equal(snap.max, 4);
  assert.equal(snap.live, 1);
  assert.equal(snap.queued, 1);
  assert.equal(snap.grants[0].slug, 'a');
  assert.equal(snap.entries[0].phase, 7);
  assert.deepEqual(snap.entries[0].scope, ['api', 'web']);
  assert.deepEqual(snap.entries[0].waitingOn[0].overlaps, ['api']);
  s.release(held);
  s.close();
});

/* ------------------------------------------------------------------ *
 * The repository guard
 * ------------------------------------------------------------------ */

test('guard off: two runs sharing a repo are admitted together', async () => {
  const s = scheduler({ guard: () => false });
  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  assert.equal(s.snapshot().live, 2, 'the operator turned serialization off, so nothing queues');
  s.release(first);
  s.release(second);
  s.close();
});

test('guard off is about OTHER runs — one run still cannot stack two lanes on a repo', async () => {
  const s = scheduler({ guard: () => false });
  const lane = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const secondLane = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(secondLane), 'two lanes of one run in one checkout is never the deal');
  s.release(lane);
  assert.equal((await secondLane).phase, 2);
  s.close();
});

test('guard off ignores foreign locks, and the cap still holds', async () => {
  const locks: LockView[] = [
    { slug: 'other', phase: 3, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ max: 1, locks: () => locks, guard: () => false });
  // The foreign lock shares the scope; with the guard off it does not block.
  const granted = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  // But the session cap is about the machine, not about scopes.
  const blocked = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(blocked[0]?.slug, 'session cap');
  s.release(granted);
  s.close();
});

test('overlapsFor reports the cross-run truth whatever the guard says', async () => {
  let guard = false;
  const locks: LockView[] = [
    { slug: 'held', phase: 2, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => guard });
  const mine = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const overlaps = s.overlapsFor({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  // The run's own grant is not an overlap — the probe is about who ELSE is here.
  assert.ok(!overlaps.some((h) => h.owner === 'autopilot/r1'));
  assert.ok(overlaps.some((h) => h.kind === 'lock' && h.slug === 'held'), 'the foreign lock is named');
  const foreign = s.overlapsFor({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  assert.ok(foreign.some((h) => h.kind === 'grant' && h.slug === 'a'), 'the live grant is named');
  guard = true;
  assert.deepEqual(s.overlapsFor({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] }), foreign,
    'the probe never consults the guard');
  s.release(mine);
  s.close();
});

test('a guard flip lands on the next poll — queued work is re-judged, not stranded', async () => {
  let guard = true;
  const s = scheduler({ guard: () => guard });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting), 'guard on: the overlap queues');
  guard = false;
  s.poll();
  assert.equal((await waiting).slug, 'b', 'guard off: the same entry is admitted');
  assert.equal(s.snapshot().guard, false, 'the snapshot says which regime is in force');
  s.release(held);
  s.close();
});

/* ------------------------------------------------------------------ *
 * The live lock read and the belt-check's observation
 * ------------------------------------------------------------------ */

test('a same-phase foreign lock the store has not scanned yet still blocks, read live off disk', async () => {
  let onDisk: LockView | null = {
    slug: 'a', phase: 1, owner: 'mobin@laptop', expired: false, scope: ['api'], leaseUntil: Date.now() + 60_000,
  };
  const s = new Scheduler({
    max: 8,
    locks: () => [],                       // the store's view: nothing
    liveLock: (slug, phase) => (slug === 'a' && phase === 1 ? onDisk : null),
  });
  const admission = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.equal(await pending(admission), true, 'admission waits on the lock the belt-check would otherwise have found');
  const entry = s.snapshot().entries[0];
  assert.equal(entry.waitingOn[0]?.kind, 'lock');
  assert.equal(entry.waitingOn[0]?.owner, 'mobin@laptop');

  onDisk = null; // the holder released
  s.poll();
  await tick();
  assert.equal(await pending(admission), false, 'and admits the moment the file is gone');
  s.release(await admission);
  s.close();
});
