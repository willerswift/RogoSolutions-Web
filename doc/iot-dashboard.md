# IoT Control Dashboard

## Mô tả
Trang dashboard điều khiển thiết bị IoT thông qua REST API và MQTT WebSocket. Cho phép đăng nhập, xem danh sách location → group → device và điều khiển trực tiếp từ trình duyệt.

## Các file liên quan

| File | Mô tả |
|------|-------|
| `dashboard.html` | Giao diện chính: login form + dashboard layout + control modal |
| `dashboard.js` | Logic: auth, API calls, MQTT, render, control |
| `dashboard.css` | Style riêng cho dashboard (import thêm `styles.css` gốc) |
| `index.html` | Đã thêm link "Dashboard" vào nav CTA |

---

## 1. Luồng xác thực (Authentication Flow)

```
1. Người dùng nhập appKey, appSecret, username/email, password
2. POST /api/v1/authen/login → nhận access_token, refresh_token
3. GET /api/v1/appsdk/get/appinfo → nhận userId, partnerId, mqttHosts, apiEndpoints
4. Lưu vào state S → dùng cho tất cả API sau
```

### Endpoint
```
POST https://openapi.rogo.com.vn/api/v1/authen/login
Headers: x-appkey, x-appsecret, Content-Type: application/json
Body: { username, email, password }
Response: { access_token, refresh_token, token_type }

GET https://openapi.rogo.com.vn/api/v1/appsdk/get/appinfo
Headers: Authorization: Bearer {token}, x-appkey, x-appsecret
Response: { userId, partnerId, mqttHosts[], apiEndpoints[] }
```

---

## 2. Internal API (Location / Group / Device)

Base URL từ `appInfo.apiEndpoints[0].url` hoặc fallback:
- Production: `https://device.rogo.com.vn`
- Staging: `https://device.rogo.com.vn/staging`

### Headers (tất cả)
```
Authorization: Bearer {access_token}
x-appkey: {appKey}
x-appsecret: {appSecret}
```

### Query params tự động thêm (tất cả)
```
?partner={partnerId}&endpoint={mqttEndpoint}&fromid={randomUUID}
```

### Endpoints
```
GET /location/get                        → [Location]
GET /group/get?locationId={id}           → [Group]
GET /device/get?locationId={id}          → [Device]
```

---

## 3. MQTT Connection (WebSocket)

### Cấu hình
```js
brokerUrl  = wss://{mqttHosts[0].url}:8084/mqtt   // WebSocket port 8084
clientId   = _02_{fromId}_0000
username   = clientId
password   = null
```

> ⚠️ iOS SDK dùng TCP/TLS port 8883. Browser cần WebSocket (WSS).
> Port WebSocket cần được cấu hình sẵn trên MQTT broker (thường 8084 cho EMQX).
> Nếu sai port/path, kiểm tra lại cấu hình server MQTT.

### Topics
| Topic | Chiều | Mục đích |
|-------|-------|----------|
| `{endpoint}/{partnerId}/app/{userId}/#` | Subscribe | Nhận state realtime từ thiết bị |
| `{endpoint}/{partnerId}/dev/{locationId}/{deviceEid}/cmd` | Publish | Điều khiển device cụ thể |
| `{endpoint}/{partnerId}/loc/{locationId}/{groupAddr}/cmd` | Publish | Điều khiển group/toàn bộ location |

---

## 4. Binary MQTT Message Format

### Long Message (dùng cho MQTT publish/subscribe)
```
Byte 0:   cmdType         (0x0A = SET_ACK)
Byte 1:   section         (0x01 = State)
Byte 2:   sectionExtra    (0x00)
Byte 3:   cmdData[0]      = deviceType (productInfos[1])
Byte 4:   cmdData[1]      = 0x00
Byte 5-6: tcpUdpPort      = 0x00, 0x00
Byte 7-8: tid             = TID (2B Big Endian, auto-increment)
Byte 9:   senderFrom      = 0x0E (WEB)
Byte 10:  senderSize      = length của userId (UTF-8)
Byte 11+: senderId        = userId bytes
...     : blocks          = [BLOCK_ATTR_VALUE, BLOCK_EID_PRTC_ELMS]
```

### Block format
```
[type (1B)] [length (1B)] [data (length bytes)]
```

### BLOCK_ATTR_VALUE (type = 0x80)
```
data = [attrType (2B BE), value0 (2B BE), value1 (2B BE), ...]
```

### BLOCK_EID_PRTC_ELMS (type = 0x44)
```
data = [eid (2B BE), protocolCtl (2B BE), elem0 (2B BE), ...]
```

