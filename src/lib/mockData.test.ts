import { describe, expect, it } from 'vitest'

import { createDefaultBootstrap } from './mockData'

describe('createDefaultBootstrap', () => {
  it('starts browser fallback storage without demo user data', () => {
    const bootstrap = createDefaultBootstrap()

    expect(bootstrap.sessions).toEqual([])
    expect(bootstrap.sessionFolders).toEqual([])
    expect(bootstrap.macros).toEqual([])
  })
})
