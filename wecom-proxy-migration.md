# 企业微信应用代理服务迁移指南

本文档说明如何将企业微信应用代理服务迁移到新的 VPS 或飞牛 NAS。

## 架构说明

```
MoePush Pages → Cloudflare Worker → VPS/NAS 代理 → 企业微信 API
                      ↓                      ↓
              pushproxy.xxx.xyz         proxy.xxx.xyz
                                           ↓
                                      固定出口 IP
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
# 飞牛 NAS 基于 Debian，使用相同方式安装
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. 创建代理服务

```bash
# 创建目录
mkdir -p ~/moepush-proxy && cd ~/moepush-proxy

# 创建代理脚本
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

# 重载 systemd
sudo systemctl daemon-reload

# 启用开机自启
sudo systemctl enable moepush-proxy

# 启动服务
sudo systemctl start moepush-proxy

# 检查状态
sudo systemctl status moepush-proxy
```

### 4. 配置 HTTPS（使用 Lucky 或 Nginx）

#### 方案 A：使用 Lucky（推荐）

1. 访问 Lucky 管理面板
2. 配置反向代理：
   - 前端地址：`https://proxy.你的域名`
   - 后端地址：`http://127.0.0.1:8080`
3. 申请 SSL 证书

#### 方案 B：使用 Nginx + Certbot

```bash
# 安装 nginx 和 certbot
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx

# 配置 nginx
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

# 申请 SSL 证书
sudo certbot --nginx -d proxy.你的域名

# 重启 nginx
sudo systemctl restart nginx
```

### 5. 配置防火墙

**华为云/阿里云/腾讯云：**
- 安全组放行 443 端口

**本地防火墙：**

```bash
# ufw
sudo ufw allow 443
sudo ufw allow 8080

# iptables
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

---

## 第二部分：Cloudflare 配置

### 1. DNS 配置

在 Cloudflare DNS 添加两条记录：

| 类型 | 名称 | 内容 | 代理状态 |
|------|------|------|---------|
| A | proxy | 你的服务器IP | DNS only（灰色云朵） |
| CNAME | pushproxy | 你的Worker域名 | Proxied（橙色云朵） |

### 2. 创建 Worker

1. Cloudflare Dashboard → Workers & Pages → Create Worker
2. 名称：`moepush-proxy`
3. 代码：

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

4. Deploy

### 3. 配置 Worker 自定义域名

1. Worker → Settings → Triggers → Custom Domains
2. 添加：`pushproxy.你的域名`

---

## 第三部分：企业微信配置

### 1. 添加 IP 白名单

在企业微信管理后台 → 应用管理 → 企业可信IP：

```
你的服务器公网IP
```

### 2. 配置可信域名

1. 下载验证文件
2. 放到 MoePush 项目的 `public/` 目录
3. 重新部署
4. 完成验证

---

## 第四部分：MoePush 配置

### Cloudflare Pages 环境变量

| 变量名 | 值 |
|--------|-----|
| `WECOM_PROXY_URL` | `https://pushproxy.你的域名` |

---

## 验证测试

### 1. 测试代理服务

```bash
# 在服务器本地测试
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" http://127.0.0.1:8080
```

预期返回：
```json
{"errcode":40013,"errmsg":"invalid corpid, hint: [...], from ip: 你的服务器IP, ..."}
```

### 2. 测试 HTTPS 代理

```bash
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" https://proxy.你的域名/
```

### 3. 测试 Worker

```bash
curl -H "x-target-url: https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=test&corpsecret=test" https://pushproxy.你的域名/
```

### 4. 测试 MoePush 推送

在 MoePush 界面测试推送。

---

## 常用命令

```bash
# 查看服务状态
sudo systemctl status moepush-proxy

# 重启服务
sudo systemctl restart moepush-proxy

# 查看日志
journalctl -u moepush-proxy -f

# 停止服务
sudo systemctl stop moepush-proxy

# 禁用开机自启
sudo systemctl disable moepush-proxy
```

---

## 故障排查

### 1. 代理服务无法启动

```bash
# 检查 Node.js 版本
node --version

# 检查端口占用
sudo netstat -tlnp | grep 8080

# 手动运行测试
cd ~/moepush-proxy && node proxy.js
```

### 2. Worker 报错 1003

- 检查 DNS 记录是否正确
- 确认 `proxy.你的域名` 是灰色云朵（DNS only）
- 确认 HTTPS 证书有效

### 3. Worker 报错 525

- HTTPS 配置有问题
- 检查 SSL 证书是否有效

### 4. 推送失败

- 检查企业微信 IP 白名单
- 检查代理服务是否运行
- 查看服务器日志

---

## 迁移检查清单

- [ ] 安装 Node.js
- [ ] 创建代理脚本
- [ ] 配置 systemd 服务
- [ ] 配置 HTTPS（Lucky/Nginx）
- [ ] 配置防火墙
- [ ] 更新 DNS 记录
- [ ] 更新 Worker 代码中的域名
- [ ] 更新企业微信 IP 白名单
- [ ] 更新 MoePush 环境变量
- [ ] 测试验证
