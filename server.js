/**
 * 图片拼接合图服务（纯 JS，无需编译）
 * 依赖：jimp（纯 JavaScript，无 C++ 编译）
 * 部署平台：Railway
 */

const http  = require('http');
const https = require('https');
const Jimp  = require('jimp');

const PORT = process.env.PORT || 3000;

// ── 计算列数 ──────────────────────────────────────────
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

// ── 解析 HEX 颜色为 jimp 整数（RGBA）────────────────────
function hexToInt(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return Jimp.rgbaToInt(r, g, b, 255);
}

// ── 合成图片核心逻辑 ──────────────────────────────────
async function collageImages({ images, layout, width, height, gap, bgColor }) {
  const n    = images.length;
  const cols = calcCols(n, layout);
  const rows = Math.ceil(n / cols);

  const cellW = Math.floor((width  - gap * (cols + 1)) / cols);
  const cellH = Math.floor((height - gap * (rows + 1)) / rows);

  // 创建画布
  const canvas = new Jimp({ width, height, color: hexToInt(bgColor || '#ffffff') });

  // 并行加载所有图片
  const imgObjects = await Promise.all(
    images.map(async (img, idx) => {
      try {
        const buf = Buffer.from(img.base64, 'base64');
        return await Jimp.read(buf);
      } catch (e) {
        console.error(`[collage] load image[${idx}] failed:`, e.message);
        return null;
      }
    })
  );

  // 绘制每张图，保持原始比例居中放入格子
  for (let i = 0; i < imgObjects.length; i++) {
    const img = imgObjects[i];
    if (!img) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = gap + col * (cellW + gap);  // 格子左上角 x
    const cy  = gap + row * (cellH + gap);  // 格子左上角 y

    const ir = img.bitmap.width  / img.bitmap.height;
    const tr = cellW / cellH;

    let dw, dh;
    if (ir > tr) { dw = cellW; dh = Math.round(cellW / ir); }
    else          { dh = cellH; dw = Math.round(cellH * ir); }

    // 居中偏移
    const dx = cx + Math.round((cellW - dw) / 2);
    const dy = cy + Math.round((cellH - dh) / 2);

    // jimp resize + composite
    const resized = img.clone().resize({ w: dw, h: dh });
    canvas.composite(resized, dx, dy);
  }

  // 输出 PNG buffer
  return await canvas.getBuffer('image/png');
}

// ── 上传到 Telegraph 图床，返回公网 URL ──────────────────
function uploadToTelegraph(pngBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const filename  = `collage_${Date.now()}.png`;

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
        const { images, layout = 'smart', width = 1080, height = 1080,
                gap = 8, bgColor = '#ffffff' } = params;

        if (!images?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'images is required' }));
          return;
        }

        console.log(`[collage] ${images.length} images, ${width}x${height}, layout=${layout}`);
        const pngBuf = await collageImages({ images, layout, width, height, gap, bgColor });
        console.log(`[collage] canvas done, ${pngBuf.length} bytes, uploading...`);

        const url = await uploadToTelegraph(pngBuf);
        console.log(`[collage] uploaded: ${url}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url }));

      } catch (e) {
        console.error('[collage] error:', e.message);
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
