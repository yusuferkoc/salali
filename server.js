const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'reservations.json');
const CLOUD_BLOB_URL = 'https://jsonblob.com/api/jsonBlob/019f8bf4-805a-7e13-8e31-edaca3c1e5c6';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache & sync status flag
let inMemoryData = null;
let isCloudDirty = false;

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

// Türkiye saat dilimine göre bugün tarihini YYYY-MM-DD olarak döndürür
function getTurkeyDateStr() {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// Akıllı Veri Birleştirme (Smart Merge - Boot Açılışı)
async function smartMergeData() {
  const local = readLocalData() || {};
  let cloud = {};

  try {
    const res = await fetch(CLOUD_BLOB_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        cloud = data;
      }
    }
  } catch (e) {
    console.warn('Cloud fetch warning during boot:', e.message);
  }

  // Hem yerel hem cloud verilerini eksiksiz birleştir (Union Merge)
  const merged = { ...cloud, ...local };
  for (const [date, cloudRes] of Object.entries(cloud)) {
    const localRes = local[date];
    if (localRes && cloudRes) {
      const cloudTime = new Date(cloudRes.createdAt || 0).getTime();
      const localTime = new Date(localRes.createdAt || 0).getTime();
      merged[date] = localTime >= cloudTime ? localRes : cloudRes;
    }
  }

  inMemoryData = merged;
  writeLocalData(inMemoryData);
  syncToCloud(inMemoryData).catch(() => {});
  console.log(`☁️ Smart merge tamamlandı. Toplam ${Object.keys(inMemoryData).length} rezervasyon korundu.`);
}

// Cloud'a yazma — 3 deneme, 2 sn aralıkla retry + arka plan kuyruğu
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
        isCloudDirty = false;
        console.log('☁️ Cloud sync başarılı.');
        return true;
      }
      console.error(`☁️ Cloud sync HTTP hatası: ${res.status} (deneme ${attempt}/${retries})`);
    } catch (e) {
      console.error(`☁️ Cloud sync hatası: ${e.message} (deneme ${attempt}/${retries})`);
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  isCloudDirty = true;
  console.warn('⚠️ Cloud sync başarısız oldu. Arka plan retry kuyruğuna alındı.');
  return false;
}

// Arka plan senkronizasyon takipçisi: Cloud güncellenemediğinde her 30sn'de bir dener
setInterval(() => {
  if (isCloudDirty && inMemoryData) {
    console.log('🔄 Arka plan retry: Cloud sync tekrar deneniyor...');
    syncToCloud(inMemoryData).catch(() => {});
  }
}, 30000);

// Geçmiş rezervasyonları temizle (Türkiye Saat Dilimi ile)
function cleanupPastReservations() {
  if (!inMemoryData) return false;
  const today = getTurkeyDateStr();
  let changed = false;
  for (const date of Object.keys(inMemoryData)) {
    if (date < today) {
      delete inMemoryData[date];
      changed = true;
    }
  }
  if (changed) {
    writeLocalData(inMemoryData);
    syncToCloud(inMemoryData).catch(() => {});
    console.log(`🧹 Geçmiş rezervasyonlar temizlendi (TR Bugün: ${today}).`);
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
  const { date, name, note, deviceId } = req.body;
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

  if (!date || !DATE_REGEX.test(date) || !name || !name.trim()) {
    return res.status(400).json({ error: 'Geçerli bir tarih (YYYY-AA-GG) ve isim gerekli.' });
  }

  const cleanName = name.trim();
  if (!inMemoryData) inMemoryData = readLocalData();

  // Check if reserved by someone else
  const existing = inMemoryData[date];
  if (existing && existing.name.toLowerCase() !== cleanName.toLowerCase()) {
    // Aynı cihazdan geliyorsa güncellemeye izin ver
    if (!deviceId || existing.deviceId !== deviceId) {
      return res.status(409).json({
        error: `Bu tarih zaten ${existing.name} tarafından rezerve edilmiş.`
      });
    }
  }

  inMemoryData[date] = {
    name: cleanName,
    note: (note || '').trim(),
    deviceId: deviceId || null,
    createdAt: new Date().toISOString()
  };

  writeLocalData(inMemoryData);
  syncToCloud(inMemoryData).catch(() => {});

  res.json({ success: true, reservation: inMemoryData[date] });
});

// DELETE reservation
app.delete('/api/reservations/:date', async (req, res) => {
  const { date } = req.params;
  const { name, deviceId } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'İsim gerekli.' });
  }

  if (!inMemoryData) inMemoryData = readLocalData();

  const existing = inMemoryData[date];
  if (!existing) {
    return res.status(404).json({ error: 'Bu tarihte rezervasyon bulunamadı.' });
  }

  // Yetki kontrolü: deviceId eşleşirse VEYA legacy veri (deviceId yok) ise isim kontrolü
  const deviceMatch = deviceId && existing.deviceId && existing.deviceId === deviceId;
  const nameMatch = existing.name.toLowerCase() === name.trim().toLowerCase();

  if (!deviceMatch && !nameMatch) {
    return res.status(403).json({ error: 'Sadece kendi rezervasyonunuzu iptal edebilirsiniz.' });
  }

  delete inMemoryData[date];
  writeLocalData(inMemoryData);
  syncToCloud(inMemoryData).catch(() => {});

  res.json({ success: true });
});

// Health check / Keep-alive endpoint
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Boot: önce smart merge yap, sonra sunucuyu başlat
async function startServer() {
  await smartMergeData();
  cleanupPastReservations();

  // Her gün gece yarısı geçmiş rezervasyonları temizle
  setInterval(() => {
    const cleaned = cleanupPastReservations();
    if (cleaned) syncToCloud(inMemoryData).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🏔️ Salalı Dağ Evi sunucusu çalışıyor: http://localhost:${PORT}`);

    // Render Keep-Alive (Eğer RENDER_EXTERNAL_URL varsa)
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
      setInterval(async () => {
        try {
          await fetch(`${RENDER_URL}/api/ping`, { signal: AbortSignal.timeout(5000) });
          console.log('🏓 Keep-alive ping başarılı.');
        } catch (e) {
          console.warn('🏓 Keep-alive ping hatası:', e.message);
        }
      }, 14 * 60 * 1000);
      console.log('🏓 Keep-alive aktif: her 14 dakikada bir ping atılacak.');
    }
  });
}

startServer();
