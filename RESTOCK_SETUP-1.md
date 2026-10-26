# Restock Notify：完整说明与上线步骤

本文分为五部分：

- 第一部分：功能说明
- 第二部分：上线步骤
- 第三部分：上线后的测试清单
- 第四部分：日常使用、修改与排错
- 第五部分：已知限制和待定事项

需要你亲自操作的地方都标了 **[Action Required]**；没有标的是说明，读懂即可。

---

# 第一部分：功能说明

## 1.1 一句话概括

顾客在门店想买的商品缺货，cashier 在 POS 上把这些商品记到顾客名下。之后系统每天检查两次（10:00、16:00）这家门店的库存，一到货就通过 Klaviyo 发邮件或短信通知顾客。

## 1.2 Cashier 的操作流程

1. 先让顾客登录，用 Customer Login 磁贴扫 Apple Wallet 卡，或者在购物车里选顾客。
2. 点首页的 **Restock Notify** 磁贴。
3. **第 1 页 · 商品**
   - 在搜索框输入商品名、SKU 或条码，也可以直接扫商品条码。
   - 结果按 **variant** 一行一行列出：图片、SKU、商品名、Variant 名、本店库存，行末有 **Add** 按钮。
   - 点 Add 后，商品会进入下方的 "Notify list"，可以点 Remove 删掉。一次最多 30 个商品。
   - 扫码时，如果正好只匹配到一个 variant，会自动加入，不用再点 Add。
   - 没登录顾客时也能先选商品，但必须登录顾客后才能进入下一页。
4. **第 2 页 · 顾客**
   - 显示顾客的 Email 和 Phone。有值就直接显示；没有值就出现输入框，填好后点 Save，会写进 Shopify 顾客资料。**已有的值不能在 POS 上修改**，这是为了防止误改或冒用账户。
   - 显示 Email 和 SMS 的订阅状态。未订阅的旁边有 **Subscribe** 按钮，只有在顾客明确同意接收 Hera Beauté 营销信息时才点。
   - **Notify by**：在 Email 和 SMS 中选一个。只有一种联系方式时会自动选上；两种都有时必须让顾客选。
   - 点 **Confirm**，显示 "Saved" 就完成了。
   - **选了 SMS 但顾客未订阅 SMS 时**，点 Confirm 不会马上保存，而是先出现黄色提示：短信只能发给已订阅 SMS 的顾客，请告诉顾客，想收短信就要订阅 SMS，否则会改用 Email 通知。提示下面有三个按钮：
     - **Customer agrees: subscribe to SMS and confirm**：顾客同意，先订阅 SMS 再保存，之后用短信通知。
     - **Notify by email instead and confirm**：改用 Email 通知并保存。顾客没有 email 时，这个按钮不出现，界面会提示先在上方补填 email。
     - **Back**：返回修改。
   - **选了 SMS，并且顾客还没订阅 SMS，或者 cashier 刚在这一页帮顾客点了 SMS 的 Subscribe** 时，第 2 页会显示红色提示 "IMPORTANT: Remind Customer to reply YES."，下面有一个红色按钮 **I reminded the customer to reply YES**。**cashier 必须先点这个按钮，Confirm 和 "subscribe to SMS and confirm" 才能点。** 改选 Email 再改回 SMS，或者换了顾客，都要重新确认。顾客之前已经订阅过 SMS 的，不显示。Klaviyo 开着 SMS 双重确认，新订阅的顾客会收到一条 "Please reply YES…" 短信，cashier 要请顾客当场回复 YES，否则到货短信发不出去。
5. 页面上有简短的英文提示，指导 cashier 每一步该做什么。

## 1.3 搜索是怎么做到按 variant 显示的

