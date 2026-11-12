const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const DATA_FILE = path.join(__dirname, 'videos.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, { etag: false, setHeaders: (res, path) => {
  // html не кешируем — всегда свежая версия; картинки/иконки пусть кешируются
  if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
} }));
// некоторые браузеры всё равно просят /favicon.ico — отдаём тот же логотип
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]');
}

app.get('/api/videos', (req, res) => {
  const data = fs.readFileSync(DATA_FILE, 'utf8');
  res.json(JSON.parse(data || '[]'));
});

app.post('/api/videos', (req, res) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

const dns = require('dns');
const THUMBS_DIR = path.join(__dirname, 'thumbs');
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR);

// Системный DNS не резолвит www.youtube.com — берём IP у DNS Google
let ytIPPromise = null;
function resolveYTIP() {
  if (!ytIPPromise) {
    ytIPPromise = new Promise((resolve) => {
      const r = new dns.Resolver();
      r.setServers(['8.8.8.8']);
      r.resolve4('www.youtube.com', (err, addrs) => {
        if (err || !addrs.length) {
          console.warn('Не удалось разрешить www.youtube.com через 8.8.8.8:', err ? err.code : 'нет адресов');
          ytIPPromise = null;
          return resolve(null);
        }
        resolve(addrs[0]);
      });
    });
  }
  return ytIPPromise;
}

// такой же обход DNS для i.ytimg.com (превью)
let ytimgIPPromise = null;
function resolveYtimgIP() {
  if (!ytimgIPPromise) {
    ytimgIPPromise = new Promise((resolve) => {
      const r = new dns.Resolver();
      r.setServers(['8.8.8.8']);
      r.resolve4('i.ytimg.com', (err, addrs) => {
        if (err || !addrs.length) {
          console.warn('Не удалось разрешить i.ytimg.com через 8.8.8.8:', err ? err.code : 'нет адресов');
          ytimgIPPromise = null;
          return resolve(null);
        }
        resolve(addrs[0]);
      });
    });
  }
  return ytimgIPPromise;
}

// Скачивает превью видео в thumbs/<id>.jpg, если его ещё нет.
// Возвращает относительный URL локального файла или null при неудаче.
function downloadThumb(videoId) {
  const file = path.join(THUMBS_DIR, videoId + '.jpg');
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    return Promise.resolve(`/thumbs/${videoId}.jpg`);
  }
  return resolveYtimgIP().then(ip => new Promise((resolve) => {
    if (!ip) return resolve(null);
    const req = https.get({
      hostname: 'i.ytimg.com',
      path: `/vi/${videoId}/hqdefault.jpg`,
      family: 4,
      lookup: (name, opts, cb) => cb(null, ip, 4),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 1000) return resolve(null); // серая заглушка YouTube
        fs.writeFileSync(file, buf);
        resolve(`/thumbs/${videoId}.jpg`);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  }));
}

// Раздаём сохранённые превью как статику с вечным кешем
app.use('/thumbs', express.static(THUMBS_DIR, { maxAge: '30d' }));

// Функция для получения просмотров и длительности одного видео
function fetchYTInfo(id) {
  return resolveYTIP().then(ip => new Promise((resolve) => {
    const finish = (views, durationSec) => resolve({ views, durationSec });

    if (!ip) return finish(0, 0);

    const options = {
      hostname: 'www.youtube.com',
      path: `/watch?v=${id}`,
      family: 4,
      lookup: (name, opts, cb) => cb(null, ip, 4),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // в новой разметке YouTube данных в "сыром" виде нет — парсим ytInitialPlayerResponse
        // (вырезаем JSON подсчётом скобок: регэкспом обрезать нельзя из-за вложенных строк с ";")
        const i = data.indexOf('ytInitialPlayerResponse');
        if (i >= 0) {
          const start = data.indexOf('{', i);
          let depth = 0, end = -1;
          for (let j = start; j < data.length; j++) {
            if (data[j] === '{') depth++;
            else if (data[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
          }
          if (end > 0) {
            try {
              const vd = JSON.parse(data.slice(start, end)).videoDetails || {};
              return finish(parseInt(vd.viewCount) || 0, parseInt(vd.lengthSeconds) || 0);
            } catch (e) { /* fallthrough */ }
          }
        }
        const viewMatch = data.match(/"viewCount":"(\d+)"/);
        const durationMatch = data.match(/"lengthSeconds":"(\d+)"/);
        finish(viewMatch ? parseInt(viewMatch[1]) : 0, durationMatch ? parseInt(durationMatch[1]) : 0);
      });
    }).on('error', () => {
      finish(0, 0);
    });
  }));
}

// Запрос инфо по одному видео
app.get('/api/ytinfo', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'No video ID' });
  const info = await fetchYTInfo(id);
  res.json(info);
});

// Скачать превью для одного видео (используется при добавлении)
app.get('/api/thumb', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'No video ID' });
  const url = await downloadThumb(id);
  res.json({ url });
});

// Скачать все недостающие превью разом
app.post('/api/thumbs-all', async (req, res) => {
  try {
    const videos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]');
    let downloaded = 0, failed = 0;
    for (const v of videos) {
      const url = await downloadThumb(v.id);
      if (url) downloaded++; else failed++;
      // пауза, чтобы не долбить ytimg подряд
      await new Promise(r => setTimeout(r, 100));
    }
    res.json({ success: true, downloaded, failed, total: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Пакетное обновление всей базы видео
app.post('/api/sync-all', async (req, res) => {
  try {
    const fileData = fs.readFileSync(DATA_FILE, 'utf8');
    let videos = JSON.parse(fileData || '[]');

    for (let video of videos) {
      const info = await fetchYTInfo(video.id);
      if (info.views) video.views = info.views;
      if (info.durationSec) video.durationSec = info.durationSec;
      // Небольшая пауза между запросами, чтобы YouTube не заблокировал
      await new Promise(r => setTimeout(r, 150));
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(videos, null, 2));
    res.json({ success: true, videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('Vault запущен! Открой в браузере: http://localhost:3000');
});