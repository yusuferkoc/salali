// ========== State & Storage ==========
let currentUser = getStorage('salali_user') || '';
let reservations = {};
let prevReservations = {}; // Bildirim karşılaştırması için
let weatherCache = {}; // dateStr -> { icon, text, maxTemp, minTemp }
let viewDate; // haftanın başlangıç tarihi (Pazartesi)
let notificationsReady = false; // İlk yükleme tamamlanana kadar bildirim gönderme

const AY = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const GUN = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];

// ========== KONUM AYARI ==========
const EV_LAT = 37.867974;  // Enlem (Erkoçlar Salarlı Bağ Evi)
const EV_LNG = 32.305585;  // Boylam
const EV_RADIUS = 800;     // Metre (GPS sapmalarını tolere etmek için 800m)

function getStorage(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function setStorage(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}

// ========== Cihaz ID ==========
function getDeviceId() {
  let id = getStorage('salali_device_id');
  if (!id) {
    id = crypto.randomUUID();
    setStorage('salali_device_id', id);
  }
  return id;
}

// ========== Bildirim Sistemi ==========
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body: body,
      icon: '🏔️',
      badge: '🏔️',
      tag: 'salali-' + Date.now()
    });
  } catch (e) {
    console.warn('Bildirim gönderilemedi:', e);
  }
}

function getReservationName(r) {
  if (!r) return '';
  if (r.name) return r.name;
  const names = [];
  if (r.day && r.day.name) names.push(`Gündüz: ${r.day.name}`);
  if (r.night && r.night.name) names.push(`Akşam: ${r.night.name}`);
  return names.join(' / ');
}

function isReservationMine(r, user) {
  if (!r || !user) return false;
  const u = user.toLowerCase();
  if (r.name && r.name.toLowerCase() === u) return true;
  if (r.day && r.day.name && r.day.name.toLowerCase() === u) return true;
  if (r.night && r.night.name && r.night.name.toLowerCase() === u) return true;
  return false;
}

function isReservationGuest(r) {
  if (!r) return false;
  if (r.note && r.note.includes('Misafir için')) return true;
  if (r.day && r.day.note && r.day.note.includes('Misafir için')) return true;
  if (r.night && r.night.note && r.night.note.includes('Misafir için')) return true;
  return false;
}

function getReservationNote(r) {
  if (!r) return '';
  if (r.note) return r.note;
  const notes = [];
  if (r.day && r.day.note) notes.push(`Gündüz: ${r.day.note}`);
  if (r.night && r.night.note) notes.push(`Akşam: ${r.night.note}`);
  return notes.join(' | ');
}

function getReservationCreatedAt(r) {
  if (!r) return '';
  if (r.createdAt) return r.createdAt;
  if (r.day && r.day.createdAt) return r.day.createdAt;
  if (r.night && r.night.createdAt) return r.night.createdAt;
  return '';
}

function checkReservationChanges(oldData, newData) {
  if (!notificationsReady) return;
  if (!oldData || Object.keys(oldData).length === 0) return;

  // Yeni eklenen rezervasyonlar
  for (const [date, r] of Object.entries(newData)) {
    if (!oldData[date]) {
      const resName = getReservationName(r);
      if (!isReservationMine(r, currentUser)) {
        const [y, m, d] = date.split('-').map(Number);
        sendNotification('📅 Yeni Rezervasyon', `${resName} — ${d} ${AY[m - 1]} tarihini rezerve etti.`);
      }
    }
  }

  // Silinen rezervasyonlar
  for (const [date, r] of Object.entries(oldData)) {
    if (!newData[date]) {
      const resName = getReservationName(r);
      if (!isReservationMine(r, currentUser)) {
        const [y, m, d] = date.split('-').map(Number);
        sendNotification('🗑️ Rezervasyon İptali', `${resName} — ${d} ${AY[m - 1]} rezervasyonunu iptal etti.`);
      }
    }
  }
}

// Haversine: mesafe hesabı (metre)
function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GPS Konum Şartı Kontrolü (Bugün saat 14:00 öncesi GPS gerekmez)
function isGpsRequiredToday() {
  const hour = new Date().getHours();
  return hour >= 14; // Saat 14:00 ve sonrası GPS gerekli
}

// GPS konum kontrolü
function verifyLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject('Tarayıcınız konum özelliğini desteklemiyor.');
      return;
    }
    showToast('📍 Konumunuz kontrol ediliyor...', 'info');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const dist = gpsDistance(pos.coords.latitude, pos.coords.longitude, EV_LAT, EV_LNG);
        if (dist <= EV_RADIUS) {
          resolve();
        } else {
          const km = (dist / 1000).toFixed(1);
          reject(`Dağ evine konum olarak uzaktasınız (~${km} km). Evde olmanız gerekiyor.`);
        }
      },
      err => {
        if (err.code === 1) reject('Konum izni reddedildi. İzin verip tekrar deneyin.');
        else if (err.code === 3) reject('Konum zaman aşımına uğradı. Lütfen tekrar deneyin.');
        else reject('Konum alınamadı. GPS açık mı kontrol edin.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

// ========== HAVA DURUMU (Open-Meteo 7 Günlük) ==========
function getWeatherInfo(code) {
  if (code === 0) return { icon: '☀️', text: 'Açık' };
  if (code >= 1 && code <= 3) return { icon: '⛅', text: 'Parçalı Bulutlu' };
  if (code === 45 || code === 48) return { icon: '🌫️', text: 'Sisli' };
  if (code >= 51 && code <= 57) return { icon: '🌧️', text: 'Çiseleme' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', text: 'Yağmurlu' };
  if (code >= 71 && code <= 77) return { icon: '❄️', text: 'Karlı' };
  if (code >= 80 && code <= 82) return { icon: '🌦️', text: 'Sağanak' };
  if (code >= 85 && code <= 86) return { icon: '🌨️', text: 'Kar Sağanağı' };
  if (code >= 95) return { icon: '⛈️', text: 'Fırtına' };
  return { icon: '🌡️', text: '' };
}

async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${EV_LAT}&longitude=${EV_LNG}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.daily && Array.isArray(data.daily.time)) {
      data.daily.time.forEach((dateStr, i) => {
        const code = data.daily.weather_code[i];
        const info = getWeatherInfo(code);
        const rainProb = data.daily.precipitation_probability_max ? data.daily.precipitation_probability_max[i] : null;
        weatherCache[dateStr] = {
          icon: info.icon,
          text: info.text,
          maxTemp: Math.round(data.daily.temperature_2m_max[i]),
          minTemp: Math.round(data.daily.temperature_2m_min[i]),
          rainProb: rainProb
        };
      });
      render();
    }
  } catch (e) {
    console.warn('Hava durumu çekilemedi:', e);
  }
}

