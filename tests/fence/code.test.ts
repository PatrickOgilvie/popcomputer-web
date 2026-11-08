/**
 * Program Code Tests
 *
 * The fence reads a program's strings as command lines, past its comments,
 * and asks the owner about code that can start a process, in each language
 * it knows.
 */

import { describe, expect, test } from 'bun:test'
import { codeKind, commandsInCode, startsProcess, type CodeKind } from '../../src/fence/code.js'

describe('codeKind', () => {
  test.each([
    ['x', '#!/usr/bin/env node\n', 'js'],
    ['x', '#!/usr/bin/env -S bun --smol\n', 'js'],
    ['x', '#!/usr/bin/env python3.12\n', 'python'],
    ['x', '#!/usr/bin/perl -w\n', 'perl'],
    ['x', '#!/usr/bin/env ruby\n', 'ruby'],
    ['x', '#!/usr/bin/php\n', 'php'],
    ['x.py', '#!/bin/bash\n', 'shell'],
    ['x.MJS', '', 'js'],
    ['x.cts', '', 'js'],
    ['x.tsx', '', 'js'],
    ['x.py', '', 'python'],
    ['x.pl', '', 'perl'],
    ['x.rb', '', 'ruby'],
    ['x.php', '', 'php'],
    ['x.sh', '', 'shell'],
    ['x', 'echo hi\n', 'shell'],
  ] as const)('%p holding %p is %p', (path, source, kind) => {
    expect(codeKind(path, source)).toBe(kind)
  })
})

describe('startsProcess', () => {
  test.each([
    ['js', "import { execFileSync } from 'node:child_process'", true],
    ['js', "exec('ls')", true],
    ['js', 'spawnSync("ls")', true],
    ['js', 'await execa("ls")', true],
    ['js', 'Bun.spawn(["ls"])', true],
    ['js', 'await $`ls`', true],
    ['js', 'new Deno.Command("ls")', true],
    ['js', '/a+/.exec(text)', false],
    ['js', 'console.log(`hi ${name}`)', false],
    ['python', 'import subprocess', true],
    ['python', 'os.system("ls")', true],
    ['python', 'print(1)', false],
    ['perl', 'my $x = `ls`;', true],
    ['perl', 'print "hi";', false],
    ['ruby', 'IO.popen("ls")', true],
    ['ruby', 'puts "hi"', false],
    ['php', 'shell_exec("ls");', true],
    ['php', 'echo "hi";', false],
  ] as const)('%p: %p is %p', (kind, source, expected) => {
    expect(startsProcess(source, kind as CodeKind)).toBe(expected)
  })
})

describe('commandsInCode', () => {
  test('each string, and each run of strings in one argument list joined as a command line', () => {
    expect(commandsInCode("spawnSync('git', ['commit', '-n'])\nlog('done')", 'js')).toEqual(['git', 'commit', '-n', "git commit -n", 'done'])
    expect(commandsInCode("new Deno.Command('git', { args: ['commit'] })", 'js')).toEqual(['git', 'commit', 'git commit'])
    expect(commandsInCode("f('a') + g('b')", 'js')).toEqual(['a', 'b'])
  })

  test("a string's escapes are read, and a placeholder stays as the shell's own `${...}`", () => {
    expect(commandsInCode("x('it\\'s')", 'js')).toEqual(["it's"])
    expect(commandsInCode('x(`git ${a ? `x` : "y"} -n`)', 'js')).toEqual(['git ${a ? `x` : "y"} -n'])
    expect(commandsInCode('x(`a\nb`)', 'js')).toEqual(['a\nb'])
  })

  test('comments are skipped: `//` and `/* */` in JavaScript and PHP, `#` elsewhere', () => {
    expect(commandsInCode("// 'a'\n/* 'b' */ 'c'", 'js')).toEqual(['c'])
    expect(commandsInCode("/* 'a'", 'js')).toEqual([])
    expect(commandsInCode("// 'a'", 'php')).toEqual([])
    expect(commandsInCode("# 'a'\n'b'", 'python')).toEqual(['b'])
    expect(commandsInCode("this.#x = 'a'", 'js')).toEqual(['a'])
    expect(commandsInCode("// 'a'", 'python')).toEqual(['a'])
  })

  test("a quote a line ends before closing opens no string, except a template's and python's triple quotes", () => {
    expect(commandsInCode("it's\n'b'", 'js')).toEqual(['b'])
    expect(commandsInCode('"""a\n"b"\n"""', 'python')).toEqual(['a\n"b"\n'])
    expect(commandsInCode("'''x'''", 'js')).toEqual(['', 'x', '', "'' x ''"])
    expect(commandsInCode('`open', 'js')).toEqual([])
    expect(commandsInCode('`a${`', 'js')).toEqual([])
    expect(commandsInCode('`git commit -n`', 'perl')).toEqual(['git commit -n'])
  })

  test("only a JavaScript template's `${` opens a placeholder", () => {
    expect(commandsInCode("f('${'); g('git status')", 'js')).toEqual(['${', 'git status'])
    expect(commandsInCode("f('${'); g('git status')", 'python')).toEqual(['${', 'git status'])
  })
})
