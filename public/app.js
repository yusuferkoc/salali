// ========== State & Storage ==========
let currentUser = getStorage('salali_user') || '';
let reservations = {};
let weatherCache = {}; // dateStr -> { icon, text, maxTemp, minTemp }
let viewDate; // haftanın başlangıç tarihi (Pazartesi)

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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${EV_LAT}&longitude=${EV_LNG}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.daily && Array.isArray(data.daily.time)) {
      data.daily.time.forEach((dateStr, i) => {
        const code = data.daily.weather_code[i];
        const info = getWeatherInfo(code);
        weatherCache[dateStr] = {
          icon: info.icon,
          text: info.text,
          maxTemp: Math.round(data.daily.temperature_2m_max[i]),
          minTemp: Math.round(data.daily.temperature_2m_min[i])
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

  nameForm.addEventListener('submit', onNameSubmit);
  btnChangeName.addEventListener('click', onChangeName);
  btnPrev.addEventListener('click', () => navWeek(-1));
  btnNext.addEventListener('click', () => navWeek(1));
  modalClose.addEventListener('click', closeModal);
  modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Hava durumunu yükle
  loadWeather();

  // 15 saniyede bir otomatik veri yenileme
  setInterval(() => {
    if (currentUser) loadReservations(true);
  }, 15000);
}

// ========== Name Flow ==========
async function showNameOverlay() {
  nameOverlay.style.display = 'flex';
  appContent.style.display = 'none';

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
  selectName(name);
}

function onChangeName() {
  showNameOverlay();
  nameInput.value = currentUser;
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 100);
}

function showApp() {
  nameOverlay.style.display = 'none';
  appContent.style.display = 'block';
  userNameEl.textContent = currentUser;
  loadReservations();
}

// ========== API Operations ==========
async function loadReservations(silent = false) {
  try {
    const res = await fetch('/api/reservations');
    if (res.ok) {
      reservations = await res.json();
      render();
    }
  } catch (e) {
    if (!silent) showToast('Bağlantı hatası. Yeniden deneniyor...', 'error');
  }
}

async function makeReservation(dateStr, note) {
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, name: currentUser, note })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'İşlem başarısız.', 'error');
      return;
    }
    showToast('✅ Başarıyla eklendi!', 'success');
    await loadReservations();
    closeModal();
  } catch {
    showToast('Sunucuya erişilemiyor.', 'error');
  }
}

