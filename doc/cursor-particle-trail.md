# Cursor Particle Trail Effect

## Mô tả
Hiệu ứng các hạt phát sáng chạy theo con trỏ chuột khi di chuyển trên trang. Các hạt xuất hiện tại vị trí chuột, nổi lên và mờ dần theo hướng ngẫu nhiên.

## Các file liên quan

| File | Vị trí thay đổi | Mô tả |
|------|-----------------|-------|
| `styles.css` | Đầu file (sau @import) | CSS class `.cursor-particle` và keyframe `particle-fade` |
| `script.js` | Đầu file (trước DOMContentLoaded) | IIFE xử lý logic spawn particle |

---

## CSS (`styles.css`)

```css
.cursor-particle {
  position: fixed;
  border-radius: 50%;
  pointer-events: none;
  z-index: 9999;
  transform: translate(-50%, -50%);
  animation: particle-fade 0.8s ease-out forwards;
}

@keyframes particle-fade {
  0% {
    opacity: 0.9;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--drift-x)), calc(-50% + var(--drift-y))) scale(0.1);
  }
}
```

- `--drift-x` / `--drift-y`: CSS custom property được set inline từ JS để mỗi hạt bay theo hướng khác nhau.
- `pointer-events: none`: Đảm bảo hạt không chặn tương tác người dùng.
- `z-index: 9999`: Hiển thị trên mọi element khác.

---

## JavaScript (`script.js`)

```js
(function () {
    const colors = ['#00F0FF', '#8A2BE2', '#00c8d4', '#a64dff', '#ffffff'];
    let lastX = 0, lastY = 0;
    let frameId = null;

    function spawnParticle(x, y) { ... }

    document.addEventListener('mousemove', (e) => { ... });
})();
```

### Cách hoạt động

1. **Lắng nghe `mousemove`**: Tính tốc độ di chuyển `speed = √(dx² + dy²)`.
2. **Ngưỡng kích hoạt**: Chỉ spawn khi `speed > 3px` — tránh spam hạt khi chuột đứng yên.
3. **Số lượng hạt**: Tỉ lệ thuận với tốc độ, tối đa 4 hạt/frame: `count = min(floor(speed/5) + 1, 4)`.
4. **`requestAnimationFrame`**: Batch spawn vào frame tiếp theo, tránh jank.
5. **Tự dọn DOM**: Mỗi hạt tự remove sau khi animation kết thúc (`animationend`).

### Tham số mỗi hạt (ngẫu nhiên)

| Tham số | Khoảng giá trị | Ghi chú |
|---------|---------------|---------|
| Kích thước | 3–9px | `Math.random() * 6 + 3` |
| Màu | 5 màu trong palette | Cyan, tím, trắng |
| Drift X | ±30px | Bay sang ngang ngẫu nhiên |
| Drift Y | -20 đến -60px | Luôn bay lên trên |
| Duration | 500–900ms | Tốc độ mờ dần ngẫu nhiên |

### Màu sắc palette

```
#00F0FF  — Cyan chính (--primary-color)
#8A2BE2  — Tím chính (--secondary-color)
#00c8d4  — Cyan nhạt
#a64dff  — Tím nhạt
#ffffff  — Trắng
```

---

## Lưu ý khi chỉnh sửa

- **Thêm màu mới**: Sửa mảng `colors` trong `script.js`.
- **Hạt to hơn / nhỏ hơn**: Điều chỉnh `Math.random() * 6 + 3` (số đầu là khoảng biến thiên, số sau là giá trị tối thiểu).
- **Bay cao hơn**: Tăng `driftY`, ví dụ `-(Math.random() * 80 + 40)`.
- **Nhiều hạt hơn**: Tăng giới hạn `Math.min(..., 4)` lên 6–8, hoặc giảm ngưỡng speed xuống 1–2.
- **Hiệu ứng chậm hơn**: Tăng `duration`, ví dụ `Math.random() * 600 + 800`.

---

## Ngày thêm
2026-04-02
