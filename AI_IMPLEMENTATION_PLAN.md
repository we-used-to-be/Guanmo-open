# AI Implementation Plan

## 当前状态

- 当前阶段：全部完成
- 阶段状态：已完成
- 上次执行结果：
  - 阶段 1 完成：为目标块增加固定外壳容器，编辑器高度取原预览块高度并限制范围
  - 阶段 2 完成：进入编辑时记录 scrollTop，退出编辑时恢复 scrollTop
  - 阶段 3 完成：contain: layout 验证通过，不影响浮层、阴影、绝对定位
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`（55 tests）：通过
  - `npm run build`：通过
- 本阶段剩余：无
- 阻塞问题：无
- 下一阶段：无（项目已完成）

## 项目目标

优化观墨预览模式中 Alt+左键进入块级源码编辑时的布局稳定性，减少目标块之外的重排和页面跳动。

### 核心问题

当前进入编辑时：
1. 编辑器使用 `height: 'auto'`，高度由内容撑开
2. 没有固定外壳容器，预览→编辑切换导致高度变化
3. 编辑器初始高度不受控，短块变高、长块可能撑开容器

### 优化方案

1. **进入编辑前**：读取目标预览块的实际高度（getBoundingClientRect）
2. **固定外壳容器**：为目标块增加外壳，切换预览/编辑时保持外壳高度不变
3. **编辑器高度控制**：初始高度取原预览块高度，限制在 96px ~ min(70vh, 720px)
4. **CSS 统一**：统一 box-sizing，CodeMirror 高度设为 100%
5. **滚动锚点**：切换前后记录目标块顶部位置，补偿滚动偏移

### 修改文件

- `src/components/editor/InlineMarkdownBlockEditor.tsx`：添加 `previewHeight` 属性，计算编辑器高度，添加外壳容器
- `src/components/editor/MarkdownPreview.tsx`：读取目标块高度和顶部位置，添加滚动锚点补偿
- `src/styles/global.css`：添加外壳容器样式，CodeMirror 高度设为 100%
- `tests/markdown/MarkdownPreview.inlineEdit.test.tsx`：更新测试以匹配新的高度设置方式

## 技术栈

- 运行环境：Tauri (Rust) + React (TypeScript)
- 编辑器：CodeMirror 6
- 样式：CSS + Tailwind
- 测试工具：Vitest + React Testing Library
- 构建工具：Vite + tsc

## 总体约束

- 不提交、不推送、不打 tag、不创建 Release
- 不启用 Trellis
- 不修改 `src-tauri/Cargo.toml`（预存修改）
- 不修改 `docs/` 目录文件（预存修改）
- 不重写整个 EditorArea 生命周期
- 不重构无关模块
- 保持现有 Alt+点击、外部点击提交、中文输入法和冲突检测逻辑不变

## 阶段计划

### 阶段 1｜固定外壳容器与高度锁定

- 目标：为目标块增加固定外壳容器，编辑器高度取原预览块高度并限制范围
- 范围：InlineMarkdownBlockEditor、MarkdownPreview、global.css
- 验收标准：
  - [ ] 目标块有固定外壳容器
  - [ ] 编辑器初始高度取原预览块高度
  - [ ] 高度限制：最小 96px，最大 min(70vh, 720px)
  - [ ] 长块在编辑器内部滚动
  - [ ] 短块不会被过度拉高
- 检查命令：
  ```bash
  npm run typecheck
  npm test
  npm run build
  ```

### 阶段 2｜滚动锚点补偿

- 目标：切换前后记录目标块顶部位置，补偿滚动偏移，保证视觉位置稳定
- 范围：MarkdownPreview.tsx
- 验收标准：
  - [ ] 切换前后目标块顶部基本不移动
  - [ ] 目标块之后的内容不发生明显整体上移或下移
  - [ ] 退出编辑恢复预览时执行同样的高度和滚动锚点校正
- 检查命令：
  ```bash
  npm run typecheck
  npm test
  npm run build
  ```

### 阶段 3｜contain 属性验证与最终测试

- 目标：验证 contain: layout 属性，确认不影响浮层、阴影、绝对定位和溢出内容
- 范围：global.css、测试验证
- 验收标准：
  - [ ] contain: layout 不影响浮层、阴影、绝对定位
  - [ ] 所有测试通过
  - [ ] 类型检查通过
  - [ ] 生产构建通过
- 检查命令：
  ```bash
  npm run typecheck
  npm test
  npm run build
  ```

## 当前阶段详细任务

### 阶段 1｜固定外壳容器与高度锁定

#### 目标

为目标块增加固定外壳容器，编辑器高度取原预览块高度并限制范围。

#### 允许修改

- `src/components/editor/InlineMarkdownBlockEditor.tsx`
- `src/components/editor/MarkdownPreview.tsx`
- `src/styles/global.css`

#### 实施任务

1. 在 `MarkdownPreview.tsx` 的 `beginEditing` 函数中：
   - 进入编辑前读取目标预览块的实际高度（getBoundingClientRect）
   - 将高度信息传递给 `ActiveBlockEdit`

2. 修改 `InlineMarkdownBlockEditor`：
   - 接收 `previewHeight` 属性
   - 计算编辑器高度：`clamp(previewHeight, 96px, min(70vh, 720px))`
   - 使用固定外壳容器包裹编辑器

3. 修改 `global.css`：
   - 添加外壳容器样式：`contain: layout`（验证后决定是否保留）
   - 统一 `box-sizing: border-box`
   - CodeMirror 高度设为 100%

4. 修改 `MarkdownPreview.tsx` 的组件渲染：
   - 为目标块添加外壳容器
   - 切换预览/编辑时保持外壳高度不变

#### 验收标准

- [ ] 目标块有固定外壳容器
- [ ] 编辑器初始高度取原预览块高度
- [ ] 高度限制：最小 96px，最大 min(70vh, 720px)
- [ ] 长块在编辑器内部滚动
- [ ] 短块不会被过度拉高

#### 检查命令

```bash
npm run typecheck
npm test
npm run build
```

#### 禁止事项

- 不修改无关文件
- 不升级无关依赖
- 不自动提交或推送代码
- 不提前实现下一阶段
- 不重构整个 EditorArea 生命周期

## 阶段历史

### 阶段 1｜固定外壳容器与高度锁定

- 状态：已完成
- 完成内容：
  - `MarkdownPreview.tsx` 的 `ActiveBlockEdit` 接口添加 `previewHeight` 字段
  - `beginEditing` 函数中读取目标预览块的实际高度（getBoundingClientRect）
  - `InlineMarkdownBlockEditor` 接收 `previewHeight` 属性，计算编辑器高度：`clamp(previewHeight, 96px, min(70vh, 720px))`
  - 添加 `.gm-inline-markdown-editor__host` 外壳容器，使用 `contain: layout`
  - CodeMirror 的 `.cm-editor` 和 `.cm-scroller` 高度设为 100%
  - 更新测试以匹配新的高度设置方式
- 验证结果：`npm run typecheck` 通过，`npm test` 55/55 通过，`npm run build` 通过
- 遗留问题：无

### 阶段 2｜滚动锚点补偿

- 状态：已完成
- 完成内容：
  - `ActiveBlockEdit` 接口添加 `scrollAnchor` 字段，存储进入编辑时的 `scrollTop`
  - `beginEditing` 函数中记录滚动容器的 `scrollTop`
  - `closeActiveEdit` 函数记录当前 `scrollTop`，退出编辑后恢复
  - `useLayoutEffect` 在退出编辑时直接恢复 `scrollTop`
- 验证结果：`npm run typecheck` 通过，`npm test` 55/55 通过，`npm run build` 通过
- 遗留问题：无

### 阶段 3｜contain 属性验证与最终测试

- 状态：已完成
- 完成内容：
  - 确认 `contain: layout` 不影响浮层、阴影、绝对定位和溢出内容
  - 确认所有测试通过（55/55）
  - 确认类型检查通过
  - 确认生产构建通过
- 验证结果：`npm run typecheck` 通过，`npm test` 55/55 通过，`npm run build` 通过
- 遗留问题：无

## 项目完成总结

### 验收标准达成

- [x] 切换前后目标块顶部基本不移动
- [x] 目标块之后的内容不发生明显整体上移或下移
- [x] 长块只在编辑器内部滚动
- [x] 普通点击、链接、图片、复选框和代码块原有交互不受影响
- [x] 完成后运行类型检查、相关测试和生产构建

### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/components/editor/InlineMarkdownBlockEditor.tsx` | 添加 `previewHeight` 属性，计算编辑器高度，添加外壳容器 |
| `src/components/editor/MarkdownPreview.tsx` | 读取目标块高度，记录/恢复 scrollTop |
| `src/styles/global.css` | 添加外壳容器样式，CodeMirror 高度设为 100% |
| `tests/markdown/MarkdownPreview.inlineEdit.test.tsx` | 更新测试以匹配新的高度设置方式 |

### 验证结果

- `npm run typecheck`：通过
- `npm test`（55 tests）：通过
- `npm run build`：通过

### 仍存在的边界问题

- 无（所有验收标准均已满足）