- 先用 POS 设备自带的商品库搜索（速度快，和 POS 原生搜索用的是同一套数据）。返回的是 product，系统把每个 product 拆成 variant，只保留和输入内容相符的 variant。
- 输入内容和某个 variant 的 **SKU 或条码完全一致**时，只显示那一个 variant。
- 普通文字搜索时，要求每个词都出现在"商品名 + variant 名 + SKU + 条码 + 品牌"里。例如搜"口红 520"，只会出现 520 那个色号。
- POS 设备上搜不到时（比如商品没有发布到 POS 渠道），会改为向 Shopify 后台搜索。

## 1.4 数据存在哪里（全部在 Shopify 里，没有额外的数据库）

**A. Metaobject `restock_request`（主数据）**

- 每"顾客 + variant + 门店"一条记录。
- 由后端在第一次启动时自动创建定义。它是商家所有（merchant-owned），所以别的 app 也能读。
- 在 Shopify 后台的 **Content → Metaobjects → Restock request** 可以查看。

| 字段 | 含义 |
|---|---|
| `status` | `pending` 等待中 / `notified` 已通知 / `cancelled` 已取消（商品被删除） |
| `location_code` | 门店代码，如 `MTL10` |
| `location_id` | Shopify location ID |
| `customer` / `customer_id` | 顾客（引用）/ 顾客 ID |
| `variant` / `variant_id` | Variant（引用）/ Variant ID |
| `sku`、`product_title`、`variant_title` | 登记时的快照，商品以后改名或删除也不受影响 |
| `channel` | `email` / `sms` |
| `requested_at` / `notified_at` | 登记时间 / 通知时间 |
| `available_at_notify` | 通知时的库存数 |
| `staff_id` | 登记的员工 |

- 可以筛选的字段：`status`、`location_code`、`customer_id`、`variant_id`、`sku`、`channel`。
- **记录永远不删除**。通知后只改状态，方便以后做分析，比如哪些商品被等得最多、平均等多久到货。
- 每个定义的上限是 100 万条，按你们的规模用几十年也没问题。

**B. 顾客 metafield `custom.restock_requests`（顾客视角的镜像）**

- JSON 列表，只保存这位顾客**还在等**的商品，例如：
  `[{"location":"MTL10","sku":"...","variant_id":"...","product":"...","channel":"sms","requested_at":"..."}]`
- 在 Shopify 后台的顾客页面可以直接看到。通知或取消后，对应条目会自动删掉。

**C. 门店 metafield `custom.display_name`（门店名称）**

- 例如 MTL10 → "Chambly Longueuil"，这个名称会写进发给 Klaviyo 的内容里。
- **地址和电话**直接取 Shopify 门店自己的资料（Settings → Locations → 门店 → Address，其中包含 Phone），不需要另外填。要改地址或电话，就在那里改。
- 没填名称时，就用门店代码（MTL10）代替。

**去重规则：** 同一位顾客、同一个 variant、同一家门店，在"等待中"状态下只会有一条记录。重复登记时不会新增，只会更新通知方式（channel）。通知完成后，同一组合可以再次登记。

## 1.5 库存检查与阈值

- Shopify Flow 每天 10:00 和 16:00 调用后端。
- 后端取出所有 `pending` 记录，查询**该记录所在门店**的 `available` 数量。
- 判断规则：
  - **全局阈值** `RESTOCK_THRESHOLD`：available ≥ 这个值才通知。
  - **按 Product type 的例外** `RESTOCK_TYPE_THRESHOLDS`：默认是 `WIG=1`，即 Product type 为 WIG 的商品，只要有 1 个 available 就通知。类型名不区分大小写。