// ========== DOM Elements ==========
const $ = id => document.getElementById(id);
const nameOverlay = $('nameOverlay');
const nameForm = $('nameForm');
const nameInput = $('nameInput');
const appContent = $('appContent');
const userNameEl = $('userName');
const btnChangeName = $('btnChangeName');
const heroDate = $('heroDate');
const heroWeather = $('heroWeather');
const heroStatus = $('heroStatus');
const heroDetail = $('heroDetail');
const heroAction = $('heroAction');
const upcomingList = $('upcomingList');
const upcomingSection = $('upcomingSection');
const monthTitle = $('monthTitle');
const calGrid = $('calGrid');
const btnPrev = $('btnPrev');
const btnNext = $('btnNext');
const modalBg = $('modalBg');
const modalClose = $('modalClose');
const modalTitle = $('modalTitle');
const modalBody = $('modalBody');
const quickMembers = $('quickMembers');
const memberChips = $('memberChips');
const btnToggleBg = $('btnToggleBg');

// ========== Background Slideshow Logic ==========
const BG_IMAGES = [
  'DSC_0080.JPG',
  'bg.jpg',
  '2a61869c-dec9-4031-b698-5d09556c9e4c.jpg',
  'f2890678-3d8d-49cb-98b7-e7d789c849b1.jpg',
  'fe09aaa9-ef13-4a82-9ddc-d554ed52d8ef.jpg'
];

function getAutoBgIndex(hour) {
  if (hour >= 5 && hour < 11) return 0; // Morning (DSC_0080.JPG)
  if (hour >= 11 && hour < 16) return 1; // Midday (bg.jpg)
  if (hour >= 16 && hour < 19) return 2; // Sunset (2a61869c-dec9-4031-b698-5d09556c9e4c.jpg)
  if (hour >= 19 && hour < 22) return 3; // Twilight (f2890678-3d8d-49cb-98b7-e7d789c849b1.jpg)
  return 4; // Night (fe09aaa9-ef13-4a82-9ddc-d554ed52d8ef.jpg)
}

function applyBackground() {
  let index = localStorage.getItem('salali_bg_idx');
  if (index === null) {
    index = getAutoBgIndex(new Date().getHours());
  } else {
    index = parseInt(index, 10);
  }
  const bgPhoto = document.querySelector('.bg-photo');
  if (bgPhoto) {
    bgPhoto.style.backgroundImage = `url('${BG_IMAGES[index]}')`;
  }
}

function toggleBackground() {
  let currentIndex = localStorage.getItem('salali_bg_idx');
  if (currentIndex === null) {
    currentIndex = getAutoBgIndex(new Date().getHours());
  } else {
    currentIndex = parseInt(currentIndex, 10);
  }
  const nextIndex = (currentIndex + 1) % BG_IMAGES.length;
  localStorage.setItem('salali_bg_idx', nextIndex);
  applyBackground();
  showToast('Arka plan görseli değiştirildi.', 'info');
}

// Toast Notification
function showToast(msg, type = 'info') {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast--show');
  }, 10);
  setTimeout(() => {
    toast.classList.remove('toast--show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ========== Init ==========
function init() {
  const now = new Date();
  viewDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let dow = viewDate.getDay() - 1;
  if (dow < 0) dow = 6;
  viewDate.setDate(viewDate.getDate() - dow);

  if (currentUser) {
    showApp();
  } else {
    showNameOverlay();
  }

  // Arka planı uygula
  applyBackground();
  if (btnToggleBg) {
    btnToggleBg.addEventListener('click', toggleBackground);
  }

  nameForm.addEventListener('submit', onNameSubmit);
  btnChangeName.addEventListener('click', onChangeName);
  btnPrev.addEventListener('click', () => navWeek(-1));
  btnNext.addEventListener('click', () => navWeek(1));
  modalClose.addEventListener('click', closeModal);
  modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Bucket list'i yükle
  loadBucketList();

  const bucketForm = $('bucketForm');
  if (bucketForm) {
    bucketForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('bucketInput');
      if (input) {
        addBucketItem(input.value);
        input.value = '';
      }
    });
  }

  // Hava durumunu yükle
  loadWeather();

  // Bildirim izni iste
  requestNotificationPermission();

  // 15 saniyede bir otomatik veri yenileme
  setInterval(() => {
    if (currentUser) loadReservations(true);
  }, 15000);
}

// ========== Name Flow ==========
async function showNameOverlay() {
  // CSS ile overlay'i göster
  document.documentElement.classList.add('name-changing');
  nameOverlay.style.display = 'flex';
  appContent.style.display = 'none';
  if (btnToggleBg) btnToggleBg.style.display = 'none';

  try {
    const res = await fetch('/api/members');
    if (res.ok) {
      const members = await res.json();
      if (Array.isArray(members) && members.length > 0) {
        quickMembers.style.display = 'block';
        memberChips.innerHTML = '';
        members.forEach(name => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'member-chip';
          chip.textContent = name;
          chip.addEventListener('click', () => selectName(name));
          memberChips.appendChild(chip);
        });
      } else {
        quickMembers.style.display = 'none';
      }
    }
  } catch {}
}

