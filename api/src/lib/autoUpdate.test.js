import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_INTERVAL_SECONDS,
  describeInterval,
  isDue,
  projectNameFrom,
  toParts,
  toSeconds,
  validateSchedule,
} from './autoUpdate.js';

const TWELVE_HOURS = 12 * 60 * 60;

test('the floor is twice a day, stated once', () => {
  assert.equal(MIN_INTERVAL_SECONDS, TWELVE_HOURS);
});

test('a disabled schedule keeps no interval', () => {
  // Storing the last interval would make re-enabling silently resume a cadence
  // nobody is looking at.
  assert.deepEqual(validateSchedule({ enabled: false, days: 3, hours: 0, seconds: 0 }), {
    ok: true,
    seconds: null,
  });
});

test('all three at zero is refused', () => {
  const result = validateSchedule({ enabled: true, days: 0, hours: 0, seconds: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /how often/i);
});

test('anything more frequent than twice a day is refused', () => {
  for (const parts of [
    { days: 0, hours: 6, seconds: 0 },
    { days: 0, hours: 0, seconds: 30 },
    { days: 0, hours: 11, seconds: 3599 },
  ]) {
    const result = validateSchedule({ enabled: true, ...parts });
    assert.equal(result.ok, false, `${JSON.stringify(parts)} should be refused`);
    assert.match(result.error, /twice a day/i);
  }
});

test('exactly twice a day is allowed, being the floor and not past it', () => {
  assert.deepEqual(validateSchedule({ enabled: true, days: 0, hours: 12, seconds: 0 }), {
    ok: true,
    seconds: TWELVE_HOURS,
  });
});

test('the parts add up, and mixed units combine', () => {
  assert.deepEqual(validateSchedule({ enabled: true, days: 1, hours: 0, seconds: 0 }), {
    ok: true,
    seconds: 86_400,
  });
  assert.deepEqual(validateSchedule({ enabled: true, days: 1, hours: 2, seconds: 3 }), {
    ok: true,
    seconds: 86_400 + 7200 + 3,
  });
});

test('a blank field counts as zero, however it arrives', () => {
  // Clearing "days" to type only hours is the ordinary way to fill this in, and
  // an omitted field over the API means the same thing. All three spellings of
  // "nothing here" have to agree, or the same schedule would validate
  // differently depending on which one the client happened to send.
  for (const blank of ['', null, undefined]) {
    assert.deepEqual(
      validateSchedule({ enabled: true, days: blank, hours: 12, seconds: blank }),
      { ok: true, seconds: TWELVE_HOURS },
      `${String(blank)} should count as zero`,
    );
  }
});

test('blanking every field still fails, on the total rather than the fields', () => {
  const result = validateSchedule({ enabled: true, days: '', hours: '', seconds: '' });
  assert.equal(result.ok, false);
  assert.match(result.error, /how often/i);
});

test('values that are not whole counts are refused, not coerced', () => {
  // Number('abc') is NaN and Number('3.5') is not a count; either would
  // otherwise become part of an interval nobody typed.
  for (const bad of ['3.5', -1, 'abc', NaN, '1e3.5', {}]) {
    const result = validateSchedule({ enabled: true, days: bad, hours: 12, seconds: 0 });
    assert.equal(result.ok, false, `${String(bad)} should be refused`);
    assert.match(result.error, /whole numbers/i);
  }
});

test('an interval survives a round trip through the form', () => {
  for (const total of [TWELVE_HOURS, 86_400, 86_400 + 7200 + 3, 7 * 86_400]) {
    assert.equal(toSeconds(toParts(total)), total);
  }
});

test('parts of a missing or broken interval are all zero', () => {
  assert.deepEqual(toParts(null), { days: 0, hours: 0, seconds: 0 });
  assert.deepEqual(toParts(0), { days: 0, hours: 0, seconds: 0 });
  assert.deepEqual(toParts(-5), { days: 0, hours: 0, seconds: 0 });
});

test('a schedule that has never run is due at once', () => {
  // Enabling the setting should take effect now, not after a first full
  // interval has quietly elapsed.
  assert.equal(
    isDue({ enabled: true, intervalSeconds: TWELVE_HOURS, lastRunAt: null }, Date.now()),
    true,
  );
});

test('a schedule is due only once its interval has elapsed', () => {
  const now = 1_000_000_000_000;
  const schedule = {
    enabled: true,
    intervalSeconds: TWELVE_HOURS,
    lastRunAt: new Date(now - TWELVE_HOURS * 1000).toISOString(),
  };

  assert.equal(isDue(schedule, now), true);
  assert.equal(isDue({ ...schedule, lastRunAt: new Date(now - 1000).toISOString() }, now), false);
});

test('a disabled or interval-less schedule is never due', () => {
  const now = Date.now();
  assert.equal(isDue({ enabled: false, intervalSeconds: TWELVE_HOURS, lastRunAt: null }, now), false);
  assert.equal(isDue({ enabled: true, intervalSeconds: null, lastRunAt: null }, now), false);
  assert.equal(isDue(null, now), false);
});

test('an unreadable last-run does not wedge the scheduler off forever', () => {
  assert.equal(
    isDue({ enabled: true, intervalSeconds: TWELVE_HOURS, lastRunAt: 'not a date' }, Date.now()),
    true,
  );
});

test('an interval describes itself in the units it was entered in', () => {
  assert.equal(describeInterval(null), 'never');
  assert.equal(describeInterval(TWELVE_HOURS), 'every 12 hours');
  assert.equal(describeInterval(86_400), 'every 1 day');
  assert.equal(describeInterval(2 * 86_400 + 3600 + 5), 'every 2 days, 1 hour, 5 seconds');
});

/**
 * Compose derives a project name from its working directory. The updater sees
 * the project through a mount whose name is ours to choose, so letting compose
 * guess names the wrong project - and getting that wrong does not fail loudly.
 * It builds a SECOND stack, with its own empty database, beside the one it was
 * asked to upgrade. That happened once; hence these.
 */

test('the project is named after the host directory, not the mount', () => {
  assert.equal(projectNameFrom('/opt/quorum'), 'quorum');
});

test('a trailing separator does not empty the name', () => {
  assert.equal(projectNameFrom('/opt/quorum/'), 'quorum');
  assert.equal(projectNameFrom('/opt/quorum///'), 'quorum');
});

test('windows paths resolve to the same name', () => {
  assert.equal(projectNameFrom('C:\\srv\\quorum'), 'quorum');
  assert.equal(projectNameFrom('C:\\srv\\quorum\\'), 'quorum');
});

test('the name is lowercased and stripped, as compose does it', () => {
  // The point is to hand back the name compose already used, so a deployment in
  // "Quorum" or "My App" recreates its own stack rather than a second one.
  assert.equal(projectNameFrom('/srv/Quorum'), 'quorum');
  assert.equal(projectNameFrom('/srv/My App'), 'myapp');
  assert.equal(projectNameFrom('/srv/quorum-prod'), 'quorum-prod');
  assert.equal(projectNameFrom('/srv/quorum_prod'), 'quorum_prod');
});

test('a path with no usable name yields nothing rather than something wrong', () => {
  // Restarting the wrong project is worse than refusing to restart at all.
  assert.equal(projectNameFrom('/'), null);
  assert.equal(projectNameFrom(''), null);
  assert.equal(projectNameFrom(null), null);
  assert.equal(projectNameFrom(undefined), null);
  assert.equal(projectNameFrom('///'), null);
  assert.equal(projectNameFrom('/srv/!!!'), null);
});
