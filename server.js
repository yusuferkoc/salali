const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'reservations.json');
const CLOUD_BLOB_URL = 'https://jsonblob.com/api/jsonBlob/019f8bf4-805a-7e13-8e31-edaca3c1e5c6';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache
let inMemoryData = null;

// Ensure data folder exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Local file reader
function readLocalData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Local read error:', e.message);
  }
  return {};
}

// Local file writer
function writeLocalData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Local write error:', e.message);
  }
}

// Sync with cloud JSONBlob (only on boot)
async function syncFromCloud() {
  try {
    const res = await fetch(CLOUD_BLOB_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const cloudData = await res.json();
      if (cloudData && typeof cloudData === 'object' && !Array.isArray(cloudData)) {
        inMemoryData = cloudData;
        writeLocalData(cloudData);
        console.log('☁️ Synced successfully from cloud storage.');
        return;
      }
    }
  } catch (e) {
    console.warn('Cloud fetch warning:', e.message);
  }
  if (!inMemoryData) {
    inMemoryData = readLocalData();
  }
}

// Cloud'a yazma — 3 deneme, 2 sn aralıkla retry
async function syncToCloud(data, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(CLOUD_BLOB_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        console.log('☁️ Cloud sync başarılı.');
        return;
      }
      console.error(`☁️ Cloud sync HTTP hatası: ${res.status} (deneme ${attempt}/${retries})`);
    } catch (e) {
      console.error(`☁️ Cloud sync hatası: ${e.message} (deneme ${attempt}/${retries})`);
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.error('☁️ Cloud sync tüm denemeler başarısız oldu! Lokal veri güncel, cloud geride.');
}

// Geçmiş rezervasyonları temizle
function cleanupPastReservations() {
  if (!inMemoryData) return false;
  const today = new Date().toISOString().split('T')[0];
  let changed = false;
  for (const date of Object.keys(inMemoryData)) {
    if (date < today) {
      delete inMemoryData[date];
      changed = true;
    }
  }
  if (changed) {
    writeLocalData(inMemoryData);
    console.log('🧹 Geçmiş rezervasyonlar temizlendi.');
  }
  return changed;
}

// GET all reservations
app.get('/api/reservations', (req, res) => {
  if (!inMemoryData) {
    inMemoryData = readLocalData();
  }
  res.json(inMemoryData || {});
});

// GET list of unique names (for easy tap-to-login)
app.get('/api/members', (req, res) => {
  const data = inMemoryData || readLocalData();
  const names = new Set();
  Object.values(data).forEach(r => {
    if (r && r.name) names.add(r.name.trim());
  });
  res.json(Array.from(names));
});

// POST reservation
app.post('/api/reservations', async (req, res) => {
  const { date, name, note } = req.body;

  if (!date || !name || !name.trim()) {
    return res.status(400).json({ error: 'Tarih ve isim gerekli.' });
  }

  const cleanName = name.trim();
  if (!inMemoryData) inMemoryData = readLocalData();

  // Check if reserved by someone else
  const existing = inMemoryData[date];
  if (existing && existing.name.toLowerCase() !== cleanName.toLowerCase()) {
    return res.status(409).json({
      error: `Bu tarih zaten ${existing.name} tarafından rezerve edilmiş.`
    });
  }

  inMemoryData[date] = {
    name: cleanName,
    note: (note || '').trim(),
    createdAt: new Date().toISOString()
  };

  writeLocalData(inMemoryData);
  await syncToCloud(inMemoryData);

  res.json({ success: true, reservation: inMemoryData[date] });
});

// DELETE reservation
app.delete('/api/reservations/:date', async (req, res) => {
  const { date } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'İsim gerekli.' });
  }

  if (!inMemoryData) inMemoryData = readLocalData();

  const existing = inMemoryData[date];
  if (!existing) {
    return res.status(404).json({ error: 'Bu tarihte rezervasyon bulunamadı.' });
  }

  if (existing.name.toLowerCase() !== name.trim().toLowerCase()) {
    return res.status(403).json({ error: 'Sadece kendi rezervasyonunuzu iptal edebilirsiniz.' });
  }

  delete inMemoryData[date];
  writeLocalData(inMemoryData);
  await syncToCloud(inMemoryData);

  res.json({ success: true });
});

// Health check / Keep-alive endpoint
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Boot: önce cloud'dan veriyi çek, sonra sunucuyu başlat
async function startServer() {
  await syncFromCloud();
  cleanupPastReservations();

  // Her gün gece yarısı geçmiş rezervasyonları temizle
  setInterval(() => {
    const cleaned = cleanupPastReservations();
    if (cleaned) syncToCloud(inMemoryData).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🏔️ Salalı Dağ Evi sunucusu çalışıyor: http://localhost:${PORT}`);

    // Render Keep-Alive: 14 dakikada bir self-ping (Render 15dk sonra uyuyor)
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
      setInterval(async () => {
        try {
          await fetch(`${RENDER_URL}/api/ping`, { signal: AbortSignal.timeout(5000) });
          console.log('🏓 Keep-alive ping başarılı.');
        } catch (e) {
          console.warn('🏓 Keep-alive ping hatası:', e.message);
        }
      }, 14 * 60 * 1000); // 14 dakika
      console.log('🏓 Keep-alive aktif: her 14 dakikada bir ping atılacak.');
    }
  });
}

startServer();
