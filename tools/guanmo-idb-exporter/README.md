# 观墨数据迁移工具 (guanmo-idb-export)

将观墨旧版 IndexedDB 数据迁移到 SQLite 数据库的完整工具。

## ⚠️ 重要提示

1. **必须退出观墨**: 迁移前请完全退出观墨应用，否则可能锁定数据库文件
2. **首次运行需下载 Chromium**: 工具使用 Playwright 读取 IndexedDB，首次运行会自动下载 Chromium 浏览器（约 150 MB）
3. **工具先备份并生成新 SQLite**: 工具会自动备份原始数据库，并生成新的迁移数据库，不会直接修改原数据库
4. **冲突只写报告**: 如果发现数据冲突，工具只会在报告中记录，不会自动覆盖或删除任何数据

## 功能特性

- ✅ **一键迁移**: 自动检测、导出、备份、合并、校验
- ✅ **安全可靠**: 使用 SQLite Backup API，不直接修改原始数据库
- ✅ **智能检测**: 自动定位 WebView2 和 SQLite 数据库
- ✅ **冲突检测**: 识别并报告数据冲突，不自动覆盖
- ✅ **完整性校验**: PRAGMA integrity_check + foreign_key_check
- ✅ **详细报告**: 生成完整的迁移报告

## 系统要求

- **操作系统**: Windows 10/11
- **Node.js**: v18.0.0 或更高版本（便携包已包含）
- **观墨**: 需要先退出观墨应用

## 快速开始

### 方法一：使用便携包（推荐）

1. 从 GitHub Releases 下载 `GuanmoDatabaseMigration-*.zip`
2. 解压到任意目录
3. 双击 `GuanmoDatabaseMigration.bat`
4. 按照提示操作

### 方法二：使用命令行

```bash
# 进入工具目录
cd tools\guanmo-idb-exporter

# 安装依赖
npm install

# 一键迁移（推荐）
node index.js migrate

# 或指定输出路径
node index.js migrate --output ./my-migrated.db
```

## 命令详解

### migrate - 一键迁移

自动完成整个迁移流程：

```bash
node index.js migrate [选项]
```

**选项:**
- `--sqlite <path>` - 指定 SQLite 数据库路径（默认: 自动检测）
- `--user-data-dir <path>` - 指定 WebView2 目录（默认: 自动检测）
- `--output <path>` - 输出文件路径（默认: `<sqlite>-migrated-<timestamp>.db`）

**流程:**
1. 检测 SQLite 数据库位置
2. 检测 WebView2 User Data 目录
3. 导出 IndexedDB 为 JSON
4. 备份原始 SQLite
5. 合并数据到新 SQLite
6. 执行完整性校验
7. 生成迁移报告

### detect - 检测数据库

```bash
node index.js detect [--user-data-dir <path>]
```

### export - 导出 IndexedDB

```bash
node index.js export [--output <path>] [--user-data-dir <path>]
```

### merge-sqlite - 合并到 SQLite

```bash
node index.js merge-sqlite --json <json-path> --sqlite <sqlite-path> [--output <path>]
```

## 迁移结果说明

迁移完成后会显示三档结果：

### ✅ 完全成功

```
═══════════════════════════════════════════════════════════
  迁移结果
═══════════════════════════════════════════════════════════
  ✅ 完全成功

  无冲突、无孤立记录
  可以安全使用新数据库
═══════════════════════════════════════════════════════════
```

### ⚠️ 成功但需检查

```
═══════════════════════════════════════════════════════════
  迁移结果
═══════════════════════════════════════════════════════════
  ⚠️  成功但需检查

  冲突: 7 条记录
  孤立消息: 16 条

  请查看报告了解详情
  建议手动检查后再使用新数据库
═══════════════════════════════════════════════════════════
```

### ❌ 失败

```
═══════════════════════════════════════════════════════════
  迁移结果
═══════════════════════════════════════════════════════════
  ❌ 失败

  完整性校验或执行过程中出现错误
  请查看报告了解详情
═══════════════════════════════════════════════════════════
```

## 输出文件

迁移完成后会生成以下文件：

| 文件 | 说明 |
|------|------|
| `*-migrated-*.db` | 迁移后的 SQLite 数据库 |
| `*-migration-report.json` | 详细的迁移报告 |
| `*.backup-*` | 原始数据库备份 |

## 迁移报告

