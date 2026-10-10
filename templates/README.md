# 工程模板（templates/）

工程模板是**现成的作品工程骨架数据**：`novel_project action=初始化工程` 时传入模板 id 即可整套拉取落盘，Agent 与用户都不必从零逐个建文件。

## 目录结构

```
templates/
├── README.md                  # 本文件：模板编写规范
├── blank/                     # 空白工程（默认模板）
│   ├── template.yml           # 模板清单（必须）
│   └── files/                 # 模板文件树（落到工程里，支持变量）
│       ├── README.md
│       ├── 大纲/总纲.md
│       └── …
├── hotblood-xuanhuan/         # 热血玄幻
├── mystery-suspense/          # 悬疑诡秘
└── romance-sweet/             # 甜宠言情
```

## template.yml（清单，扁平键即可）

```yaml
id: blank                       # 必须与目录名一致；初始化时传给 template 参数
name: 空白工程
spec: obsidian                  # 推荐规范：obsidian | webui（仅作展示，模板与规范可任意组合）
tags: 通用
description: 标准 Markdown 工程骨架：正文/大纲/设定集/人物卡/归档 + 伏笔清单、时间线、文风卡、剧情线，全部为待填占位
```

## files/ 文件树约定

- 整个目录按相对路径原样落盘到作品根目录；目录即创建。
- 内容支持变量：`{{title}}`（作品名）、`{{date}}`（初始化日期），落盘时替换。
- 不要放空目录：没有文件的目录不会被创建（需要占位的目录放 `说明.md`，工具列目录时会自动跳过它）。
- 遵守全局工程约定，Agent 侧工具依赖它们：
  - 章节文件名 `第NNN章-标题.md`（三位序号）；
  - `伏笔清单.md` 表头必须含「伏笔」列；
  - `大纲/剧情线.md` 用表格承载（线名/类型/状态/起点/终点/关键节点）；
  - `人物卡/`、`设定集/`、`大纲/`、`归档/`、`正文/` 目录名固定。

## 模板与规范的关系

**模板管内容骨架，规范管工程环境**，两者正交：

| 组合 | 效果 |
| --- | --- |
| `template=blank`（默认）+ `规范=obsidian` | 纯 Markdown，Obsidian 直接打开 |
| `template=hotblood-xuanhuan` + `规范=obsidian` | 玄幻骨架 + 纯 Markdown |
| 任意模板 + `规范=webui` | 同上骨架 + 额外安装 `.webui/` 网页管理服务 |

`规范=webui` 时无论用什么模板，都会自动安装 WebUI 资产；之后 `novel_webui` 启动即可。

## 自定义模板

在**工作区**（通常是存放多部小说的父目录）建 `templates/<你的模板id>/`，结构同上。`查询模板` 与 `初始化工程` 会优先使用工作区模板，可覆盖同名内置模板；`.webui/`、`state.json` 等运行产物不要放进模板。

## 使用方式（Agent 视角）

1. `novel_project action=查询模板` —— 列出可用模板（内置 + 工作区自定义）；
2. `novel_project action=初始化工程 title=书名 template=<id> 规范=obsidian|webui` —— 拉取模板建工程；
3. 不传 `template` 时默认拉取内置 `blank`；`templates/` 目录缺失时回退到插件内置骨架（保证安装不完整时初始化仍可用）。
