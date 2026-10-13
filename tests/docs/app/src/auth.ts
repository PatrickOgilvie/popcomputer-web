// The Better Auth factories the README examples import as `./auth`.
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import type { Database } from './db'

export interface CreateAuthOptions {
  readonly db: Database
  readonly secret: string
  readonly baseURL: string
  readonly advanced?: BetterAuthOptions['advanced']
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: memoryAdapter({}),
    secret: options.secret,
    baseURL: options.baseURL,
    advanced: options.advanced,
    emailAndPassword: { enabled: true },
  })
}

export interface CreateStatelessAuthOptions {
  readonly secret: string
  readonly advanced?: BetterAuthOptions['advanced']
}

export function createStatelessAuth(options: CreateStatelessAuthOptions) {
  return betterAuth({ secret: options.secret, advanced: options.advanced })
}
