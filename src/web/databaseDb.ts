import { UnsupportedCapabilityError } from './externalHttp'
export function isDatabaseReady(): false { return false }
export function getDatabase(): never { throw new UnsupportedCapabilityError('数据库相关能力') }
export async function initDatabase(): Promise<never> { throw new UnsupportedCapabilityError('数据库相关能力') }
