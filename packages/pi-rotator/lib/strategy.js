// Pure next-slot selection. isCooling is a predicate over provider ids so the
// strategies stay testable without any Pi or clock dependency.
//
// Failover sticks to the current slot while healthy: best prompt-cache reuse,
// switches only on exhaustion. Round-robin advances every turn for even drain
// across accounts at the cost of colder caches.
export function pickFailover(slots, isCooling, current) {
  if (current && slots.includes(current) && !isCooling(current)) return current;

  for (const id of slots) {
    if (!isCooling(id)) return id;
  }

  return null;
}

export function pickRoundRobin(slots, isCooling, lastIndex) {
  const total = slots.length;

  for (let step = 1; step <= total; step += 1) {
    const index = (lastIndex + step) % total;
    const id = slots[index];

    if (!isCooling(id)) return { id, index };
  }

  return null;
}
