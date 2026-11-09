/**
 * Typed handles over the host's `storageDomain` tables.
 *
 * `ctx.storageDomain.open()` answers untyped tables; {@link typedTable} gives
 * each one the value type its spec's zod schema validates, so stores read and
 * write records without casting at every call.
 *
 * @module dsh-channels/storage/table
 */

/**
 * One untyped table of an open domain. Mirrors `KvTable` from
 * `@deepseek-ai/dsh-storage-domain`: reads are synchronous, writes go through
 * `put`/`delete`, and `update` is an atomic read-modify-write that rejects
 * with `missing-key` when the key is absent.
 */
export interface RawTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<unknown>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  entries(): IterableIterator<[string, unknown]>
}

/** What `ctx.storageDomain.open()` resolves to. */
export interface RawDomainHandle {
  table(name: string): RawTable
  global: {
    get(): unknown
    set(value: unknown): Promise<unknown>
  }
  close(): Promise<void>
}

/** One table whose values the domain spec validated as `V`. */
export interface DomainTable<V> {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<unknown>
  /** Atomic read-modify-write; rejects with `missing-key` when the key is absent. */
  update(key: string, fn: (current: V) => V): Promise<unknown>
  delete(key: string): Promise<unknown>
  entries(): IterableIterator<[string, V]>
}

/**
 * Type one raw table with the value type its schema validates on load and write.
 * @param raw - the table from the open domain.
 * @returns the same table, typed.
 */
export function typedTable<V>(raw: RawTable): DomainTable<V> {
  return {
    get: key => raw.get(key) as V | undefined,
    put: (key, value) => raw.put(key, value),
    update: (key, fn) => raw.update(key, current => fn(current as V)),
    delete: key => raw.delete(key),
    entries: () => raw.entries() as IterableIterator<[string, V]>,
  }
}
