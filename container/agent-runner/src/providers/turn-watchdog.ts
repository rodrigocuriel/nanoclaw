/** Bound both inactivity and total elapsed time without interrupting active work. */
export function createTurnWatchdog(
  onTimeout: (reason: string) => void,
  idleMs = 10 * 60 * 1000,
  maximumMs = 30 * 60 * 1000,
  schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
): { touch: () => void; stop: () => void } {
  let stopped = false;
  let cancelIdle = () => {};
  let cancelMaximum = () => {};
  const stop = () => {
    stopped = true;
    cancelIdle();
    cancelMaximum();
  };
  const expire = (reason: string) => {
    if (stopped) return;
    stop();
    onTimeout(reason);
  };
  const touch = () => {
    if (stopped) return;
    cancelIdle();
    cancelIdle = schedule(() => expire(`Turn inactive for ${idleMs}ms`), idleMs);
  };
  touch();
  cancelMaximum = schedule(() => expire(`Turn exceeded maximum duration of ${maximumMs}ms`), maximumMs);
  return { touch, stop };
}
