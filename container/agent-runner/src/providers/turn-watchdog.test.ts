import { expect, it } from 'bun:test';
import { createTurnWatchdog } from './turn-watchdog.js';

function clock() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  return {
    schedule(callback: () => void, delay: number) {
      const task = { at: now + delay, callback };
      pending.add(task);
      return () => { pending.delete(task); };
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...pending].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        now = next.at;
        pending.delete(next);
        next.callback();
      }
      now = end;
    },
    pending,
  };
}

it('allows active work past the original idle deadline, then expires after silence', () => {
  const c = clock();
  const errors: string[] = [];
  const w = createTurnWatchdog((e) => errors.push(e), 10, 30, c.schedule);
  c.advance(8);
  w.touch();
  c.advance(8);
  expect(errors).toEqual([]);
  c.advance(2);
  expect(errors).toEqual(['Turn inactive for 10ms']);
  expect(c.pending.size).toBe(0);
});

it('enforces the maximum even when activity continues', () => {
  const c = clock();
  const errors: string[] = [];
  const w = createTurnWatchdog((e) => errors.push(e), 10, 30, c.schedule);
  for (let i = 0; i < 3; i++) { c.advance(8); w.touch(); }
  c.advance(6);
  expect(errors).toEqual(['Turn exceeded maximum duration of 30ms']);
  expect(c.pending.size).toBe(0);
});

it('cancels both deadlines when a turn ends and ignores later activity', () => {
  const c = clock();
  const errors: string[] = [];
  const w = createTurnWatchdog((e) => errors.push(e), 10, 30, c.schedule);
  w.stop();
  w.touch();
  c.advance(100);
  expect(errors).toEqual([]);
  expect(c.pending.size).toBe(0);
});
