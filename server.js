const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'reservations.json');
const CLOUD_BLOB_URL = 'https://jsonblob.com/api/jsonBlob/019f9f89-9d8e-76a0-9ce3-6b26ed54a3dc';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache & sync status flag
let inMemoryData = null;
let isCloudDirty = false;

// Supabase REST client configuration
let SUPABASE_URL = process.env.SUPABASE_URL;
if (SUPABASE_URL) {
  SUPABASE_URL = SUPABASE_URL.trim().replace(/\/$/, '').replace(/\/rest\/v1$/, '');
}
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const isSupabaseEnabled = !!(SUPABASE_URL && SUPABASE_KEY);

if (isSupabaseEnabled) {
  console.log(`✅ Supabase database support is ENABLED. (URL: ${SUPABASE_URL})`);
} else {
  console.warn('⚠️ Supabase environment variables missing. Falling back to local file + JSONBlob mode.');
}

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

// --- Supabase REST API Helpers ---
async function fetchFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/reservations?select=*`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase GET error: ${res.status}`);
  const rows = await res.json();
  
  const data = {};
  rows.forEach(row => {
    const { date, slot, name, note, device_id, is_gps, created_at } = row;
    const formattedItem = {
      name,
      note: note || '',
      slot,
      deviceId: device_id,
      isGps: !!is_gps,
      createdAt: created_at
    };

    if (slot === 'full') {
      data[date] = formattedItem;
    } else {
      if (!data[date]) data[date] = {};
      data[date][slot] = formattedItem;
    }
  });
  return data;
}

async function saveToSupabase(date, name, note, slot, deviceId, isGps) {
  const url = `${SUPABASE_URL}/rest/v1/reservations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      date,
      slot,
      name,
      note: note || '',
      device_id: deviceId || null,
      is_gps: !!isGps
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase POST error: ${res.status} - ${errText}`);
  }
}

