/**
 * Hard guard for subprocess-touching tests: race the promise against a wall
 * clock (and the test's abort signal) so a broken handshake can never hang
 * the suite. The card requires handshake tests to be hang-proof.
 */
export function withBound<T>(
  signal: AbortSignal,
  ms: number,
  p: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`probe did not settle within ${ms} ms`)),
      ms,
    );
    signal.addEventListener(
      "abort",
      () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new Error("test aborted before the probe settled"));
      },
      { once: true },
    );
  });
  return Promise.race([p, wall]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
