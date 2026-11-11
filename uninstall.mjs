/**
 * 卸载本插件：撤掉 install.mjs 加的三处改动。
 *  1. 删 profile node_modules 里的 symlink
 *  2. 从 cordis.patch.yml 删掉带标记的激活段落
 *  3. 从 profile package.json 的 dependencies 删掉 link 依赖
 *
 * 同时清理旧名 @local/reading-notes 的残留（2026-11-11 改名前装过的那份）。
 * 不碰 .backup/ 里的备份（留着做人工回溯）。
 * 用法：node uninstall.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const PKG_NAME = '@local/gloss'
const LEGACY_PKG_NAME = '@local/reading-notes'
const rawProfileDir =
  process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh/profiles/desktop')
const profileDir = fs.existsSync(rawProfileDir) ? fs.realpathSync(rawProfileDir) : rawProfileDir
const profilePkgPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')

/** 从 patch 文本里删掉一段管理块（含首尾标记）。返回 [新文本, 是否删除]。 */
function stripPatchBlock(text, markBegin, markEnd) {
  const begin = text.indexOf(markBegin)
  const end = text.indexOf(markEnd)
  if (begin < 0 || end <= begin) return [text, false]
  const cleaned = (text.slice(0, begin) + text.slice(end + markEnd.length))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
  return [cleaned, true]
}

/** 撤掉一个包名的三处写入，返回实际撤掉的项。 */
function removeEntries(pkgName) {
  const removed = []
  const linkPath = path.join(profileDir, 'node_modules', pkgName)
  try {
    fs.unlinkSync(linkPath)
    removed.push('symlink')
  } catch {
    /* 没有就算了 */
  }
  if (fs.existsSync(patchPath)) {
    const [cleaned, didRemove] = stripPatchBlock(
      fs.readFileSync(patchPath, 'utf8'),
      '# >>> ' + pkgName,
      '# <<< ' + pkgName,
    )
    if (didRemove) {
      fs.writeFileSync(patchPath, cleaned)
      removed.push('patch')
    }
  }
  if (fs.existsSync(profilePkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
    if (pkg.dependencies && pkg.dependencies[pkgName]) {
      delete pkg.dependencies[pkgName]
      fs.writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + '\n')
      removed.push('dependency')
    }
  }
  return removed
}

for (const [pkgName, label] of [
  [PKG_NAME, '本插件'],
  [LEGACY_PKG_NAME, '旧名'],
]) {
  const removed = removeEntries(pkgName)
  console.log(`[${label}] ${pkgName}: ${removed.length ? '已撤销 ' + removed.join(', ') : '没有残留，跳过'}`)
}

console.log('\n当前状态:')
if (fs.existsSync(profilePkgPath)) {
  const check = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
  console.log('  dependency 残留 =', (check.dependencies || {})[PKG_NAME] ?? '无')
  console.log('  旧名依赖残留   =', (check.dependencies || {})[LEGACY_PKG_NAME] ?? '无')
} else {
  console.log('  dependency 残留 = 无法检查（profile package.json 不存在）')
}
console.log('  patch 标记残留 =', fs.existsSync(patchPath) && fs.readFileSync(patchPath, 'utf8').includes('# >>> ' + PKG_NAME))
console.log('  symlink 残留   =', fs.existsSync(path.join(profileDir, 'node_modules', PKG_NAME)))
console.log('\n浏览器半侧：刷新页面后入口消失（必要时重启 DSH）。')
