export const title = 'A cached value and the purges of its tag'

const stored = (v) => {
  if (!v.entry.present) return 'Nothing stored'
  const old = v.entry.v < v.db ? 'an old value' : 'the current value'
  return v.entry.g === 0 ? `Stored ${old}, no tag recorded` : v.entry.g === v.gen ? `Stored ${old}` : `Stored ${old}, purged`
}

const setting = (v) => (v.held !== 0 ? ', a read waits for cacheSet' : v.captured !== 0 ? ', cacheSet reading' : '')

export const state = (v) => `${stored(v)}${v.reading.busy ? ', computing' : ''}${setting(v)}`

export const step = (action, from, to) => {
  if (action === 'CacheStarts') return to.reading.busy ? 'cache() misses and computes' : 'cache() hits'
  if (action === 'CacheStores') return 'cache() stores its value'
  if (action === 'CacheGetReads') return to.stale && !from.stale ? 'cacheGet returns the stored value' : 'cacheGet reads'
  if (action === 'CacheSetStartsItsRead') return "cacheSet reads the tag's generation"
  if (action === 'TheRecordIsRead') return from.captured !== 0 ? "cacheSet's read reads the record" : 'an action reads the record'
  if (action === 'CacheSetWrites') return 'cacheSet stores what was read, with the tag'
  if (action === 'TheRecordChanges') return 'an action writes the record and purges the tag'
  return null
}
