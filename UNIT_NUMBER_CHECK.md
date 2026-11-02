# 地址单元号（Unit Number）检查：现状与计划

> Hera Beauté · Hera_POS_aid 后端（Render：`https://search-0wf4.onrender.com`）
> 整理日期：2026-11-02。本文汇总到目前为止关于"多单元建筑、漏填单元号"的讨论，供另一个对话继续。

---

## 1. 目标

识别**寄往加拿大多单元建筑（公寓、Condo、办公楼）却没填单元号**的线上订单，减少 Canada Post 投递失败。

要区分两个问题：

1. **这个地址是不是多单元建筑？**（靠 Canada Post AddressComplete 判断）
2. **顾客有没有漏填单元号？**（看地址文字本身）

只有"是多单元建筑"且"没填单元号"才需要处理。

---

## 2. 计划（三步）

1. **干测试（先做）**：拿到 AddressComplete API key，手动提交几个已知地址，看返回结果是否准确可靠。
2. **结账扩展（Checkout extension）**：顾客结账时，如果地址应该有单元号却没写，就拦截并提示。顾客可以：
   - 回去补填单元号，或
   - 确认"我的地址没有单元号"，继续结账。
3. **Shopify Flow 二次扫描**：每张非 POS 的新订单再检查一遍，命中的打标签（如 `Check unit`），人工确认。

---

## 3. "已填单元号"的判断规则（当前实现）

满足任一条即视为**已填**，不再查询：

- 地址第二行（address2）**有内容**；
- 第一行是 `单元-门牌` 格式：`12-345 Main St`、`A-345 Rue X`、`12 - 345 …`；
- 第一行含单元关键词 + 号码：`#12`、`Apt / Apartment / App / Appartement / Unit / Unité / Suite / Ste / Bureau / Bur / Logement / Log / Room / Rm / Porte / PH / Penthouse 12`。

已测试的例子：

| 地址第一行 | 第二行 | 视为已填？ |
|---|---|---|
| `345 Main St` | （空） | 否 → 去查 |
| `345 Main St` | `Apt 5` | 是 |
| `12-345 Main St` | | 是 |
| `A-345 Rue X` | | 是 |
| `345 Main St #12` | | 是 |
| `1234 Rue Saint-Denis app. 5` | | 是 |
| `345 Rue Ste-Catherine` | | 否（"Ste-"是街名，不误判） |
| `345 Burnside Rd` / `345 Logan Ave` | | 否（不误判） |

**待确认**：用户原话是"address line 是空的，**或者** line 1 里没有 `{unit}-{street number}`"。当前实现理解为"两处都没有单元号才查"。如果意思是"只要 line 1 不是 `单元-门牌` 格式就标记（即使 line 2 写了 Apt 5）"，需要改。

---

## 4. Canada Post AddressComplete：已知信息

### 4.1 接口（官方文档）

- **Interactive Find（v2.10）**：按输入文字搜索匹配地址。
  - 参数：`Key`（必填）、`SearchTerm`（必填）、`LastId`、`Country`（默认 CAN）、`LanguagePreference`（默认 en）、`MaxSuggestions`（默认 7）。
  - 返回：`Id`、`Text`、`Highlight`、`Cursor`、`Description`、`Next`（`Find` 或 `Retrieve`）。
  - `Next = Retrieve` → 把 Id 交给 Retrieve；`Next = Find` → 这是一个"容器"，再调 Find 并把 Id 作为 `LastId` 展开。
- **Interactive Retrieve（v2.11）**：用 Find 拿到的 Id 取完整地址。
  - 参数（文档列出）：`Key`、`Id`。
  - 返回字段包括：`SubBuilding`、`BuildingNumber`、`BuildingName`、`Street`、`Line1`–`Line5`、`Company`、`PostalCode`、`DataLevel` 等。
  - 返回格式列表中有一项 **"JSON (with extra)"**，文档没解释额外返回什么。