function selectName(name) {
  currentUser = name.trim();
  setStorage('salali_user', currentUser);
  showApp();
}

function onNameSubmit(e) {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  if (name.toLowerCase() === 'states') {
    window.location.href = '/stats';
    return;
  }
  selectName(name);
}

function onChangeName() {
  showNameOverlay();
  nameInput.value = currentUser;
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 100);
}

function showApp() {
  // CSS class'larını düzelt
  document.documentElement.classList.add('has-user');
  document.documentElement.classList.remove('name-changing');
  nameOverlay.style.display = 'none';
  appContent.style.display = 'block';
  if (btnToggleBg) btnToggleBg.style.display = 'flex';
  userNameEl.textContent = currentUser;
  loadReservations();
}

// ========== API Operations ==========
let loadRetryCount = 0;

async function loadReservations(silent = false) {
  try {
    const res = await fetch('/api/reservations');
    if (res.ok) {
      const newData = await res.json();
      loadRetryCount = 0;
      // Bildirim kontrolü (ilk yükleme hariç)
      checkReservationChanges(prevReservations, newData);
      prevReservations = JSON.parse(JSON.stringify(newData));
      reservations = newData;
      if (!notificationsReady) notificationsReady = true;
      render();
      return;
    }
  } catch (e) {}

  // Render uyanma veya deploy anlarında otomatik yeniden deneme
  if (loadRetryCount < 4) {
    loadRetryCount++;
    if (!silent && loadRetryCount === 1) {
      showToast('⚡ Sunucu uyanıyor, bağlanılıyor...', 'info');
    }
    setTimeout(() => loadReservations(silent), 2500);
  } else {
    loadRetryCount = 0;
    if (!silent) showToast('Bağlantı hatası. Yeniden deneniyor...', 'error');
  }
}

async function makeReservation(dateStr, note, slot, isGps) {
  const btn = document.querySelector('#modalBody .modal-btn--reserve');
  let originalHtml = '';
  if (btn) {
    originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.innerHTML = '⏳ Kaydediliyor...';
  }
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, name: currentUser, note, slot: slot || modalSlot || 'full', deviceId: getDeviceId(), isGps: !!isGps })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'İşlem başarısız.', 'error');
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = originalHtml; }
      return;
    }
    showToast('✅ Başarıyla eklendi!', 'success');
    await loadReservations();
    closeModal();
  } catch {
    showToast('Sunucuya erişilemiyor.', 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = originalHtml; }
  }
}

