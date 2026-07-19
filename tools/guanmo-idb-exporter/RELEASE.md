# 观墨数据迁移工具 - Release 使用说明

## 版本信息

- **版本**: v1.0.0
- **发布日期**: 2026-07-18
- **适用系统**: Windows 10/11 (x64)
- **Node.js 要求**: v18.0.0+

## 下载与安装

### 方式一：直接使用源码

1. 下载本项目源码
2. 确保已安装 Node.js v18+
3. 进入 `tools/guanmo-idb-exporter` 目录
4. 运行 `npm install` 安装依赖
5. 双击 `guanmo-migrate.bat` 启动

### 方式二：便携版（推荐）

1. 下载发布的压缩包
2. 解压到任意目录
3. 双击 `guanmo-migrate.bat` 启动

## 快速开始

### 第一步：退出观墨

在迁移前，请确保观墨应用已完全退出。

### 第二步：运行迁移

双击 `guanmo-migrate.bat`，工具会自动：

1. ✅ 检测 SQLite 数据库位置
2. ✅ 检测 WebView2 目录
3. ✅ 导出 IndexedDB 数据
4. ✅ 备份原始数据库
5. ✅ 合并数据到新数据库
6. ✅ 执行完整性校验
7. ✅ 生成迁移报告

### 第三步：查看结果

迁移完成后会显示结果：

- **✅ 完全成功**: 可以安全使用新数据库
- **⚠️ 成功但需检查**: 存在冲突或孤立消息，建议查看报告
- **❌ 失败**: 出现错误，查看报告了解详情

### 第四步：使用新数据库

如果迁移成功，需要手动替换正式数据库：

```bash
# 1. 关闭观墨

# 2. 备份当前数据库
copy "%APPDATA%\com.guanmo.app\guanmo.db" "%APPDATA%\com.guanmo.app\guanmo.db.bak"

# 3. 替换为迁移后的数据库
copy "输出路径\guanmo-migrated-xxx.db" "%APPDATA%\com.guanmo.app\guanmo.db"

# 4. 重新启动观墨
```

## 输出文件说明

| 文件 | 说明 |
|------|------|
| `guanmo-migrated-*.db` | 迁移后的 SQLite 数据库 |
| `guanmo-migrated-*-migration-report.json` | 详细迁移报告 |
| `guanmo.db.backup-*` | 原始数据库备份 |

## 迁移报告解读

### 统计信息

```json
{
  "stats": {
    "imported": 1359,      // 成功导入的记录数
    "skipped": 44,         // 跳过的记录数（已存在或内容相同）
    "conflicts": 7,        // 冲突数（同ID但内容不同）
    "errors": 0,           // 错误数
    "orphanMessages": 16   // 孤立消息数（session不存在）
  }
}
```

### 冲突详情

```json
{
  "conflicts": [
    {
      "store": "documents",
      "id": "doc-xxx",
      "conflictType": "file_path_duplicate",
      "sqliteRecord": {...},
      "jsonRecord": {...}
    }
  ]
}
```

### 孤立消息

```json
{
  "orphanMessages": [
    {
      "id": "msg-xxx",
      "session_id": "session-xxx",
      "role": "assistant",
      "content": "...",
      "reason": "session_id 不存在于 chat_sessions"
    }
  ]
}
```

## 常见问题

### Q: 迁移需要多长时间？

A: 取决于数据量，通常：
- 小型数据库 (< 100MB): 1-2 分钟
- 中型数据库 (100MB-500MB): 3-5 分钟
- 大型数据库 (> 500MB): 5-10 分钟

### Q: 迁移过程中可以使用电脑吗？

A: 可以，但建议不要运行观墨或其他大量使用数据库的程序。

### Q: 迁移失败了怎么办？

A: 
1. 查看迁移报告了解具体错误
2. 使用自动备份恢复原始数据库
3. 根据错误信息排查问题
4. 必要时联系技术支持

### Q: 可以只迁移部分数据吗？

A: 当前版本支持完整的数据迁移。如需部分迁移，可以：
1. 先完成完整迁移
2. 手动编辑迁移后的数据库
3. 或使用 SQL 语句提取所需数据

### Q: 迁移后可以回退吗？

A: 可以。使用自动生成的备份文件恢复：
```bash
copy "%APPDATA%\com.guanmo.app\guanmo.db.backup-*" "%APPDATA%\com.guanmo.app\guanmo.db"
```

## 技术支持

- **问题反馈**: 通过 GitHub Issues
- **文档**: 查看 README.md
- **日志**: 查看迁移报告文件

## 更新日志

### v1.0.0 (2026-07-18)

- ✅ 一键迁移功能
- ✅ 自动检测数据库位置
- ✅ SQLite Backup API 支持
- ✅ 完整性校验
- ✅ 冲突检测和报告
- ✅ 孤立消息检测
- ✅ 三档结果显示
- ✅ 详细的迁移报告

## 许可证

ISC License