- 达到阈值的记录，会按"顾客 + 门店 + 通知方式"合并成**一个** Klaviyo event。同一位顾客同时有 3 件到货，只会收到一条通知。
- 发送成功后：记录改为 `notified`，并从顾客 metafield 中删除。
- **发送失败时**（例如 Klaviyo 出错），记录保持 `pending`，下一次检查会自动重试。
- **商品被删除时**，记录改为 `cancelled`，并从顾客 metafield 中删除。
- **SMS 自动改为 Email：** 到货时会再核对一次订阅状态。记录是 SMS，但顾客当时未订阅 SMS（比如后来退订了），只要有 email 就改用 Email 通知，日志里会注明。既没订阅 SMS 也没有 email 的，记录保持 `pending`。
- **顾客没有对应的联系方式时**（比如选了 SMS 但电话被删了），记录保持 `pending`，日志里会提示。
- 请求**永不过期**。

## 1.6 发给 Klaviyo 的 event

- Metric 名称：**Restock Available**
- 顾客识别方式：选 email 的用邮箱识别，选 sms 的用电话识别，同时带上 first / last name。
- Event properties（模板里写成 `{{ event.xxx }}`）：

| 属性 | 例子 |
|---|---|
| `channel` | 实际通知方式 `email` / `sms`（Klaviyo flow 按这个值分流） |
| `requested_channel` | 登记时选的方式。和 `channel` 不同，就说明是 SMS 未订阅、改用了 Email |
| `store_code` | `MTL10` |
| `store_name` | `Chambly Longueuil` |
| `store_address` | `2877 Ch. de Chambly 22, Longueuil, QC J4L 1M8` |
| `store_address1`、`store_city`、`store_province`、`store_zip` | 地址的各个部分 |
| `store_phone` | `(450) 670-9777`（门店电话，取自 Shopify 门店地址里的 Phone） |
| `store_phone_e164` | `+14506709777`（同一个电话的国际格式，可用于 `tel:` 链接） |
| `item_count` | 本次到货的商品数 |
| `first_product_title`、`first_variant_title`、`first_image_url` | 第一件商品 |
| `items_text` | 所有到货商品，用逗号连起来，例如 `Wig Pop Nadia - #1B, Aphogee Shampoo 16oz, Lip Gloss - Rose` |
| `items_short` | 短信用：最多列 2 件，其余写 "and N more"，例如 `Wig Pop Nadia - #1B, Aphogee Shampoo 16oz and 1 more` |
| `items` | 列表，每项包含 `sku`、`product_title`、`variant_title`、`vendor`、`price`、`image_url`、`url`、`available`、`variant_id` |
| `shopify_customer_id` | Shopify 顾客 ID |

- 同一天、同一组商品重复发送时，Klaviyo 会按 `unique_id` 去重，不会重复触发。

## 1.7 安全

- POS 的所有接口都要求 Shopify 签发的 POS session token（和 Gift Card 磁贴同等级别），因为这些接口会返回顾客的联系方式。
- Flow 调用的检查接口需要请求头 `X-Restock-Key`，值必须和 Render 上的 `RESTOCK_RUN_KEY` 一致，否则返回 401。
- 订阅操作会在 Shopify 里记录同意时间和门店（`sourceLocationId`），opt-in 级别为 `SINGLE_OPT_IN`。

## 1.8 其他 Shopify app 读取名单

- **所需权限：** 那个 app 需要 `read_metaobjects`；如果要展开顾客或商品资料，还需要 `read_customers` 和 `read_products`。
- **查询示例：** 查询 MTL10 正在等待的名单，示例写在 `README.md` 的 Restock Notify 一节。核心写法是：
  `metaobjects(type: "restock_request", query: "fields.location_code:\"MTL10\" AND fields.status:\"pending\"")`
- **分页：** 每页最多 250 条，用 `pageInfo.endCursor` 翻页。

## 1.9 本次改动的文件

| 文件 | 内容 |
|---|---|
| `restock.js`（新） | 后端全部逻辑 |
| `server.js` | 引入 `restock.js`；`/auth` 加上新权限 |
| `shopify.app.toml` | 新增 7 个权限 |
| `render.yaml` | 新增 `RESTOCK_RUN_KEY`、`RESTOCK_THRESHOLD`、`RESTOCK_TYPE_THRESHOLDS` |
| `extensions/restock/`（新） | POS 磁贴（`Tile.jsx`、`Modal.jsx`） |
| `README.md`、`RESTOCK_SETUP.md` | 文档 |

