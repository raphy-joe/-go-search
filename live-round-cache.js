'use strict';

function createLiveRoundCache({ now = Date.now, liveTtlMs = 10000, historyTtlMs = 300000,
  maxGroups = 32, maxBytes = 16 * 1024 * 1024, validateRefresh = () => {} } = {}) {
  const groups = new Map();
  let bytes = 0;
  function groupFor(id) {
    if (!groups.has(id)) {
      while (groups.size >= maxGroups) {
        const key = groups.keys().next().value;
        bytes -= groups.get(key).bytes; groups.delete(key);
      }
      groups.set(id, { rounds: new Map(), completed: 0, bytes: 0 });
    }
    const group = groups.get(id);
    groups.delete(id); groups.set(id, group);
    return group;
  }
  return {
    async get(groupId, bout, fetchRound) {
      const group = groupFor(String(groupId));
      const cached = group.rounds.get(bout);
      // Round one also carries mutable event metadata, so always recheck it with the live tier.
      const ttl = bout > 1 && bout < group.completed ? historyTtlMs : liveTtlMs;
      if (cached && now() - cached.checkedAt < ttl) return { data: cached.data, checkedAt: cached.checkedAt };
      const data = await fetchRound();
      validateRefresh(data, cached?.data, { groupId, bout, completed: group.completed });
      const checkedAt = now();
      const size = Buffer.byteLength(JSON.stringify(data));
      const previousBytes = group.rounds.get(bout)?.bytes || 0;
      if (size <= maxBytes && groups.get(String(groupId)) === group) {
        while (groups.size > 1 && bytes - previousBytes + size > maxBytes) {
          const key = [...groups.keys()].find(key => key !== String(groupId));
          bytes -= groups.get(key).bytes; groups.delete(key);
        }
        if (bytes - previousBytes + size <= maxBytes) {
          group.bytes += size - previousBytes; bytes += size - previousBytes;
          group.rounds.set(bout, { data, checkedAt, bytes: size });
        }
      }
      return { data, checkedAt };
    },
    confirm(groupId, completed) { groupFor(String(groupId)).completed = completed; },
    // Called after a mixed-age snapshot fails validation; the next attempt refetches every sheet.
    invalidate(groupId) {
      const group = groups.get(String(groupId));
      if (group) { bytes -= group.bytes; groups.delete(String(groupId)); }
    },
  };
}
module.exports = { createLiveRoundCache };
