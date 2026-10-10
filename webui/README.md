# WebUI 工程规范（webui/）

轻量化的作品工程网页管理端：一个**零 npm 依赖**的单文件服务（`server.mjs`）+ 单文件前端（`index.html`），浏览器里管理人物卡、设定卡、大纲与剧情线、章节、伏笔与时间线，并使用 AI 味检查、全文搜索、旧稿分章、字数统计等工具。

## 核心原则：md 是唯一事实源

WebUI **不引入任何私有数据格式或数据库**。网页读写的正是工程里那批 Markdown 文件——Obsidian、Agent 工具（novel_briefing / novel_archive / novel_project…）、文件管理器与本网页看到的是同一份数据，随时混用、随时互转。

- 两种规范对比：

| | obsidian 规范 | webui 规范 |
| --- | --- | --- |
| 内容数据 | 纯 Markdown | 纯 Markdown（完全相同） |
| 额外文件 | 无 | `.webui/` 隐藏目录（服务脚本/页面/运行状态；Obsidian 不显示） |
| 编辑方式 | Obsidian / Agent / 文本编辑器 | 上述全部 + 浏览器网页 |
| 多工程管理 | 逐个打开 | 支持工作区模式，一个页面集中管理 |

- 互转：obsidian 工程随时 `novel_webui action=安装服务` 原地升级为 webui；删掉 `.webui/` 即回到纯 obsidian。md 文件全程不动。

## 启动方式

**方式一（推荐）：Agent 工具**

```
novel_webui action=启动服务 范围=工程      # 只管理当前作品
novel_webui action=启动服务 范围=工作区    # 当前目录作为多工程工作区
novel_webui action=停止服务 / 服务状态 / 安装服务
```

`启动服务` 会自动把服务副本装进工程 `.webui/`（幂等，可作升级），以**分离进程**拉起（Agent 会话关闭后服务仍在），并把访问地址返回给用户。

**方式二：手动命令行**

```bash
node .webui/server.mjs --project /path/to/作品        # 单工程
node /path/to/预设/webui/server.mjs --workspace /path/to/书架   # 多工程
```

参数：`--port`（默认 4311，被占用自动顺延）、`--host`（默认 127.0.0.1）、`--token`（访问令牌）、`--project` / `--workspace`（二选一）。也可在 `<根>/.webui/config.json` 里持久化 `port` / `host` / `token`。

## 两种模式

- **工程模式**（`--project`）：服务只管理一个作品目录。
- **工作区模式**（`--workspace`）：把一个目录当作书架，自动发现其下所有作品工程（识别条件：子目录含 `README.md`，且含 `大纲/ 人物卡/ 设定集/ 正文/` 任一目录），网页顶部可切换工程。适合把服务架在所有作品工程的公共父目录（工程外）。

## 功能一览

| 页面 | 能力 |
| --- | --- |
| 仪表盘 | 章节/字数/人物/设定/伏笔统计，最近章节与归档，伏笔回收进度 |
| 人物卡 / 设定卡 | 卡片网格、筛选、新建（内置符合《novel-project》格式的脚手架）、预览（双链渲染）、编辑、删除 |
| 大纲 · 剧情线 | 总纲等大纲文件编辑；剧情线表格化增删改（`大纲/剧情线.md`） |
| 章节 | 新建章节（自动命名 第NNN章-标题.md）、阅读、编辑；**保存执行与 Agent 相同的质量门禁**（硬违规拦截，可强制豁免） |
| 伏笔 · 时间线 | 两张追踪表表格化编辑（表头校验与 novel_archive 一致） |
| 工具箱 | AI 味检查（与 novel_lint 同源规则）、全文搜索、旧稿分章（与 novel_import 同规则，预览后落盘） |

## 安全

- 默认只监听 `127.0.0.1`；写操作限定白名单路径（根目录 `*.md` 与 `大纲/ 人物卡/ 设定集/ 正文/ 归档/` 下的 `*.md`），写入走临时文件 + 原子替换。
- 绑定非回环地址时**强制要求 token**（未提供则自动生成），所有 `/api` 请求校验 `Authorization: Bearer <token>`。
- 服务不做任何模型调用、不联网；它只是本地文件的一层网页视图。

## REST API（供脚本/集成）

| 方法 路径 | 说明 |
| --- | --- |
| GET `/api/state` | 服务信息、模式、工程列表 |
| GET `/api/overview?project=` | 工程总览与统计 |
| GET `/api/cards?project=&type=人物卡` | 卡片列表（人物卡 / 设定集） |
| GET/PUT/POST/DELETE `/api/card` | 读取/保存/新建/删除卡片 |
| GET `/api/chapters`、GET/PUT/POST `/api/chapter` | 章节列表/读取/修改/新建（内置门禁） |
| GET/PUT `/api/table?file=伏笔清单.md` | 表格读写（伏笔/时间线/剧情线通用） |
| GET `/api/outline`、GET `/api/search?q=` | 大纲文件列表、全文搜索 |
| POST `/api/tool/lint`、`/api/tool/split` | AI 味检查、旧稿分章 |
| POST `/api/shutdown` | 停止服务 |

`project` 参数在工作区模式下用于选择工程，单工程模式可省略。

## 文件布局

```
作品根/
├── （原有 md 工程文件，一个不动）
└── .webui/
    ├── server.mjs      # 服务（从预设包安装的副本，自包含）
    ├── index.html      # 前端单页应用
    ├── lint.mjs        # 与插件共享的正文铁律规则
    ├── config.json     # 可选配置（首次安装时生成）
    ├── state.json      # 运行状态（服务拉起后写入，停止后删除）
    └── server.log      # 运行日志
```
