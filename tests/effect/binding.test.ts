/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import assert from 'node:assert/strict'
/**
 * Route Model Binding Tests
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Predicate, Effect, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { uuid } from '../../src/effect/schema.js'
import {
  parseBindings,
  toHonoPath,
  pluralize,
  bound,
  BoundModels,
  compileBindingPlan,
  decodeBoundRow,
  columnTypeToSchema,
  inferParamsSchema,
} from '../../src/effect/binding.js'
import { RouteConfigurationError } from '../../src/effect/errors.js'
import { registerErrorHandlers } from '../../src/setup.js'

describe('parseBindings', () => {
  describe('basic Laravel-style bindings', () => {
    test('parses single binding with default column', () => {
      const bindings = parseBindings('/projects/{project}')
      expect(bindings).toEqual([{ param: 'project', column: 'id' }])
    })

    test('parses single binding with custom column', () => {
      const bindings = parseBindings('/projects/{project:slug}')
      expect(bindings).toEqual([{ param: 'project', column: 'slug' }])
    })

    test('parses multiple bindings', () => {
      const bindings = parseBindings('/users/{user}/posts/{post}')
      expect(bindings).toEqual([
        { param: 'user', column: 'id' },
        { param: 'post', column: 'id' },
      ])
    })

    test('parses mixed bindings with custom columns', () => {
      const bindings = parseBindings('/users/{user:email}/posts/{post:slug}')
      expect(bindings).toEqual([
        { param: 'user', column: 'email' },
        { param: 'post', column: 'slug' },
      ])
    })

    test('handles complex nested paths', () => {
      const bindings = parseBindings('/api/v1/users/{user}/posts/{post}/comments/{comment}')
      expect(bindings).toEqual([
        { param: 'user', column: 'id' },
        { param: 'post', column: 'id' },
        { param: 'comment', column: 'id' },
      ])
    })
  })

  describe('Hono-style routes (no Laravel bindings)', () => {
    test('returns empty array for Hono :param style', () => {
      expect(parseBindings('/users/:id')).toEqual([])
    })

    test('returns empty array for multiple Hono params', () => {
      expect(parseBindings('/users/:userId/posts/:postId')).toEqual([])
    })

    test('returns empty array for static paths', () => {
      expect(parseBindings('/users')).toEqual([])
      expect(parseBindings('/api/v1/health')).toEqual([])
      expect(parseBindings('/')).toEqual([])
    })

    test('returns empty array for wildcard routes', () => {
      expect(parseBindings('/files/*')).toEqual([])
      expect(parseBindings('/api/*')).toEqual([])
    })

    test('returns empty array for regex routes', () => {
      expect(parseBindings('/users/:id{[0-9]+}')).toEqual([])
    })
  })

  describe('mixed Hono and Laravel notation', () => {
    test('only extracts Laravel bindings from mixed route', () => {
      const bindings = parseBindings('/users/:userId/projects/{project}')
      expect(bindings).toEqual([{ param: 'project', column: 'id' }])
    })

    test('extracts Laravel binding before Hono param', () => {
      const bindings = parseBindings('/orgs/{org}/users/:userId')
      expect(bindings).toEqual([{ param: 'org', column: 'id' }])
    })

    test('extracts multiple Laravel bindings ignoring Hono params', () => {
      const bindings = parseBindings('/api/:version/users/{user}/posts/:postId/comments/{comment}')
      expect(bindings).toEqual([
        { param: 'user', column: 'id' },
        { param: 'comment', column: 'id' },
      ])
    })

    test('handles Laravel binding with custom column mixed with Hono', () => {
      const bindings = parseBindings('/teams/:teamId/projects/{project:slug}/tasks/:taskId')
      expect(bindings).toEqual([{ param: 'project', column: 'slug' }])
    })
  })

  describe('edge cases', () => {
    test('handles binding at root', () => {
      const bindings = parseBindings('/{user}')
      expect(bindings).toEqual([{ param: 'user', column: 'id' }])
    })

    test('handles binding with trailing slash', () => {
      const bindings = parseBindings('/users/{user}/')
      expect(bindings).toEqual([{ param: 'user', column: 'id' }])
    })

    test('handles consecutive bindings', () => {
      const bindings = parseBindings('/{org}/{project}/{task}')
      expect(bindings).toEqual([
        { param: 'org', column: 'id' },
        { param: 'project', column: 'id' },
        { param: 'task', column: 'id' },
      ])
    })

    test('handles single character param names', () => {
      const bindings = parseBindings('/users/{u}/posts/{p}')
      expect(bindings).toEqual([
        { param: 'u', column: 'id' },
        { param: 'p', column: 'id' },
      ])
    })

    test('handles underscored param names', () => {
      const bindings = parseBindings('/user_profiles/{user_profile}')
      expect(bindings).toEqual([{ param: 'user_profile', column: 'id' }])
    })

    test('handles numeric-suffixed param names', () => {
      const bindings = parseBindings('/items/{item1}/subitems/{item2}')
      expect(bindings).toEqual([
        { param: 'item1', column: 'id' },
        { param: 'item2', column: 'id' },
      ])
    })

    test('handles empty path', () => {
      expect(parseBindings('')).toEqual([])
    })

    test('handles path with query string (should not affect parsing)', () => {
      // Query strings shouldn't be in route definitions, but test anyway
      const bindings = parseBindings('/users/{user}?include=posts')
      expect(bindings).toEqual([{ param: 'user', column: 'id' }])
    })

    test('does not match incomplete braces', () => {
      expect(parseBindings('/users/{user')).toEqual([])
      expect(parseBindings('/users/user}')).toEqual([])
      expect(parseBindings('/users/{{user}}')).toEqual([{ param: 'user', column: 'id' }])
    })

    test('handles various column name formats', () => {
      expect(parseBindings('/users/{user:uuid}')).toEqual([{ param: 'user', column: 'uuid' }])
      expect(parseBindings('/users/{user:user_id}')).toEqual([{ param: 'user', column: 'user_id' }])
      expect(parseBindings('/users/{user:ID}')).toEqual([{ param: 'user', column: 'ID' }])
    })
  })
})

describe('compiled route binding contract', () => {
  const projects = {
    id: { name: 'id', columnType: 'SQLiteText', dataType: 'string' },
    name: { name: 'name', columnType: 'SQLiteText', dataType: 'string' },
  }

  test('fails closed when a bound parameter has no row parser', async () => {
    await expect(
      compileBindingPlan(
        [{ param: 'project', column: 'id' }],
        { projects },
        {}
      )
    ).rejects.toBeInstanceOf(RouteConfigurationError)
  })

  test('fails closed when nested scope cannot be proven', async () => {
    const tasks = {
      id: { name: 'id', columnType: 'SQLiteText', dataType: 'string' },
    }

    await expect(
      compileBindingPlan(
        [
          { param: 'project', column: 'id' },
          { param: 'task', column: 'id' },
        ],
        { projects, tasks },
        {
          project: S.Struct({ id: S.String, name: S.String }),
          task: S.Struct({ id: S.String }),
        }
      )
    ).rejects.toMatchObject({
      // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
      _tag: 'RouteConfigurationError',
      parent: 'projects',
      child: 'tasks',
    })
  })

  test('parses loaded rows before exposing them through bound()', async () => {
    const [binding] = await compileBindingPlan(
      [{ param: 'project', column: 'id' }],
      { projects },
      { project: S.Struct({ id: S.String, name: S.String }) }
    )

    await expect(
      decodeBoundRow(binding, { id: 'project-1', name: 42 })
    ).rejects.toMatchObject({
      // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
      _tag: 'RouteConfigurationError',
      binding: 'project',
    })
  })

  test('returns the parser output instead of the raw persisted row', async () => {
    const [binding] = await compileBindingPlan(
      [{ param: 'project', column: 'id' }],
      { projects },
      { project: S.Struct({ id: S.String }) }
    )

    await expect(
      decodeBoundRow(binding, {
        id: 'project-1',
        name: 'Internal name',
      })
    ).resolves.toEqual({ id: 'project-1' })
  })
})

describe('toHonoPath', () => {
  describe('basic Laravel to Hono conversion', () => {
    test('converts single binding to Hono format', () => {
      expect(toHonoPath('/projects/{project}')).toBe('/projects/:project')
    })

    test('converts binding with custom column to Hono format (strips column)', () => {
      expect(toHonoPath('/projects/{project:slug}')).toBe('/projects/:project')
    })

    test('converts multiple bindings', () => {
      expect(toHonoPath('/users/{user}/posts/{post}')).toBe('/users/:user/posts/:post')
    })

    test('converts deeply nested bindings', () => {
      expect(toHonoPath('/orgs/{org}/teams/{team}/projects/{project}/tasks/{task}')).toBe(
        '/orgs/:org/teams/:team/projects/:project/tasks/:task'
      )
    })

    test('converts all custom columns', () => {
      expect(toHonoPath('/users/{user:email}/posts/{post:slug}')).toBe('/users/:user/posts/:post')
    })
  })

  describe('Hono-style routes (passthrough)', () => {
    test('preserves Hono :param style unchanged', () => {
      expect(toHonoPath('/users/:id')).toBe('/users/:id')
    })

    test('preserves multiple Hono params', () => {
      expect(toHonoPath('/users/:userId/posts/:postId')).toBe('/users/:userId/posts/:postId')
    })

    test('preserves static paths', () => {
      expect(toHonoPath('/users')).toBe('/users')
      expect(toHonoPath('/api/v1/health')).toBe('/api/v1/health')
      expect(toHonoPath('/')).toBe('/')
    })

    test('preserves wildcard routes', () => {
      expect(toHonoPath('/files/*')).toBe('/files/*')
      expect(toHonoPath('/api/*')).toBe('/api/*')
    })

    test('preserves regex routes', () => {
      expect(toHonoPath('/users/:id{[0-9]+}')).toBe('/users/:id{[0-9]+}')
    })
  })

  describe('mixed Hono and Laravel notation', () => {
    test('converts Laravel bindings while preserving Hono params', () => {
      expect(toHonoPath('/users/:userId/projects/{project}')).toBe('/users/:userId/projects/:project')
    })

    test('handles Laravel before Hono', () => {
      expect(toHonoPath('/orgs/{org}/users/:userId')).toBe('/orgs/:org/users/:userId')
    })

    test('handles complex mixed routes', () => {
      expect(toHonoPath('/api/:version/users/{user}/posts/:postId/comments/{comment}')).toBe(
        '/api/:version/users/:user/posts/:postId/comments/:comment'
      )
    })

    test('handles Laravel with custom column mixed with Hono', () => {
      expect(toHonoPath('/teams/:teamId/projects/{project:slug}/tasks/:taskId')).toBe(
        '/teams/:teamId/projects/:project/tasks/:taskId'
      )
    })

    test('handles alternating styles', () => {
      expect(toHonoPath('/{a}/:b/{c}/:d/{e}')).toBe('/:a/:b/:c/:d/:e')
    })
  })

  describe('edge cases', () => {
    test('handles binding at root', () => {
      expect(toHonoPath('/{user}')).toBe('/:user')
    })

    test('handles binding with trailing slash', () => {
      expect(toHonoPath('/users/{user}/')).toBe('/users/:user/')
    })

    test('handles consecutive bindings without separators', () => {
      expect(toHonoPath('/{org}/{project}/{task}')).toBe('/:org/:project/:task')
    })

    test('handles single character param names', () => {
      expect(toHonoPath('/users/{u}/posts/{p}')).toBe('/users/:u/posts/:p')
    })

    test('handles underscored param names', () => {
      expect(toHonoPath('/user_profiles/{user_profile}')).toBe('/user_profiles/:user_profile')
    })

    test('handles numeric-suffixed param names', () => {
      expect(toHonoPath('/items/{item1}/subitems/{item2}')).toBe('/items/:item1/subitems/:item2')
    })

    test('handles empty path', () => {
      expect(toHonoPath('')).toBe('')
    })

    test('handles incomplete braces (no conversion)', () => {
      expect(toHonoPath('/users/{user')).toBe('/users/{user')
      expect(toHonoPath('/users/user}')).toBe('/users/user}')
    })

    test('handles double braces', () => {
      expect(toHonoPath('/users/{{user}}')).toBe('/users/{:user}')
    })

    test('preserves query string portion', () => {
      expect(toHonoPath('/users/{user}?include=posts')).toBe('/users/:user?include=posts')
    })
  })
})

describe('pluralize', () => {
  test('adds s to regular words', () => {
    expect(pluralize('user')).toBe('users')
    expect(pluralize('project')).toBe('projects')
    expect(pluralize('post')).toBe('posts')
  })

  test('handles words ending in consonant + y', () => {
    expect(pluralize('category')).toBe('categories')
    expect(pluralize('company')).toBe('companies')
    expect(pluralize('city')).toBe('cities')
  })

  test('handles words ending in vowel + y', () => {
    expect(pluralize('day')).toBe('days')
    expect(pluralize('key')).toBe('keys')
    expect(pluralize('toy')).toBe('toys')
  })

  test('handles words ending in s, x, z, ch, sh', () => {
    expect(pluralize('class')).toBe('classes')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('buzz')).toBe('buzzes')
    expect(pluralize('match')).toBe('matches')
    expect(pluralize('wish')).toBe('wishes')
    expect(pluralize('bus')).toBe('buses')
  })
})

describe('bound() accessor', () => {
  test('retrieves bound model from context', async () => {
    const models = new Map<string, unknown>()
    models.set('project', { id: '123', name: 'Test Project' })

    const effect = Effect.gen(function* () {
      const project = yield* bound('project')

      return project
    })

    const result = await Effect.runPromise(
      effect.pipe(Effect.provideService(BoundModels, models))
    )

    expect(result).toEqual({ id: '123', name: 'Test Project' })
  })

  test('fails with BoundModelNotFound for missing binding', async () => {
    const models = new Map<string, unknown>()

    const effect = Effect.gen(function* () {
      const project = yield* bound('project')

      return project
    })

    const result = await Effect.runPromiseExit(
      effect.pipe(Effect.provideService(BoundModels, models))
    )

    expect(result._tag).toBe('Failure')

    if (Predicate.isTagged(result, 'Failure')) {
      const error = result.cause
      // The error should be a BoundModelNotFound
      expect(String(error)).toContain('BoundModelNotFound')
      expect(String(error)).toContain('project')
    }
  })
})

describe('parseBindings and toHonoPath consistency', () => {
  const testCases = [
    // [input, expectedHonoPath, expectedBindings]
    ['/projects/{project}', '/projects/:project', [{ param: 'project', column: 'id' }]],
    ['/projects/{project:slug}', '/projects/:project', [{ param: 'project', column: 'slug' }]],
    ['/users/{user}/posts/{post}', '/users/:user/posts/:post', [
      { param: 'user', column: 'id' },
      { param: 'post', column: 'id' },
    ]],
    ['/api/:version/users/{user}', '/api/:version/users/:user', [{ param: 'user', column: 'id' }]],
    ['/users/:id', '/users/:id', []],
    ['/static/path', '/static/path', []],
    ['/', '/', []],
  ] as const

  test.each(testCases)(
    'route "%s" converts to "%s" with correct bindings',
    (input, expectedPath, expectedBindings) => {
      expect(toHonoPath(input)).toBe(expectedPath)
      expect(parseBindings(input)).toEqual(expectedBindings)
    }
  )

  test('binding param names match Hono param names after conversion', () => {
    const routes = [
      '/users/{user}',
      '/users/{user}/posts/{post}',
      '/orgs/{org:slug}/teams/{team}/projects/{project:uuid}',
    ]

    for (const route of routes) {
      const bindings = parseBindings(route)
      const honoPath = toHonoPath(route)

      // Each binding param should appear as :param in the Hono path
      for (const binding of bindings) {
        expect(honoPath).toContain(`:${binding.param}`)
      }
    }
  })
})

describe('Route Model Binding Integration', () => {
  describe('route registration with different path styles', () => {
    test('Laravel-style routes work without schema (no binding resolution)', async () => {
      const app = new Hono()

      app.use(
        '*',
        honertia({
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        })
      )

      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/projects/{project}',
        Effect.succeed(new Response('Project page'))
      )

      const res = await app.request('/projects/123')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Project page')
    })

    test('Laravel-style routes with custom column work', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/projects/{project:slug}',
        Effect.succeed(new Response('Project by slug'))
      )

      const res = await app.request('/projects/my-awesome-project')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Project by slug')
    })

    test('Hono-style routes still work (backward compatibility)', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/projects/:id',
        Effect.succeed(new Response('Project by ID'))
      )

      const res = await app.request('/projects/456')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Project by ID')
    })

    test('mixed Hono and Laravel styles work together', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/api/:version/projects/{project}',
        Effect.succeed(new Response('Mixed styles'))
      )

      const res = await app.request('/api/v1/projects/123')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Mixed styles')
    })

    test('nested Laravel-style routes work', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/users/{user}/posts/{post}/comments/{comment}',
        Effect.succeed(new Response('Deeply nested'))
      )

      const res = await app.request('/users/1/posts/2/comments/3')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Deeply nested')
    })

    test('all HTTP methods support Laravel-style binding', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      const routes = effectRoutes(app)

      routes.get('/items/{item}', Effect.succeed(new Response('GET')))
      routes.post('/items/{item}', Effect.succeed(new Response('POST')))
      routes.put('/items/{item}', Effect.succeed(new Response('PUT')))
      routes.patch('/items/{item}', Effect.succeed(new Response('PATCH')))
      routes.delete('/items/{item}', Effect.succeed(new Response('DELETE')))

      expect((await app.request('/items/1', { method: 'GET' })).status).toBe(200)
      expect(await (await app.request('/items/1', { method: 'GET' })).text()).toBe('GET')

      expect((await app.request('/items/1', { method: 'POST' })).status).toBe(200)
      expect(await (await app.request('/items/1', { method: 'POST' })).text()).toBe('POST')

      expect((await app.request('/items/1', { method: 'PUT' })).status).toBe(200)
      expect(await (await app.request('/items/1', { method: 'PUT' })).text()).toBe('PUT')

      expect((await app.request('/items/1', { method: 'PATCH' })).status).toBe(200)
      expect(await (await app.request('/items/1', { method: 'PATCH' })).text()).toBe('PATCH')

      expect((await app.request('/items/1', { method: 'DELETE' })).status).toBe(200)
      expect(await (await app.request('/items/1', { method: 'DELETE' })).text()).toBe('DELETE')
    })

    test('prefix() works with Laravel-style routes', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app)
        .prefix('/api/v1')
        .get('/projects/{project}', Effect.succeed(new Response('Prefixed')))

      const res = await app.request('/api/v1/projects/123')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Prefixed')
    })

    test('group() works with Laravel-style routes', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app)
        .prefix('/admin')
        .group((route) => {
          route.get('/users/{user}', Effect.succeed(new Response('Admin user')))
          route.get('/projects/{project:slug}', Effect.succeed(new Response('Admin project')))
        })

      expect((await app.request('/admin/users/1')).status).toBe(200)
      expect(await (await app.request('/admin/users/1')).text()).toBe('Admin user')

      expect((await app.request('/admin/projects/my-project')).status).toBe(200)
      expect(await (await app.request('/admin/projects/my-project')).text()).toBe('Admin project')
    })
  })

  describe('params schema validation with Laravel-style routes', () => {
    test('validates params schema and 404s invalid values with Laravel syntax', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/projects/{project}',
        Effect.succeed(new Response('Validated')),
        { params: S.Struct({ project: uuid }) }
      )

      const invalid = await app.request('/projects/not-a-uuid')
      expect(invalid.status).toBe(404)

      const valid = await app.request('/projects/123e4567-e89b-12d3-a456-426614174000')
      expect(valid.status).toBe(200)
      expect(await valid.text()).toBe('Validated')
    })

    test('validates multiple params with Laravel syntax', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/users/{user}/posts/{post}',
        Effect.succeed(new Response('Both valid')),
        {
          params: S.Struct({
            user: uuid,
            post: uuid,
          }),
        }
      )

      // Both invalid
      const bothInvalid = await app.request('/users/bad/posts/also-bad')
      expect(bothInvalid.status).toBe(404)

      // First valid, second invalid
      const secondInvalid = await app.request(
        '/users/123e4567-e89b-12d3-a456-426614174000/posts/not-uuid'
      )

      expect(secondInvalid.status).toBe(404)

      // Both valid
      const bothValid = await app.request(
        '/users/123e4567-e89b-12d3-a456-426614174000/posts/987fcdeb-51a2-3bc4-a567-890123456789'
      )

      expect(bothValid.status).toBe(200)
      expect(await bothValid.text()).toBe('Both valid')
    })

    test('validates params with custom column syntax', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      // Even with :slug column, the param name is still 'project'
      effectRoutes(app).get(
        '/projects/{project:slug}',
        Effect.succeed(new Response('Slug validated')),
        {
          params: S.Struct({
            project: S.String.check(
              S.isMinLength(3),
              S.isMaxLength(50)
            ),
          }),
        }
      )

      const tooShort = await app.request('/projects/ab')
      expect(tooShort.status).toBe(404)

      const valid = await app.request('/projects/my-awesome-project')
      expect(valid.status).toBe(200)
    })

    test('validates mixed Hono and Laravel params', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/api/:version/projects/{project}',
        Effect.succeed(new Response('Mixed validated')),
        {
          params: S.Struct({
            version: S.Literals(['v1', 'v2']),
            project: uuid,
          }),
        }
      )

      // Invalid version
      const badVersion = await app.request('/api/v3/projects/123e4567-e89b-12d3-a456-426614174000')
      expect(badVersion.status).toBe(404)

      // Invalid project
      const badProject = await app.request('/api/v1/projects/not-uuid')
      expect(badProject.status).toBe(404)

      // Both valid
      const valid = await app.request('/api/v1/projects/123e4567-e89b-12d3-a456-426614174000')
      expect(valid.status).toBe(200)
      expect(await valid.text()).toBe('Mixed validated')
    })

    test('params validation runs before model binding', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      // Even without schema configured, params validation should work
      effectRoutes(app).get(
        '/projects/{project}',
        Effect.succeed(new Response('Validated first')),
        { params: S.Struct({ project: uuid }) }
      )

      // This should 404 from params validation, not from model binding
      const invalid = await app.request('/projects/invalid-uuid')
      expect(invalid.status).toBe(404)
    })

    test('bound() gives helpful RouteConfigurationError when schema not provided', async () => {
      const app = new Hono()
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      // Set up error handler to render error pages
      registerErrorHandlers(app, { component: 'Error' })

      // Route with bindings but no schema - using bound() should error helpfully
      effectRoutes(app).get(
        '/projects/{project}',
        Effect.gen(function* () {
          const project = yield* bound('project')

          return Response.json(project)
        })
      )

      const res = await app.request('/projects/123')
      expect(res.status).toBe(500)

      const body = await res.json()
      // Error is rendered via Honertia's error component (not raw JSON)
      expect(body.component).toBe('Error')
      expect(body.props.status).toBe(500)
      // In prod, message is hidden; in dev (with env var), it shows the actual error
      expect(body.props.message).toBeDefined()
    })
  })
})

describe('columnTypeToSchema', () => {
  // Helper to decode with the dynamically returned schema
  // oxlint-disable-next-line effecttsgo/schema-sync -- These tests deliberately exercise the synchronous throwing decoder with toThrow; their schemas require no runtime services.
  const decodeWith = (schema: S.Constraint) => S.decodeUnknownSync(schema)

  describe('UUID types', () => {
    test('PgUUID returns UUID schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgUUID'))

      // Valid UUID should pass
      expect(decode('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000')

      // Invalid UUID should throw
      expect(() => decode('not-a-uuid')).toThrow()
    })
  })

  describe('Integer types', () => {
    test('PgInteger returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('PgInteger'))

      expect(decode('42')).toBe(42)
      expect(decode('0')).toBe(0)
      expect(decode('-10')).toBe(-10)

      // Non-integer should throw
      expect(() => decode('3.14')).toThrow()
      expect(() => decode('abc')).toThrow()
    })

    test('SQLiteInteger returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('SQLiteInteger'))
      expect(decode('100')).toBe(100)
    })

    test('MySqlInt returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('MySqlInt'))
      expect(decode('999')).toBe(999)
    })
  })

  describe('BigInt types', () => {
    test('PgBigInt64 returns BigInt schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgBigInt64'))
      expect(decode('9007199254740993')).toBe(9007199254740993n)
    })
  })

  describe('Numeric/Decimal types', () => {
    test('PgNumeric returns NumberFromString', () => {
      const decode = decodeWith(columnTypeToSchema('PgNumeric'))

      expect(decode('3.14159')).toBe(3.14159)
      expect(decode('42')).toBe(42)
    })

    test('PgDoublePrecision returns NumberFromString', () => {
      const decode = decodeWith(columnTypeToSchema('PgDoublePrecision'))
      expect(decode('1.23456789')).toBe(1.23456789)
    })

    test('rejects non-finite numeric route parameters', () => {
      for (const type of ['PgNumeric', 'PgDoublePrecision', 'MySqlDecimal', 'SQLiteReal']) {
        const decode = decodeWith(columnTypeToSchema(type))

        for (const value of ['NaN', 'Infinity', '-Infinity', '1e999']) {
          expect(() => decode(value)).toThrow()
        }
      }
    })
  })

  describe('String types', () => {
    test('PgText returns String schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgText'))

      expect(decode('hello world')).toBe('hello world')
      expect(decode('')).toBe('')
    })

    test('PgVarchar returns String schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgVarchar'))
      expect(decode('some-slug')).toBe('some-slug')
    })

    test('SQLiteText returns String schema', () => {
      const decode = decodeWith(columnTypeToSchema('SQLiteText'))
      expect(decode('sqlite text')).toBe('sqlite text')
    })
  })

  describe('Boolean types', () => {
    test('PgBoolean transforms string to boolean (case-insensitive)', () => {
      const decode = decodeWith(columnTypeToSchema('PgBoolean'))

      expect(decode('true')).toBe(true)
      expect(decode('TRUE')).toBe(true)
      expect(decode('True')).toBe(true)
      expect(decode('1')).toBe(true)
      expect(decode('false')).toBe(false)
      expect(decode('FALSE')).toBe(false)
      expect(decode('0')).toBe(false)
      expect(decode('anything-else')).toBe(false)
    })

    test('SQLiteBoolean transforms string to boolean', () => {
      const decode = decodeWith(columnTypeToSchema('SQLiteBoolean'))

      expect(decode('true')).toBe(true)
      expect(decode('1')).toBe(true)
      expect(decode('false')).toBe(false)
      expect(decode('0')).toBe(false)
    })
  })

  describe('Unknown types', () => {
    test('unknown column type returns String schema as fallback', () => {
      const decode = decodeWith(columnTypeToSchema('SomeUnknownType'))
      expect(decode('anything')).toBe('anything')
    })
  })
})

describe('inferParamsSchema', () => {
  // Helper to decode with the dynamically returned schema
  // oxlint-disable-next-line effecttsgo/schema-sync -- These tests deliberately exercise the synchronous throwing decoder with toThrow; their schemas require no runtime services.
  const decodeWith = (schema: S.Constraint) => S.decodeUnknownSync(schema)

  // Mock Drizzle-like schema for testing
  const mockSchema = {
    projects: {
      id: { columnType: 'PgUUID', dataType: 'string', name: 'id' },
      slug: { columnType: 'PgVarchar', dataType: 'string', name: 'slug' },
      position: { columnType: 'PgInteger', dataType: 'number', name: 'position' },
    },
    users: {
      id: { columnType: 'PgInteger', dataType: 'number', name: 'id' },
      email: { columnType: 'PgText', dataType: 'string', name: 'email' },
    },
    posts: {
      id: { columnType: 'PgBigInt64', dataType: 'bigint', name: 'id' },
    },
  }

  test('infers UUID schema for UUID column', () => {
    const bindings = parseBindings('/projects/{project}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).not.toBeNull()

    assert.ok(schema)
    const decode = decodeWith(schema)

    // Valid UUID
    expect(decode({ project: '123e4567-e89b-12d3-a456-426614174000' })).toEqual({
      project: '123e4567-e89b-12d3-a456-426614174000',
    })

    // Invalid UUID should throw
    expect(() => decode({ project: 'not-a-uuid' })).toThrow()
  })

  test('infers String schema for text/varchar column with custom column syntax', () => {
    const bindings = parseBindings('/projects/{project:slug}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).not.toBeNull()

    assert.ok(schema)
    const decode = decodeWith(schema)

    // Any string should work for slug
    expect(decode({ project: 'my-awesome-project' })).toEqual({
      project: 'my-awesome-project',
    })
  })

  test('infers Integer schema for integer column', () => {
    const bindings = parseBindings('/users/{user}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).not.toBeNull()

    assert.ok(schema)
    const decode = decodeWith(schema)

    // String number should be decoded to number
    expect(decode({ user: '42' })).toEqual({ user: 42 })

    // Non-numeric should throw
    expect(() => decode({ user: 'abc' })).toThrow()
  })

  test('infers BigInt schema for bigint column', () => {
    const bindings = parseBindings('/posts/{post}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).not.toBeNull()

    assert.ok(schema)
    const decode = decodeWith(schema)

    expect(decode({ post: '9007199254740993' })).toEqual({ post: 9007199254740993n })
  })

  test('infers schema for multiple bindings', () => {
    const bindings = parseBindings('/users/{user}/projects/{project}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).not.toBeNull()

    assert.ok(schema)
    const decode = decodeWith(schema)

    expect(
      decode({
        user: '1',
        project: '123e4567-e89b-12d3-a456-426614174000',
      })
    ).toEqual({
      user: 1,
      project: '123e4567-e89b-12d3-a456-426614174000',
    })
  })

  test('returns null for empty bindings', () => {
    const bindings = parseBindings('/static/path')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).toBeNull()
  })

  test('returns null when table not found in schema', () => {
    const bindings = parseBindings('/unknown/{unknown}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).toBeNull()
  })

  test('returns null when column not found in table', () => {
    const bindings = parseBindings('/projects/{project:nonexistent}')
    const schema = inferParamsSchema(bindings, mockSchema)

    expect(schema).toBeNull()
  })
})
