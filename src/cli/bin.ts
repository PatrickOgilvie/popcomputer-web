#!/usr/bin/env node
/**
 * Popcomputer Web CLI entrypoint.
 *
 * This powers the `popweb` executable distributed with the package.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRoutes, routesHelp } from './index.js'
import { runCheck, checkHelp } from './check.js'
import { runDb, dbHelp } from './db.js'
import { runGenerateAction, generateActionHelp, runGenerateCrud, generateCrudHelp } from './generate.js'
import { runGenerateFeature, generateFeatureHelp } from './feature.js'
import { runGenerateOpenApi, generateOpenApiHelp } from './openapi.js'
import { runGenerateInlineTestsRunner, generateInlineTestsRunnerHelp } from './inline-tests.js'

function mainHelp(): string {
  return `
popweb - Agent-first CLI for Popcomputer Web

USAGE:
  popweb <command> [OPTIONS]

COMMANDS:
  routes                        List registered routes
  check                         Validate project routes/configuration
  db <subcommand>               Database migration commands
  db:status                     Alias for "db status"
  db:migrate                    Alias for "db migrate"
  db:rollback                   Alias for "db rollback"
  db:generate <name>            Alias for "db generate <name>"
  generate:action <name>        Generate a colocated action file
  generate:crud <resource>      Generate CRUD action files
  generate:feature <name>       Generate a colocated feature file
  generate:openapi              Generate OpenAPI spec
  generate:tests-runner         Generate inline tests runner

EXAMPLES:
  popweb routes --app src/app.ts --json
  popweb check --app src/app.ts --verbose
  popweb db status
  popweb db:migrate --preview
  popweb generate:action projects/create --method POST --path /projects
  popweb generate:openapi --app src/app.ts --output openapi.json --format json

Run "popweb <command> --help" for command-specific options.
`.trim()
}

function commandHelp(command: string): string | null {
  switch (command) {
    case 'routes':
      return routesHelp()
    case 'check':
      return checkHelp()
    case 'db':
    case 'db:status':
    case 'db:migrate':
    case 'db:rollback':
    case 'db:generate':
      return dbHelp()
    case 'generate:action':
      return generateActionHelp()
    case 'generate:crud':
      return generateCrudHelp()
    case 'generate:feature':
      return generateFeatureHelp()
    case 'generate:openapi':
      return generateOpenApiHelp()
    case 'generate:tests-runner':
      return generateInlineTestsRunnerHelp()
    default:
      return null
  }
}

interface NormalizedCommand {
  command: string | null
  rest: string[]
}

function normalizeCommand(args: string[]): NormalizedCommand {
  if (args.length === 0) {
    return { command: null, rest: [] }
  }

  const [first, ...rest] = args

  // Support grouped form: "generate action ..."
  if (first === 'generate' && rest.length > 0) {
    const [subcommand, ...remaining] = rest
    return { command: `generate:${subcommand}`, rest: remaining }
  }

  return { command: first, rest }
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const { command, rest } = normalizeCommand(args)

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    if (rest.length > 0) {
      const help = commandHelp(rest[0])
      if (help) {
        console.log(help)
        return
      }
    }

    console.log(mainHelp())
    return
  }

  switch (command) {
    case 'routes':
      await runRoutes(rest)
      return
    case 'check':
      await runCheck(rest)
      return
    case 'db':
      await runDb(rest)
      return
    case 'db:status':
      await runDb(['status', ...rest])
      return
    case 'db:migrate':
      await runDb(['migrate', ...rest])
      return
    case 'db:rollback':
      await runDb(['rollback', ...rest])
      return
    case 'db:generate':
      await runDb(['generate', ...rest])
      return
    case 'generate:action':
      runGenerateAction(rest)
      return
    case 'generate:crud':
      runGenerateCrud(rest)
      return
    case 'generate:feature':
      runGenerateFeature(rest)
      return
    case 'generate:openapi':
      await runGenerateOpenApi(rest)
      return
    case 'generate:tests-runner':
      runGenerateInlineTestsRunner(rest)
      return
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "popweb --help" for usage')
      process.exit(1)
  }
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMain) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
