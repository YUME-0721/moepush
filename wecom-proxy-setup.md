# 企业微信应用代理服务配置指南

本文档说明如何配置企业微信应用推送的代理服务，适用于更换 VPS 或迁移到飞牛 NAS 等场景。

## 架构说明

```
MoePush Pages → Worker (pushproxy.域名) → VPS/NAS 代理 (proxy.域名) → 企业微信 API
```

## 前置条件

- 一台有固定公网 IP 的服务器（VPS 或 NAS）
- 域名（已托管在 Cloudflare）
- Cloudflare 账号

---

## 第一部分：服务器端配置

### 1. 安装 Node.js

**Ubuntu/Debian：**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**飞牛 NAS（fnOS）：**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. 创建代理服务

```bash
mkdir -p ~/moepush-proxy && cd ~/moepush-proxy

cat > proxy.js << 'EOF'
const http = require('http');
const https = require('https');
const url = require('url');

const server = http.createServer((req, res) => {
  const targetUrl = req.headers['x-target-url'];
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing x-target-url header');
    return;
  }

  const parsedUrl = new url.URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: { ...req.headers, host: parsedUrl.hostname }
  };
  delete options.headers['x-target-url'];

  const proxyReq = httpModule.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(8080, '0.0.0.0', () => {
  console.log('Proxy running on port 8080');
});
EOF
```

### 3. 配置 systemd 服务（开机自启）

```bash
sudo tee /etc/systemd/system/moepush-proxy.service << 'EOF'
[Unit]
Description=MoePush Proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/moepush-proxy
ExecStart=/usr/bin/node proxy.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable moepush-proxy
sudo systemctl start moepush-proxy
sudo systemctl status moepush-proxy
```

### 4. 配置 HTTPS

#### 方案 A：使用 Lucky（推荐）

1. 访问 Lucky 管理面板
2. 配置反向代理：
   - 前端地址：`https://proxy.你的域名`
   - 后端地址：`http://127.0.0.1:8080`
3. 申请 SSL 证书

#### 方案 B：使用 Nginx + Certbot

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/proxy << 'EOF'
server {
    listen 443 ssl;
    server_name proxy.你的域名;

    ssl_certificate /etc/letsencrypt/live/proxy.你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.你的域名/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/proxy /etc/nginx/sites-enabled/
sudo certbot --nginx -d proxy.你的域名
sudo systemctl restart nginx
```

### 5. 配置防火墙

**云服务商安全组：** 放行 443 端口

**本地防火墙：**

```bash
sudo ufw allow 443
sudo ufw allow 8080
```

---

## 第二部分：Cloudflare 配置

### 1. DNS 配置

| 类型 | 名称 | 内容 | 代理状态 |
|------|------|------|---------|
| A | proxy | 服务器IP | DNS only（灰色云朵） |
| Worker | pushproxy | moepush-proxy | Proxied（橙色云朵） |

### 2. 创建 Worker

Cloudflare Dashboard → Workers & Pages → Create Worker

```javascript
export default {
  async fetch(request) {
    const targetUrl = request.headers.get('x-target-url');
    if (!targetUrl) {
      return new Response('Missing x-target-url', { status: 400 });
    }

    const method = request.method;
    const body = method !== 'GET' ? await request.text() : undefined;

    const response = await fetch('https://proxy.你的域名/', {
      method,
      headers: {
        'x-target-url': targetUrl,
      },
      body,
    });

    return response;
  }
}
```

### 3. 配置 Worker 自定义域名

Worker → Settings → Triggers → Custom Domains → 添加 `pushproxy.你的域名`

---

## 第三部分：企业微信配置

### 1. 添加 IP 白名单

企业微信管理后台 → 应用管理 → 企业可信IP → 添加服务器公网 IP

### 2. 配置可信域名

1. 下载验证文件放到 MoePush 项目的 `public/` 目录
2. 重新部署
3. 完成验证

---

## 第四部分：MoePush 配置

### Cloudflare Pages 环境变量

| 变量名 | 值 |
|--------|-----|
| `WECOM_PROXY_URL` | `https://pushproxy.你的域名` |

---

## 验证测试

```bash
# 测试代理服务（在服务器上）
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" http://127.0.0.1:8080

# 测试 HTTPS 代理
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" https://proxy.你的域名/

# 测试 Worker
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" https://pushproxy.你的域名/
```

预期返回：`{"errcode":40013,"errmsg":"invalid corpid...","from ip: 你的服务器IP"...}`

---

## 常用命令

```bash
sudo systemctl status moepush-proxy
sudo systemctl restart moepush-proxy
sudo systemctl stop moepush-proxy
journalctl -u moepush-proxy -f
```

---

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| Worker 报错 1003 | DNS 记录配置错误，确认 proxy 域名是灰色云朵 |
| Worker 报错 525 | HTTPS 配置问题，检查 SSL 证书 |
| 推送失败 | 检查企业微信 IP 白名单、代理服务状态 |
| 代理超时 | 检查防火墙、端口是否放行 |
