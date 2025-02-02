import fs from 'fs'
import path from 'path'

import execa from 'execa'
import Listr from 'listr'
import VerboseRenderer from 'listr-verbose-renderer'
import rimraf from 'rimraf'
import terminalLink from 'terminal-link'

import { buildApi } from '@redwoodjs/internal/dist/build/api'
import { loadAndValidateSdls } from '@redwoodjs/internal/dist/validateSchema'
import { detectPrerenderRoutes } from '@redwoodjs/prerender/detection'
import { timedTelemetry, errorTelemetry } from '@redwoodjs/telemetry'

import { getPaths } from '../lib'
import c from '../lib/colors'
import { generatePrismaCommand } from '../lib/generatePrismaClient'

import { getTasks as getPrerenderTasks } from './prerenderHandler'

export const handler = async ({
  side = ['api', 'web'],
  verbose = false,
  performance = false,
  stats = false,
  prisma = true,
  prerender,
}) => {
  const rwjsPaths = getPaths()

  if (performance) {
    console.log('Measuring Web Build Performance...')
    execa.sync(
      `yarn cross-env NODE_ENV=production webpack --config ${require.resolve(
        '@redwoodjs/core/config/webpack.perf.js'
      )}`,
      { stdio: 'inherit', shell: true, cwd: rwjsPaths.web.base }
    )
    // We do not want to continue building...
    return
  }

  if (stats) {
    console.log('Building Web Stats...')
    execa.sync(
      `yarn cross-env NODE_ENV=production webpack --config ${require.resolve(
        '@redwoodjs/core/config/webpack.stats.js'
      )}`,
      { stdio: 'inherit', shell: true, cwd: rwjsPaths.web.base }
    )
    // We do not want to continue building...
    return
  }

  const tasks = [
    side.includes('api') &&
      prisma && {
        title: 'Generating Prisma Client...',
        task: async () => {
          const { cmd, args } = generatePrismaCommand(rwjsPaths.api.dbSchema)
          return execa(cmd, args, {
            stdio: verbose ? 'inherit' : 'pipe',
            shell: true,
            cwd: rwjsPaths.api.base,
          })
        },
      },
    side.includes('api') && {
      title: 'Verifying graphql schema...',
      task: loadAndValidateSdls,
    },
    side.includes('api') && {
      title: 'Building API...',
      task: () => {
        const { errors, warnings } = buildApi()

        if (errors.length) {
          console.error(errors)
        }
        if (warnings.length) {
          console.warn(warnings)
        }
      },
    },
    side.includes('web') && {
      // Clean web
      title: 'Cleaning Web...',
      task: () => {
        rimraf.sync(rwjsPaths.web.dist)
      },
    },
    side.includes('web') && {
      title: 'Building Web...',
      task: async () => {
        await execa(
          `yarn cross-env NODE_ENV=production webpack --config ${require.resolve(
            '@redwoodjs/core/config/webpack.production.js'
          )}`,
          {
            stdio: verbose ? 'inherit' : 'pipe',
            shell: true,
            cwd: rwjsPaths.web.base,
          }
        )

        console.log('Creating 200.html...')

        const indexHtmlPath = path.join(getPaths().web.dist, 'index.html')

        fs.copyFileSync(
          indexHtmlPath,
          path.join(getPaths().web.dist, '200.html')
        )
      },
    },
    side.includes('web') &&
      prerender && {
        title: 'Prerendering Web...',
        task: async () => {
          const prerenderRoutes = detectPrerenderRoutes()
          if (prerenderRoutes.length === 0) {
            return `You have not marked any "prerender" in your ${terminalLink(
              'Routes',
              'file://' + rwjsPaths.web.routes
            )}.`
          }
          return new Listr(await getPrerenderTasks(), {
            renderer: verbose && VerboseRenderer,
            concurrent: true, // Re-use prerender tasks, but run them in parallel to speed things up
          })
        },
      },
  ].filter(Boolean)

  const jobs = new Listr(tasks, {
    renderer: verbose && VerboseRenderer,
  })

  try {
    await timedTelemetry(process.argv, { type: 'build' }, async () => {
      await jobs.run()
    })
  } catch (e) {
    console.log(c.error(e.message))
    errorTelemetry(process.argv, e.message)
    process.exit(1)
  }
}
