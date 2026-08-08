const locks = new Map<string, Promise<unknown>>();

/**
 * Serializes async work by key. Used to protect the integration repo: two specialist tasks
 * merging at the same time would otherwise race on `git checkout` + `git merge` against the
 * same working directory and could corrupt it. Worktrees are isolated per task and don't need
 * this — only the final merge step, which mutates the shared integration repo, does.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
