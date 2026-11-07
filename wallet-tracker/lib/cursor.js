export function planSignatureWindow({ pages, cursor = null, reachedCursor = false, initialized = false }) {
  const newestFirst = (pages || []).flat().filter((row) => row?.signature);
  if (!initialized) {
    return {
      mode: "baseline",
      process: [],
      nextCursor: newestFirst[0]?.signature || null,
      nextCursorSlot: newestFirst[0]?.slot ?? null,
      gap: false,
      backlog: 0,
    };
  }

  const newer = [];
  for (const row of newestFirst) {
    if (cursor && row.signature === cursor) break;
    newer.push(row);
  }

  if (!reachedCursor) {
    return {
      mode: "gap",
      process: [],
      nextCursor: cursor,
      nextCursorSlot: null,
      gap: true,
      backlog: newer.length,
    };
  }

  return {
    mode: newer.length ? "forward" : "idle",
    process: newer.slice().reverse(),
    nextCursor: newer[0]?.signature || cursor,
    nextCursorSlot: newer[0]?.slot ?? null,
    gap: false,
    backlog: 0,
  };
}
