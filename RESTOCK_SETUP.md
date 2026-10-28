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
   - 弹窗顶部有两个按钮：**Add Notify**（登记）和 **Check Item**（查询），选中的那个是实心并带 ✓。
   - **顾客的等待清单（本店）**：已登录顾客时，先显示这位顾客在**本店**正在等待的商品（图片、SKU、名称、登记日期、通知方式），可以上下滚动。每项都有 **Remove**：点一次变成 "Tap again to remove"，再点一次才会取消（记录改为 `cancelled`，报表里也看得到）。清单最上方是长条按钮 **Add**，点了进入下面的第 1 页。顾客在本店没有等待中的商品时，直接进入第 1 页。第 1 页搜到已在清单里的商品时，按钮显示 "Already waiting"。
   - **Check Item**：搜索或扫码一个商品，显示**本店**正在等这个商品的顾客人数，以及每位顾客的姓名、电话、email、登记日期、通知方式。只显示本店，其他门店的顾客在 POS 上看不到。
3. **第 1 页 · 商品**
   - 在搜索框输入商品名、SKU 或条码，也可以直接扫商品条码。
   - 结果按 **variant** 一行一行列出：图片、SKU、商品名、Variant 名、本店库存，行末有 **Add** 按钮。
   - 点 Add 后，商品会进入下方的 "Notify list"，可以点 Remove 删掉。一次最多 30 个商品。
   - 扫码时，如果正好只匹配到一个 variant，会自动加入，不用再点 Add。
   - 没登录顾客时也能先选商品，但必须登录顾客后才能进入下一页。
4. **第 2 页 · 顾客**（同一页内按操作顺序逐步出现）
   - **① 通知方式**：先只显示 "How does the customer want to be notified?"，让顾客选 **Email** 或 **SMS (text message)**。选中的按钮是实心并带 ✓，另一个是普通样式。
   - 选好后，下面同时出现 ② 和 ③：
   - **② 确认语言** "Confirm customer's language"：**English** / **Français** 两个按钮，选中的同样是实心带 ✓，下面还有一行 "Selected: …"。会按顾客在 Shopify 的语言（locale）预选，fr 开头的选 Français，其他或为空选 English。Shopify 的语言来自顾客浏览网站时的设置，没访问过网站的顾客可能不准，所以要 cashier 当面确认，可以改。确认后的语言会写回顾客的 Shopify 资料，并发给 Klaviyo（event 属性 `language`）。
   - **③ 对应渠道的联系方式**：只显示所选渠道那一项，选 Email 显示邮箱，选 SMS 显示手机号。
     - **没有值**：显示输入框和 Save 按钮。
     - **有值**：显示号码或邮箱，旁边有 **Edit**。点 Edit 可以改成顾客想用的新地址，保存后**会同步修改 Shopify 顾客资料**里的 email 或电话。
     - **未订阅**：显示 **Subscribe** 按钮。只在顾客同意时才点。
     - **已填且已订阅**：不需要再做什么，可以直接 Confirm。
   - **Email**：必须**已订阅 email** 才能 Confirm；顾客不同意订阅时，可以改选 SMS。
   - **POS 上显示的订阅状态取自 Shopify**。点 **Confirm** 时，后端会把所选渠道的订阅状态同步写进 Klaviyo（因为 Shopify → Klaviyo 的同步不可靠）：
     - **A. Email，已订阅**：在 Klaviyo 写为已订阅，同意时间用 Shopify 记录的时间，不发确认邮件。
     - **B. Email，cashier 刚点了 Subscribe**：同上。
     - **C. SMS，cashier 刚点了 Subscribe**：Confirm 时不写。点 Subscribe 时已经在 Klaviyo 发起订阅，Klaviyo 发 "Reply YES" 短信，是否订阅以顾客回复为准。
     - **D. SMS，Shopify 显示已订阅**：在 Klaviyo 写为已订阅，同意时间用 Shopify 记录的时间，**不需要再回复 YES**。如果 Klaviyo 本来就是已订阅，就不写。
     - 到货发送时如果 Klaviyo 仍然不能给这个号码发短信（比如情况 C 顾客一直没回复 YES），就改发 Email；没有 Email 就继续等待。
   - **SMS**：必须**已订阅 SMS** 才能 Confirm，因为 Klaviyo 只给订阅者发短信；也可以改选 Email。cashier **刚点了 SMS 的 Subscribe** 后，会出现红色提示 "IMPORTANT: Remind Customer to reply YES."，下面有一个红色按钮 **I reminded the customer to reply YES**，**必须先点它才能 Confirm**。改选 Email 再改回 SMS、换了手机号或换了顾客，都要重新确认。Klaviyo 开着 SMS 双重确认，新订阅的顾客会收到 "Please reply YES…" 短信，不回复 YES 就收不到到货短信。
   - 联系方式那一行依次是：邮箱或号码 · **Edit** · 绿色 **Subscribed**（已订阅）或 **Subscribe** 按钮（未订阅，下面一行小字 "Only tap Subscribe with customer's consent."）。
   - 还差步骤时，Confirm 显示为灰色，上方用一句话说明还差什么；cashier 点灰色的 Confirm 不会保存，只会把这句话变成红色。点 **Confirm** 后进入完成页，显示 "Saved"、通知方式和语言；点 **OK** 关闭弹窗。
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
| `language` | `en` / `fr`，cashier 在 POS 上确认的语言（存在顾客的 Shopify locale 里）。Klaviyo 里可以按它分英文、法文模板 |

