import { Link } from '@inertiajs/react'
import { eq } from 'drizzle-orm' // expect: no-server-imports-in-pages
import { href } from '@popcomputer/web/paths'
import type { FormInput, WebPage } from '@popcomputer/web/react'
import { dbQuery } from '@popcomputer/web/effect' // expect: no-server-imports-in-pages
import { env } from '../../env' // expect: no-server-imports-in-pages
import { projects } from '../../schema' // expect: no-server-imports-in-pages
import { updateProject } from '../../actions/projects/update' // expect: no-server-imports-in-pages
import type { UpdateProject } from '../../actions/projects/update'
import { type Database } from '../../db'
import { paths } from '../../paths'
import { RenameForm } from '../../components/RenameForm'

const Show: WebPage<'Projects/Show'> = ({ project }) => {
  const fields: FormInput<typeof UpdateProject> = { name: project.name }
  const db: Database | undefined = undefined
  void [eq, dbQuery, env, projects, updateProject, db, fields]

  return <Link href={href(paths.project, { project: project.id })}><RenameForm /></Link>
}

export default Show