报告文件包含完整的迁移信息：

```json
{
  "timestamp": "2026-07-18T00:00:00.000Z",
  "duration": 45000,
  "source": {
    "sqlite": "C:\\Users\\xxx\\AppData\\Roaming\\com.guanmo.app\\guanmo.db",
    "json": "C:\\Users\\xxx\\AppData\\Local\\Temp\\guanmo-migrate-xxx.json"
  },
  "output": {
    "path": "D:\\guanmo-migrated-xxx.db",
    "backup": "C:\\Users\\xxx\\AppData\\Roaming\\com.guanmo.app\\guanmo.db.backup-xxx"
  },
  "stats": {
    "imported": 1359,
    "skipped": 44,
    "conflicts": 7,
    "errors": 0,
    "orphanMessages": 16
  },
  "integrityCheck": true,
  "foreignKeyCheck": true,
  "conflicts": [...],
  "orphanMessages": [...]
}
```

## 冲突类型

### Documents 冲突

当同一个文件路径在 IndexedDB 和 SQLite 中都有记录，但内容不同时：

- **保留 SQLite 版本**
- **记录到冲突报告**
- **不自动覆盖**

### 孤立消息

当 chat_messages 引用的 session_id 不存在于 chat_sessions 时：

- **跳过该消息**
- **记录到孤立消息报告**
- **不猜测、不自动修复关联**

## 使用新数据库

迁移完成后，需要手动替换正式数据库：

1. **备份当前数据库**
   ```bash
   copy "%APPDATA%\com.guanmo.app\guanmo.db" "%APPDATA%\com.guanmo.app\guanmo.db.bak"
   ```

2. **关闭观墨应用**（如果正在运行）

3. **替换数据库**
   ```bash
   copy "D:\guanmo-migrated-xxx.db" "%APPDATA%\com.guanmo.app\guanmo.db"
   ```

4. **重新启动观墨**

## 常见问题

### Q: 迁移前需要做什么？

A: 
1. 确保观墨已完全退出
2. 备份重要数据（工具会自动备份，但建议额外备份）

### Q: 迁移后数据丢失了怎么办？

A: 
1. 使用自动生成的备份文件（`.backup-*`）
2. 或使用手动备份的副本

### Q: 出现"session_id 不存在"错误？

A: 这表示有些聊天消息引用的会话不存在。工具会自动跳过这些消息并记录到报告中，不影响其他数据迁移。

### Q: 如何查看详细的冲突信息？

A: 打开 `*-migration-report.json` 文件，查看 `conflicts` 和 `orphanMessages` 字段。

### Q: 可以多次运行迁移吗？

A: 可以。工具会自动检测已存在的数据，避免重复导入。幂等性测试表明多次运行结果一致。

## 技术细节

### 数据处理

- **documents**: 按 ID 和 file_path 检查，内容相同则跳过
- **chat_sessions**: 按 ID 检查
- **chat_messages**: 按 ID 检查，验证 session_id 存在性
- **memories**: 按 ID 检查，比较业务核心字段
- **settings**: 以 SQLite 为准，只补充不存在的键

### 跳过的数据

- `chunks` - 文档分块（可通过重建恢复）
- `embeddings` - 向量嵌入（可通过重建恢复）
- `embedding_jobs` - 嵌入任务队列

### 安全特性

- 使用 SQLite Backup API 创建副本
- 不直接修改原始数据库
- 完整性校验（integrity_check + foreign_key_check）
- 外键约束验证

## 开发说明

### 项目结构

```
guanmo-idb-exporter/
├── index.js              # 主入口
├── lib/
│   ├── detect.js         # WebView2 检测
│   ├── export.js         # IndexedDB 导出
│   ├── merge-sqlite.js   # SQLite 合并
│   ├── migrate.js        # 一键迁移流程
│   ├── sensitive.js      # 敏感数据过滤
│   ├── snapshot.js       # 文件快照
│   └── verify.js         # 最小验证
├── guanmo-migrate.bat    # Windows 批处理
├── package.json
└── README.md
```

### 运行测试

```bash
# 检测
node index.js detect

# 导出
node index.js export --output ./test-export.json

# 合并
node index.js merge-sqlite --json ./test-export.json --sqlite ./test.db --output ./test-merged.db

# 一键迁移
node index.js migrate --output ./test-migrated.db
```

## 许可证

ISC License
