import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

const clientDirectory = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(clientDirectory), resolve(clientDirectory, '..')],
    },
  },
})
