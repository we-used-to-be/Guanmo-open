# 观墨数据迁移工具 - 使用说明

## 下载

从 GitHub Releases 下载最新版本：
- 文件名：`GuanmoDatabaseMigration.zip`
- 大小：约 250 MB（包含 Node.js 运行时）

## 安装

无需安装，解压即用：

1. 将 ZIP 文件解压到任意目录
2. 例如：`D:\GuanmoDatabaseMigration\`

## 使用方法

### 第一步：退出观墨

在迁移前，请确保观墨应用已完全退出。

可以按 `Ctrl + Shift + Esc` 打开任务管理器，确认没有 `guanmo.exe` 进程。

### 第二步：运行迁移工具

双击 `GuanmoDatabaseMigration.bat` 启动工具。

### 第三步：等待迁移完成

工具会自动执行以下步骤：

1. ✅ 检测观墨状态
2. ✅ 导出 IndexedDB 数据
3. ✅ 备份原始数据库
4. ✅ 合并数据到新数据库
5. ✅ 执行完整性校验

### 第四步：查看结果

迁移完成后会显示结果：

#### ✅ 完全成功

```
完全成功
无冲突、无孤立记录
可以安全使用新数据库
```

可以立即使用新数据库。

#### ⚠️ 成功但需检查

```
成功但需检查
冲突: X 条
孤立消息: X 条
请查看迁移报告了解详情
建议手动检查后再使用新数据库
```

请查看迁移报告（`*-migration-report.json`）了解详情。

#### ❌ 失败

```
失败
完整性校验或执行过程中出现错误
请查看报告了解详情
```

请根据错误信息排查问题。

### 第五步：使用新数据库

如果迁移成功，需要手动替换正式数据库：

```bash
# 1. 关闭观墨（如果正在运行）

# 2. 备份当前数据库
copy "%APPDATA%\com.guanmo.app\guanmo.db" "%APPDATA%\com.guanmo.app\guanmo.db.bak"

# 3. 替换为迁移后的数据库
copy "输出目录\guanmo-migrated-*.db" "%APPDATA%\com.guanmo.app\guanmo.db"

# 4. 重新启动观墨
```

## 输出文件

迁移完成后会在桌面生成 `guanmo-migration` 目录，包含：

| 文件 | 说明 |
|------|------|
| `guanmo-migrated-*.db` | 迁移后的数据库 |
| `*-migration-report.json` | 详细迁移报告 |
| `guanmo.db.backup-*` | 原始数据库备份 |

## 常见问题

### Q: 双击 bat 文件没有反应？

A: 
1. 确保已解压 ZIP 文件
2. 尝试以管理员身份运行
3. 检查是否有杀毒软件拦截

### Q: 提示"未找到 Node.js"？

A: 
1. 确保 `node\` 目录存在且包含 `node.exe`
2. 或者从 https://nodejs.org/ 下载安装 Node.js

### Q: 提示"观墨正在运行"？

A: 
1. 完全退出观墨应用
2. 通过任务管理器确认没有 guanmo.exe 进程

### Q: 迁移后数据丢失？

A: 
1. 使用备份文件恢复：
   ```bash
   copy "%APPDATA%\com.guanmo.app\guanmo.db.bak" "%APPDATA%\com.guanmo.app\guanmo.db"
   ```

### Q: 可以多次运行迁移吗？

A: 可以。工具会自动检测已存在的数据，避免重复导入。

## 技术信息

- **版本**: v1.0.0
- **运行环境**: Windows 10/11
- **依赖**: Node.js v20+（已包含在便携包中）
- **数据库**: SQLite 3
- **导出**: IndexedDB via Chromium

## 获取帮助

- 查看迁移报告了解详细信息
- 提交 GitHub Issue 反馈问题

## 许可证

ISC License
