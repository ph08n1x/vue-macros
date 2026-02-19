import process from 'node:process'

if (process.env.VUE_MACROS_DEBUG) {
  // eslint-disable-next-line no-console
  console.warn('--- vue-macros debug build ---')
  // eslint-disable-next-line no-console
  console.warn('[vue-macros][api] loaded')
}

export * from '@vue-macros/common'

export * from './error'
export * from './vue'
export * from './ts'
