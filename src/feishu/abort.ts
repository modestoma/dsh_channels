/**
 * Cancellation helpers shared by the Feishu reads and tools.
 *
 * @module dsh-channels/feishu/abort
 */

/** @returns a new `AbortError`. */
export function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * @param error - any thrown value.
 * @returns whether it is an `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Settle with `task`, or reject with an `AbortError` as soon as `signal`
 * aborts. The abandoned task's later rejection is swallowed.
 * @param task - the work to wait for.
 * @param signal - the cancellation signal.
 * @returns the task's value.
 */
export function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    task.catch(() => {})
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      task.catch(() => {})
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