另外，后端会把同一个语言写进 **Klaviyo 顾客资料的 Locale**（`fr-CA` / `en-CA`）：在 POS 上 Confirm 时立即写一次，发送 event 时再写一次。原因是 Shopify 改了顾客语言后，不一定会重新同步到 Klaviyo。所以 Klaviyo 的 Smart Translations（按 Locale 选语言）也能用。两种方式**选一种**：要么 flow 里按 `language` 分流、每个分支写原文；要么不分流、用 Smart Translations。不要两种同时用。
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
| `items` | 列表，每件到货商品一项，包含：`product_title`、`variant_title`、`sku`、`vendor`、`price`（如 `11.99`）、`price_display`（如 `$11.99`）、`image_url`（商品的第一张图 / first media；商品没有图片时用 variant 图片）、`variant_image_url`（variant 自己的图片，可能为空）、`url`（网店商品页并选中该 variant；商品没在网店上架时，改为网店搜索这个 SKU）、`available`、`variant_id` |
| `shopify_customer_id` | Shopify 顾客 ID |

- 同一天、同一组商品重复发送时，Klaviyo 会按 `unique_id` 去重，不会重复触发。

## 1.7 安全

- POS 的所有接口都要求 Shopify 签发的 POS session token（和 Gift Card 磁贴同等级别），因为这些接口会返回顾客的联系方式。Shopify 只在 **POS 上登录的那个账号**的角色有这个 App 的权限时才发 token（Shopify 后台 → Settings → Users → 该账号的角色 → Apps）。没有权限时，磁贴会直接显示 "This POS account cannot use this tile…"，不会一直 Loading。
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
| `KLAVIYO_SMS_LIST_ID` | 可以不建 | POS 上点 SMS 的 Subscribe 时，后端直接在 Klaviyo 订阅，并加入这个 list。不设时默认就是 `UeqRiu`。这个 list 的确认设置决定 Klaviyo 是否发 "Reply YES" 短信 |
| `KLAVIYO_EMAIL_LIST_ID` | 可以不建 | 设了才会把 POS 上的 email 订阅也直接写进 Klaviyo。不设时用 Shopify 的 email 同步 |

**Klaviyo API key 需要的权限**：Profiles、Events、Lists、Subscriptions 都设为 Full Access。Klaviyo 的私钥创建后不能再加权限，缺权限时只能新建一个 key，替换 Render 上的 `KLAVIYO_API_KEY`。

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
| 10 | 进入第 2 页 | 只显示通知方式（Email / SMS），语言和联系方式还没出现 |
| 11 | 选 SMS | 出现语言（按 Shopify 预选）和手机号两项；选中的按钮实心带 ✓ |
| 12 | 选 SMS，顾客未订阅 SMS | Confirm 不能点，上方提示需要订阅或改选 Email |
| 13 | 点 SMS 的 Subscribe | 出现红色 "Remind Customer to reply YES"，点红色按钮确认后 Confirm 才能点 |
| 14 | 点邮箱旁的 Edit，改成新邮箱并保存 | Shopify 顾客资料里的 email 被替换 |
| 15 | 改选语言后 Confirm | 完成页显示该语言；Shopify 顾客的语言被更新 |

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
| `[restock] Klaviyo sms subscription failed ... Klaviyo 403` | Klaviyo key 缺少 Lists 或 Subscriptions 权限，需要新建 key |
| `[restock] customer ... subscribed to sms in Klaviyo` | 已在 Klaviyo 订阅；如果 list 开着双重确认，顾客会收到 "Reply YES" 短信 |
| `has no phone (kept pending)` | 顾客选了 SMS，但资料里没有电话 |
| `not subscribed to SMS → notified by email instead` | 记录是 SMS，但顾客未订阅 SMS，已改用 Email 通知 |
| `not subscribed to SMS and has no email (kept pending)` | 无法通知，等顾客订阅 SMS 或补填 email |
| `variant ... no longer exists → cancelled` | 商品被删除，记录已取消 |
| `[pos-auth] rejected (/api/restock/...): no token ... (POS user …)` | POS 上登录的账号没有这个 App 的权限：给该账号的角色加上 Hera_POS_aid |
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
4. **POS 上可以修改顾客的 Email / Phone。** 点 Edit 保存后会直接替换 Shopify 顾客资料里的值，所以 cashier 要当面跟顾客核对。新邮箱或新电话如果已被另一位顾客使用，Shopify 会拒绝，POS 上会显示原因。
5. **扩展还没有在真实 POS 设备上运行过。** 代码已经通过 Shopify 官方类型检查和模拟测试，但真实设备上的表现（特别是搜索）要在步骤 8 和第三部分的测试中确认。有任何问题，把截图或 Render 日志发给我。
