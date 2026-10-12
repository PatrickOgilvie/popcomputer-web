// Application values that README fragments use without defining them.
// Fragments (fences without a `// src/...` header) import every name exported
// here that they do not declare or import themselves.
import { Effect, Schema as S } from 'effect'
import { createTemplate, createVersion } from '@popcomputer/web'
import { json } from '@popcomputer/web/effect'
import manifest from '../dist/manifest.json'
import { createAuth, createStatelessAuth } from './auth'
import { createDb } from './db'

export { createAuth, createDb, createStatelessAuth, manifest }

export const version = createVersion(manifest)
export const template = createTemplate({ title: 'Projects' })

export const auth = createAuth({
  db: createDb(':memory:'),
  secret: 'readme-secret',
  baseURL: 'http://localhost',
})
export declare const headers: Headers

export declare const userId: string
export const ProjectSummary = S.Struct({ id: S.String, name: S.String })
export declare function loadProjects(
  userId: string
): Promise<ReadonlyArray<typeof ProjectSummary.Type>>

export const Task = S.Struct({ id: S.String, projectId: S.String, title: S.String })

export interface AuditEvent {
  readonly action: string
  readonly userId: string
}
export declare const event: AuditEvent
export declare function sendAuditEvent(event: AuditEvent): Effect.Effect<void>

export { showProject } from './actions/projects/show'
export const showProjectBySlug = json({ page: 'Projects/Show' })
export const showTask = json({ page: 'Tasks/Show' })
export const showPricing = json({ page: 'Pricing' })