async function cancelReservation(dateStr, slot) {
  const btn = document.querySelector('#modalBody .modal-btn--cancel') || document.querySelector('#heroAction .btn-hero--cancel');
  let originalHtml = '';
  if (btn) {
    originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.innerHTML = '⏳ İptal ediliyor...';
  }
  try {
    const res = await fetch(`/api/reservations/${dateStr}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: currentUser, slot: slot || null, deviceId: getDeviceId() })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'İptal edilemedi.', 'error');
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = originalHtml; }
      return;
    }
    showToast('🗑️ Rezervasyon iptal edildi.', 'success');
    await loadReservations();
    closeModal();
  } catch {
    showToast('Sunucuya erişilemiyor.', 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = originalHtml; }
  }
}

// ========== Render Logic ==========
function render() {
  renderHero();
  renderUpcoming();
  renderCalendar();
}

// ---- Hero: Bugünün Durumu ----
function renderHero() {
  const now = new Date();
  const todayStr = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
  const dayName = GUN[now.getDay()];
  const monthName = AY[now.getMonth()];

  heroDate.textContent = `${dayName}, ${now.getDate()} ${monthName} ${now.getFullYear()}`;

  // Bugünün Hava Durumu
  if (heroWeather) {
    const tw = weatherCache[todayStr];
    if (tw) {
      heroWeather.style.display = 'inline-flex';
      const rainHtml = tw.rainProb !== null ? ` <span class="hero-weather-rain" style="margin-left:6px;opacity:0.85;">☔ %${tw.rainProb}</span>` : '';
      heroWeather.innerHTML = `<span class="hero-weather-icon">${tw.icon}</span> <span>${tw.text}${rainHtml}</span> <span class="hero-weather-temp">${tw.maxTemp}° / ${tw.minTemp}°C</span>`;
    } else {
      heroWeather.style.display = 'none';
    }
  }

  const r = reservations[todayStr];
  const currentHour = now.getHours();
  const isNightTime = currentHour >= 17; // 17:00'den sonrası Akşam/Gece sayılır

  if (r) {
    let dayRes = null;
    let nightRes = null;
    let fullRes = null;

    if (r.day || r.night) {
      dayRes = r.day;
      nightRes = r.night;
    } else {
      if (r.slot === 'day') dayRes = r;
      else if (r.slot === 'night') nightRes = r;
      else fullRes = r;
    }

    const activeRes = isNightTime ? (nightRes || fullRes) : (dayRes || fullRes);
    const otherRes = isNightTime ? null : (nightRes || fullRes);

    if (activeRes) {
      const isMine = isReservationMine(activeRes, currentUser);
      const resName = activeRes.name;
      const resNote = activeRes.note;
      const slotLabel = (activeRes.slot === 'day') ? 'Gündüz' : ((activeRes.slot === 'night') ? 'Akşam' : 'Tam Gün');
      
      if (isMine) {
        heroStatus.className = 'hero-status status-mine';
        heroStatus.innerHTML = `🏔️${activeRes.isGps ? '<span class="hero-gps-badge">📍 GPS</span>' : ''}`;
        heroDetail.innerHTML = `Şu an <strong>sen</strong> oradasın (${slotLabel})`;
        
        let actionsHtml = `<button class="btn-hero btn-hero--cancel" onclick="cancelReservation('${todayStr}', '${activeRes.slot || 'full'}')" style="display:flex;align-items:center;justify-content:center;"><i data-lucide="x-circle" style="width:18px;margin-right:6px;"></i> İptal Et</button>`;
        if (!activeRes.isGps) {
          actionsHtml = `<button class="btn-hero btn-hero--verify" onclick="verifyCurrentReservationLocation('${todayStr}', '${activeRes.slot || 'full'}', '${esc(activeRes.note || '')}')" style="display:flex;align-items:center;justify-content:center;margin-bottom:8px;background:var(--green);border:none;color:#fff;font-weight:600;"><i data-lucide="map-pin" style="width:18px;margin-right:6px;"></i> Konumu Doğrula</button>` + actionsHtml;
        }
        heroAction.innerHTML = actionsHtml;
      } else {
        heroStatus.className = 'hero-status status-occupied';
        heroStatus.innerHTML = `Dolu${activeRes.isGps ? '<span class="hero-gps-badge">📍 GPS</span>' : ''}`;
        heroDetail.innerHTML = `<strong>${esc(resName)}</strong> şu an orada (${slotLabel})${resNote ? ' (' + esc(resNote) + ')' : ''}`;
        
        const avail = getSlotAvailability(todayStr);
        if (avail.day || avail.night) {
          heroAction.innerHTML = `
            <button class="btn-hero btn-hero--coming" onclick="heroReserveComing()" style="display:flex;align-items:center;justify-content:center;">
              <i data-lucide="calendar-plus" style="width:18px;margin-right:6px;"></i> Boş Saati Rezerve Et
            </button>
          `;
        } else {
          heroAction.innerHTML = '';
        }
      }
    } else {
      // Şu anki saat dilimi boş ama günün diğer kısmı dolu
      heroStatus.className = 'hero-status status-split';
      heroStatus.innerHTML = 'Müsait';
      
      const otherLabel = otherRes ? `ancak akşam <strong>${esc(otherRes.name)}</strong> gelecek.` : '';
      heroDetail.innerHTML = `Şu an ev boş/müsait, ${otherLabel}`;
      
      heroAction.innerHTML = `
        <button class="btn-hero btn-hero--reserve" onclick="heroReserveHere()" style="display:flex;align-items:center;justify-content:center;">
          <i data-lucide="map-pin" style="width:18px;margin-right:6px;"></i> Buradayım
        </button>
        <button class="btn-hero btn-hero--coming" onclick="heroReserveComing()" style="display:flex;align-items:center;justify-content:center;">
          <i data-lucide="calendar-plus" style="width:18px;margin-right:6px;"></i> Gideceğim
        </button>
      `;
    }
  } else {
    heroStatus.className = 'hero-status status-free';
    heroStatus.innerHTML = 'Boş';
    heroDetail.textContent = 'Ev şu an boş, müsait!';
    
    heroAction.innerHTML = `
      <button class="btn-hero btn-hero--reserve" onclick="heroReserveHere()" style="display:flex;align-items:center;justify-content:center;">
        <i data-lucide="map-pin" style="width:18px;margin-right:6px;"></i> Buradayım
      </button>
      <button class="btn-hero btn-hero--coming" onclick="heroReserveComing()" style="display:flex;align-items:center;justify-content:center;">
        <i data-lucide="calendar-plus" style="width:18px;margin-right:6px;"></i> Gideceğim
      </button>
    `;
  }

  // Lucide iconları render et
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Hero butonları: modal açarak Kendim/Misafir seçimine yönlendir
function heroReserveHere() {
  const now = new Date();
  const dateStr = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
  openReserveStepModal(dateStr, now.getDate(), now.getMonth(), now.getFullYear(), 'here');
}

function heroReserveComing() {
  const now = new Date();
  const dateStr = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
  openReserveStepModal(dateStr, now.getDate(), now.getMonth(), now.getFullYear(), 'coming');
}

function cancelTodayReservation() {
  const now = new Date();
  cancelReservation(fmtDate(now.getFullYear(), now.getMonth(), now.getDate()));
}

// ---- Upcoming: Gelecek Günler ----
function renderUpcoming() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = fmtDate(today.getFullYear(), today.getMonth(), today.getDate());

  const upcoming = Object.entries(reservations)
    .filter(([d]) => d > todayStr)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 5);

  if (upcoming.length === 0) {
    upcomingSection.style.display = 'none';
    return;
  }

  upcomingSection.style.display = 'block';
  upcomingList.innerHTML = '';

  for (const [dateStr, r] of upcoming) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const dayName = GUN[dateObj.getDay()];
    const isMine = isReservationMine(r, currentUser);
    const isGuest = isReservationGuest(r);
    const resName = getReservationName(r);
    const resNote = getReservationNote(r);
    const createdDate = getReservationCreatedAt(r);

    let dotClass = 'upcoming-dot--occupied';
    if (isGuest) dotClass = 'upcoming-dot--guest';
    else if (isMine) dotClass = 'upcoming-dot--mine';

    const card = document.createElement('div');
    card.className = 'upcoming-card';
    card.addEventListener('click', () => openDayModal(dateStr, d, m - 1, y, r));

    // Hava durumu ekle
    const w = weatherCache[dateStr];
    const rainText = (w && w.rainProb !== null && w.rainProb > 0) ? ` <span style="font-size:0.75rem;opacity:0.8;color:#93c5fd;">☔%${w.rainProb}</span>` : '';
    const weatherHtml = w ? `<span style="font-size:0.8rem;margin-left:auto;color:#fbbf24;display:flex;align-items:center;gap:4px;">${w.icon} ${w.maxTemp}°C${rainText}</span>` : '';

    // Rezerve tarihi
    const createdInfo = createdDate ? formatCreatedAt(createdDate) : '';

    card.innerHTML = `
      <span class="upcoming-dot ${dotClass}"></span>
      <div class="upcoming-info">
        <div class="upcoming-date">${d} ${AY[m - 1]} · ${dayName}</div>
        <div class="upcoming-name">${esc(resName)}${resNote ? ' — ' + esc(resNote) : ''}</div>
        ${createdInfo ? `<div class="upcoming-created">📌 ${createdInfo}</div>` : ''}
      </div>
      ${weatherHtml}
    `;

    upcomingList.appendChild(card);
  }
}

// ---- Calendar Grid ----
function renderCalendar() {
  const endDate = new Date(viewDate);
  endDate.setDate(viewDate.getDate() + 13);
  
  const m1 = AY[viewDate.getMonth()];
  const m2 = AY[endDate.getMonth()];
  const y1 = viewDate.getFullYear();
  const y2 = endDate.getFullYear();
  
  if (y1 !== y2) {
    monthTitle.textContent = `${viewDate.getDate()} ${m1} ${y1} - ${endDate.getDate()} ${m2} ${y2}`;
  } else if (m1 !== m2) {
    monthTitle.textContent = `${viewDate.getDate()} ${m1} - ${endDate.getDate()} ${m2} ${y1}`;
  } else {
    monthTitle.textContent = `${viewDate.getDate()} - ${endDate.getDate()} ${m1} ${y1}`;
  }

  calGrid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 14; i++) {
    const dateObj = new Date(viewDate);
    dateObj.setDate(viewDate.getDate() + i);
    
    const y = dateObj.getFullYear();
    const m = dateObj.getMonth();
    const d = dateObj.getDate();
    
    const dateStr = fmtDate(y, m, d);
    const r = reservations[dateStr];
    const isPast = dateObj < today;
    const isToday = dateObj.getTime() === today.getTime();

    let cls = 'cal-day';
    if (isPast) cls += ' cal-day--past';
    if (isToday) cls += ' cal-day--today';

    let dayLabelHtml = '';

    if (r) {
      if (r.day || r.night) {
        // Çift slotlu gün
        cls += ' cal-day--split';
        const dayNameText = r.day ? r.day.name : '';
        const nightNameText = r.night ? r.night.name : '';
        const combined = [dayNameText, nightNameText].filter(Boolean).join('/');
        dayLabelHtml = `<span class="cal-day-name">${esc(combined)}</span>`;
      } else {
        // Tekil slotlu gün
        const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
        const isGuest = r.note && r.note.includes('Misafir için');
        if (isGuest) cls += ' cal-day--guest';
        else if (isMine) cls += ' cal-day--mine';
        else cls += ' cal-day--occupied';

        dayLabelHtml = `<span class="cal-day-name">${esc(r.name)}</span>`;
      }
    } else if (!isPast) {
      cls += ' cal-day--free';
    }

    const el = document.createElement('div');
    el.className = cls;

    // Hava durumu simgesi (takvim hücresi)
    const w = weatherCache[dateStr];
    const rainText = (w && w.rainProb !== null) ? ` (Yağış: %${w.rainProb})` : '';
    const weatherBadge = w ? `<span class="cal-weather" title="${w.text}: ${w.maxTemp}° / ${w.minTemp}°C${rainText}">${w.icon}${w.maxTemp}°</span>` : '';

    el.innerHTML = `
      <span class="cal-day-num">${d}</span>
      ${r ? dayLabelHtml : weatherBadge}
    `;

    if (!isPast) {
      el.addEventListener('click', () => openDayModal(dateStr, d, m, y, r));
    }

    calGrid.appendChild(el);
  }
}

function navWeek(dir) {
  viewDate.setDate(viewDate.getDate() + (dir * 14));
  renderCalendar();
}

// ========== İki Adımlı Rezervasyon Akışı ==========
let modalReserveType = 'self';
let modalReserveMode = 'coming'; // 'here' veya 'coming'
let modalSlot = 'full'; // 'full', 'day', 'night'

function buildSlotSelectHtml(avail = { full: true, day: true, night: true }) {
  if (!avail.full && avail.night && modalSlot === 'full') modalSlot = 'night';
  if (!avail.full && avail.day && modalSlot === 'full') modalSlot = 'day';

  return `<div class="slot-select-tags">
    ${avail.full ? `<button type="button" data-slot="full" class="slot-tag ${modalSlot === 'full' ? 'active' : ''}" onclick="setModalSlot('full')">
      <span class="slot-icon">🏡</span> Tam Gün
    </button>` : ''}
    ${avail.day ? `<button type="button" data-slot="day" class="slot-tag ${modalSlot === 'day' ? 'active' : ''}" onclick="setModalSlot('day')">
      <span class="slot-icon">☀️</span> Gündüz <span class="slot-desc">(Piknik)</span>
    </button>` : ''}
    ${avail.night ? `<button type="button" data-slot="night" class="slot-tag ${modalSlot === 'night' ? 'active' : ''}" onclick="setModalSlot('night')">
      <span class="slot-icon">🌙</span> Akşam & Gece
    </button>` : ''}
  </div>`;
}

function setModalSlot(slot) {
  modalSlot = slot;
  const tags = document.querySelectorAll('#modalBody .slot-select-tags .slot-tag');
  tags.forEach(t => {
    t.classList.remove('active');
    if (t.getAttribute('data-slot') === slot) {
      t.classList.add('active');
    }
  });
}

// Kendim/Misafir HTML bloğunu oluştur
function buildKendimMisafirHtml() {
  return `<div class="reserve-type-tags">
    <button type="button" data-type="self" class="reserve-type-tag ${modalReserveType === 'self' ? 'active' : ''}" onclick="setModalReserveType('self')">
      <span class="tag-icon">🙋</span> Kendim
    </button>
    <button type="button" data-type="guest" class="reserve-type-tag ${modalReserveType === 'guest' ? 'active' : ''}" onclick="setModalReserveType('guest')">
      <span class="tag-icon">👤</span> Misafir
    </button>
  </div>`;
}

// ========== Modal Dialog ==========
function openDayModal(dateStr, day, month, year, r) {
  const dayName = GUN[new Date(year, month, day).getDay()];
  modalTitle.textContent = `${day} ${AY[month]} ${year} · ${dayName}`;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const cellDate = new Date(year, month, day);
  cellDate.setHours(0, 0, 0, 0);
  const isToday = cellDate.getTime() === now.getTime();

  let html = '';

  // Modal Hava Durumu Kartı
  const w = weatherCache[dateStr];
  if (w) {
    const rainHtml = w.rainProb !== null ? `<span style="font-size:0.8rem;color:rgba(255,255,255,0.7);margin-left:8px;background:rgba(59,130,246,0.2);padding:2px 6px;border-radius:4px;">☔ Yağış: %${w.rainProb}</span>` : '';
    html += `<div class="modal-weather-badge">
      <span>${w.icon}</span>
      <span>${w.text}${rainHtml}</span>
      <span style="margin-left:auto;font-weight:600;">${w.maxTemp}° / ${w.minTemp}°C</span>
    </div>`;
  }

  if (r) {
    // 1. Durum: Çift slotlu nesne ({ day: {...}, night: {...} })
    if (r.day || r.night) {
      if (r.day) {
        const isMine = r.day.name.toLowerCase() === currentUser.toLowerCase();
        html += `<div class="modal-status-badge ${isMine ? 's-mine' : 's-occupied'}">Gündüz (Piknik) — ${esc(r.day.name)}</div>`;
        if (r.day.note) html += `<div class="modal-info"><strong>Not:</strong> ${esc(r.day.note)}</div>`;
        if (r.day.createdAt) html += `<div class="modal-info"><strong>Rezerve tarihi:</strong> ${formatCreatedAt(r.day.createdAt)}</div>`;
        if (r.day.isGps) {
          html += `<div class="gps-badge"><i data-lucide="map-pin" style="width:14px;height:14px;"></i> GPS ile Salarlı'dan doğrulandı (${formatGpsTime(r.day.createdAt)})</div>`;
        } else if (isMine && isToday) {
          html += `<button class="modal-btn modal-btn--verify" onclick="verifyCurrentReservationLocation('${dateStr}', 'day', '${esc(r.day.note || '')}')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;background:var(--green);border:none;color:#fff;font-weight:600;"><i data-lucide="map-pin" style="width:18px;"></i> Konumu Doğrula</button>`;
        }
        if (isMine) html += `<button class="modal-btn modal-btn--cancel" onclick="cancelReservation('${dateStr}', 'day')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;"><i data-lucide="x-circle" style="width:18px;"></i> Gündüzü İptal Et</button>`;
      }
      if (r.night) {
        const isMine = r.night.name.toLowerCase() === currentUser.toLowerCase();
        html += `<div class="modal-status-badge ${isMine ? 's-mine' : 's-occupied'}">Akşam & Gece — ${esc(r.night.name)}</div>`;
        if (r.night.note) html += `<div class="modal-info"><strong>Not:</strong> ${esc(r.night.note)}</div>`;
        if (r.night.createdAt) html += `<div class="modal-info"><strong>Rezerve tarihi:</strong> ${formatCreatedAt(r.night.createdAt)}</div>`;
        if (r.night.isGps) {
          html += `<div class="gps-badge"><i data-lucide="map-pin" style="width:14px;height:14px;"></i> GPS ile Salarlı'dan doğrulandı (${formatGpsTime(r.night.createdAt)})</div>`;
        } else if (isMine && isToday) {
          html += `<button class="modal-btn modal-btn--verify" onclick="verifyCurrentReservationLocation('${dateStr}', 'night', '${esc(r.night.note || '')}')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;background:var(--green);border:none;color:#fff;font-weight:600;"><i data-lucide="map-pin" style="width:18px;"></i> Konumu Doğrula</button>`;
        }
        if (isMine) html += `<button class="modal-btn modal-btn--cancel" onclick="cancelReservation('${dateStr}', 'night')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;"><i data-lucide="x-circle" style="width:18px;"></i> Akşamı İptal Et</button>`;
      }
      // Boş kalan slot varsa rezervasyon butonu göster
      if (!r.day) {
        modalReserveType = 'self';
        modalReserveMode = 'coming';
        modalSlot = 'day';
        html += `<div style="margin-top:12px;font-weight:600;font-size:0.85rem;color:var(--green);">Gündüz saatleri boş!</div>`;
        html += buildSlotSelectHtml({ full: false, day: true, night: false });
        html += buildKendimMisafirHtml();
        html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
        html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Gündüzü Rezerve Et</button>`;
      } else if (!r.night) {
        modalReserveType = 'self';
        modalReserveMode = 'coming';
        modalSlot = 'night';
        html += `<div style="margin-top:12px;font-weight:600;font-size:0.85rem;color:var(--blue);">Akşam saatleri boş!</div>`;
        html += buildSlotSelectHtml({ full: false, day: false, night: true });
        html += buildKendimMisafirHtml();
        html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
        html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Akşamı Rezerve Et</button>`;
      }
    } else {
      // 2. Durum: Tekil nesne ({ name, slot, ... })
      const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
      const cls = isMine ? 's-mine' : 's-occupied';
      const icon = isMine ? '🔵' : '🔴';
      const slotName = r.slot === 'day' ? 'Gündüz (Piknik)' : (r.slot === 'night' ? 'Akşam & Gece' : 'Tam Gün');

      html += `<div class="modal-status-badge ${cls}">${icon} ${slotName} — ${esc(r.name)}</div>`;
      if (r.note) html += `<div class="modal-info"><strong>Not:</strong> ${esc(r.note)}</div>`;
      if (r.createdAt) html += `<div class="modal-info"><strong>Rezerve tarihi:</strong> ${formatCreatedAt(r.createdAt)}</div>`;
      if (r.isGps) {
        html += `<div class="gps-badge"><i data-lucide="map-pin" style="width:14px;height:14px;"></i> GPS ile Salarlı'dan doğrulandı (${formatGpsTime(r.createdAt)})</div>`;
      } else if (isMine && isToday) {
        html += `<button class="modal-btn modal-btn--verify" onclick="verifyCurrentReservationLocation('${dateStr}', '${r.slot || 'full'}', '${esc(r.note || '')}')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;background:var(--green);border:none;color:#fff;font-weight:600;"><i data-lucide="map-pin" style="width:18px;"></i> Konumu Doğrula</button>`;
      }
      if (isMine) html += `<button class="modal-btn modal-btn--cancel" onclick="cancelReservation('${dateStr}', '${r.slot || 'full'}')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;"><i data-lucide="x-circle" style="width:18px;"></i> İptal Et</button>`;

      // Tekil slot day ise night boş; night ise day boş
      if (r.slot === 'day') {
        modalReserveType = 'self';
        modalReserveMode = 'coming';
        modalSlot = 'night';
        html += `<div style="margin-top:12px;font-weight:600;font-size:0.85rem;color:var(--blue);">Akşam & Gece saati boş!</div>`;
        html += buildSlotSelectHtml({ full: false, day: false, night: true });
        html += buildKendimMisafirHtml();
        html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
        html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Akşamı Rezerve Et</button>`;
      } else if (r.slot === 'night') {
        modalReserveType = 'self';
        modalReserveMode = 'coming';
        modalSlot = 'day';
        html += `<div style="margin-top:12px;font-weight:600;font-size:0.85rem;color:var(--green);">Gündüz saati boş!</div>`;
        html += buildSlotSelectHtml({ full: false, day: true, night: false });
        html += buildKendimMisafirHtml();
        html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
        html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Gündüzü Rezerve Et</button>`;
      }
    }
  } else {
    // 3. Durum: Gün tamamen boş
    html += `<div class="modal-status-badge s-free">🟢 Müsait</div>`;
    modalReserveType = 'self';
    modalReserveMode = 'coming';
    modalSlot = 'full';

    if (isToday) {
      html += `<div class="modal-choice-buttons">
        <button class="modal-btn modal-btn--reserve" onclick="openReserveStepModal('${dateStr}', ${day}, ${month}, ${year}, 'here')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:8px;">
          <i data-lucide="map-pin" style="width:18px;"></i> Buradayım (GPS)
        </button>
        <button class="modal-btn modal-btn--coming" onclick="openReserveStepModal('${dateStr}', ${day}, ${month}, ${year}, 'coming')" style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <i data-lucide="calendar-plus" style="width:18px;"></i> Gideceğim
        </button>
      </div>`;
    } else {
      html += buildSlotSelectHtml({ full: true, day: true, night: true });
      html += buildKendimMisafirHtml();
      html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
      html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Gideceğim</button>`;
    }
  }

  // Mobil uyumlu kapatma butonu
  html += `<button type="button" class="modal-btn" onclick="closeModal()" style="margin-top:10px;background:rgba(255,255,255,0.06);color:var(--text-dim);border:1px solid var(--glass-border);display:flex;align-items:center;justify-content:center;">Kapat</button>`;

  modalBody.innerHTML = html;
  modalBg.classList.add('show');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function getSlotAvailability(dateStr) {
  const r = reservations[dateStr];
  
  // Bugün için saat kontrolü (Geçmiş saatteki slotu rezerve etmeyi engelle)
  const now = new Date();
  const todayStr = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
  const isToday = (dateStr === todayStr);
  const currentHour = now.getHours();
  const isAfter17 = currentHour >= 17; // 17:00'den sonrası Akşam/Gece dilimidir

  if (!r) {
    if (isToday && isAfter17) {
      // Bugün akşam saatindeysek, bugünün Gündüzü veya Tam Günü seçilemez
      return { full: false, day: false, night: true };
    }
    return { full: true, day: true, night: true };
  }
  
  let dayRes = null;
  let nightRes = null;
  let fullRes = null;

  if (r.day || r.night) {
    dayRes = r.day;
    nightRes = r.night;
  } else {
    if (r.slot === 'day') dayRes = r;
    else if (r.slot === 'night') nightRes = r;
    else fullRes = r;
  }

  if (fullRes) {
    return { full: false, day: false, night: false };
  }

  let canFull = !dayRes && !nightRes;
  let canDay = !dayRes;
  let canNight = !nightRes;

  if (isToday && isAfter17) {
    // Bugün saat 17:00'yi geçtiyse artık Gündüz ve Tam Gün rezerve edilemez
    canFull = false;
    canDay = false;
  }

  return {
    full: canFull,
    day: canDay,
    night: canNight
  };
}

// Buradayım / Gideceğim tıklandıktan sonra Kendim/Misafir adımı
function openReserveStepModal(dateStr, day, month, year, mode) {
  modalReserveMode = mode;
  modalReserveType = 'self';

  const dayName = GUN[new Date(year, month, day).getDay()];
  modalTitle.textContent = `${day} ${AY[month]} ${year} · ${dayName}`;

  let html = '';

  // Hava durumu
  const w = weatherCache[dateStr];
  if (w) {
    const rainHtml = w.rainProb !== null ? `<span style="font-size:0.8rem;color:rgba(255,255,255,0.7);margin-left:8px;background:rgba(59,130,246,0.2);padding:2px 6px;border-radius:4px;">☔ Yağış: %${w.rainProb}</span>` : '';
    html += `<div class="modal-weather-badge">
      <span>${w.icon}</span>
      <span>${w.text}${rainHtml}</span>
      <span style="margin-left:auto;font-weight:600;">${w.maxTemp}° / ${w.minTemp}°C</span>
    </div>`;
  }

  // Seçilen mod göstergesi
  if (mode === 'here') {
    html += `<div class="modal-status-badge s-mine">📍 Buradayım — GPS ile doğrulanacak</div>`;
  } else {
    html += `<div class="modal-status-badge s-free">📅 Gideceğim</div>`;
  }

  // Slot seçimi (Tam Gün / Gündüz / Akşam)
  const avail = getSlotAvailability(dateStr);
  html += buildSlotSelectHtml(avail);

  // Kendim / Misafir tag'ları
  html += buildKendimMisafirHtml();

  // Not alanı
  html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;

  // Onay butonu
  if (mode === 'here') {
    html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="map-pin" style="width:18px;"></i> Onayla (GPS Kontrol)</button>`;
  } else {
    html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Onayla</button>`;
  }

  // Mobil uyumlu kapatma butonu
  html += `<button type="button" class="modal-btn" onclick="closeModal()" style="margin-top:10px;background:rgba(255,255,255,0.06);color:var(--text-dim);border:1px solid var(--glass-border);display:flex;align-items:center;justify-content:center;">Kapat</button>`;

  modalBody.innerHTML = html;
  modalBg.classList.add('show');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setModalReserveType(type) {
  modalReserveType = type;
  const tags = document.querySelectorAll('#modalBody .reserve-type-tags .reserve-type-tag');
  tags.forEach(t => {
    t.classList.remove('active');
    if (t.getAttribute('data-type') === type) {
      t.classList.add('active');
    }
  });
}

function closeModal() {
  modalBg.classList.remove('show');
}

// Son onay: GPS kontrol + Kendim/Misafir
async function onFinalReserve(dateStr) {
  try {
    const isGps = modalReserveMode === 'here';
    // GPS kontrolü sadece "here" modunda
    if (isGps) {
      await verifyLocation();
    }

    const noteEl = $('reserveNote');
    let note = noteEl ? noteEl.value.trim() : '';

    if (modalReserveType === 'guest') {
      // Misafir seçildiyse nota ekle
      note = note ? `Misafir için · ${note}` : 'Misafir için';
    }

    await makeReservation(dateStr, note, modalSlot, isGps);
  } catch (msg) {
    showToast(msg, 'error');
  }
}

// ========== Helpers ==========
function fmtDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatCreatedAt(isoStr) {
  try {
    const dt = new Date(isoStr);
    const d = dt.getDate();
    const m = AY[dt.getMonth()];
    const y = dt.getFullYear();
    const h = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    return `${d} ${m} ${y}, ${h}:${min}`;
  } catch {
    return '';
  }
}

function formatGpsTime(isoStr) {
  try {
    const dt = new Date(isoStr);
    const h = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    return `${h}:${min}`;
  } catch {
    return '';
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function verifyCurrentReservationLocation(dateStr, slot, existingNote) {
  try {
    await verifyLocation();
    
    // Konum doğrulandıysa doğrudan POST ile güncelleme yap
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: dateStr,
        name: currentUser,
        note: existingNote,
        slot: slot,
        deviceId: getDeviceId(),
        isGps: true
      })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Konum doğrulama başarısız.');
    }
    
    showToast('Konumunuz başarıyla doğrulandı! 📍', 'success');
    closeModal();
    loadReservations();
  } catch (err) {
    showToast(err, 'error');
  }
}

// ========== Bucket List Logic ==========
let bucketItems = [];

function loadBucketList() {
  try {
    const raw = localStorage.getItem('salali_bucket_list');
    bucketItems = raw ? JSON.parse(raw) : [];
  } catch {
    bucketItems = [];
  }
  renderBucketList();
}

function saveBucketList() {
  try {
    localStorage.setItem('salali_bucket_list', JSON.stringify(bucketItems));
  } catch {}
}

function renderBucketList() {
  const container = $('bucketList');
  if (!container) return;
  container.innerHTML = '';

  bucketItems.forEach(item => {
    const el = document.createElement('div');
    el.className = `bucket-item ${item.completed ? 'completed' : ''}`;
    
    el.innerHTML = `
      <div class="bucket-content" onclick="toggleBucketItem(${item.id})">
        <span class="bucket-checkbox">
          <i data-lucide="check" style="width:12px;height:12px;"></i>
        </span>
        <span class="bucket-text">${esc(item.text)}</span>
      </div>
      <button class="btn-bucket-delete" onclick="deleteBucketItem(${item.id})" title="Sil">
        <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
      </button>
    `;
    container.appendChild(el);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function addBucketItem(text) {
  const clean = text.trim();
  if (!clean) return;
  const newItem = {
    id: Date.now(),
    text: clean,
    completed: false
  };
  bucketItems.push(newItem);
  saveBucketList();
  renderBucketList();
}

function toggleBucketItem(id) {
  const item = bucketItems.find(x => x.id === id);
  if (item) {
    item.completed = !item.completed;
    saveBucketList();
    renderBucketList();
  }
}

function deleteBucketItem(id) {
  bucketItems = bucketItems.filter(x => x.id !== id);
  saveBucketList();
  renderBucketList();
}

// ========== Start ==========
init();
