<div align="center">

# Pi CCSwitch Balance

**在 Pi 终端页脚显示当前供应商余额，以及上轮 / 本会话消耗。**

**Show the current provider balance and last-turn / session spending in the Pi terminal footer.**

<sub>Base URL + API Key · `GET /v1/usage` · 跟随 CCSwitch 切换供应商 / Follows CCSwitch provider changes</sub>

</div>

[中文](#中文) | [English](#english)

## 中文

插件从 Pi 当前 `models.json` 读取站点地址和 API Key，请求 `GET /v1/usage`，并在页脚显示余额。`models.json` 已有 Key 时无需再次登录。

### 适用站点

只支持提供以下接口的网关，常见于 TokenRouter / Sub2API 兼容站：

```http
GET {baseUrl}/v1/usage
Authorization: Bearer <API Key>
```

没有该接口的站点（包括多数 New API 中转）会显示“该站无用量接口”，不会猜测其他余额 API。

### 功能

- 自动使用当前 `models.json` 的 Base URL 和 API Key
- 页脚显示站点名、余额、上轮消耗和本会话累计
- 监听 `models.json` / `settings.json`，CCSwitch 切换供应商后页脚同步更新
- 每轮 Agent 结束后刷新，并在 1 / 3 / 6 秒补查异步结算
- 通过 `setStatus` 只写入自己的扩展状态行，不替换整个页脚，可与 `pi-open-tui` 等页脚扩展共存

### 安装

```bash
pi install npm:pi-ccswitch-balance
```

或从 GitHub 安装：

```bash
pi install git:github.com/Koma-Chen/pi-ccswitch-balance
```

安装后重启 Pi，或执行 `/reload`。

| 更新 | 卸载 |
| --- | --- |
| `pi update npm:pi-ccswitch-balance` | `pi remove npm:pi-ccswitch-balance` |

### 使用

多数情况安装后即可使用。只有 `models.json` 没有 Key，或查询余额需要另一把 Key 时才需执行：

```text
/ccswitch-login
```

| 命令 | 作用 |
| --- | --- |
| `/ccswitch-login` | 为当前站点额外保存用量 Key |
| `/ccswitch-refresh` | 立即刷新余额 |
| `/ccswitch-status` | 查看站点、余额、消耗和错误 |
| `/ccswitch-logout` | 清除当前站点的额外凭据 |

额外凭据保存在 `~/.pi/agent/ccswitch-balance.json`，文件权限为 `0600`。

页脚示例：

```text
MySite 余额: $12.34  上轮 -$0.18  会话 -$0.55
```

CCSwitch 切换供应商后，页脚会同步切换站点。若模型请求仍使用旧站点，再执行一次 `/reload`。

## English

The extension reads the current site URL and API key from Pi's `models.json`, requests `GET /v1/usage`, and shows the balance in the footer. No additional login is required when `models.json` already contains the key.

### Supported gateways

The gateway must provide the following endpoint, commonly available on TokenRouter / Sub2API-compatible services:

```http
GET {baseUrl}/v1/usage
Authorization: Bearer <API Key>
```

Sites without this endpoint, including most New API relays, display “该站无用量接口” (“No usage endpoint”) instead of probing unrelated balance APIs.

### Features

- Uses the Base URL and API key from the active `models.json` entry automatically
- Shows the site name, remaining balance, last-turn spending, and session spending
- Watches `models.json` and `settings.json` so the footer follows CCSwitch provider changes
- Refreshes after every agent run, with follow-up checks after 1 / 3 / 6 seconds for delayed settlement
- Uses `setStatus` to update only its own extension status instead of replacing the entire footer, allowing coexistence with footer extensions such as `pi-open-tui`

### Installation

```bash
pi install npm:pi-ccswitch-balance
```

Or install from GitHub:

```bash
pi install git:github.com/Koma-Chen/pi-ccswitch-balance
```

Restart Pi after installation, or run `/reload`.

| Update | Remove |
| --- | --- |
| `pi update npm:pi-ccswitch-balance` | `pi remove npm:pi-ccswitch-balance` |

### Usage

The extension normally works immediately after installation. Run the following command only when `models.json` has no key or the usage endpoint requires a different key:

```text
/ccswitch-login
```

| Command | Description |
| --- | --- |
| `/ccswitch-login` | Save an additional usage API key for the current site |
| `/ccswitch-refresh` | Refresh the balance immediately |
| `/ccswitch-status` | Show the current site, balance, spending, and errors |
| `/ccswitch-logout` | Remove the additional credential for the current site |

Additional credentials are stored in `~/.pi/agent/ccswitch-balance.json` with file mode `0600`.

Footer example (the current runtime labels are Chinese):

```text
MySite 余额: $12.34  上轮 -$0.18  会话 -$0.55
```

The footer follows CCSwitch when the provider changes. If model requests still use the previous provider, run `/reload` once.

## Development

```bash
npm run check
```

## License

[MIT](./LICENSE)