---

## 5. Device Types & Control

### Device type (device.productInfos[1])
| Value | Type | Control |
|-------|------|---------|
| 2 | LIGHT | on/off, brightness (0-1000), kelvin (800-20000K) |
| 3 | SWITCH | on/off |
| 4 | PLUG | on/off |
| 5 | CURTAIN | open/stop/close |
| 6 | DOOR_LOCK | on/off |
| 16 | AC | on/off, temp (16-30°C), mode (0-4), fan speed |
| 17 | TV | on/off |
| 18 | FAN | on/off, fan speed (0-4) |
| 30 | TEMP_SENSOR | read only |

### Attribute types (attrValue[0])
```js
ONOFF    = 1   → [1, 0|1]
TEMP_SET = 2   → [2, temperature]   (AC nhiệt độ)
FAN_SPEED= 8   → [8, speed]         (0=auto, 1-4)
MODE     = 19  → [19, mode]         (0=cool, 1=heat, 2=fan, 4=dry)
BRIGHTNESS=28  → [28, value]        (0-1000)
KELVIN   = 29  → [29, value]        (800-20000)
OPEN_CLOSE=2   → [2, value]         (0=close, 1=open, 2=stop)  (Rèm)
```

---

## 6. State Management (client-side)

```js
S.deviceStates[uuid] = {
  on:         Boolean,
  brightness: Number (0-1000),
  kelvin:     Number (800-20000),
  acTemp:     Number (16-30),
}
```

State được cập nhật qua:
1. MQTT message subscribe (realtime từ device)
2. Optimistic update sau khi user điều khiển

---

## 7. Cấu trúc State object (S)

```js
{
  env,              // 'production' | 'staging'
  appKey,           // x-appkey header
  appSecret,        // x-appsecret header
  accessToken,      // JWT từ login
  refreshToken,
  tokenType,        // 'Bearer'
  userId,           // từ appInfo
  partnerId,        // từ appInfo
  mqttHosts[],      // từ appInfo
  mqttEndpoint,     // mqttHosts[0].endpoint
  deviceApiBase,    // từ appInfo.apiEndpoints[0].url
  fromId,           // random UUID cho browser session
  locations[],
  groups[],
  devices[],
  activeLocationId,
  deviceStates{},   // uuid → state
  mqttClient,       // mqtt.js client instance
  selectedDevice,   // device đang mở modal
  tidCounter,       // tự tăng cho MQTT TID
}
```

---

## 8. Lưu ý quan trọng

### CORS
Browser enforce CORS. Nếu server Rogo không có CORS headers cho origin của trang web này, các API call sẽ bị block.
- **Giải pháp 1**: Bật CORS trên server cho domain của trang web.
- **Giải pháp 2**: Dùng browser extension "CORS Unblock" khi test local.
- **Giải pháp 3**: Tạo proxy server (nginx reverse proxy) giữa browser và API.

### MQTT WebSocket port
- iOS SDK dùng TCP TLS port 8883.
- Browser cần WebSocket (WSS), thường port **8084** (EMQX default).
- Nếu không kết nối được: kiểm tra MQTT broker có bật listener ws/wss chưa.
- URL pattern: `wss://{broker_host}:8084/mqtt`

### appKey / appSecret
Lấy từ Rogo developer portal hoặc từ file cấu hình SDK của bạn.
Trong SDK sample: appKey = `fa751d67ddcf4e0dabe03d29ec81bac5`.

---

## 9. Các file nguồn tham khảo (iOS SDK)

| Mục | File |
|-----|------|
| Auth flow | `IotCoreIOS/1-PublicAPI/Core/IotCoreIOS+Authenticate.swift` |
| REST endpoints | `IotCoreIOS/3-Service/Networking/Endpoints/RGBInternalApiEndpoint.swift` |
| MQTT message format | `IotCoreIOS/3-Service/Messages/Helpers/RGBMessageHelper.swift` |
| Message types/enums | `IotCoreIOS/3-Service/Messages/Types/RGBIotMessageTypes.swift` |
| MQTT topic patterns | `IotCoreIOS/4-Platform/MQTT/Topics/Builders/RGBMQTTDeviceTopicBuilder.swift` |
| Control operation | `IotCoreIOS/3-Service/Operations/Control/RGBSendControlOperation.swift` |
| Long message (MQTT) | `IotCoreIOS/4-Platform/MQTT/Messages/RGBMQTTMessageConverter.swift` |

---

## Ngày tạo
2026-04-02
