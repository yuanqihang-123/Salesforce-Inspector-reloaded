# Data Export Query Templates Spec

状态：Implemented（自动化测试和本地浏览器交互验收通过，真实 Salesforce 执行验收待完成）  
日期：2026-10-14

Templates 帮助用户选择查询场景、填写参数并生成新的查询。History 继续负责查找成功执行过的查询；模板选择和预览不会写入历史。原来的语句骨架下拉框替换为可搜索、可预览的模板面板。

## 页面入口与面板

Export Query 保留 Templates 和 History 两个入口。Templates 打开时清空搜索、选择第一个内置模板，聚焦搜索框；默认继承当前编辑器 SOQL 的顶层 FROM 对象和 Tooling API 模式。无法识别对象时要求选择对象。

面板宽度为 960px，不超过视口宽度，两侧至少留 16px；高度不超过视口 80%，并按入口位置避开底边。桌面左侧为模板列表，右侧为参数、完整查询预览和操作区；宽度不超过 600px 时上下布局，列表高度 140px，参数和预览区域可滚动，操作区保持在下方可见。

模板列表跨 SOQL Built-in、SOSL / GraphQL、My templates、Legacy snippets 统一排序。搜索名称、描述、查询原文及类型，忽略大小写，按空白分词且全部词可在任意位置匹配。筛选后仅按成功运行次数降序排列，空搜索亦然，不区分精确、前缀或子串匹配。无匹配显示 No matching templates。点击候选或按上下键只切换选择，不修改编辑器、不执行查询。搜索变化后保留仍匹配的选择，否则选择第一项。

点击面板外部、再次点击 Templates 或按 Escape 关闭面板，焦点返回入口。Escape 优先取消替换确认，再退出模板编辑器；关闭或取消编辑会丢弃尚未保存的模板草稿。面板提供展开状态、控件名称、候选选中状态和完整预览名称；Tab 可访问操作，替换确认中的 Tab 在三个操作按钮间循环。

## 内置查询场景

六个内置模板均生成完整 SOQL，不再提供 Record limit 参数，生成的查询不附加 LIMIT。记录查询默认 SELECT Id，以及存在的字符串类型 nameField；时间查询另加对应时间字段。分组查询返回分组字段与 COUNT(Id) recordCount。

| 模板 | 参数 | 生成行为 |
| --- | --- | --- |
| Find records by ID | 对象、一个或多个 ID | 单个 ID 使用 =，多个 ID 使用 IN |
| Recently created records | 对象、天数 | CreatedDate = LAST_N_DAYS:n，按 CreatedDate DESC |
| Recently modified records | 对象、天数 | LastModifiedDate = LAST_N_DAYS:n，按 LastModifiedDate DESC |
| Search a text field | 对象、字段、关键词 | field LIKE '%keyword%' |
| Count by field | 对象、分组字段 | GROUP BY field，按 COUNT(Id) DESC |
| Find duplicate values | 对象、分组字段 | 排除 null，GROUP BY field，HAVING COUNT(Id) > 1，按 COUNT(Id) DESC |

