/**
 * 图片拼接合图服务
 * 部署平台：Railway
 * 运行环境：Node.js 18+
 *
 * POST /collage
 * Body: {
 *   images:  [{ name, base64, mimeType }],  // 图片数据
 *   layout:  'smart' | '2col' | '3col' | 'row',
 *   width:   number,   // 画布宽度
 *   height:  number,   // 画布高度
 *   gap:     number,   // 间距 px
 *   bgColor: string,   // 背景色 HEX
 * }
 * Response: { url: string }  // 合成图片的临时下载地址
 */

const http    = require('http');
const https   = require('https');
const { createCanvas, loadImage } = require('canvas');

const PORT = process.env.PORT || 3000;

// ── 计算列数 ─────────────────────────────────────────
function calcCols(n, layout) {
  if (layout === '2col') return n <= 1 ? 1 : 2;
  if (layout === '3col') return n <= 1 ? 1 : n <= 2 ? 2 : 3;
  if (layout === 'row')  return n;
  // smart
  if (n === 1) return 1;
  if (n <= 2)  return 2;
  if (n <= 4)  return 2;
  if (n <= 6)  return 3;
  if (n <= 9)  return 3;
  return 4;
}

// ── 合成图片核心逻辑 ──────────────────────────────────
async function collageImages({ images, layout, width, height, gap, bgColor }) {
  const n    = images.length;
  const cols = calcCols(n, layout);
  const rows = Math.ceil(n / cols);

  const cellW = Math.floor((width  - gap * (cols + 1)) / cols);
  const cellH = Math.floor((height - gap * (rows + 1)) / rows);

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  // 填充背景
  ctx.fillStyle = bgColor || '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 并行加载所有图片
  const imgObjects = await Promise.all(
    images.map(async (img) => {
      try {
        const dataUrl = `data:${img.mimeType};base64,${img.base64}`;
        return await loadImage(dataUrl);
      } catch (e) {
        console.error('[collage] loadImage failed:', e.message);
        return null;
      }
    })
  );

  // 绘制每张图，保持原始比例居中
  imgObjects.forEach((img, i) => {
    if (!img) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = gap + col * (cellW + gap);
    const cy  = gap + row * (cellH + gap);

    const ir = img.width  / img.height;
    const tr = cellW / cellH;
    let dw, dh;
    if (ir > tr) { dw = cellW; dh = cellW / ir; }
    else          { dh = cellH; dw = cellH * ir; }

    const dx = cx + (cellW - dw) / 2;
    const dy = cy + (cellH - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
  });

  return canvas.toBuffer('image/png');
}

// ── 上传到图床，返回公网可访问 URL ───────────────────────
// 使用 Telegraph 匿名图床（免费，无需注册，支持 POST 上传）
async function uploadToTelegraph(pngBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const filename  = `collage_${Date.now()}.png`;

    // 手动构造 multipart/form-data
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body   = Buffer.concat([header, pngBuffer, footer]);

    const options = {
      hostname: 'telegra.ph',
      path:     '/upload',
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // telegraph 返回 [{ src: '/file/xxx.png' }]
          if (Array.isArray(json) && json[0]?.src) {
            resolve('https://telegra.ph' + json[0].src);
          } else {
            reject(new Error('Telegraph upload failed: ' + data));
          }
        } catch (e) {
          reject(new Error('Telegraph parse error: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── HTTP 服务 ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/collage') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body);
        const { images, layout = 'smart', width = 1080, height = 1080, gap = 8, bgColor = '#ffffff' } = params;

        if (!images?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'images is required' }));
          return;
        }

        console.log(`[collage] processing ${images.length} images, ${width}x${height}, layout=${layout}`);

        const pngBuf = await collageImages({ images, layout, width, height, gap, bgColor });
        console.log(`[collage] canvas done, size=${pngBuf.length} bytes, uploading...`);

        const url = await uploadToTelegraph(pngBuf);
        console.log(`[collage] uploaded: ${url}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url }));

      } catch (e) {
        console.error('[collage] error:', e.message, e.stack);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[collage-server] running on port ${PORT}`);
});
