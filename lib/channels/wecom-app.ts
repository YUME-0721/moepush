import { BaseChannel, ChannelConfig, SendMessageOptions } from "./base"

interface WecomAppMessage {
  msgtype: string
  touser?: string
  toparty?: string
  totag?: string
  agentid: number
  text?: {
    content: string
  }
  markdown?: {
    content: string
  }
  safe?: number
}

const PROXY_URL = process.env.WECOM_PROXY_URL || null

async function proxyFetch(targetUrl: string, options?: RequestInit): Promise<Response> {
  if (!PROXY_URL) {
    return fetch(targetUrl, options)
  }
  
  const headers = new Headers(options?.headers)
  headers.set('x-target-url', targetUrl)
  
  return fetch(PROXY_URL, {
    method: options?.method || 'GET',
    headers,
    body: options?.body,
  })
}

export class WecomAppChannel extends BaseChannel {
  readonly config: ChannelConfig = {
    type: "wecom_app",
    label: "企业微信应用",
    templates: [
      {
        type: "text",
        name: "文本消息",
        description: "最基础的消息类型",
        fields: [
          { key: "text.content", description: "消息内容", required: true, component: 'textarea' },
          { key: "touser", description: "指定接收消息的成员", component: 'input' },
          { key: "toparty", description: "指定接收消息的部门", component: 'input' },
          { key: "totag", description: "指定接收消息的标签", component: 'input' },
          { key: "safe", description: "是否保密消息", component: 'checkbox' },
          { key: "msgtype", component: 'hidden', defaultValue: "text" },
        ],
      },
      {
        type: "markdown",
        name: "Markdown消息",
        description: "支持Markdown格式的富文本消息",
        fields: [
          { key: "markdown.content", description: "markdown格式的消息内容", required: true, component: 'textarea' },
          { key: "touser", description: "指定接收消息的成员" },
          { key: "toparty", description: "指定接收消息的部门" },
          { key: "totag", description: "指定接收消息的标签" },
          { key: "msgtype", component: 'hidden', defaultValue: "markdown" },
        ],
      },
    ]
  }

  async sendMessage(
    message: WecomAppMessage,
    options: SendMessageOptions
  ): Promise<Response> {
    const { corpId, agentId, secret } = options
    
    if (!corpId || !agentId || !secret) {
      throw new Error("缺少必要的配置信息")
    }
    
    console.log('sendWecomAppMessage message:', message)

    const tokenResponse = await proxyFetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`
    )
    const tokenData = await tokenResponse.json() as { access_token: string, errcode: number, errmsg: string }
    
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(`获取访问令牌失败: ${tokenData.errmsg}`)
    }

    const response = await proxyFetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...message,
          agentid: parseInt(agentId),
          touser: message.touser || "@all",
        }),
      }
    )

    const data = await response.json() as { errcode: number, errmsg: string }
    if (data.errcode !== 0) {
      throw new Error(`企业微信应用消息推送失败: ${data.errmsg}`)
    }

    return response
  }
} 
