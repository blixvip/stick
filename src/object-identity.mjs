/** Object identities the editor hands out stay below this bound so they remain
 * positive 32-bit values. A file may carry larger ones (Pivot writes IDs above
 * 2^31); those are kept as they are and never collide with allocations. */
export const MAX_ALLOCATED_UID = 0x7ffffffe;

/** The next identity to allocate once `uid` is in use. */
export const nextUidAfter = (next, uid) => uid <= MAX_ALLOCATED_UID ? Math.max(next, uid + 1) : next;