async function deleteFromSupabase(date, slot) {
  let url = `${SUPABASE_URL}/rest/v1/reservations?date=eq.${date}`;
  if (slot) {
    url += `&slot=eq.${slot}`;
  }
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase DELETE error: ${res.status}`);
}

// Akıllı Veri Birleştirme (Smart Merge - Boot Açılışı)
async function smartMergeData() {
  if (isSupabaseEnabled) {
    try {
      inMemoryData = await fetchFromSupabase();
      console.log(`☁️ Supabase veritabanından ${Object.keys(inMemoryData).length} kayıt başarıyla yüklendi.`);
      return;
    } catch (e) {
      console.error('❌ Supabase boot yükleme hatası, yerel dosyaya dönülüyor:', e.message);
    }
  }

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
  console.log(`☁️ Smart merge tamamlandı. Toplam ${Object.keys(inMemoryData).length} yerel rezervasyon korundu.`);
}

// Cloud'a yazma — 3 deneme, 2 sn aralıkla retry + arka plan kuyruğu (Fallback modu için)
async function syncToCloud(data, retries = 3) {
  if (isSupabaseEnabled) return true; // Supabase aktifken JSONBlob'a senkronize etme
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

// Arka plan senkronizasyon takipçisi: Cloud güncellenemediğinde her 30sn'de bir dener (Fallback modu için)
setInterval(() => {
  if (!isSupabaseEnabled && isCloudDirty && inMemoryData) {
    console.log('🔄 Arka plan retry: Cloud sync tekrar deneniyor...');
    syncToCloud(inMemoryData).catch(() => {});
  }
}, 30000);

// Geçmiş rezervasyonları temizle (Türkiye Saat Dilimi ile)
async function cleanupPastReservations() {
  const today = getTurkeyDateStr();
  if (isSupabaseEnabled) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/reservations?date=lt.${today}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      if (res.ok) {
        console.log(`🧹 Supabase geçmiş rezervasyonlar temizlendi (TR Bugün: ${today}).`);
        inMemoryData = await fetchFromSupabase();
      }
    } catch (e) {
      console.error('Supabase cleanupPastReservations error:', e.message);
    }
    return;
  }

  if (!inMemoryData) return false;
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

// stats route to serve stats.html
app.get('/stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

// GET all reservations
app.get('/api/reservations', async (req, res) => {
  if (isSupabaseEnabled) {
    try {
      inMemoryData = await fetchFromSupabase();
      return res.json(inMemoryData);
    } catch (e) {
      console.error('Supabase GET /api/reservations error, using cache:', e.message);
    }
  }
  if (!inMemoryData) {
    inMemoryData = readLocalData();
  }
  res.json(inMemoryData || {});
});

// GET list of unique names (for easy tap-to-login)
app.get('/api/members', async (req, res) => {
  if (isSupabaseEnabled) {
    try {
      inMemoryData = await fetchFromSupabase();
    } catch (e) {
      console.error('Supabase GET /api/members fetch cache update failed:', e.message);
    }
  }
  const data = inMemoryData || readLocalData();
  const names = new Set();
  Object.values(data).forEach(r => {
    if (!r) return;
    if (r.name) names.add(r.name.trim());
    if (r.day && r.day.name) names.add(r.day.name.trim());
    if (r.night && r.night.name) names.add(r.night.name.trim());
  });
  res.json(Array.from(names));
});

// Helper: tekil rezervasyon nesnesinin slotunu döndürür ('full', 'day', 'night')
function getReservationSlot(item) {
  if (!item) return null;
  return item.slot || 'full';
}

// POST reservation
app.post('/api/reservations', async (req, res) => {
  const { date, name, note, slot, deviceId } = req.body;
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

  if (!date || !DATE_REGEX.test(date) || !name || !name.trim()) {
    return res.status(400).json({ error: 'Geçerli bir tarih (YYYY-AA-GG) ve isim gerekli.' });
  }

  const cleanName = name.trim();
  const targetSlot = (slot === 'day' || slot === 'night') ? slot : 'full';

  if (isSupabaseEnabled) {
    try {
      inMemoryData = await fetchFromSupabase();
    } catch (e) {
      console.warn('Supabase fetch failed before POST conflict check, using cache:', e.message);
    }
  } else {
    if (!inMemoryData) inMemoryData = readLocalData();
  }

  const existing = inMemoryData[date];

  const newRes = {
    name: cleanName,
    note: (note || '').trim(),
    slot: targetSlot,
    deviceId: deviceId || null,
    isGps: !!req.body.isGps,
    createdAt: new Date().toISOString()
  };

  if (existing) {
    if (existing.day || existing.night) {
      if (targetSlot === 'full') {
        return res.status(409).json({ error: 'Bu günün saatleri zaten kısmen rezerve edilmiş. Tam gün alınamaz.' });
      }
      const currentSlotRes = existing[targetSlot];
      if (currentSlotRes && currentSlotRes.name.toLowerCase() !== cleanName.toLowerCase()) {
        if (!deviceId || currentSlotRes.deviceId !== deviceId) {
          const slotLabel = targetSlot === 'day' ? 'Gündüz (Piknik)' : 'Akşam & Gece';
          return res.status(409).json({ error: `Bu tarihte ${slotLabel} zaten ${currentSlotRes.name} tarafından rezerve edilmiş.` });
        }
      }
      existing[targetSlot] = newRes;
    } else {
      const existingSlot = getReservationSlot(existing);
      const isSameUser = existing.name.toLowerCase() === cleanName.toLowerCase() || (deviceId && existing.deviceId === deviceId);

      if (isSameUser) {
        if (targetSlot === 'full') {
          inMemoryData[date] = newRes;
        } else if (existingSlot === targetSlot || existingSlot === 'full') {
          inMemoryData[date] = newRes;
        } else {
          inMemoryData[date] = {
            [existingSlot]: existing,
            [targetSlot]: newRes
          };
        }
      } else {
        if (existingSlot === 'full' || targetSlot === 'full' || existingSlot === targetSlot) {
          const slotLabel = existingSlot === 'full' ? 'Tam Gün' : (existingSlot === 'day' ? 'Gündüz' : 'Akşam');
          return res.status(409).json({ error: `Bu tarih (${slotLabel}) zaten ${existing.name} tarafından rezerve edilmiş.` });
        } else {
          inMemoryData[date] = {
            [existingSlot]: existing,
            [targetSlot]: newRes
          };
        }
      }
    }
  } else {
    if (targetSlot === 'full') {
      inMemoryData[date] = newRes;
    } else {
      inMemoryData[date] = {
        [targetSlot]: newRes
      };
    }
  }

  if (isSupabaseEnabled) {
    try {
      await saveToSupabase(date, cleanName, note, targetSlot, deviceId, req.body.isGps);
      inMemoryData = await fetchFromSupabase();
    } catch (e) {
      console.error('Supabase POST error:', e.message);
      return res.status(500).json({ error: 'Veritabanı kayıt hatası oluştu.' });
    }
  } else {
    writeLocalData(inMemoryData);
    syncToCloud(inMemoryData).catch(() => {});
  }

  res.json({ success: true, reservation: inMemoryData[date] });
});

// DELETE reservation
app.delete('/api/reservations/:date', async (req, res) => {
  const { date } = req.params;
  const { name, slot, deviceId } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'İsim gerekli.' });
  }

  if (isSupabaseEnabled) {
    try {
      inMemoryData = await fetchFromSupabase();
    } catch (e) {
      console.warn('Supabase fetch failed before DELETE check, using cache:', e.message);
    }
  } else {
    if (!inMemoryData) inMemoryData = readLocalData();
  }

  const existing = inMemoryData[date];
  if (!existing) {
    return res.status(404).json({ error: 'Bu tarihte rezervasyon bulunamadı.' });
  }

  const targetSlot = (slot === 'day' || slot === 'night') ? slot : null;

  // 1. Çift slotlu kayıt silme yetki kontrolü
  if (existing.day || existing.night) {
    if (targetSlot && existing[targetSlot]) {
      const item = existing[targetSlot];
      const deviceMatch = deviceId && item.deviceId && item.deviceId === deviceId;
      const nameMatch = item.name.toLowerCase() === name.trim().toLowerCase();
      if (!deviceMatch && !nameMatch) {
        return res.status(403).json({ error: 'Sadece kendi rezervasyonunuzu iptal edebilirsiniz.' });
      }
      delete existing[targetSlot];
      const remaining = existing.day ? 'day' : (existing.night ? 'night' : null);
      if (!remaining) {
        delete inMemoryData[date];
      }
    } else {
      let deletedCount = 0;
      ['day', 'night'].forEach(s => {
        if (existing[s]) {
          const item = existing[s];
          const deviceMatch = deviceId && item.deviceId && item.deviceId === deviceId;
          const nameMatch = item.name.toLowerCase() === name.trim().toLowerCase();
          if (deviceMatch || nameMatch) {
            delete existing[s];
            deletedCount++;
          }
        }
      });
      if (!existing.day && !existing.night) {
        delete inMemoryData[date];
      }
      if (deletedCount === 0) {
        return res.status(403).json({ error: 'Sadece kendi rezervasyonunuzu iptal edebilirsiniz.' });
      }
    }
  } else {
    // 2. Tekil kayıt silme yetki kontrolü
    const deviceMatch = deviceId && existing.deviceId && existing.deviceId === deviceId;
    const nameMatch = existing.name.toLowerCase() === name.trim().toLowerCase();
    if (!deviceMatch && !nameMatch) {
      return res.status(403).json({ error: 'Sadece kendi rezervasyonunuzu iptal edebilirsiniz.' });
    }
    delete inMemoryData[date];
  }

  if (isSupabaseEnabled) {
    try {
      await deleteFromSupabase(date, targetSlot);
      inMemoryData = await fetchFromSupabase();
    } catch (e) {
      console.error('Supabase DELETE error:', e.message);
      return res.status(500).json({ error: 'Veritabanı silme hatası oluştu.' });
    }
  } else {
    writeLocalData(inMemoryData);
    syncToCloud(inMemoryData).catch(() => {});
  }

  res.json({ success: true });
});

// ========== Notlar (Notes) API ==========
const NOTES_FILE = path.join(dataDir, 'notes.json');
let inMemoryNotes = [];

function readLocalNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Yerel notlar okunamadı:', e.message);
  }
  return [];
}

function writeLocalNotes(data) {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Yerel notlar yazılamadı:', e.message);
  }
}

async function fetchNotesFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/notes?order=id.asc`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase GET notes error: ${res.status}`);
  return await res.json();
}

// GET all notes
app.get('/api/notes', async (req, res) => {
  if (isSupabaseEnabled) {
    try {
      inMemoryNotes = await fetchNotesFromSupabase();
      return res.json(inMemoryNotes);
    } catch (e) {
      console.error('Supabase not yükleme hatası, yerel önbellek kullanılıyor:', e.message);
    }
  }
  inMemoryNotes = readLocalNotes();
  res.json(inMemoryNotes);
});

// POST new note
app.post('/api/notes', async (req, res) => {
  const { id, text, completed } = req.body;
  if (!id || !text) {
    return res.status(400).json({ error: 'id ve text alanları gerekli.' });
  }

  const newNote = { id, text, completed: !!completed };

  if (isSupabaseEnabled) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/notes`;
      const sRes = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(newNote)
      });
      if (!sRes.ok) throw new Error(await sRes.text());
      inMemoryNotes = await fetchNotesFromSupabase();
    } catch (e) {
      console.error('Supabase POST notes error:', e.message);
      return res.status(500).json({ error: 'Veritabanı not ekleme hatası oluştu.' });
    }
  } else {
    inMemoryNotes = readLocalNotes();
    inMemoryNotes.push(newNote);
    writeLocalNotes(inMemoryNotes);
  }

  res.json({ success: true, notes: inMemoryNotes });
});

