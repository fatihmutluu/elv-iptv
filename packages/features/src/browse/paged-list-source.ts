import type { ListSource } from '@elv/ui-kit';

const DEFAULT_PAGE_SIZE = 200;
const MAX_CATALOG_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 16;

/** Options accepted by {@link createPagedListSource}. */
export interface PagedListSourceOptions<T> {
  count: number;
  pageSize?: number;
  maxPages?: number;
  loadPage: (offset: number, limit: number) => Promise<readonly T[]>;
}

/** LRU-paged {@link ListSource} with on-demand item lookup and explicit disposal. */
export interface PagedListSource<T> extends ListSource<T> {
  loadItem(index: number): Promise<T | undefined>;
  dispose(): void;
}

/**
 * Wraps an offset/limit async loader (`CatalogService.items`) in an insertion-ordered LRU page
 * cache (`pageSize = 200`, `maxPages = 16` by default) so 25k–100k+ categories never materialize
 * full item arrays in JS memory.
 */
export function createPagedListSource<T>(opts: PagedListSourceOptions<T>): PagedListSource<T> {
  const totalCount = Math.max(0, Math.floor(opts.count));
  const pageSize = Math.max(
    1,
    Math.min(MAX_CATALOG_PAGE_SIZE, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));

  const pages = new Map<number, readonly T[]>();
  const inFlight = new Map<number, Promise<readonly T[]>>();
  const listeners = new Set<() => void>();
  let disposed = false;

  function touchPage(page: number, rows: readonly T[]): void {
    if (pages.has(page)) {
      pages.delete(page);
    }
    pages.set(page, rows);
    while (pages.size > maxPages) {
      const oldest = pages.keys().next().value;
      if (oldest === undefined) break;
      pages.delete(oldest);
    }
  }

  function fetchPage(page: number): Promise<readonly T[]> {
    if (disposed) return Promise.resolve([]);
    const cached = pages.get(page);
    if (cached !== undefined) {
      touchPage(page, cached);
      return Promise.resolve(cached);
    }
    const active = inFlight.get(page);
    if (active !== undefined) {
      return active;
    }

    const offset = page * pageSize;
    const limit = Math.min(pageSize, totalCount - offset);
    const request = opts
      .loadPage(offset, limit)
      .then((rows) => {
        inFlight.delete(page);
        if (disposed) return rows;
        touchPage(page, rows);
        for (const listener of [...listeners]) {
          listener();
        }
        return rows;
      })
      .catch(() => {
        inFlight.delete(page);
        return [] as readonly T[];
      });

    inFlight.set(page, request);
    return request;
  }

  function get(index: number): T | undefined {
    if (disposed || !Number.isInteger(index) || index < 0 || index >= totalCount) {
      return undefined;
    }
    const page = Math.floor(index / pageSize);
    const cached = pages.get(page);
    if (cached === undefined) {
      return undefined;
    }
    touchPage(page, cached);
    return cached[index % pageSize];
  }

  return {
    count: () => (disposed ? 0 : totalCount),
    get,
    prefetch(start, end) {
      if (disposed || totalCount <= 0) return;
      const from = Math.max(0, Math.floor(start));
      const to = Math.min(totalCount, Math.ceil(end));
      if (to <= from) return;

      const firstPage = Math.floor(from / pageSize);
      const lastPage = Math.min(Math.floor((to - 1) / pageSize), firstPage + maxPages - 1);

      for (let page = firstPage; page <= lastPage; page++) {
        const cached = pages.get(page);
        if (cached !== undefined) {
          touchPage(page, cached);
        } else {
          void fetchPage(page);
        }
      }
    },
    onChange(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async loadItem(index) {
      if (disposed || !Number.isInteger(index) || index < 0 || index >= totalCount) {
        return undefined;
      }
      const hit = get(index);
      if (hit !== undefined) return hit;
      const page = Math.floor(index / pageSize);
      const rows = await fetchPage(page);
      if (disposed) return undefined;
      return rows[index % pageSize];
    },
    dispose() {
      disposed = true;
      pages.clear();
      inFlight.clear();
      listeners.clear();
    },
  };
}
