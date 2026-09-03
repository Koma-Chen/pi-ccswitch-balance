<div align="center">

# Pi CCSwitch Balance

**在 Pi 终端页脚显示当前供应商余额，以及上轮 / 本会话消耗。**

<sub>Base URL + API Key · `GET /v1/usage` · 跟随 CCSwitch 切换供应商</sub>

</div>

---

从 Pi 当前 `models.json` 读取站点地址和 API Key，请求 `GET /v1/usage`，把余额画在页脚。`models.json` 里已有 Key 时**不必**再登录。

## 适用站点

只支持提供以下接口的网关（常见于 TokenRouter / Sub2API 兼容站）：

```http
GET {baseUrl}/v1/usage
Authorization: Bearer <API Key>
```

没有该接口的站点（包括多数 New API 中转）会显示「该站无用量接口」，不会去猜别的余额 API。

## 功能

- 自动使用当前 `models.json` 的 Base URL 和 API Key
- 页脚显示站点名、余额、上轮消耗、本会话累计
- 监听 `models.json` / `settings.json`，CCSwitch 切换供应商后页脚跟随
- 每轮 Agent 结束后刷新，并在 1/3/6 秒补查异步结算
- 余额低于 `$1` / `$0.2` 时仍在状态行标出当前数字；不替换整个页脚
- 通过 `setStatus` 写入扩展状态行，可与 `pi-open-tui` 等页脚扩展共存

## 安装

```bash
pi install git:github.com/Koma-Chen/pi-ccswitch-balance
```

发布到 npm 后也可以：

```bash
pi install npm:pi-ccswitch-balance
```

然后重启 Pi，或运行 `/reload`。

| 更新 | 卸载 |
| --- | --- |
| `pi update git:github.com/Koma-Chen/pi-ccswitch-balance` | `pi remove pi-ccswitch-balance` |

## 使用

多数情况打开即可。只有 `models.json` 没有 Key，或查余额要用另一把 Key 时：

```text
/ccswitch-login
```

| 命令 | 作用 |
| --- | --- |
| `/ccswitch-login` | 为当前站点额外保存用量 Key |
| `/ccswitch-refresh` | 立即刷新余额 |
| `/ccswitch-status` | 查看站点、余额、消耗和错误 |
| `/ccswitch-logout` | 清除当前站点的额外凭据 |

额外凭据写在 `~/.pi/agent/ccswitch-balance.json`，权限 `0600`。

页脚示例：

```text
MySite 余额: $12.34  上轮 -$0.18  会话 -$0.55
```

CCSwitch 切换供应商后，页脚会换站。若模型请求仍打旧站，再 `/reload` 一次。

## 开发

```bash
npm run check
```

## 许可证

[MIT](./LICENSE)
