/**
 * Path Policy Tests
 *
 * The files a change may touch without the owner, compared as normalised
 * paths without regard to case, and the files a glob, an expansion or a
 * `cd` the fence cannot follow may name.
 */

import { describe, expect, test } from 'bun:test'
import { filePolicy } from '../../src/fence/command-policy.js'
import { pathFindings, protectedFileFindings, writeFindings } from '../../src/fence/file-policy.js'
import { isAbsolutePath, joinPath, normalizePath, parentPath } from '../../src/fence/path.js'
import { GLOB_ANY, GLOB_ONE, UNREAD } from '../../src/fence/shell.js'

describe('paths', () => {
  test.each([
    ['a/./b', 'a/b'],
    ['a//b/', 'a/b'],
    ['a/../b', 'b'],
    ['a/..', ''],
    ['../a', '../a'],
    ['../../a/..', '../..'],
    ['/../a', '/a'],
    ['/a/b/../../..', '/'],
    ['C:\\repo\\.git', 'C:/repo/.git'],
    ['', ''],
  ])('%p normalises to %p', (path, normal) => {
    expect(normalizePath(path)).toBe(normal)
  })

  test('absolute paths, joins and parents', () => {
    expect(['/x', '\\x', 'C:\\x', 'c:/x', 'x', './x'].map(isAbsolutePath)).toEqual([true, true, true, true, false, false])
    expect([joinPath(undefined, 'x'), joinPath(undefined, '/x'), joinPath('', 'x'), joinPath('a', 'b'), joinPath('a', '/b'), joinPath('a', '..')]).toEqual([
      undefined, '/x', 'x', 'a/b', '/b', '',
    ])
    expect([parentPath('/'), parentPath('/a'), parentPath('a'), parentPath(''), parentPath('..')]).toEqual([undefined, '/', '', '..', '../..'])
  })
})

describe('filePolicy', () => {
  test('a refusal outranks a question, whatever the order of the patterns', () => {
    expect(filePolicy('.husky/.git/config')).toMatchObject({ decision: 'deny', rule: 'hook-bypass' })
    expect(filePolicy('/home/me/.gitconfig')).toMatchObject({ decision: 'deny' })
    expect(filePolicy('/home/me/.config/git/config')).toMatchObject({ decision: 'deny' })
  })

  test('the reason names the change, by an edit or by a command', () => {
    expect(filePolicy('lint-debt.json')).toMatchObject({ reason: expect.stringMatching(/^lint-debt\.json is part of the fence/) })
    expect(filePolicy('.git/hooks/x')).toMatchObject({ reason: expect.stringMatching(/^Changing \.git\/hooks\/x switches off/) })
    expect(pathFindings('.git/hooks/x', 'rm x')[0]).toMatchObject({ subject: 'rm x', reason: expect.stringMatching(/^`rm x` changes \.git\/hooks\/x, which/) })
  })

  test('the directory core.hooksPath names: relative, absolute or under home', () => {
    expect(filePolicy('/repo/gate/pre-commit', { hooksPath: 'gate' })).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(filePolicy('/hooks/pre-commit', { hooksPath: '/hooks' })).toMatchObject({ decision: 'ask' })
    expect(filePolicy('/repo/hooks/pre-commit', { hooksPath: '/hooks' })).toEqual({ decision: 'allow' })
    expect(filePolicy('/home/me/hooks/pre-commit', { hooksPath: '~/hooks' })).toMatchObject({ decision: 'ask' })
    expect(filePolicy('/repo/x', { hooksPath: '' })).toEqual({ decision: 'allow' })
    expect(filePolicy('/repo/x', { hooksPath: '/' })).toEqual({ decision: 'allow' })
  })
})

describe('writeFindings', () => {
  test('a glob is tried against each protected file, a wildcard at a name start matching no dot', () => {
    expect(writeFindings(GLOB_ANY, '', 'rm *')).toMatchObject([{ decision: 'deny', reason: expect.stringContaining('lefthook-local.yml') }])
    expect(writeFindings(`${GLOB_ANY}.json`, '', 'rm *.json')).toMatchObject([{ decision: 'ask', rule: 'fence-change' }])
    expect(writeFindings(`${GLOB_ANY}hooks/pre-commit`, '', 'rm *hooks/pre-commit')).toEqual([])
    expect(writeFindings(`.g${GLOB_ONE}t/config`, '', 'rm .g?t/config')).toMatchObject([{ decision: 'deny' }])
    expect(writeFindings(`${GLOB_ONE}git/config`, '', 'rm ?git/config')).toEqual([])
    expect(writeFindings(`${GLOB_ANY}/config`, '', 'rm */config')).toEqual([])
    expect(writeFindings(`.git/${GLOB_ANY}`, '', 'rm .git/*')).toMatchObject([{ decision: 'deny' }])
  })

  test("an expansion's known text is all the fence reads of it", () => {
    expect(writeFindings(`${UNREAD}/.git/hooks/pre-commit`, '', 'x')).toMatchObject([{ decision: 'deny' }])
    expect(writeFindings(`${UNREAD}/notes.txt`, undefined, 'x')).toEqual([])
    expect(writeFindings(UNREAD, '', 'x')).toEqual([])
  })

  test('a relative path after a cd the fence cannot follow asks; an absolute one is read', () => {
    expect(writeFindings('notes.txt', undefined, 'echo > notes.txt')).toMatchObject([{ decision: 'ask', rule: 'unreadable' }])
    expect(writeFindings(`${GLOB_ANY}.txt`, undefined, 'x')).toMatchObject([{ decision: 'ask', rule: 'unreadable' }])
    expect(writeFindings('/dev/null', undefined, 'x')).toEqual([])
    expect(writeFindings('pre-commit', '.git/hooks', 'x')).toMatchObject([{ decision: 'deny' }])
  })

  test("a path is matched against the protected files' examples", () => {
    expect(protectedFileFindings('./.git/hooks/pre-commit', 'x')).toMatchObject([{ decision: 'deny' }])
    expect(protectedFileFindings('.git/hooks/lint-debt.json', 'x')).toEqual([])
  })
})