---

# 第二部分：上线步骤

请**严格按顺序**做，每一步都有"确认"项，确认通过再做下一步。

## 步骤 1 [Action Required] 安装依赖并部署 POS 扩展

在 `D:\Hera_APPs\Hera_POS_aid` 打开终端：

```
npm install
shopify app deploy
```

- 必须先运行 `npm install`，新扩展 `extensions/restock` 需要安装依赖。
- deploy 时，CLI 会列出新扩展 **restock** 和新的权限，确认发布。

**确认：** CLI 显示部署成功，新版本里包含 restock。

## 步骤 2 [Action Required] 批准新权限

Shopify 后台 → **Apps** → **Hera_POS_aid**，按提示批准更新的权限。

新权限有 7 个：`read_products`、`read_inventory`、`read_locations`、`read_metaobjects`、`write_metaobjects`、`read_metaobject_definitions`、`write_metaobject_definitions`。

## 步骤 3 [Action Required] 取得新的 access token

浏览器打开（把"你的店铺"换成 myshopify 域名）：

```
https://search-0wf4.onrender.com/auth?shop=你的店铺.myshopify.com
```

**确认：** 页面上的 Scopes 包含上面 7 个新权限。复制显示的 token，这个 token 不会保存在任何地方，只显示这一次。

## 步骤 4 [Action Required] 设置 Render 环境变量

先生成一个随机 key（PowerShell）：

