import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const sourceRoot = resolve('src-tauri/icons/android')
const resourcesRoot = resolve('src-tauri/gen/android/app/src/main/res')
const resourceDirectories = [
  'mipmap-anydpi-v26',
  'mipmap-hdpi',
  'mipmap-mdpi',
  'mipmap-xhdpi',
  'mipmap-xxhdpi',
  'mipmap-xxxhdpi',
  'values',
]

for (const directory of resourceDirectories) {
  const sourceDirectory = join(sourceRoot, directory)
  const destinationDirectory = join(resourcesRoot, directory)
  await mkdir(destinationDirectory, { recursive: true })

  for (const filename of await readdir(sourceDirectory)) {
    if (directory.startsWith('mipmap-') && !filename.startsWith('ic_launcher')) continue
    await copyFile(join(sourceDirectory, filename), join(destinationDirectory, filename))
  }
}