// PATCH update note completion state
app.patch('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { completed } = req.body;

  if (isSupabaseEnabled) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/notes?id=eq.${id}`;
      const sRes = await fetch(url, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ completed: !!completed })
      });
      if (!sRes.ok) throw new Error(await sRes.text());
      inMemoryNotes = await fetchNotesFromSupabase();
    } catch (e) {
      console.error('Supabase PATCH notes error:', e.message);
      return res.status(500).json({ error: 'Veritabanı not güncelleme hatası oluştu.' });
    }
  } else {
    inMemoryNotes = readLocalNotes();
    const note = inMemoryNotes.find(n => String(n.id) === String(id));
    if (note) {
      note.completed = !!completed;
      writeLocalNotes(inMemoryNotes);
    }
  }

  res.json({ success: true, notes: inMemoryNotes });
});

// DELETE a note
app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;

  if (isSupabaseEnabled) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/notes?id=eq.${id}`;
      const sRes = await fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      if (!sRes.ok) throw new Error(await sRes.text());
      inMemoryNotes = await fetchNotesFromSupabase();
    } catch (e) {
      console.error('Supabase DELETE notes error:', e.message);
      return res.status(500).json({ error: 'Veritabanı not silme hatası oluştu.' });
    }
  } else {
    inMemoryNotes = readLocalNotes();
    inMemoryNotes = inMemoryNotes.filter(n => String(n.id) !== String(id));
    writeLocalNotes(inMemoryNotes);
  }

  res.json({ success: true, notes: inMemoryNotes });
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
    cleanupPastReservations();
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
