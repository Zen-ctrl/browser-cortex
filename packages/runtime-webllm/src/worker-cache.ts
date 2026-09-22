type CacheRequest = RequestInfo | URL;

/**
 * Complete a Cache.add operation while tolerating only the Chromium race where
 * another equivalent add wins after the caller observed a cache miss.
 */
export async function addCacheEntryIdempotently(
  cache: Pick<Cache, "match">,
  add: (request: CacheRequest) => Promise<void>,
  request: CacheRequest,
): Promise<void> {
  try {
    await add(request);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "InvalidAccessError") throw error;

    let matched: Response | undefined;
    try {
      matched = await cache.match(request);
    } catch {
      throw error;
    }
    if (!matched?.ok) throw error;
  }
}
