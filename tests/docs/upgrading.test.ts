/**
 * UPGRADING.md takes a reader from any release to the package's own version,
 * so each release must bring along the places that name where the path ends:
 * the title and the opening path, the contents, the peer table and install
 * steps of "Before you start", every row of "Find your starting point", and
 * the checklist, with each "From A to B" section after the one before it.
 * They fell behind for three releases before this test, because each release
 * updated the opening paragraph alone, and 1.13.0 put its section before
 * 1.12's and left it out of the contents.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
const guide = readFileSync(join(repoRoot, 'UPGRADING.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  readonly version: string
  readonly peerDependencies: Readonly<Record<string, string>>
}

/** A heading's anchor as GitHub writes it, as tests/docs/check-docs.ts does. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replaceAll(' ', '-')

/** The text under a `## ` heading, up to the next one. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`)

  if (start < 0) return ''

  const end = markdown.indexOf('\n## ', start + 1)

  return markdown.slice(start, end < 0 ? undefined : end)
}

/** The release a starting-point row is for: its first cell. */
const startOf = (row: string) => (row.split('|')[1] ?? '').trim()

/** Text with each run of whitespace as one space, so a phrase matches across a wrapped line. */
const flat = (text: string) => text.replace(/\s+/g, ' ')

/** Each place the guide stops short of `version`, or names other peer ranges than `peers`, as what to change. */
function stalePlaces(markdown: string, version: string, peers: Readonly<Record<string, string>>): string[] {
  const stale: string[] = []
  const minor = version.split('.').slice(0, 2).join('.')
  const sections = [...markdown.matchAll(/^## From (\d+\.\d+) to (\d+\.\d+)$/gm)].flatMap(([heading, from, to]) =>
    from === undefined || to === undefined ? [] : [{ from, to, anchor: `#${slug(heading.slice(3))}` }]
  )
  const order = (release: string) => release.split('.').map(Number).reduce((major, part) => major * 1000 + part)
  const newest = sections.toSorted((a, b) => order(b.to) - order(a.to))[0]

  if (newest === undefined || newest.to !== minor) {
    return [`No section reaches ${minor}: add "## From ${newest?.to ?? '?'} to ${minor}", then run this test again.`]
  }

  const opening = flat(markdown.slice(0, markdown.indexOf('\n## ')))
  const contents = section(markdown, 'Contents')
  const before = section(markdown, 'Before you start')
  const starts = section(markdown, 'Find your starting point')
  const checklist = section(markdown, 'Checklist')
  const link = `(${newest.anchor})`

  if (!opening.startsWith(`# Upgrading to @popcomputer/web ${version}\n`.replace('\n', ' '))) {
    stale.push(`The title names another version than ${version}.`)
  }
  if (!opening.includes(`renamed from, to ${version}.`)) stale.push(`The opening names another version than ${version} as the one it takes a reader to.`)
  if (!opening.includes(`install ${version},`)) stale.push(`The opening path installs another version than ${version}.`)
  if (!opening.includes(link)) stale.push(`The opening path ends before "From ${newest.from} to ${newest.to}".`)
  if (!contents.includes(link)) stale.push(`The contents stop before "From ${newest.from} to ${newest.to}".`)

  // In the file's order, each section takes a reader on from where the one before it ended.
  for (const [index, each] of sections.entries()) {
    const before = sections[index - 1]
    if (before !== undefined && order(each.from) < order(before.to)) {
      stale.push(`"From ${each.from} to ${each.to}" comes after "From ${before.from} to ${before.to}": keep the sections oldest first.`)
    }
  }
  if (!before.includes(`**Check the peer dependencies.** ${version} needs:`)) stale.push(`"Before you start" names another version than ${version} for the peer dependencies.`)
  if (!before.includes(`**Install ${version}**`) || !before.includes(`bun add @popcomputer/web@^${version} `)) {
    stale.push(`"Before you start" installs another version than ${version}.`)
  }

  const listed = new Map(
    [...before.matchAll(/^ *\| `([^`]+)` \| `([^`]+)` \|/gm)].flatMap(([, name, range]) => (name === undefined || range === undefined ? [] : [[name, range] as const]))
  )

  for (const [name, range] of Object.entries(peers)) {
    if (listed.get(name) !== range) stale.push(`"Before you start" gives ${name} ${listed.get(name) ?? 'no range'}, where package.json needs ${range}.`)
  }
  for (const name of listed.keys()) {
    if (!(name in peers)) stale.push(`"Before you start" lists ${name}, which is no peer dependency.`)
  }

  const rows = starts.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| You are on') && !line.startsWith('| ---'))

  for (const row of rows) {
    if (!row.includes(link)) stale.push(`"Find your starting point": the row for ${startOf(row)} stops before "From ${newest.from} to ${newest.to}".`)
  }
  if (!rows.some((row) => row.startsWith(`| ${newest.from}.x |`))) stale.push(`"Find your starting point" has no row for ${newest.from}.x.`)
  if (!checklist.includes(`\`@popcomputer/web\` is \`^${version}\``)) stale.push(`The checklist asks for another version than ^${version}.`)
  if (!checklist.includes(link)) stale.push(`The checklist's list of sections stops before "From ${newest.from} to ${newest.to}".`)

  return stale
}

describe('UPGRADING.md', () => {
  test('takes every reader to the package’s version, through its newest section, with its peer ranges', () => {
    expect(stalePlaces(guide, pkg.version, pkg.peerDependencies)).toEqual([])
  })

  describe('reports what a release leaves behind', () => {
    const [rowBefore = '', lastRow = ''] = [...guide.matchAll(/^\| \d+\.\d+\.x \|.*$/gm)].slice(-2).map(([row]) => row)

    test('a release with no section of its own', () => {
      const [major = 0, minor = 0] = pkg.version.split('.').map(Number)

      expect(stalePlaces(guide, `${major}.${minor + 1}.0`, pkg.peerDependencies)).toEqual([
        expect.stringContaining(`No section reaches ${major}.${minor + 1}`),
      ])
    })

    test('a starting-point row that stops early, and a missing row', () => {
      // The row before the last loses its final section, and the last row goes.
      const rows = guide
        .replace(rowBefore, rowBefore.replace(/, then \[[^\]]+\]\([^)]+\) \|$/, ' |'))
        .replace(`${lastRow}\n`, '')

      expect(stalePlaces(rows, pkg.version, pkg.peerDependencies)).toEqual([
        expect.stringMatching(new RegExp(`the row for ${startOf(rowBefore).replaceAll('.', '\\.')} stops before`)),
        expect.stringMatching(/no row for \d+\.\d+\.x/),
      ])
    })

    test('a checklist, title and install steps on an older version', () => {
      const older = guide
        .replace(`\`@popcomputer/web\` is \`^${pkg.version}\``, '`@popcomputer/web` is `^1.9.0`')
        .replace(`# Upgrading to @popcomputer/web ${pkg.version}`, '# Upgrading to @popcomputer/web 1.9.0')
        .replace(`**Install ${pkg.version}**`, '**Install 1.9.0**')

      expect(stalePlaces(older, pkg.version, pkg.peerDependencies)).toEqual([
        expect.stringContaining('The title'),
        expect.stringContaining('installs another version'),
        expect.stringContaining('The checklist asks for another version'),
      ])
    })

    test('a newest section before the one it follows, and left out of the contents', () => {
      // The last two sections, swapped, and the last one's line of the contents dropped.
      const blocks = [...guide.matchAll(/\n## From (\d+)\.(\d+) to (\d+)\.(\d+)\n[\s\S]*?(?=\n## )/g)]
      const [previous, last] = blocks.slice(-2)
      const link = last === undefined ? '' : `(#from-${last[1]}${last[2]}-to-${last[3]}${last[4]})`
      const swapped = guide.replace(`${previous?.[0]}${last?.[0]}`, `${last?.[0]}${previous?.[0]}`)
      const unlisted = swapped.split('\n').filter((line) => !(/^\d+\. /.test(line) && line.endsWith(link))).join('\n')

      expect(stalePlaces(unlisted, pkg.version, pkg.peerDependencies)).toEqual([
        expect.stringContaining('The contents stop before'),
        expect.stringContaining('keep the sections oldest first'),
      ])
    })

    test('a peer range package.json moved', () => {
      expect(stalePlaces(guide, pkg.version, { ...pkg.peerDependencies, 'better-auth': '>=1.8.0 <1.9.0' })).toEqual([
        expect.stringContaining('gives better-auth >=1.7.7 <1.8.0, where package.json needs >=1.8.0 <1.9.0'),
      ])
    })
  })
})
