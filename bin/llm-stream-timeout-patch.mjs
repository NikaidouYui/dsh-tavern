import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { patchDeepSeekStreamTimeoutSource, patchPiAiStreamTimeoutSource } from '../tavern-plugin/lib/domain/llm-stream-timeout.js'

function patchPackageStreamTimeout(directory, expectedName, patchSource) {
  const file = path.join(directory, 'lib', 'index.js')
  let before
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (manifest.name !== expectedName) return null
    before = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const result = patchSource(before)
  if (result.status === 'unmatched') return null
  if (result.status === 'patched') return false
  writeFileSync(file, result.text)
  return true
}

/** 写入返回 true，已打补丁返回 false，宿主形状不符或读取失败返回 null。 */
export function patchPiAiStreamTimeout(directory) {
  return patchPackageStreamTimeout(directory, '@deepseek-ai/dsh-llm-pi-ai', patchPiAiStreamTimeoutSource)
}

/** 写入返回 true，已打补丁返回 false，宿主形状不符或读取失败返回 null。 */
export function patchDeepSeekStreamTimeout(directory) {
  return patchPackageStreamTimeout(directory, '@deepseek-ai/dsh-llm-deepseek', patchDeepSeekStreamTimeoutSource)
}
