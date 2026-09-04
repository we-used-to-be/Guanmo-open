import type { PersistStorage, StorageValue } from 'zustand/middleware'

/** Zustand storage that intentionally lasts only for the current page runtime. */
export function createVolatilePersistStorage<T>(): PersistStorage<T> {
  return {
    getItem: () => null,
    setItem: (_name: string, _value: StorageValue<T>) => undefined,
    removeItem: (_name: string) => undefined,
  }
}
