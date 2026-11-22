# 微信连接与维护说明

第一版使用腾讯公开客户端中的 iLink Bot 协议，连接自己扫码绑定的微信 ClawBot。无需部署公网回调服务器。此项目是独立的社区实现，腾讯客户端的开源协议说明不构成服务可用性承诺。

协议依据：[腾讯协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[请求实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts)、[二维码登录](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)、[消息结构](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts)。核对日期：2026-11-22；上游当时版本为 `3.0.0-beta-1`。

## 本版流程

1. `POST /ilink/bot/get_bot_qrcode?bot_type=3` 请求自己的绑定二维码，本版不绑定他人的 ClawBot。
2. 展示原始 `qrcode_img_content`，使用 `qrcode` 查询 `GET /ilink/bot/get_qrcode_status`。手机要求 PIN 时，将输入附在下一次查询。
3. 只有 `confirmed` 的可信服务响应才能建立账号绑定。将扫码人的 `ilink_user_id` 作为唯一允许的聊天发送者和回复接收者。
4. `POST /ilink/bot/getupdates` 长轮询。应用层负责把收到的消息和游标一起持久化后再处理。
5. `POST /ilink/bot/sendmessage` 回传文字。回复必须带收到的 `context_token`，发送给绑定的本人。

腾讯的版本字段要求先填写兼容的上游版本，再附本项目版本，因此本版使用 `channel_version: 3.0.0/wechat-chatgpt-bridge-0.1.0`，应用版本头为 `196608`。`bot_agent: WeChatChatGPTBridge/0.1.0` 仅标识客户端。

## V1 明确边界

- 仅接收本人发来的完整单聊文字；群聊、引用、媒体、其他人消息及机器人回声都不会交给 ChatGPT。
- 每条输入只接受一个文字条目，输出按应用层规则切分到每条不超过 4000 UTF-8 字节。这个数值是本项目的保守实现上限。
- 请求固定发往 `https://ilinkai.weixin.qq.com`，拒绝 HTTP 跳转和登录跨地域跳转。本版遇到 `scaned_but_redirect` 或 `binded_redirect` 会明确停止；这类账号暂不在第一版已支持范围内。
- 单次读取最多 1 MiB，普通请求 15 秒，长轮询 40 秒；消息收发请求接受取消信号。微信适配器没有公网监听端口。
- 消息 ID 可能超过 JavaScript 的安全整数范围；先保留原始整数文本再解析。不得把消息 ID 转成 `Number`，也不得依赖浮点数生成去重键。
- 发送结果不明确时 `WeChatError.uncertain` 为 `true`，适配器不自动重发。明确的业务拒绝也应由上层记录后告知用户，不能把 `ret=-2` 固定解释成一种原因。
- 日志仅使用固定错误码、HTTP 状态和数值业务码，不能记录响应正文、请求 URL 查询、令牌、二维码或聊天内容。登录令牌和上下文应保存在本机私有状态目录中。

## 维护验收

`node --test test/wechat.test.js` 覆盖 QR/PIN、精确 ID、本人绑定、文字保真、错误与不确定状态、响应大小限制和取消，所有网络使用合成响应。

这些测试不证明某个新微信账号能完成实际扫码或收发。正式发布前应使用单独的测试账号，从全新状态目录实际完成扫码、手机发文字、ChatGPT 回答、微信收回、重启去重与 Ctrl+C 停止。

## 适配器接口

```js
import { WeChatClient, validateConfirmedLogin, extractOwnerText } from '../src/wechat.js';

// 登录阶段：不要记录返回的二维码或凭据。
const unauthenticated = new WeChatClient();
const qr = await unauthenticated.getQr();
// 在本地显示 qr.qrcode_img_content，等待本人扫码。
const status = await unauthenticated.pollQr(qr.qrcode /*, phonePin */);
// 仅当 status.status === 'confirmed' 时：
const credentials = validateConfirmedLogin(status);
const client = new WeChatClient({ credentials });
// getUpdates(cursor, { signal }) 返回腾讯响应，createdAt 是毫秒时间戳。
// extractOwnerText(msg, credentials) 返回 null 或 { id, text, contextToken, createdAt }。
// sendText({ text, contextToken, clientId }, { signal }) 不接受可变接收人。
```

示例省略轮询、私有存储和提交去重；正式入口应使用项目 CLI。
