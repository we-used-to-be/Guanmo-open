export default class UnsupportedDatabase {
  async select(): Promise<never> { throw new Error('Web 端数据库不可用') }
  async execute(): Promise<never> { throw new Error('Web 端数据库不可用') }
}