ID 支持 15 或 18 位字母数字，逗号、分号或空白分隔，重复 ID 去重；不检查 ID 校验和或所属对象。天数支持 1–3650 的整数。LAST_N_DAYS 包含今天，界面明确显示 includes today；日期边界由 Salesforce 的用户设置决定，不能理解为精确过去 n×24 小时。[Salesforce 日期与日期字面量](https://developer.salesforce.com/docs/platform/salesforce-soql-sosl/guide/sforce-api-calls-soql-select-dateformats.html)

对象输入和字段参数复用 DescribeInfo 缓存。对象候选只列 queryable 对象，接受 API name 并显示 label；忽略大小写匹配 API name 和 label，按 API name 精确、label 精确、API name 前缀、label 前缀、API name 包含、label 包含的顺序排序，同级按 API name 排序。对象候选支持上下键、Enter 选择和 Escape 关闭；字段候选显示 label 和 API name。内置搜索字段只提供 filterable 的 string、textarea、email、phone、url 字段。分组字段要求 groupable，重复值模板还要求 filterable；时间字段必须存在且 filterable、sortable。更换对象或 API 模式后清空内置字段选择。

未选择对象、元数据加载中、加载失败、字段不存在或参数不合法时显示提示，禁止载入。依赖元数据的模板在数据到达后随页面更新重新生成预览。对象 describe 加载失败时提示重新打开 Data Export 重试。

关键词按字面文本处理：单引号、反斜杠及换行转义，输入中的 % 和 _ 按字面字符转义，只有模板添加的前后 % 作为通配符。[Salesforce 引号字符串转义](https://developer.salesforce.com/docs/platform/salesforce-soql-sosl/guide/sforce-api-calls-soql-select-quotedstringescapes.html)

保留原有 SOSL 和 GraphQL 示例，作为单独分组的 Query starter。示例和旧 snippets 载入后由用户继续编辑，不要求填写内置 SOQL 参数。

## 实时预览与载入

填写参数时实时生成完整查询，使用现有 SOQL 高亮和格式化预览；复制预览文本不修改模板、编辑器或历史。无效参数显示提示并清空生成预览，避免载入过期查询。

Load query 只载入当前内部查询标签页；当前有未成功执行的修改时显示 Replace the current query? Your edits will be overwritten.，提供 Cancel、Open in new tab、Replace。取消保留原编辑。Open in new tab 保存原标签页实时文本、模式和结果，再创建并激活内部新标签页；新页没有结果。点击这两个按钮只载入。参数填写有效后，在参数输入或 Load query 按钮上按 Enter 会载入并执行 Run export；若有替换确认，确认 Replace 或 Open in new tab 后继续执行。参数无效、导出中、输入法组合输入、重复按键或载入失败时不执行。Record IDs 中 Shift+Enter 保留换行。Object 候选中 Enter 先选中非精确匹配的对象，再按 Enter 执行；已精确匹配时直接执行。

载入复用 loadHistoryQuery：先持久化标签页，成功后更新编辑器、模式、标签页名和自动补全。持久化失败保留原标签页与编辑器，面板保持打开并显示错误；不同查询或模式清空旧结果。Tooling API 强制关闭 queryAll；当前标签页载入 Data API 保留原 queryAll，新标签页默认 false。

正在导出时可搜索、预览和管理模板，禁止载入，并显示 Wait for the current export to finish。只有用户之后运行且成功执行，查询才按既有 History 规则保存。

## 自定义模板创建与管理

From current query 使用编辑器的实时文本和当前 API 模式创建草稿。用户填写名称，在草稿查询里选择完整值或字段，再点击 Make selection a parameter，将选区替换成 {{value1}}、{{value2}} 等未使用参数名。不会改动原编辑器。

选中完整的单引号字符串，或选中紧邻两侧引号的全部内容时，自动将两侧引号一起替换，参数类型设为 text；数字设为 number，YYYY-MM-DD 设为 date，其他内容默认 field。用户可修改类型与默认值。只选字符串中的部分内容且引号未完整包围选区时，拒绝转换并显示提示。

用户也可直接在草稿中输入 {{name}}；参数名支持字母或下划线开头，后续可含字母、数字、下划线。编辑查询后自动同步参数定义，新参数默认 text，同名参数复用同一个输入。参数位于单引号字符串或注释内时拒绝保存，文本参数自己添加引号。参数重命名通过编辑查询完成；新名字视为新参数，需要重新设置类型和默认值。

| 类型 | 输入与生成规则 |
| --- | --- |
| text | 非空文本，自动添加单引号并转义 |
| number | 带可选负号的整数或小数；不接受指数、表达式 |
| date | 有效 YYYY-MM-DD，原样作为 SOQL Date 字面量；不用于 DateTime 字段 |
| object | 单一对象 API name，通过当前 API 的 queryable 对象列表校验 |
| field | 单一直接字段 API name，通过对象 describe 校验，不支持关系路径 |

字段参数使用第一个 object 参数的值作为元数据上下文；没有 object 参数时使用查询中固定的顶层 FROM 对象。多个对象、子查询中的字段或关系路径可作为查询固定内容保留，不提供针对它们的参数元数据推断。

My templates 支持 Edit template 和 Delete template。编辑保留原 id，保存后更新同一条记录；删除前确认，成功后选择第一个内置模板。保存和删除仅在写入成功后更新界面。模板 API 模式保存于模板，在载入时恢复；要改变模式可编辑模板。内置模板不允许修改或删除。Query starter 和旧 snippet 可 Convert to template，另存为新模板。

保存仅检查名称、查询非空、参数标记、参数类型、引号和注释边界，不执行查询或完整解析 SOQL；自定义查询的字段类型、函数、API 支持及其他语法最终由 Salesforce 校验。参数为空时可保存模板，但禁止载入直到补全。

## 存储与兼容

自定义模板以 JSON 数组保存在 localStorage 的 queryTemplatesV2，记录包含 id、name、query、parameters、useToolingApi、kind。parameters 为 name、type、default 的数组，保存时移除已不在查询中的参数。模板与历史一样按当前存储 origin 共享，跨 Salesforce Org 使用时根据当前 Org 元数据重新检查对象和字段。

旧 queryTemplates 键保持原值，以既有 // 分隔方式读取并展示为 Legacy snippets，不自动迁移或删除；设置中的旧入口改名 Legacy Query Templates，并提示通过 Data Export 管理参数模板。旧默认 SOQL 骨架由六个内置模板替代，SOSL 和 GraphQL 示例保留。

打开面板时重新读取存储；相关 storage 事件刷新列表，包括其他窗口的新增、编辑和删除。数组中损坏记录忽略。整个 JSON 损坏或读取失败时显示错误，写入不覆盖该损坏数据。存储写入失败时保留已有模板与草稿，不误报成功。

## 验收标准

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| AC01 | 当前查询为 Account，打开 Templates | 继承 Account 和 API 模式，搜索框获得焦点 |
| AC02 | 选择最近创建，使用默认参数 | 生成包含 CreatedDate、LAST_N_DAYS:7、倒序且不附加 LIMIT 的查询 |
| AC03 | 单个、多个或重复 ID | 正确生成 = 或 IN，并去重；非法 ID 禁止载入 |
| AC04 | 搜索关键词含单引号、%、_ | 正确转义，关键词按字面匹配 |
| AC05 | 分组或重复值模板 | 正确生成聚合、排序；重复值排除 null 并 HAVING count > 1 |
| AC06 | 元数据未加载、缺少字段或类型不兼容 | 显示提示，载入按钮禁用 |
| AC07 | 点击候选、上下键、填写参数 | 只改变模板预览，编辑器、结果和历史不变 |
| AC08 | 当前编辑有修改，点击 Load query | 显示确认；Cancel 保留原编辑；Replace 只载入 |
| AC09 | Open in new tab | 新标签页激活，无结果，不执行；原编辑及结果保留 |
| AC10 | 导出中或标签页持久化失败 | 禁止载入，或保留原编辑并显示错误 |
| AC11 | 从查询选中完整字符串转成参数 | 自动移除原引号，生成 text 参数并正确预览新值 |
| AC12 | 参数在引号或注释内、非法日期或表达式 | 保存或载入被阻止并提示原因 |
| AC13 | 保存、编辑、刷新、删除自定义模板 | 持久化正确，编辑不产生重复记录，删除需确认 |
| AC14 | 存在旧 // 配置 | Legacy snippets 可载入和另存，旧键不变 |
| AC15 | 窄屏、Escape、Tab、无搜索匹配 | 内容可滚动、操作可访问，焦点和空状态符合约定 |

## 验证与范围

自动化覆盖六类查询生成、五种参数校验、字面量转义、旧配置兼容、存储失败、参数转换、预览不改编辑器、替换保护、执行中阻止载入以及标签页持久化失败。与 query-history-test 和 record-login-test 一起运行，共 67 项测试通过，包含对象匹配排序、Enter 加载执行及失败保护。

本地浏览器以模拟 Account 元数据检查桌面和 390px 窄屏布局、参数预览、创建保存、自定义模板载入新标签页、替换确认和取消。真实 Salesforce 的对象权限、Tooling API 对象支持、聚合查询及查询执行结果仍需集成验收。第一版不包含模板共享、市场、AI 生成或跨对象参数推断。
