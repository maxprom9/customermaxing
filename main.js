/* ============================================
   CustomerMaxing - Main JavaScript
   ============================================ */

(function () {
    'use strict';

    // ==========================================
    // Scroll-triggered fade-in animations
    // ==========================================
    const fadeElements = document.querySelectorAll('.fade-in');

    const observerOptions = {
        threshold: 0.15,
        rootMargin: '0px 0px -40px 0px'
    };

    const fadeObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                fadeObserver.unobserve(entry.target);
            }
        });
    }, observerOptions);

    fadeElements.forEach(function (el) {
        fadeObserver.observe(el);
    });

    // ==========================================
    // Navbar scroll effect
    // ==========================================
    const navbar = document.getElementById('navbar');
    let lastScrollY = 0;

    function handleScroll() {
        const scrollY = window.scrollY;

        if (scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        lastScrollY = scrollY;
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // ==========================================
    // Mobile menu toggle
    // ==========================================
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navLinks = document.getElementById('navLinks');

    if (mobileMenuBtn && navLinks) {
        mobileMenuBtn.addEventListener('click', function () {
            mobileMenuBtn.classList.toggle('active');
            navLinks.classList.toggle('active');
        });

        // Close menu when a link is clicked
        navLinks.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                mobileMenuBtn.classList.remove('active');
                navLinks.classList.remove('active');
            });
        });
    }

    // ==========================================
    // Smooth scroll for anchor links
    // ==========================================
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            var targetId = this.getAttribute('href');
            if (targetId === '#') return;

            var target = document.querySelector(targetId);
            if (!target) return;

            e.preventDefault();

            var navHeight = navbar.offsetHeight;
            var targetPosition = target.getBoundingClientRect().top + window.scrollY - navHeight - 20;

            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        });
    });

    // ==========================================
    // Login Modal
    // ==========================================
    var loginBtn = document.getElementById('loginBtn');
    var loginModal = document.getElementById('loginModal');
    var modalClose = document.getElementById('modalClose');
    var loginForm = document.getElementById('loginForm');
    var companyIdInput = document.getElementById('companyIdInput');

    function openModal() {
        loginModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        setTimeout(function () {
            companyIdInput.focus();
        }, 300);
    }

    function closeModal() {
        loginModal.classList.remove('active');
        document.body.style.overflow = '';
        companyIdInput.value = '';
    }

    if (loginBtn) {
        loginBtn.addEventListener('click', openModal);
    }

    if (modalClose) {
        modalClose.addEventListener('click', closeModal);
    }

    // Close modal on overlay click
    if (loginModal) {
        loginModal.addEventListener('click', function (e) {
            if (e.target === loginModal) {
                closeModal();
            }
        });
    }

    // Close modal on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && loginModal.classList.contains('active')) {
            closeModal();
        }
    });

    // Handle login form submission
    if (loginForm) {
        loginForm.addEventListener('submit', function (e) {
            e.preventDefault();

            var companyId = companyIdInput.value.trim().toLowerCase();

            if (!companyId) return;

            // Validate: only letters, numbers, and hyphens
            if (!/^[a-zA-Z0-9-]+$/.test(companyId)) {
                companyIdInput.setCustomValidity('Only letters, numbers, and hyphens are allowed.');
                companyIdInput.reportValidity();
                return;
            }

            companyIdInput.setCustomValidity('');

            // Redirect to the tenant portal
            window.location.href = 'https://' + companyId + '.customermaxing.com/portal/';
        });

        // Clear custom validity on input
        companyIdInput.addEventListener('input', function () {
            companyIdInput.setCustomValidity('');
        });
    }

    // ==========================================
    // CTA Form handling
    // ==========================================
    var ctaForm = document.getElementById('ctaForm');

    if (ctaForm) {
        ctaForm.addEventListener('submit', function (e) {
            e.preventDefault();

            var email = document.getElementById('ctaEmail').value.trim();
            if (!email) return;

            // Show success state
            var btn = ctaForm.querySelector('.btn');
            var originalText = btn.textContent;
            btn.textContent = 'Thank you!';
            btn.style.background = '#065F46';
            btn.disabled = true;

            setTimeout(function () {
                btn.textContent = originalText;
                btn.style.background = '';
                btn.disabled = false;
                document.getElementById('ctaEmail').value = '';
            }, 3000);
        });
    }

    // ==========================================
    // Animated counter for hero stats
    // ==========================================
    var statsAnimated = false;

    function animateStats() {
        if (statsAnimated) return;

        var statsSection = document.querySelector('.hero-stats');
        if (!statsSection) return;

        var rect = statsSection.getBoundingClientRect();
        if (rect.top > window.innerHeight || rect.bottom < 0) return;

        statsAnimated = true;

        var statNumbers = statsSection.querySelectorAll('.stat-number');
        statNumbers.forEach(function (el) {
            var text = el.textContent;
            // Only animate pure numbers
            var match = text.match(/^([<>]?)(\d+)(\.?\d*)([\+%s]*)$/);
            if (!match) return;

            var prefix = match[1];
            var target = parseInt(match[2], 10);
            var decimal = match[3];
            var suffix = match[4];
            var duration = 1500;
            var startTime = null;

            function step(timestamp) {
                if (!startTime) startTime = timestamp;
                var progress = Math.min((timestamp - startTime) / duration, 1);
                // Ease out cubic
                var eased = 1 - Math.pow(1 - progress, 3);
                var current = Math.floor(eased * target);
                el.textContent = prefix + current + (progress >= 1 ? decimal : '') + suffix;
                if (progress < 1) {
                    requestAnimationFrame(step);
                }
            }

            requestAnimationFrame(step);
        });
    }

    window.addEventListener('scroll', animateStats, { passive: true });
    animateStats();

})();
