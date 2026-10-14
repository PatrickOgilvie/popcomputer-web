/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Action Composables Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Layer, Redacted } from 'effect'
import { action } from '../../src/effect/action.js'
import {
  AuthUserService,
  authorize,
  type AuthUser,
} from '../../src/effect/services.js'
import { UnauthorizedError } from '../../src/effect/errors.js'

// Mock user
const createMockUser = (overrides: Partial<AuthUser['user']> = {}): AuthUser => ({
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    image: null,
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    createdAt: new Date('2024-01-01'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  },
  session: {
    id: 'session-456',
    userId: 'user-123',
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    expiresAt: new Date('2024-12-31'),
    token: Redacted.make('test-token'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    createdAt: new Date('2024-01-01'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    updatedAt: new Date('2024-01-01'),
  },
})

describe('action', () => {
  test('wraps an Effect and returns it unchanged', () => {
    const effect = Effect.succeed(new Response('x'))

    expect(action(effect)).toBe(effect)
  })
})

describe('authorize', () => {
  test('returns user when no check function provided', async () => {
    const effect = authorize()

    const mockUser = createMockUser({ name: 'Jane' })
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(Effect.provide(effect, layer))

    expect(result.user.name).toBe('Jane')
  })

  test('returns user when check passes', async () => {
    const effect = authorize((a) => a.user.email === 'test@example.com')

    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(Effect.provide(effect, layer))

    expect(result.user.email).toBe('test@example.com')
  })

  test('fails with the message it is given when the check fails', async () => {
    const effect = authorize((a) => a.user.email === 'admin@example.com', 'Only admins can do this.')
    const layer = Layer.succeed(AuthUserService, createMockUser({ email: 'user@example.com' }))

    const failure = await Effect.runPromise(Effect.flip(Effect.provide(effect, layer)))

    expect(failure).toMatchObject({ _tag: 'ForbiddenError', message: 'Only admins can do this.' })
  })

  test('fails without authenticated user', async () => {
    const error = await Effect.runPromise(Effect.flip(authorize()))

    expect(error).toBeInstanceOf(UnauthorizedError)
    // The boundary sends the visitor to setupWeb's auth.signInPath.
    expect(error.redirectTo).toBeUndefined()
  })
})