```
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

然后到 Render → 服务 **search** → **Environment**：

| 变量 | 操作 | 值 |
|---|---|---|
| `SHOP_ACCESS_TOKEN` | 修改 | 步骤 3 的新 token |
| `RESTOCK_RUN_KEY` | 新建 | 上面生成的 40 位随机字符 |
| `RESTOCK_THRESHOLD` | 新建 | 全局阈值，例如 `3`（available ≥ 3 才通知）。不设时默认为 1 |
| `RESTOCK_TYPE_THRESHOLDS` | 可以不建 | 不设时默认就是 `WIG=1`。要加别的类型时，写成 `WIG=1,MAKEUP=2` |

把 `RESTOCK_RUN_KEY` 另外妥善保存，步骤 9、10、13 都要用到。

## 步骤 5 [Action Required] 推送后端代码

```
git add .
git commit -m "Restock Notify"
git push
```

Render 会自动部署。

**确认：** Render → **Logs** 中出现以下内容：

```
[restock] created metaobject definition restock_request
[restock] created customer metafield definition custom.restock_requests
[restock] ready (threshold 3, by product type {"WIG":1})
```

- 前两行只在第一次启动时出现。
- 如果出现 `[restock] setup check failed`，说明步骤 2–4 的权限或 token 没生效，回去检查。

## 步骤 6 [Action Required] 填门店名称

1. Shopify 后台 → **Settings** → **Metafields and metaobjects** → **Locations** → **Add definition**：
   - Name：`Display name`
   - Namespace and key：`custom.display_name`
   - Type：**Single line text**，并选 **One value**（单个值），**不要选 List**
2. **Settings** → **Locations**，逐个打开门店，在 Metafields 里填写名称，例如 MTL10 → `Chambly Longueuil`。
3. 同一页面检查门店的 **Address** 和 **Phone**。邮件里的门店地址和电话都直接取自这里。

如果后台的门店页面看不到 Metafields 区块，把"门店代码 → 名称"的列表发给我，我直接写入。

## 步骤 7 [Action Required] 在 POS 上添加磁贴

每台 POS 设备：在首页 smart grid 进入编辑 → 添加 app 磁贴 **Restock Notify**。

## 步骤 8 [Action Required] 在 POS 上做一笔测试登记

1. 准备一位**测试顾客**，用你自己的邮箱和手机号。
2. 登录这位顾客 → Restock Notify → 搜索一个**本店当前有库存、且数量达到阈值**的商品 → Add → Next。
3. 第 2 页：确认 Email 和 Phone，选择 **Email** → Confirm。

**确认：**
- POS 显示 "Saved"。
- Shopify 后台 → Content → Metaobjects → Restock request 里多了一条 `pending` 记录。
- 测试顾客的 metafield `Restock requests` 里有这件商品。

## 步骤 9 [Action Required] 演练（不发送、不改数据）

PowerShell，把 `KEY` 换成你的 `RESTOCK_RUN_KEY`：

```
Invoke-RestMethod -Method Post -Uri "https://search-0wf4.onrender.com/api/restock/run?dryRun=1" -Headers @{ "X-Restock-Key" = "KEY" } | ConvertTo-Json -Depth 5
```

返回结果里：

- `pending`：等待中的总数
- `due`：已达到阈值的数量
- `preview`：将会通知谁、哪些商品
- `threshold` / `typeThresholds`：当前生效的阈值

**确认：** `preview` 里有测试顾客和那件商品。

## 步骤 10 [Action Required] 第一次真实运行（在 Klaviyo 里生成 metric）

Klaviyo 要收到第一个 event，才会出现 **Restock Available** 这个 metric，flow 也才能选到它。

```
Invoke-RestMethod -Method Post -Uri "https://search-0wf4.onrender.com/api/restock/run" -Headers @{ "X-Restock-Key" = "KEY" }
```

**确认：**
- 返回 `accepted: true`。
- Render Logs 里出现 `[restock] notified customer ... by email @ MTL10: ...` 和 `[restock] run done: ...`。
- Klaviyo → Analytics → Metrics 里出现 **Restock Available**，测试顾客的 profile 里能看到这个 event。
- 这条记录在 Shopify 里变为 `notified`。

此时还没有建 flow，所以这一次顾客收不到邮件，属于正常现象。

## 步骤 11 [Action Required] 建 Klaviyo flow（Email、SMS 各一个）

**Flow A：Email**

1. Klaviyo → **Flows** → **Create flow** → **Build your own**，名称 `Restock Notify - Email`。
2. Trigger：**Metric** → **Restock Available**（选定后不能修改）。
3. **Trigger filters**：`channel` equals `email`（全小写，要完全一致）。
4. Re-entry：允许每次都进入，例如 "Re-enter whenever they re-qualify"。
5. 加一封 **Email**，在邮件 Settings 里**关闭 Smart Sending**。
6. 写邮件内容。最稳妥的方法是在编辑器里点 **Preview & test** → **Event Properties**，直接点击复制变量：
   - 门店：`{{ event.store_name }}`、`{{ event.store_address }}`
   - 商品：用 **content repeat**（重复块），Repeat for 选 `event.items`，块里用 `item.product_title`、`item.variant_title`、`item.sku`、`item.image_url`
   - 只显示一件：`{{ event.first_product_title }}`、`{{ event.first_image_url }}`
7. 用 Preview 选测试顾客那条 event 检查效果，没问题后把邮件设为 **Live**，并开启 flow。
8. **可选：** 在邮件的 **Transactional** 里勾选 **Apply for transactional status** → **Submit for review**（Klaviyo 审核最长 24 小时）。通过后，退订过营销邮件的顾客也能收到。注意：transactional 邮件里不能放优惠码或促销内容；审核期间不能编辑，通过后如果编辑会失去 transactional 状态，需要重新提交。

**Flow B：SMS**

1. 新建 flow `Restock Notify - SMS`，Trigger 同样选 **Metric** → **Restock Available**。
2. **Trigger filters**：`channel` equals `sms`。
3. Re-entry 同上；加一条 **SMS**，关闭 Smart Sending。
4. 短信不能循环列表，所以用后端拼好的文字 `items_short`（最多 2 件，其余写 "and N more"），例如：
   `Hera Beauté: {{ event.items_short }} is back in stock at {{ event.store_name }}, {{ event.store_address }}. Questions: {{ event.store_phone }}`
   想全部列出可以改用 `{{ event.items_text }}`，但商品多时短信会变长，费用也更高。
5. 设为 Live，开启 flow。

**Klaviyo 设置检查**

在 Klaviyo 的 Shopify 集成设置里，确认已开启同步 email / SMS 订阅状态，这样 POS 上点的 Subscribe 才会同步到 Klaviyo。

## 步骤 12 [Action Required] 端到端测试（真的收到通知）

1. 在 POS 上给测试顾客**再登记一次**同一件商品（之前那条已经是 notified，所以这次会新建一条记录），选 Email。
2. 再执行一次步骤 10 的真实运行命令。
3. **确认：** 测试邮箱收到邮件，内容里的门店名、地址、商品都正确。
4. 再用 SMS 测试一次：测试顾客的 SMS 必须**已订阅**，可以在第 2 页点 Subscribe。登记时选 SMS，运行后**确认**手机收到短信。

## 步骤 13 [Action Required] 设置 Shopify Flow 定时运行

**13.1 存 secret**

Shopify 后台 → **Apps** → **Flow** → **Settings** → **Secrets** → 新建：
- Handle：`restock_run_key`
- Value：`RESTOCK_RUN_KEY` 的值

**13.2 建 workflow（一个 workflow，两个时间点）**

1. Flow → **Create workflow** → **Select a trigger** → **Scheduled time**。
2. 第一个时间：
   - **Time zone**：保持店铺时区。
   - **Start date**：明天；**Start time**：`10:00 AM`。
   - **Add repeat rule**：每 `1` **Days**，不加 end rule。
3. 点 **Add schedule** 加第二个时间：Start time `4:00 PM`，**Add repeat rule** 每 `1` **Days**。
4. 加一个 Action：**Send HTTP request**
   - **HTTP method**：`POST`
   - **URL**：`https://search-0wf4.onrender.com/api/restock/run`
   - **Headers**：
     - `Content-Type` → `application/json`
     - `X-Restock-Key` → 点 **Add secret**，选 `restock_run_key`
   - **Body**：`{}`
   - **On client error (4XX response)**：**Fail**
   - **On server error (5XX or 429 response)**：**Retry**