- 文档只描述这两个方法，**没有**"直接校验一个完整地址"的接口。
- 当前代码用的 REST 地址（PCA/Loqate 惯例，**尚未用真实 key 验证**）：
  `https://ws1.postescanada-canadapost.ca/AddressComplete/Interactive/Find/v2.10/json3.ws?Key=…&SearchTerm=…&Country=CAN`

### 4.2 Multi-Unit 标记 `{AcMua}`

- Canada Post **安装指南**里有两个额外标记，用于网页 JavaScript 控件的字段映射：
  - `{AcMua}`：Multi-Unit 标记（示例：`{ element: "multi-unit", field: "{AcMua}", mode: pca.fieldMode.POPULATE }`）
  - `{AcRbdi}`：住宅 / 商业标记
- 指南说添加这些标记时字段名要加花括号。
- **未知**：
  - `{AcMua}` 的可能取值（Y/N？代码？）**文档没写**；
  - 服务器端 Retrieve 能否返回它：Retrieve 文档的参数里**没有** `Field1Format`…`Field20Format`。同系统的 Loqate 版本支持 `Field1Format={AcMua}` 这类参数（未能打开 Loqate 文档核实），Canada Post 版本是否支持需实测；
  - 你的 key / 套餐是否包含这些标记（Retrieve 错误 1002 "Not Available" 表示账户无权取该数据）。

### 4.3 多单元的另一种判断方式（不依赖 `{AcMua}`）

推测（**需干测试验证**）：查一个多单元建筑的门牌时，Find 会返回：

- 一个容器条目：`Text: "345 Main St"`，`Description: "Toronto, ON, M5V 1A1 - 24 Addresses"`，`Next: "Find"`；或
- 一串带单元号的地址：`1-345 Main St`、`2-345 Main St`…

当前代码用这个规则判断"多单元"。

### 4.4 费用与 key

- 预付套餐，例如 $35 / 300 次（11.6¢），$2,000 / 25,000 次（8¢），最高 500,000 次 $20,000（4¢）；国际地址每次 +1¢；12 个月有效。
- **未确认**：Find 是否计费，还是只有 Retrieve 计费 → 干测试时看账户余额变化。
- key 可以限制 IP、URL、可用的 web service。服务器端使用是否符合 EULA 需看最终用户协议。
- **key 不能放在浏览器或结账扩展代码里**，只放 Render 环境变量，由后端调用。

---

## 5. 已写好的代码（Hera_POS_aid）

文件已在 `D:\Hera_APPs\Hera_POS_aid`，**尚未配置 key、尚未实际测试**：

- `address.js`：接口 `POST /api/address/check`
  - 认证：header `X-Address-Key` = Render 变量 `ADDRESS_CHECK_KEY`（24 位以上随机字符）
  - AddressComplete key：Render 变量 `CANADAPOST_AC_KEY`
  - 输入 JSON：`order, address1, address2, city, province, zip, countryCode`
  - 输出：`{ needsReview, status, units?, building?, how?, reason?, error? }`
    - `status`：`unit-missing`（需人工）、`unit-given`、`single-unit`、`skipped`（无地址 / 非加拿大）、`error`
  - 同一地址查询结果缓存 7 天（内存，重启清空）
  - 每次在 Render 日志写一行 `[address] #订单号: 状态`
- `server.js`：已注册 `registerAddressCheck(app, { rateLimit, safeEqual })`
- `render.yaml`、`README.md`：已加两个变量和说明

**设计选择**：订单标签由 Flow 自己加，后端只回答"要不要人工处理"，所以 app **不需要新增 `write_orders` 权限**（当前 scopes 只有 `read_orders`）。

### 5.1 建议的下一步代码改动

- 先用 Find 定位门牌对应的地址，再调 Retrieve 并尝试取 `{AcMua}`（`Field1Format={AcMua}` 或 "JSON (with extra)" 格式）。取得到就以它为准，取不到就退回 4.3 的容器判断。
- 加一个**干测试模式**（例如 header 或参数 `debug=1`）：把 AddressComplete 原始返回写进日志或直接返回，方便手动比对。

