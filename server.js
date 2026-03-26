/**
 * 图片拼接合图服务
 * 使用 jimp@0.22.x (稳定版，API不变)
 */

const http  = require('http');
const https = require('https');
const Jimp  = require('jimp');

const PORT = process.env.PORT || 3000;

function calcCols(n, layout) {
  if (layout === '2col') return n <= 1 ? 1 : 2;
  if (layout === '3col') return n <= 1 ? 1 : n <= 2 ? 2 : 3;
  if (layout === 'row')  return n;
  if (n === 1) return 1;
  if (n <= 2)  return 2;
  if (n <= 4)  return 2;
  if (n <= 6)  return 3;
  if (n <= 9)  return 3;
  return 4;
}

async function collageImages({ images, layout, width, height, gap, bgColor }) {
  const n    = images.length;
  const cols = calcCols(n, layout);
  const rows = Math.ceil(n / cols);

  const cellW = Math.floor((width  - gap * (cols + 1)) / cols);
  const cellH = Math.floor((height - gap * (rows + 1)) / rows);

  // 解析背景色
  const hex = (bgColor || '#ffffff').replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const bgInt = Jimp.rgbaToInt(r, g, b, 255);

  // 创建画布
  const canvas = new Jimp(width, height, bgInt);

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

  // 绘制每张图，保持原始比例居中
  for (let i = 0; i < imgObjects.length; i++) {
    const img = imgObjects[i];
    if (!img) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = gap + col * (cellW + gap);
    const cy  = gap + row * (cellH + gap);

    const ir = img.bitmap.width  / img.bitmap.height;
    const tr = cellW / cellH;

    let dw, dh;
    if (ir > tr) { dw = cellW; dh = Math.round(cellW / ir); }
    else          { dh = cellH; dw = Math.round(cellH * ir); }

    const dx = cx + Math.round((cellW - dw) / 2);
    const dy = cy + Math.round((cellH - dh) / 2);

    const resized = img.clone().resize(dw, dh);
    canvas.composite(resized, dx, dy);
  }

  return await canvas.getBufferAsync(Jimp.MIME_PNG);
}

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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
        const { images, layout = 'smart', width = 1080, height = 1080,
                gap = 8, bgColor = '#ffffff' } = JSON.parse(body);

        if (!images?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'images is required' }));
          return;
        }

        console.log(`[collage] ${images.length} images, ${width}x${height}, layout=${layout}`);
        const pngBuf = await collageImages({ images, layout, width, height, gap, bgColor });
        console.log(`[collage] done, ${pngBuf.length} bytes, uploading...`);

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