5. 命名为 `Restock Notify - stock check` → **Turn on workflow**。

**确认（可以先把第一个时间改成几分钟后来测试）：**
- Flow 的 **Run history** 显示成功（服务器返回 202）。
- Render Logs 出现 `[restock] run done: {...}`。
- 测试完成后，把时间改回 10:00 AM。

## 步骤 14 [Action Required] 培训 cashier

需要让 cashier 知道的要点：

- 先登录顾客，再打开 Restock Notify。
- 可以直接扫商品条码。
- Subscribe 只在顾客同意时才点。
- 顾客选 SMS 但未订阅时，Confirm 后会出现提示：要告诉顾客，想收短信就要订阅 SMS，否则会用 Email 通知。按顾客的回答点对应按钮。

---

# 第三部分：上线后的测试清单

| # | 测试 | 预期结果 |
|---|---|---|
| 1 | 输入完整 SKU | 只出现 1 行 |
| 2 | 扫商品条码 | 自动加入 Notify list |
| 3 | 搜索一个多色号商品的名称加色号 | 只出现该色号 |
| 4 | 没登录顾客就点磁贴 | 显示黄色提示，Next 按钮不可用 |
| 5 | 顾客没有 email，输入后点 Save | 保存成功，Shopify 顾客资料里出现该 email |
| 6 | 输入错误格式的电话 | 显示 "enter 10 digits" 的提示 |
| 7 | 同一顾客、同一商品登记两次 | 完成页提示 "already on the list"，不会出现重复记录 |
| 8 | 假发（WIG）库存为 1、全局阈值大于 1 | 演练的 `preview` 里有这件假发 |
| 9 | 普通商品库存低于全局阈值 | 不在 `preview` 里 |
| 10 | 选 SMS，顾客未订阅 SMS，点 Confirm | 出现黄色提示和三个按钮，此时还没有保存 |
| 11 | 在上面的提示里点 "Notify by email instead" | 保存成功，完成页显示用 email 通知 |
| 12 | 在上面的提示里点 "subscribe to SMS and confirm" | 顾客变为已订阅 SMS，保存成功，完成页显示用短信通知 |