async function cancelReservation(dateStr) {
  try {
    const res = await fetch(`/api/reservations/${dateStr}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: currentUser })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'İptal edilemedi.', 'error');
      return;
    }
    showToast('🗑️ Rezervasyon iptal edildi.', 'success');
    await loadReservations();
    closeModal();
  } catch {
    showToast('Sunucuya erişilemiyor.', 'error');
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
      heroWeather.innerHTML = `<span class="hero-weather-icon">${tw.icon}</span> <span>${tw.text}</span> <span class="hero-weather-temp">${tw.maxTemp}° / ${tw.minTemp}°C</span>`;
    } else {
      heroWeather.style.display = 'none';
    }
  }

  const r = reservations[todayStr];

  if (r) {
    const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
    if (isMine) {
      heroStatus.className = 'hero-status status-mine';
      heroStatus.innerHTML = '🏔️';
      heroDetail.innerHTML = 'Şu an <strong>sen</strong> oradasın';
      heroAction.innerHTML = `<button class="btn-hero btn-hero--cancel" onclick="cancelTodayReservation()" style="display:flex;align-items:center;justify-content:center;"><i data-lucide="x-circle" style="width:18px;margin-right:6px;"></i> İptal Et</button>`;
    } else {
      heroStatus.className = 'hero-status status-occupied';
      heroStatus.innerHTML = 'Dolu';
      heroDetail.innerHTML = `<strong>${esc(r.name)}</strong> şu an orada${r.note ? ' (' + esc(r.note) + ')' : ''}`;
      heroAction.innerHTML = '';
    }
  } else {
    heroStatus.className = 'hero-status status-free';
    heroStatus.innerHTML = 'Boş';
    heroDetail.textContent = 'Ev şu an boş, müsait!';
    
    // Bugün için iki ayrı buton: Buradayım (GPS) ve Geleceğim
    heroAction.innerHTML = `
      <button class="btn-hero btn-hero--reserve" onclick="heroReserveHere()" style="display:flex;align-items:center;justify-content:center;">
        <i data-lucide="map-pin" style="width:18px;margin-right:6px;"></i> Buradayım
      </button>
      <button class="btn-hero btn-hero--coming" onclick="heroReserveComing()" style="display:flex;align-items:center;justify-content:center;">
        <i data-lucide="calendar-plus" style="width:18px;margin-right:6px;"></i> Geleceğim
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
    const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
    const isGuest = r.note && r.note.includes('Misafir için');
    let dotClass = 'upcoming-dot--occupied';
    if (isGuest) dotClass = 'upcoming-dot--guest';
    else if (isMine) dotClass = 'upcoming-dot--mine';

    const card = document.createElement('div');
    card.className = 'upcoming-card';
    card.addEventListener('click', () => openDayModal(dateStr, d, m - 1, y, r));

    // Hava durumu ekle
    const w = weatherCache[dateStr];
    const weatherHtml = w ? `<span style="font-size:0.8rem;margin-left:auto;color:#fbbf24;">${w.icon} ${w.maxTemp}°C</span>` : '';

    card.innerHTML = `
      <span class="upcoming-dot ${dotClass}"></span>
      <div class="upcoming-info">
        <div class="upcoming-date">${d} ${AY[m - 1]} · ${dayName}</div>
        <div class="upcoming-name">${esc(r.name)}${r.note ? ' — ' + esc(r.note) : ''}</div>
      </div>
      ${weatherHtml}
    `;

    upcomingList.appendChild(card);
  }
}

// ---- Calendar Grid ----
function renderCalendar() {
  const endDate = new Date(viewDate);
  endDate.setDate(viewDate.getDate() + 6);
  
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

  for (let i = 0; i < 7; i++) {
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

    if (r) {
      const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
      const isGuest = r.note && r.note.includes('Misafir için');
      if (isGuest) {
        cls += ' cal-day--guest';
      } else if (isMine) {
        cls += ' cal-day--mine';
      } else {
        cls += ' cal-day--occupied';
      }
    } else if (!isPast) {
      cls += ' cal-day--free';
    }

    const el = document.createElement('div');
    el.className = cls;

    // 7 günlük hava durumu simgesi (takvim hücresi)
    const w = weatherCache[dateStr];
    const weatherBadge = w ? `<span class="cal-weather" title="${w.text}: ${w.maxTemp}° / ${w.minTemp}°C">${w.icon}${w.maxTemp}°</span>` : '';

    el.innerHTML = `
      <span class="cal-day-num">${d}</span>
      ${r ? `<span class="cal-day-name">${esc(r.name)}</span>` : weatherBadge}
    `;

    if (!isPast) {
      el.addEventListener('click', () => openDayModal(dateStr, d, m, y, r));
    }

    calGrid.appendChild(el);
  }
}

function navWeek(dir) {
  viewDate.setDate(viewDate.getDate() + (dir * 7));
  renderCalendar();
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
    html += `<div class="modal-weather-badge">
      <span>${w.icon}</span>
      <span>${w.text}</span>
      <span style="margin-left:auto;font-weight:600;">${w.maxTemp}° / ${w.minTemp}°C</span>
    </div>`;
  }

  if (r) {
    const isMine = r.name.toLowerCase() === currentUser.toLowerCase();
    const cls = isMine ? 's-mine' : 's-occupied';
    const icon = isMine ? '🔵' : '🔴';
    const label = isMine ? (isToday ? 'Şu An Sen Oradasın' : 'Senin Planın') : 'Dolu';

    html += `<div class="modal-status-badge ${cls}">${icon} ${label}</div>`;
    html += `<div class="modal-info"><strong>Kim:</strong> ${esc(r.name)}</div>`;
    if (r.note) html += `<div class="modal-info"><strong>Not:</strong> ${esc(r.note)}</div>`;
    if (isMine) html += `<button class="modal-btn modal-btn--cancel" onclick="cancelReservation('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="x-circle" style="width:18px;"></i> İptal Et</button>`;
  } else {
    html += `<div class="modal-status-badge s-free">🟢 Müsait</div>`;

    if (isToday) {
      // Bugün: İlk adım — Buradayım ve Geleceğim seçenekleri
      html += `<div class="modal-choice-buttons">
        <button class="modal-btn modal-btn--reserve" onclick="openReserveStepModal('${dateStr}', ${day}, ${month}, ${year}, 'here')" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:8px;">
          <i data-lucide="map-pin" style="width:18px;"></i> Buradayım (GPS)
        </button>
        <button class="modal-btn modal-btn--coming" onclick="openReserveStepModal('${dateStr}', ${day}, ${month}, ${year}, 'coming')" style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <i data-lucide="calendar-plus" style="width:18px;"></i> Geleceğim
        </button>
      </div>`;
    } else {
      // Gelecek günler: Direkt Kendim/Misafir seçimi
      modalReserveType = 'self';
      modalReserveMode = 'coming';
      html += buildKendimMisafirHtml();
      html += `<textarea class="modal-note-input" id="reserveNote" rows="2" placeholder="Not ekle (opsiyonel)..."></textarea>`;
      html += `<button class="modal-btn modal-btn--reserve" onclick="onFinalReserve('${dateStr}')" style="display:flex;align-items:center;justify-content:center;gap:6px;"><i data-lucide="calendar-plus" style="width:18px;"></i> Geleceğim</button>`;
    }
  }

  modalBody.innerHTML = html;
  modalBg.classList.add('show');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeModal() { modalBg.classList.remove('show'); }

// ========== İki Adımlı Rezervasyon Akışı ==========
let modalReserveType = 'self';
let modalReserveMode = 'coming'; // 'here' veya 'coming'

// Kendim/Misafir HTML bloğunu oluştur
function buildKendimMisafirHtml() {
  return `<div class="reserve-type-tags">
    <button type="button" class="reserve-type-tag active" onclick="setModalReserveType('self')">
      <span class="tag-icon">🙋</span> Kendim
    </button>
    <button type="button" class="reserve-type-tag" onclick="setModalReserveType('guest')">
      <span class="tag-icon">👤</span> Misafir
    </button>
  </div>`;
}

// Buradayım / Geleceğim tıklandıktan sonra Kendim/Misafir adımı
function openReserveStepModal(dateStr, day, month, year, mode) {
  modalReserveMode = mode;
  modalReserveType = 'self';

  const dayName = GUN[new Date(year, month, day).getDay()];
  modalTitle.textContent = `${day} ${AY[month]} ${year} · ${dayName}`;

  let html = '';

  // Hava durumu
  const w = weatherCache[dateStr];
  if (w) {
    html += `<div class="modal-weather-badge">
      <span>${w.icon}</span>
      <span>${w.text}</span>
      <span style="margin-left:auto;font-weight:600;">${w.maxTemp}° / ${w.minTemp}°C</span>
    </div>`;
  }

  // Seçilen mod göstergesi
  if (mode === 'here') {
    html += `<div class="modal-status-badge s-mine">📍 Buradayım — GPS ile doğrulanacak</div>`;
  } else {
    html += `<div class="modal-status-badge s-free">📅 Geleceğim</div>`;
  }

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

  modalBody.innerHTML = html;
  modalBg.classList.add('show');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setModalReserveType(type) {
  modalReserveType = type;
  const tags = document.querySelectorAll('#modalBody .reserve-type-tags .reserve-type-tag');
  tags.forEach(t => t.classList.remove('active'));
  if (type === 'self') {
    tags[0].classList.add('active');
  } else {
    tags[1].classList.add('active');
  }
}

// Son onay: GPS kontrol + Kendim/Misafir
async function onFinalReserve(dateStr) {
  try {
    // GPS kontrolü sadece "here" modunda
    if (modalReserveMode === 'here') {
      await verifyLocation();
    }

    const noteEl = $('reserveNote');
    let note = noteEl ? noteEl.value.trim() : '';

    if (modalReserveType === 'guest') {
      // Misafir seçildiyse nota ekle
      note = note ? `Misafir için · ${note}` : 'Misafir için';
    }

    makeReservation(dateStr, note);
  } catch (msg) {
    showToast(msg, 'error');
  }
}

// ========== Helpers ==========
function fmtDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ========== Start ==========
init();
