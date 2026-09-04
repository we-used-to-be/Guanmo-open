import { UnsupportedCapabilityError } from './externalHttp'
const unsupported = async (): Promise<never> => { throw new UnsupportedCapabilityError('数据库备份与迁移') }
export const exportDataBackup = unsupported
export const importDataBackup = unsupported
