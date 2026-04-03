// Cursor Particle Trail Effect
(function () {
    const colors = ['#00F0FF', '#8A2BE2', '#00c8d4', '#a64dff', '#ffffff'];
    let lastX = 0, lastY = 0;
    let frameId = null;

    function spawnParticle(x, y) {
        const particle = document.createElement('div');
        particle.classList.add('cursor-particle');

        const size = Math.random() * 6 + 3; // 3–9px
        const color = colors[Math.floor(Math.random() * colors.length)];
        const driftX = (Math.random() - 0.5) * 60;
        const driftY = -(Math.random() * 40 + 20); // float upward
        const duration = Math.random() * 400 + 500; // 500–900ms

        particle.style.cssText = `
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
            background: ${color};
            box-shadow: 0 0 ${size * 2}px ${color};
            --drift-x: ${driftX}px;
            --drift-y: ${driftY}px;
            animation-duration: ${duration}ms;
        `;

        document.body.appendChild(particle);
        particle.addEventListener('animationend', () => particle.remove());
    }

    document.addEventListener('mousemove', (e) => {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        const speed = Math.sqrt(dx * dx + dy * dy);

        if (speed > 3) {
            if (frameId) cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(() => {
                const count = Math.min(Math.floor(speed / 5) + 1, 4);
                for (let i = 0; i < count; i++) {
                    const offsetX = (Math.random() - 0.5) * 8;
                    const offsetY = (Math.random() - 0.5) * 8;
                    spawnParticle(e.clientX + offsetX, e.clientY + offsetY);
                }
                frameId = null;
            });
            lastX = e.clientX;
            lastY = e.clientY;
        }
    });
})();

document.addEventListener('DOMContentLoaded', () => {
    // 1. Mobile Menu Toggle
    const mobileMenu = document.getElementById('mobile-menu');
    const navLinks = document.getElementById('nav-links');
    const navCta = document.getElementById('nav-cta');
    const navbar = document.getElementById('navbar');

    mobileMenu.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        navCta.classList.toggle('active');
        navbar.classList.toggle('menu-open');
        
        const icon = mobileMenu.querySelector('i');
        if (navLinks.classList.contains('active')) {
            icon.classList.remove('fa-bars');
            icon.classList.add('fa-times');
        } else {
            icon.classList.remove('fa-times');
            icon.classList.add('fa-bars');
        }
    });

    // 2. Navbar background on scroll
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.add('transitioning');
            navbar.classList.remove('scrolled');
            // Prevent flickering background during transitions 
        }
    });

    // Handle initial state just in case of reload mid-page
    if (window.scrollY > 50) {
        navbar.classList.add('scrolled');
    }

    // 3. Scroll Animation with Intersection Observer
    const animatedElements = document.querySelectorAll('.animate-on-scroll');

    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.15 // Kích hoạt khi 15% phần tử hiển thị trên viewport
    };

    const scrollObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target); // Chỉ animate 1 lần
            }
        });
    }, observerOptions);

    animatedElements.forEach(el => {
        scrollObserver.observe(el);
    });

    // 4. Phone carousel — infinite auto-scroll with center highlight
    (function initPhoneCarousel() {
        const wrapper = document.querySelector('.phones-track-wrapper');
        const track = document.querySelector('.phones-track');
        if (!track || !wrapper) return;

        const origCards = [...track.querySelectorAll('.phone-card')];
        if (origCards.length === 0) return;

        // Clone enough sets so the viewport is always filled.
        // Need: EXTRA * origWidth >= viewport + origWidth  →  EXTRA >= ceil(viewport / origWidth)
        // Using 5 extra sets covers viewports up to 5× card-set width (safe for all screens).
        const EXTRA = 5;
        for (let i = 0; i < EXTRA; i++) {
            origCards.forEach(card => {
                const clone = card.cloneNode(true);
                clone.setAttribute('aria-hidden', 'true');
                track.appendChild(clone);
            });
        }

        const SPEED = 0.5;
        let pos = 0;
        let origWidth = 0;
        let wrapWidth = wrapper.offsetWidth;
        let paused = false;

        function setup() {
            const all = track.querySelectorAll('.phone-card');
            origWidth = all[origCards.length].getBoundingClientRect().left
                      - all[0].getBoundingClientRect().left;
            if (origWidth <= 0) return;

            // Center the middle original card, then ensure pos is positive
            const mid = origCards[Math.floor(origCards.length / 2)];
            const midCenter = mid.getBoundingClientRect().left + mid.offsetWidth / 2;
            pos = midCenter - (wrapper.getBoundingClientRect().left + wrapWidth / 2);
            while (pos < 0) pos += origWidth;   // guarantee positive start

            track.style.transform = `translateX(${-pos}px)`;
            updateCenter();
        }

        function updateCenter() {
            const cx = wrapper.getBoundingClientRect().left + wrapWidth / 2;
            let closest = null, minDist = Infinity;
            track.querySelectorAll('.phone-card').forEach(card => {
                card.classList.remove('is-center');
                const r = card.getBoundingClientRect();
                const d = Math.abs((r.left + r.width / 2) - cx);
                if (d < minDist) { minDist = d; closest = card; }
            });
            if (closest) closest.classList.add('is-center');
        }

        function tick() {
            if (!paused && origWidth > 0) {
                pos += SPEED;
                // Reset before the last filled pixel — ensures no empty gap ever appears.
                // At resetAt, visible range ends exactly at the last card of the track.
                const resetAt = (EXTRA + 1) * origWidth - wrapWidth;
                if (pos >= resetAt) pos -= origWidth;
                if (pos < 0) pos += origWidth;
                track.style.transform = `translateX(${-pos}px)`;
                updateCenter();
            }
            requestAnimationFrame(tick);
        }

        window.addEventListener('resize', () => {
            wrapWidth = wrapper.offsetWidth;
        });

        wrapper.addEventListener('mouseenter', () => { paused = true; });
        wrapper.addEventListener('mouseleave', () => { paused = false; });

        let txStart = 0, posStart = 0;
        wrapper.addEventListener('touchstart', e => {
            paused = true;
            txStart = e.touches[0].clientX;
            posStart = pos;
        }, { passive: true });
        wrapper.addEventListener('touchmove', e => {
            if (!origWidth) return;
            const newPos = posStart + (txStart - e.touches[0].clientX);
            const resetAt = (EXTRA + 1) * origWidth - wrapWidth;
            pos = Math.max(0, Math.min(resetAt, newPos));
            track.style.transform = `translateX(${-pos}px)`;
            updateCenter();
        }, { passive: true });
        wrapper.addEventListener('touchend', () => {
            setTimeout(() => { paused = false; }, 1200);
        });

        setTimeout(() => { setup(); requestAnimationFrame(tick); }, 120);
    })();

    // 5. Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        if (anchor.getAttribute('href') !== '#') {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const targetId = this.getAttribute('href');
                const targetSection = document.querySelector(targetId);
                
                if (targetSection) {
                    // Close mobile menu if open
                    if (navLinks.classList.contains('active')) {
                        mobileMenu.click();
                    }

                    const headerOffset = 80;
                    const elementPosition = targetSection.getBoundingClientRect().top;
                    const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

                    window.scrollTo({
                        top: offsetPosition,
                        behavior: 'smooth'
                    });
                }
            });
        }
    });
});