---

## 6. Shopify Flow 设置（二次扫描）

1. 触发：**Order created**
2. 条件：**Source name ≠ `pos`**
3. **Send HTTP request**
   - `POST https://search-0wf4.onrender.com/api/address/check`
   - Headers：`Content-Type: application/json`；`X-Address-Key: <ADDRESS_CHECK_KEY>`（用 Flow 的 Secret 保存）
   - Body：
     ```liquid
     {
       "order": {{ order.name | json }},
       "address1": {{ order.shippingAddress.address1 | json }},
       "address2": {{ order.shippingAddress.address2 | json }},
       "city": {{ order.shippingAddress.city | json }},
       "province": {{ order.shippingAddress.provinceCode | json }},
       "zip": {{ order.shippingAddress.zip | json }},
       "countryCode": {{ order.shippingAddress.countryCodeV2 | json }}
     }
     ```
4. **Run code**（解析返回）
   - Input：`{ sendHttpRequest { status body } }`
   - Code：
     ```js
     export default function main(input) {
       let data = {};
       try { data = JSON.parse(input.sendHttpRequest.body || '{}'); } catch (e) {}
       return { needsReview: data.needsReview === true, status: String(data.status || 'error') };
     }
     ```
   - Output schema：`type Output { needsReview: Boolean! status: String! }`
5. 条件 `needsReview` 为 true → **Add order tags** `Check unit`
6. 可选：`status = error` → 加 `Address check failed`

Flow 编辑器里的实际字段名（如 `sendHttpRequest`）以变量选择器为准。Flow 的 Send HTTP request 自 2025-05 起可把响应交给后续步骤（Run code 里用 `JSON.parse`）。

---

## 7. 结账扩展（尚未开始，待研究）

- 思路：结账填完收货地址后，扩展把地址发给后端（同一套判断逻辑），后端调用 AddressComplete；若 `unit-missing`，阻止继续并提示，提供"去补填"和"我的地址没有单元号，继续"两个选择。
- 需要研究 / 确认：
  - 用哪个 checkout UI extension 目标（收货地址附近）以及**拦截前进**的 API（buyer journey intercept）；
  - 信息 / 配送步骤的 checkout UI extension 是否需要 **Shopify Plus**；
  - 扩展需开启 **network access**，后端需要单独的认证方式（结账扩展的 session token），不能复用 Flow 的 key；
  - 顾客选择"继续"后如何记录（例如写入订单属性），让 Flow 二次扫描时知道顾客已确认，避免重复标记；
  - 响应速度：结账中调用必须快，AddressComplete 超时时应放行而不是卡住顾客。

---

## 8. 干测试清单

准备以下地址，分别查询并记录 Find、Retrieve 原始返回（含 `{AcMua}` 是否出现、取值）：

- 已知公寓楼 / Condo，不填单元号
- 同一栋楼，填了单元号
- 独立屋（single-family）
- 商业办公楼
- 魁北克法语地址（Rue / App. / Bureau）
- 农村地址或 PO Box

同时记录：每种调用前后账户余额变化（确认计费方式）、响应时间。

---

## 9. 参考

- [AddressComplete API 总览](https://www.canadapost-postescanada.ca/ac/support/api/)
- [Interactive Find](https://www.canadapost-postescanada.ca/ac/support/api/addresscomplete-interactive-find/)
- [Interactive Retrieve](https://www.canadapost-postescanada.ca/ac/support/api/addresscomplete-interactive-retrieve/)
- [安装指南（含 {AcMua}、{AcRbdi}）](https://www.canadapost-postescanada.ca/ac/support/setup-guides/)
- [价格](https://www.canadapost-postescanada.ca/ac/pricing/)
- [Flow：Send HTTP request 可返回数据（Shopify changelog）](https://shopify.dev/changelog/posts/flow-improved-send-http-request-action-enables-secure-connections-and-returns-data-to-the-workflow)
