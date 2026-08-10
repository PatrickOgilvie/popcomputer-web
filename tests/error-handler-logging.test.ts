import { describe, expect, test } from 'bun:test'

type FixtureResult = {
  readonly exitCode: number
  readonly stderr: string
}

const runFixture = async (
  environment: 'development' | 'production',
): Promise<FixtureResult> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      `${import.meta.dir}/fixtures/error-handler-logging.ts`,
      environment,
    ],
    env: {
      ...Bun.env,
      NODE_ENV: environment,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])

  return { exitCode, stderr }
}

describe('default error-handler logging', () => {
  test('prints structured diagnostics in explicit development', async () => {
    const result = await runFixture('development')

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('error-handler-logging-fixture')
  })

  test('writes a redacted structured line, not the raw error, to the production console', async () => {
    const result = await runFixture('production')

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('HON_INT_800_UNEXPECTED')
    expect(result.stderr).not.toContain('error-handler-logging-fixture')
  })
})
