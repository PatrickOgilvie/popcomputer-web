// Application values that README and AGENTS fragments use without defining them.
// Fragments (fences without a `// src/...` header) import every name exported
// here that they do not declare or import themselves.
import { Effect, Schema as S } from 'effect'
import { createTemplate, createVersion } from '@popcomputer/web'
import { json } from '@popcomputer/web/effect'
import manifest from '../dist/manifest.json'
import { createAuth, createStatelessAuth } from './auth'
import { createDb } from './db'
import { pages, ProjectSummary, Task } from './pages'
import { projects } from './schema'

export { createAuth, createDb, createStatelessAuth, manifest, projects }

export const version = createVersion(manifest)
export const template = createTemplate({ title: 'Projects' })

export const auth = createAuth({
  db: createDb(':memory:'),
  secret: 'readme-secret',
  baseURL: 'http://localhost',
})
export declare const headers: Headers

export declare const userId: string
export { pages, ProjectSummary, Task }
export declare function loadProjects(
  userId: string
): Promise<ReadonlyArray<typeof ProjectSummary.Type>>

export declare const newProject: typeof projects.$inferInsert
export declare const testDb: ReturnType<typeof createDb>
export { testBindings } from './test-bindings'

export interface AuditEvent {
  readonly action: string
  readonly userId: string
}
export declare const event: AuditEvent
export declare function sendAuditEvent(event: AuditEvent): Effect.Effect<void>

export { showProject } from './actions/projects/show'
export { showDashboard } from './actions/dashboard'
export { updateProject } from './actions/projects/update'
export { ClockLive, auditLogFor } from './services'
export const showProjectBySlug = json({ page: 'Projects/Show' })
export const showTask = json({ page: 'Tasks/Show' })
export const showPricing = json({ page: 'Pricing' })
