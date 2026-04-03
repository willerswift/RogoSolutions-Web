/**
 * dashboard.js  —  Rogo IoT Control Dashboard
 *
 * Kết nối với backend Rogo thông qua:
 *   1. OpenAPI REST   → xác thực, lấy app info
 *   2. Internal API   → lấy locations, groups, devices
 *   3. MQTT WebSocket → nhận state realtime, gửi lệnh điều khiển
 *
 * Binary message format (MQTT Long Message):
 *   [cmdType(1), section(1), sectionExtra(1), cmdData[2], tcpUdpPort[2],
 *    tid[2], senderFrom(1), senderSize(1), senderId[N], blocks...]
 *
 * Block format: [type(1), length(1), data[N]]
 */

/* ============================================================
   CONSTANTS
   ============================================================ */
// Nếu chạy qua server.js (localhost), dùng proxy path để tránh CORS.
// Nếu mở file:// trực tiếp thì dùng URL gốc (cần CORS hoặc extension).
const IS_PROXIED = window.location.protocol !== 'file:' &&
                   (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const OPEN_API = {
  production: IS_PROXIED ? `${window.location.origin}/proxy/openapi` : 'https://openapi.rogo.com.vn',
  staging:    IS_PROXIED ? `${window.location.origin}/proxy/openapi` : 'https://staging.openapi.rogo.com.vn',
};

const DEVICE_API = {
  production: IS_PROXIED ? `${window.location.origin}/proxy/device`  : 'https://device.rogo.com.vn',
  staging:    IS_PROXIED ? `${window.location.origin}/proxy/staging` : 'https://device.rogo.com.vn/staging',
};

// Command types (byte 0)
const CMD_TYPE = { SET_ACK: 0x0A };
// Sections (byte 1)
const SECTION  = { State: 0x01 };
// Sender from (for Long message extension)
const SENDER_FROM = { WEB: 0x0E };
// Block types
const BLOCK = { ATTR_VALUE: 0x80, EID_PRTC_ELMS: 0x44 };
// Attribute types (attrValue[0])
const ATTR  = { ONOFF: 1, TEMP_SET: 2, FAN_SPEED: 8, MODE: 19, BRIGHTNESS: 28, KELVIN: 29, BRIGHTNESS_KELVIN: 30, OPEN_CLOSE: 2 };
// Device type categories (productInfos[1])
const DEV_TYPE = { LIGHT: 2, SWITCH: 3, PLUG: 4, CURTAIN: 5, DOOR_LOCK: 6, AC: 16, TV: 17, FAN: 18, TEMP_SENSOR: 30 };

/* ============================================================
   STATE
   ============================================================ */
let S = {
  env: 'production',
  appKey: '',
  appSecret: '',
  accessToken: null,
  refreshToken: null,
  tokenType: 'Bearer',
  userId: null,
  partnerId: null,
  mqttHosts: [],
  deviceApiBase: null,
  fromId: generateUUID(), // random UUID for this browser session
  locations: [],
  groups: [],
  devices: [],
  activeLocationId: null,
  deviceStates: {},    // uuid → { on: bool, brightness: int, kelvin: int, ... }
  mqttClient: null,
  mqttEndpoint: null,
  selectedDevice: null,
  tidCounter: 1,
};

/* ============================================================
   HELPERS
   ============================================================ */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function nextTid() {
  const t = S.tidCounter;
  S.tidCounter = (S.tidCounter % 65535) + 1;
  return t;
}

function be2(val) { return [(val >> 8) & 0xFF, val & 0xFF]; }

/* Build MQTT Long Message binary payload */
function buildControlPayload({ cmdType, section, sectionExtra = 0, deviceType = 0, attrValue, eid, protocolCtl, elements, senderId }) {
  const bytes = [];

  // 5-byte short header
  bytes.push(cmdType);
  bytes.push(section);
  bytes.push(sectionExtra);
  bytes.push(deviceType & 0xFF, 0x00);

  // Long message extension
  bytes.push(0x00, 0x00);            // tcpUdpPort (unused for MQTT)
  bytes.push(...be2(nextTid()));     // TID
  bytes.push(SENDER_FROM.WEB);       // senderFrom
  const senderBytes = new TextEncoder().encode(senderId || '');
  bytes.push(senderBytes.length);   // senderSize
  bytes.push(...senderBytes);       // senderId

  // BLOCK_ATTR_VALUE: type(1) + length(1) + [attr,v0,v1...](2B each BE)
  const attrData = [];
  for (const v of attrValue) attrData.push(...be2(v));
  bytes.push(BLOCK.ATTR_VALUE, attrData.length, ...attrData);

  // BLOCK_EID_PRTC_ELMS: type(1) + length(1) + eid(2) + prtcCtl(2) + elms(2 each)
  const eidData = [...be2(eid), ...be2(protocolCtl)];
  for (const e of elements) eidData.push(...be2(e));
  bytes.push(BLOCK.EID_PRTC_ELMS, eidData.length, ...eidData);

  return new Uint8Array(bytes);
}

/* ============================================================
   API CALLS
   ============================================================ */
async function apiRequest(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

function openApiHeaders(withAuth = false) {
  const h = { 'x-appkey': S.appKey, 'x-appsecret': S.appSecret };
  if (withAuth && S.accessToken) h['Authorization'] = `${S.tokenType} ${S.accessToken}`;
  return h;
}

function deviceApiHeaders() {
  return {
    'Authorization': `${S.tokenType} ${S.accessToken}`,
    'x-appkey': S.appKey,
    'x-appsecret': S.appSecret,
  };
}

function deviceApiParams(extra = {}) {
  const p = new URLSearchParams({
    partner: S.partnerId || '',
    endpoint: S.mqttEndpoint || '',
    fromid: S.fromId,
    ...extra,
  });
  return p.toString();
}

async function doLogin(usernameOrEmail, password) {
  const base = OPEN_API[S.env];
  const isEmail = usernameOrEmail.includes('@');
  const body = {
    username: isEmail ? '' : usernameOrEmail,
    email:    isEmail ? usernameOrEmail : '',
    password,
  };

  const data = await apiRequest(`${base}/api/v1/authen/login`, {
    method: 'POST',
    headers: openApiHeaders(false),
    body: JSON.stringify(body),
  });

  if (!data.access_token) throw new Error('Không nhận được token từ server');

  S.accessToken  = data.access_token;
  S.refreshToken = data.refresh_token;
  S.tokenType    = data.token_type || 'Bearer';
  return data;
}

async function fetchAppInfo() {
  const base = OPEN_API[S.env];
  const data = await apiRequest(`${base}/api/v1/appsdk/get/appinfo`, {
    headers: openApiHeaders(true),
  });
  return data;
}

async function fetchLocations() {
  const base = S.deviceApiBase || DEVICE_API[S.env];
  const data = await apiRequest(`${base}/location/get?${deviceApiParams()}`, {
    headers: deviceApiHeaders(),
  });
  return Array.isArray(data) ? data : (data.data || []);
}

async function fetchGroups(locationId) {
  const base = S.deviceApiBase || DEVICE_API[S.env];
  const extra = locationId ? { locationId } : {};
  const data = await apiRequest(`${base}/group/get?${deviceApiParams(extra)}`, {
    headers: deviceApiHeaders(),
  });
  return Array.isArray(data) ? data : (data.data || []);
}

async function fetchDevices(locationId) {
  const base = S.deviceApiBase || DEVICE_API[S.env];
  const extra = locationId ? { locationId } : {};
  const data = await apiRequest(`${base}/device/get?${deviceApiParams(extra)}`, {
    headers: deviceApiHeaders(),
  });
  return Array.isArray(data) ? data : (data.data || []);
}

/* ============================================================
   MQTT
   ============================================================ */
function connectMQTT() {
  if (!S.mqttHosts.length) return;

  const host = S.mqttHosts[0];
  const brokerHost = host.url || host.host;
  // Browser MQTT needs WebSocket. Try WSS port 8084, common for EMQX.
  const wsPort = host.wsPort || 8084;
  const wsPath = host.wsPath || '/mqtt';
  const brokerUrl = `wss://${brokerHost}:${wsPort}${wsPath}`;

  const clientId = `_02_${S.fromId.replace(/-/g, '')}_0000`;

  updateMqttBadge('connecting', 'Đang kết nối...');

  const client = mqtt.connect(brokerUrl, {
    clientId,
    username: clientId,
    password: null,
    keepalive: 60,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    rejectUnauthorized: false,
  });

  client.on('connect', () => {
    S.mqttClient = client;
    updateMqttBadge('connected', 'MQTT: Đã kết nối');

    // Subscribe to app topic for state updates
    if (S.mqttEndpoint && S.partnerId && S.userId) {
      const topic = `${S.mqttEndpoint}/${S.partnerId}/app/${S.userId}/#`;
      client.subscribe(topic, { qos: 1 }, err => {
        if (err) console.warn('MQTT subscribe error:', err);
      });
    }
  });

  client.on('message', (topic, payload) => {
    handleMqttMessage(topic, payload);
  });

  client.on('error', err => {
    console.error('MQTT error:', err);
    updateMqttBadge('disconnected', 'MQTT: Lỗi kết nối');
  });

  client.on('close', () => {
    updateMqttBadge('disconnected', 'MQTT: Đã ngắt kết nối');
  });

  client.on('reconnect', () => {
    updateMqttBadge('connecting', 'MQTT: Đang kết nối lại...');
  });
}

function handleMqttMessage(topic, payload) {
  // Parse binary message to extract device state updates
  try {
    const bytes = new Uint8Array(payload);
    if (bytes.length < 5) return;

    const section = bytes[1];
    if (section !== SECTION.State) return; // Only care about state messages

    // Skip long message header if present (11+ bytes)
    let offset = 5;
    if (bytes.length >= 11) {
      // Long message: skip port(2), tid(2), senderFrom(1), senderSize(1) + senderId(N)
      offset = 5 + 2 + 2; // after basic header + port + tid
      const senderFrom = bytes[offset];
      offset += 1;
      const senderSize = bytes[offset];
      offset += 1 + senderSize;
    }

    // Parse blocks
    const stateUpdate = {};
    while (offset + 2 <= bytes.length) {
      const blockType = bytes[offset++];
      const blockLen  = bytes[offset++];
      const blockData = bytes.slice(offset, offset + blockLen);
      offset += blockLen;

      if (blockType === BLOCK.ATTR_VALUE && blockData.length >= 4) {
        const attrType = (blockData[0] << 8) | blockData[1];
        const value    = (blockData[2] << 8) | blockData[3];
        if (attrType === ATTR.ONOFF) stateUpdate.on = value === 1;
        if (attrType === ATTR.BRIGHTNESS) stateUpdate.brightness = value;
        if (attrType === ATTR.KELVIN) stateUpdate.kelvin = value;
        if (attrType === ATTR.TEMP_SET) stateUpdate.acTemp = value;
      }
    }

    // Match device from topic path (…/dev/{locationId}/{eid}/… or app topic)
    const topicParts = topic.split('/');
    // Try to find device by EID from topic
    const eidIdx = topicParts.indexOf('dev');
    if (eidIdx >= 0 && topicParts.length > eidIdx + 2) {
      const eid = parseInt(topicParts[eidIdx + 2]);
      const dev = S.devices.find(d => d.eid === eid);
      if (dev && Object.keys(stateUpdate).length > 0) {
        S.deviceStates[dev.uuid] = { ...(S.deviceStates[dev.uuid] || {}), ...stateUpdate };
        updateDeviceCard(dev.uuid);
        // Update modal if open
        if (S.selectedDevice?.uuid === dev.uuid) syncModalState(dev.uuid);
      }
    }
  } catch (e) {
    // Ignore parse errors for unknown message formats
  }
}

function publishControl(device, attrValue) {
  if (!S.mqttClient || !S.mqttClient.connected) {
    showToast('MQTT chưa kết nối. Lệnh không được gửi.', 'warn');
    return false;
  }

  const locationId = device.locationId;
  const eid = device.eid;
  const protocolCtl = device.protocolCtl ?? 0;
  const elements = device.elementIds || [0];
  const deviceType = (device.productInfos && device.productInfos[1]) || 0;

  const topic = `${S.mqttEndpoint}/${S.partnerId}/dev/${locationId}/${eid}/cmd`;

  const payload = buildControlPayload({
    cmdType: CMD_TYPE.SET_ACK,
    section: SECTION.State,
    deviceType,
    attrValue,
    eid,
    protocolCtl,
    elements,
    senderId: S.userId || '',
  });

  S.mqttClient.publish(topic, Buffer.from(payload), { qos: 1 }, err => {
    if (err) {
      console.error('Publish error:', err);
      showSendStatus('error', 'Gửi lệnh thất bại: ' + err.message);
    } else {
      showSendStatus('success', 'Đã gửi lệnh thành công');
    }
  });

  return true;
}

/* ============================================================
   RENDER
   ============================================================ */
function deviceTypeInfo(productInfos) {
  const cat = (productInfos && productInfos[1]) || 0;
  const map = {
    [DEV_TYPE.LIGHT]:       { icon: 'fa-lightbulb',     label: 'Đèn',       accent: '#00F0FF' },
    [DEV_TYPE.SWITCH]:      { icon: 'fa-toggle-on',     label: 'Công tắc',  accent: '#8A2BE2' },
    [DEV_TYPE.PLUG]:        { icon: 'fa-plug',          label: 'Ổ cắm',     accent: '#a855f7' },
    [DEV_TYPE.CURTAIN]:     { icon: 'fa-align-justify',  label: 'Rèm',       accent: '#f59e0b' },
    [DEV_TYPE.DOOR_LOCK]:   { icon: 'fa-lock',          label: 'Khoá cửa',  accent: '#ef4444' },
    [DEV_TYPE.AC]:          { icon: 'fa-snowflake',     label: 'Điều hoà',  accent: '#38bdf8' },
    [DEV_TYPE.TV]:          { icon: 'fa-tv',            label: 'TV',        accent: '#6366f1' },
    [DEV_TYPE.FAN]:         { icon: 'fa-fan',           label: 'Quạt',      accent: '#22d3ee' },
    [DEV_TYPE.TEMP_SENSOR]: { icon: 'fa-temperature-half', label: 'Cảm biến', accent: '#34d399' },
  };
  return map[cat] || { icon: 'fa-microchip', label: 'Thiết bị', accent: '#00F0FF' };
}

function renderLocationList() {
  const el = document.getElementById('location-list');
  el.innerHTML = '';

  if (!S.locations.length) {
    el.innerHTML = '<div style="padding: 12px 16px; color: var(--text-muted); font-size: 0.82rem;">Không có vị trí nào</div>';
    return;
  }

  S.locations.forEach(loc => {
    const item = document.createElement('div');
    item.className = 'nav-item' + (loc.uuid === S.activeLocationId ? ' active' : '');
    item.innerHTML = `<i class="fa-solid fa-house"></i><span>${escapeHtml(loc.label || loc.uuid)}</span>`;
    item.addEventListener('click', () => selectLocation(loc.uuid));
    el.appendChild(item);
  });
}

function renderGroups() {
  const content = document.getElementById('devices-content');
  const container = document.getElementById('groups-container');
  const loc = S.locations.find(l => l.uuid === S.activeLocationId);

  document.getElementById('location-title').textContent = loc ? (loc.label || 'Vị trí') : 'Thiết bị';

  const devCount = S.devices.length;
  document.getElementById('stats-text').textContent = `${devCount} thiết bị`;

  container.innerHTML = '';

  // Group devices by groupId
  const groupMap = {};
  S.devices.forEach(dev => {
    const gid = dev.groupId || '__none__';
    if (!groupMap[gid]) groupMap[gid] = [];
    groupMap[gid].push(dev);
  });

  // Render groups that have devices
  S.groups.forEach(grp => {
    const devs = groupMap[grp.uuid] || [];
    if (!devs.length) return;
    renderGroupSection(container, grp.label || 'Nhóm', devs, grp.uuid);
    delete groupMap[grp.uuid];
  });

  // Devices with no group
  if (groupMap['__none__'] && groupMap['__none__'].length) {
    renderGroupSection(container, 'Thiết bị khác', groupMap['__none__'], '__none__');
  }

  content.style.display = 'block';
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('devices-loading').style.display = 'none';
}

function renderGroupSection(container, title, devices, groupId) {
  const section = document.createElement('div');
  section.className = 'group-section';
  section.innerHTML = `
    <div class="group-title">
      <i class="fa-solid fa-layer-group"></i>
      <span>${escapeHtml(title)}</span>
      <span style="margin-left:auto;font-weight:400;">${devices.length}</span>
    </div>
    <div class="devices-grid" id="grid-${groupId}"></div>
  `;
  container.appendChild(section);

  const grid = section.querySelector('.devices-grid');
  devices.forEach(dev => grid.appendChild(createDeviceCard(dev)));
}

function createDeviceCard(dev) {
  const info = deviceTypeInfo(dev.productInfos);
  const state = S.deviceStates[dev.uuid] || {};
  const isOn = state.on === true;
  const offline = dev.link === 0;

  const card = document.createElement('div');
  card.className = `device-card${isOn ? ' powered-on' : ''}${offline ? ' offline' : ''}`;
  card.id = `card-${dev.uuid}`;
  card.style.setProperty('--device-accent', info.accent);
  card.innerHTML = `
    <div class="device-card-top">
      <div class="device-icon${isOn ? ' on' : ''}" style="${isOn ? `background:rgba(${hexToRgb(info.accent)},0.12);color:${info.accent}` : ''}">
        <i class="fa-solid ${info.icon}"></i>
      </div>
      <div class="device-power-dot${isOn ? ' on' : ''}"></div>
    </div>
    <div>
      <div class="device-name">${escapeHtml(dev.label || dev.uuid)}</div>
      <div class="device-type-label">${info.label}${offline ? ' · Offline' : ''}</div>
    </div>
  `;

  if (!offline) {
    card.addEventListener('click', () => openControlModal(dev));
  }

  return card;
}

function updateDeviceCard(uuid) {
  const card = document.getElementById(`card-${uuid}`);
  if (!card) return;

  const dev = S.devices.find(d => d.uuid === uuid);
  if (!dev) return;

  const info = deviceTypeInfo(dev.productInfos);
  const state = S.deviceStates[uuid] || {};
  const isOn = state.on === true;

  card.classList.toggle('powered-on', isOn);
  const iconEl = card.querySelector('.device-icon');
  const dotEl  = card.querySelector('.device-power-dot');
  if (iconEl) {
    iconEl.className = `device-icon${isOn ? ' on' : ''}`;
    if (isOn) {
      iconEl.style.background = `rgba(${hexToRgb(info.accent)},0.12)`;
      iconEl.style.color = info.accent;
    } else {
      iconEl.style.background = '';
      iconEl.style.color = '';
    }
  }
  if (dotEl) dotEl.className = `device-power-dot${isOn ? ' on' : ''}`;
}

/* ============================================================
   CONTROL MODAL
   ============================================================ */
function openControlModal(dev) {
  S.selectedDevice = dev;
  const info = deviceTypeInfo(dev.productInfos);
  const cat  = (dev.productInfos && dev.productInfos[1]) || 0;
  const state = S.deviceStates[dev.uuid] || {};

  document.getElementById('modal-device-name').textContent = dev.label || dev.uuid;
  document.getElementById('modal-device-type').textContent = info.label;

  const iconEl = document.getElementById('modal-device-icon');
  iconEl.innerHTML = `<i class="fa-solid ${info.icon}"></i>`;
  iconEl.style.color = info.accent;
  iconEl.style.background = `rgba(${hexToRgb(info.accent)}, 0.12)`;

  // On/Off
  const toggle = document.getElementById('ctrl-onoff');
  toggle.checked = state.on === true;

  // Show/hide controls by device type
  showControlRow('ctrl-brightness-row', cat === DEV_TYPE.LIGHT);
  showControlRow('ctrl-kelvin-row',     cat === DEV_TYPE.LIGHT);
  showControlRow('ctrl-actemp-row',     cat === DEV_TYPE.AC);
  showControlRow('ctrl-acmode-row',     cat === DEV_TYPE.AC);
  showControlRow('ctrl-fanspeed-row',   cat === DEV_TYPE.FAN || cat === DEV_TYPE.AC);
  showControlRow('ctrl-curtain-row',    cat === DEV_TYPE.CURTAIN);

  // Set current values
  if (state.brightness !== undefined) {
    document.getElementById('ctrl-brightness').value = state.brightness;
    document.getElementById('ctrl-brightness-val').textContent = state.brightness;
  }
  if (state.kelvin !== undefined) {
    document.getElementById('ctrl-kelvin').value = state.kelvin;
    document.getElementById('ctrl-kelvin-val').textContent = state.kelvin + 'K';
  }
  if (state.acTemp !== undefined) {
    document.getElementById('ctrl-actemp').value = state.acTemp;
    document.getElementById('ctrl-actemp-val').textContent = state.acTemp + '°C';
  }

  hideSendStatus();
  document.getElementById('control-modal').style.display = 'flex';
}

function syncModalState(uuid) {
  const state = S.deviceStates[uuid] || {};
  document.getElementById('ctrl-onoff').checked = state.on === true;
  if (state.brightness !== undefined) {
    document.getElementById('ctrl-brightness').value = state.brightness;
    document.getElementById('ctrl-brightness-val').textContent = state.brightness;
  }
}

function showControlRow(id, show) {
  document.getElementById(id).style.display = show ? 'flex' : 'none';
}

function showSendStatus(type, msg) {
  const el = document.getElementById('ctrl-send-status');
  el.className = 'send-status ' + type;
  el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check' : 'fa-triangle-exclamation'}"></i> ${msg}`;
  el.style.display = 'flex';
  setTimeout(() => hideSendStatus(), 3000);
}

function hideSendStatus() {
  document.getElementById('ctrl-send-status').style.display = 'none';
}

/* ============================================================
   ACTIONS
   ============================================================ */
async function selectLocation(locationId) {
  S.activeLocationId = locationId;
  renderLocationList();

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('devices-content').style.display = 'none';
  document.getElementById('devices-loading').style.display = 'flex';

  try {
    const [groups, devices] = await Promise.all([
      fetchGroups(locationId),
      fetchDevices(locationId),
    ]);
    S.groups  = groups;
    S.devices = devices;
    renderGroups();
  } catch (err) {
    document.getElementById('devices-loading').style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
    showToast('Lỗi tải thiết bị: ' + err.message, 'error');
  }
}

function sendOnOff(value) {
  const dev = S.selectedDevice;
  if (!dev) return;
  S.deviceStates[dev.uuid] = { ...(S.deviceStates[dev.uuid] || {}), on: value };
  updateDeviceCard(dev.uuid);
  publishControl(dev, [ATTR.ONOFF, value ? 1 : 0]);
}

function sendBrightness(bri) {
  const dev = S.selectedDevice;
  if (!dev) return;
  publishControl(dev, [ATTR.BRIGHTNESS, bri]);
}

function sendKelvin(k) {
  const dev = S.selectedDevice;
  if (!dev) return;
  publishControl(dev, [ATTR.KELVIN, k]);
}

function sendAcTemp(t) {
  const dev = S.selectedDevice;
  if (!dev) return;
  publishControl(dev, [ATTR.TEMP_SET, t]);
}

function sendMode(mode) {
  const dev = S.selectedDevice;
  if (!dev) return;
  document.querySelectorAll('.btn-mode').forEach(b => b.classList.remove('active'));
  document.querySelector(`.btn-mode[data-mode="${mode}"]`)?.classList.add('active');
  publishControl(dev, [ATTR.MODE, parseInt(mode)]);
}

function sendFanSpeed(speed) {
  const dev = S.selectedDevice;
  if (!dev) return;
  document.querySelectorAll('.btn-speed').forEach(b => b.classList.remove('active'));
  document.querySelector(`.btn-speed[data-speed="${speed}"]`)?.classList.add('active');
  publishControl(dev, [ATTR.FAN_SPEED, parseInt(speed)]);
}

function sendCurtain(action) {
  const dev = S.selectedDevice;
  if (!dev) return;
  // open=1, stop=2, close=0
  const val = { open: 1, stop: 2, close: 0 }[action] ?? 0;
  publishControl(dev, [ATTR.OPEN_CLOSE, val]);
}

/* ============================================================
   UTILITY
   ============================================================ */
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

function updateMqttBadge(state, text) {
  const badge = document.getElementById('mqtt-status');
  badge.className = `mqtt-badge ${state}`;
  badge.querySelector('span').textContent = text;
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.borderColor = type === 'error' ? 'rgba(255,80,80,0.4)' : 'var(--border-color)';
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3500);
}

function showScreen(id) {
  // Tìm trong overlay hoặc toàn trang (standalone)
  const container = document.getElementById('dashboard-overlay') || document;
  container.querySelectorAll('.db-screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function openOverlay() {
  const overlay = document.getElementById('dashboard-overlay');
  if (overlay) {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden'; // khóa scroll trang chính
  }
}

function closeOverlay() {
  const overlay = document.getElementById('dashboard-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

function setLoginLoading(loading) {
  const btn = document.getElementById('btn-login');
  const txt = document.getElementById('btn-login-text');
  const spin = document.getElementById('btn-login-spinner');
  btn.disabled = loading;
  txt.textContent = loading ? 'Đang đăng nhập...' : 'Đăng nhập';
  spin.style.display = loading ? 'inline-block' : 'none';
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideLoginError() {
  document.getElementById('login-error').style.display = 'none';
}

/* ============================================================
   INIT & EVENT LISTENERS
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  // --- Nút mở overlay từ trang chủ ---
  document.getElementById('btn-open-dashboard')?.addEventListener('click', () => {
    openOverlay();
  });

  // --- Nút quay lại trang chủ (từ login screen) ---
  document.getElementById('btn-back-from-login')?.addEventListener('click', () => {
    closeOverlay();
  });

  // --- Nút quay lại trang chủ (từ dashboard screen) ---
  document.getElementById('btn-back-from-dashboard')?.addEventListener('click', () => {
    closeOverlay();
  });

  // --- Login form ---
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    hideLoginError();

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    S.appKey    = document.getElementById('cfg-appkey').value.trim();
    S.appSecret = document.getElementById('cfg-appsecret').value.trim();
    S.env       = document.getElementById('cfg-env').value;

    if (!S.appKey || !S.appSecret) {
      showLoginError('Vui lòng nhập App Key và App Secret trong mục "Cấu hình nâng cao".');
      return;
    }

    setLoginLoading(true);

    try {
      await doLogin(username, password);

      const appInfo = await fetchAppInfo();
      S.userId      = appInfo.userId;
      S.partnerId   = appInfo.partnerId || appInfo.partnerID;
      S.mqttHosts   = appInfo.mqttHosts || [];
      S.mqttEndpoint = S.mqttHosts[0]?.endpoint || '';

      // Device API base from apiEndpoints or fallback
      const apiEndpoints = appInfo.apiEndpoints || [];
      S.deviceApiBase = (apiEndpoints[0]?.url) || DEVICE_API[S.env];

      // Show dashboard
      document.getElementById('header-username').textContent = username;
      showScreen('dashboard-screen');

      // Load locations
      document.getElementById('loc-loading').style.display = 'inline-block';
      try {
        S.locations = await fetchLocations();
      } finally {
        document.getElementById('loc-loading').style.display = 'none';
      }
      renderLocationList();

      // Connect MQTT
      if (S.mqttHosts.length) {
        connectMQTT();
      } else {
        updateMqttBadge('disconnected', 'MQTT: Không có cấu hình');
      }

    } catch (err) {
      const isFetchError = err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('CORS');
      const msg = isFetchError
        ? (IS_PROXIED
            ? 'Không thể kết nối server. Kiểm tra lại appKey/appSecret và kết nối mạng.\nChi tiết: ' + err.message
            : 'Lỗi CORS: hãy chạy qua proxy server.\n\nMở terminal trong thư mục Web và chạy:\n  node server.js\nSau đó truy cập http://localhost:3000/dashboard.html')
        : 'Đăng nhập thất bại: ' + err.message;
      showLoginError(msg);
    } finally {
      setLoginLoading(false);
    }
  });

  // --- Logout ---
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    if (S.mqttClient) { S.mqttClient.end(); S.mqttClient = null; }
    S.accessToken = S.refreshToken = null;
    S.locations = []; S.groups = []; S.devices = [];
    S.activeLocationId = null;
    document.getElementById('location-list').innerHTML = '';
    document.getElementById('groups-container').innerHTML = '';
    document.getElementById('devices-content').style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
    showScreen('login-screen'); // quay về login, vẫn trong overlay
  });

  // --- Modal close ---
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('control-modal').style.display = 'none';
    S.selectedDevice = null;
  });
  document.getElementById('control-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('control-modal')) {
      document.getElementById('control-modal').style.display = 'none';
      S.selectedDevice = null;
    }
  });

  // --- On/Off toggle ---
  document.getElementById('ctrl-onoff').addEventListener('change', e => {
    sendOnOff(e.target.checked);
  });

  // --- Brightness slider ---
  let bTimer = null;
  document.getElementById('ctrl-brightness').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    document.getElementById('ctrl-brightness-val').textContent = val;
    clearTimeout(bTimer);
    bTimer = setTimeout(() => sendBrightness(val), 300);
  });

  // --- Kelvin slider ---
  let kTimer = null;
  document.getElementById('ctrl-kelvin').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    document.getElementById('ctrl-kelvin-val').textContent = val + 'K';
    clearTimeout(kTimer);
    kTimer = setTimeout(() => sendKelvin(val), 300);
  });

  // --- AC temp slider ---
  let tTimer = null;
  document.getElementById('ctrl-actemp').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    document.getElementById('ctrl-actemp-val').textContent = val + '°C';
    clearTimeout(tTimer);
    tTimer = setTimeout(() => sendAcTemp(val), 300);
  });

  // --- AC mode buttons ---
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => sendMode(btn.dataset.mode));
  });

  // --- Fan speed buttons ---
  document.querySelectorAll('.btn-speed').forEach(btn => {
    btn.addEventListener('click', () => sendFanSpeed(btn.dataset.speed));
  });

  // --- Curtain buttons ---
  document.querySelectorAll('.btn-curtain').forEach(btn => {
    btn.addEventListener('click', () => sendCurtain(btn.dataset.action));
  });
});