---

# 第四部分：日常使用、修改与排错

**查看某家门店的等待名单**

Shopify 后台 → Content → Metaobjects → Restock request，按 `location_code` 和 `status` 筛选。也可以用你们的另一个 app 读取（见 1.8）。

**修改阈值**

Render → Environment 修改 `RESTOCK_THRESHOLD` 或 `RESTOCK_TYPE_THRESHOLDS`。保存后 Render 会自动重启，新值立即生效，不需要改代码，也不需要 deploy。

**新增或改门店名称**

改对应门店的 metafield `custom.display_name` 即可。后端会缓存门店名称 10 分钟。

**手动检查一次**

用步骤 9 的演练命令查看；需要立刻发送时用步骤 10 的命令。

**常见日志和对应处理**

| 日志 | 含义 / 处理 |
|---|---|
| `[restock] run rejected: bad key` | Flow secret 和 Render 上的 key 不一致 |
| `[restock] notify failed ... Klaviyo 4xx` | Klaviyo key 或数据有问题，记录保持 pending，下次会重试 |
| `has no phone (kept pending)` | 顾客选了 SMS，但资料里没有电话 |
| `not subscribed to SMS → notified by email instead` | 记录是 SMS，但顾客未订阅 SMS，已改用 Email 通知 |
| `not subscribed to SMS and has no email (kept pending)` | 无法通知，等顾客订阅 SMS 或补填 email |
| `variant ... no longer exists → cancelled` | 商品被删除，记录已取消 |
| `[pos-auth] rejected (/api/restock/...)` | POS 没有登录员工账户，或者 token 过期 |
| `[restock] metaobject field status is not filterable` | metaobject 定义被手动改过，联系我处理 |

**取消某条请求**

在 Metaobjects 里把这条记录的 `status` 改为 `cancelled`，并把顾客 metafield 中对应的条目删掉。

---

# 第五部分：已知限制和待定事项

1. **SMS 必须已订阅才能收到。** Klaviyo 的 SMS（包括 transactional）都要求顾客已同意接收短信。POS 在 Confirm 时会提醒 cashier；到货时如果仍未订阅，会自动改用 Email（见 1.2、1.5）。
   另外，Klaviyo 的 SMS list 开着双重确认：顾客在 POS 订阅后，**还要回复 YES** 才算真正订阅。POS 上会用红色提示提醒 cashier。设置位置：Klaviyo → Audience → Lists & segments → SMS 同步的那个 list → Settings → Consent → Opt-in process。Klaviyo 建议保持双重确认。
   注意：Shopify 显示"已订阅"不代表 Klaviyo 已确认。顾客没回复 YES 时，后端无法自动改用 Email，这条短信就不会送达。
2. **只会通知登记时的那家门店。** 其他门店有货不会触发通知。
3. **检查频率是每天两次**（10:00 和 16:00），不是到货即时通知。
4. **只能补填、不能修改已有的 Email / Phone。** 顾客资料已有值时，POS 上不能改，需要到 Shopify 后台修改。
5. **扩展还没有在真实 POS 设备上运行过。** 代码已经通过 Shopify 官方类型检查和模拟测试，但真实设备上的表现（特别是搜索）要在步骤 8 和第三部分的测试中确认。有任何问题，把截图或 Render 日志发给我。
