import process from 'node:process'
import { resolveDtsHMR } from '@vue-macros/api'
import {
  createFilter,
  detectVueVersion,
  FilterFileType,
  getFilterPattern,
  type BaseOptions,
  type MarkRequired,
} from '@vue-macros/common'
import { generatePluginName } from '#macros' with { type: 'macro' }
import {
  createUnplugin,
  type UnpluginContextMeta,
  type UnpluginInstance,
} from 'unplugin'
import { transformBetterDefine } from './core'

export type Options = BaseOptions
export type OptionsResolved = MarkRequired<
  Options,
  'include' | 'version' | 'isProduction'
>

function resolveOptions(
  options: Options,
  framework: UnpluginContextMeta['framework'],
): OptionsResolved {
  const version = options.version || detectVueVersion()
  const include = getFilterPattern(
    [FilterFileType.VUE_SFC_WITH_SETUP, FilterFileType.SETUP_SFC],
    framework,
  )
  return {
    include,
    isProduction: process.env.NODE_ENV === 'production',
    ...options,
    version,
  }
}

const name = generatePluginName()

const plugin: UnpluginInstance<Options | undefined, false> = createUnplugin(
  (userOptions = {}, { framework }) => {
    const options = resolveOptions(userOptions, framework)
    const filter = createFilter(options)

    if (process.env.VUE_MACROS_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[vue-macros][better-define] plugin init', {
        framework,
        isProduction: options.isProduction,
      })
    }

    return {
      name,
      enforce: 'pre',

      transformInclude: filter,
      transform(code, id) {
        if (process.env.VUE_MACROS_DEBUG) {
          // eslint-disable-next-line no-console
          console.warn('[vue-macros][better-define] transform', id)
        }
        return transformBetterDefine(code, id, options.isProduction).match(
          (res) => res,
          (error) => {
            this.warn(`${name} ${error}`)
            console.warn(error)
          },
        )
      },

      vite: {
        configResolved(config) {
          options.isProduction ??= config.isProduction
        },

        handleHotUpdate: resolveDtsHMR,
      },
    }
  },
)
export default plugin
