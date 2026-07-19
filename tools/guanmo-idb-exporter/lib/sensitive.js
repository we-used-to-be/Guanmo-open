/**
 * sensitive.js — 敏感数据过滤
 *
 * settings 中的 API Key、Token 等敏感项必须跳过或脱敏。
 */

// 敏感字段名模式（不区分大小写）
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /auth[_-]?token/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /bearer/i,
  /private[_-]?key/i,
  /encryption[_-]?key/i,
];

// 已知的敏感字段路径（精确匹配）
const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secretKey',
  'secret_key',
  'privateKey',
  'private_key',
  'token',
  'password',
  'credential',
]);

// settings 中需要脱敏的字段路径（点分隔）
const SETTINGS_SENSITIVE_PATHS = [
  'ai.apiKey',
  'ai.api_key',
  'ai.embedding.apiKey',
  'ai.embedding.api_key',
  'webSearch.apiKey',
  'webSearch.api_key',
];

/**
 * 判断字段名是否敏感
 * @param {string} fieldName
 * @returns {boolean}
 */
function isSensitiveField(fieldName) {
  if (SENSITIVE_FIELDS.has(fieldName)) return true;
  return SENSITIVE_PATTERNS.some(p => p.test(fieldName));
}

/**
 * 对敏感值进行脱敏
 * @param {string} value
 * @returns {string}
 */
function maskValue(value) {
  if (typeof value !== 'string') return '***';
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***' + value.slice(-4);
}

/**
 * 递归过滤对象中的敏感字段
 * @param {any} obj
 * @returns {any}
 */
export function filterSensitiveFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(filterSensitiveFields);
  }

  const filtered = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      // 脱敏处理：保留字段名，替换值
      filtered[key] = maskValue(String(value ?? ''));
      filtered[`${key}_masked`] = true;
    } else if (typeof value === 'object' && value !== null) {
      filtered[key] = filterSensitiveFields(value);
    } else {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * 检查 settings 记录是否包含敏感数据
 * @param {object} record
 * @returns {string[]} 敏感字段名列表
 */
export function findSensitiveFields(record) {
  const sensitive = [];
  if (!record || typeof record !== 'object') return sensitive;

  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveField(key)) {
      sensitive.push(key);
    }
    if (typeof value === 'object' && value !== null) {
      const nested = findSensitiveFields(value);
      for (const field of nested) {
        sensitive.push(`${key}.${field}`);
      }
    }
  }
  return sensitive;
}
