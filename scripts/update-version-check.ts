import { compareSemVer, normalizeVersion } from '../src/services/semver'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

assert(normalizeVersion(' v1.2.3 ') === '1.2.3', '应兼容 v 前缀')
assert(compareSemVer('1.3.0', '1.2.9') > 0, '次版本升级比较失败')
assert(compareSemVer('2.0.0', '1.99.99') > 0, '主版本升级比较失败')
assert(compareSemVer('1.2.3', 'v1.2.3') === 0, 'v 前缀版本应相等')
assert(compareSemVer('1.2.3', '1.2.3-beta.2') > 0, '正式版应高于预发布版')
assert(compareSemVer('1.2.3-beta.10', '1.2.3-beta.2') > 0, '预发布数字标识比较失败')
assert(compareSemVer('1.2.3+build.2', '1.2.3+build.1') === 0, '构建元数据不应影响优先级')

let invalidRejected = false
try {
  compareSemVer('1.2', '1.2.0')
} catch {
  invalidRejected = true
}
assert(invalidRejected, '无效版本号应被拒绝')

console.info('Update version checks passed')
