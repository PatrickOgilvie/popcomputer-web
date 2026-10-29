export const title = 'A cached value and the purges of its tag'

const stored = (v) => {
  if (!v.entry.present) return 'Nothing stored'
  const old = v.entry.v < v.db ? 'an old value' : 'the current value'
  return v.entry.g === 0 ? `Stored ${old}, no tag recorded` : v.entry.g === v.gen ? `Stored ${old}` : `Stored ${old}, purged`
}

export const state = (v) => `${stored(v)}${v.reading.busy ? ', computing' : ''}${v.held === 0 ? '' : ', an action holds a read'}`

export const step = (action, from, to) => {
  if (action === 'CacheStarts') return to.reading.busy ? 'cache() misses and computes' : 'cache() hits'
  if (action === 'CacheStores') return 'cache() stores its value'
  if (action === 'CacheGetReads') return to.stale && !from.stale ? 'cacheGet returns the stored value' : 'cacheGet reads'
  if (action === 'AnActionReadsTheRecord') return 'an action reads the record'
  if (action === 'CacheSetWrites') return 'cacheSet stores what it read, with the tag'
  if (action === 'TheRecordChanges') return 'an action writes the record and purges the tag'
  return null
}
