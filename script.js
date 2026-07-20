/* ═══════════════════════════════════════════════════════════
   THAR — Born Unstoppable
   Scroll-Hijacked Video Slide Engine
   Page stays fixed on current slide while wheel scrubs video.
   Scrolls to next slide ONLY after full animation completion!
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ── DOM REFS ────────────────────────────────────────────
  const navbar       = document.getElementById('navbar');
  const progressFill = document.getElementById('progress-fill');
  const navLinks     = document.querySelectorAll('.nav-links a');

  // Slide list in order
  const slideIds = ['hero', 'section-orbit', 'section-engine', 'section-colour', 'section-interior', 'section-finale'];

  const videoConfigs = [
    { sectionId: 'section-orbit',    videoId: 'video-orbit'    },
    { sectionId: 'section-engine',   videoId: 'video-engine'   },
    { sectionId: 'section-colour',   videoId: 'video-colour'   },
    { sectionId: 'section-interior', videoId: 'video-interior' }
  ];

  const videoData = [];
  let currentSlideIdx = 0;
  let isNavigating = false;
  const SCRUB_SPEED = 0.003; // Time per wheel delta pixel

  // ── INIT VIDEO METADATA ──────────────────────────────────
  videoConfigs.forEach(cfg => {
    const section = document.getElementById(cfg.sectionId);
    const video   = document.getElementById(cfg.videoId);
    const ring    = section ? section.querySelector('.ring-fill') : null;

    if (section && video) {
      video.pause(); // Ensure video never plays on its own

      const data = {
        sectionId: cfg.sectionId,
        section, video, ring,
        targetTime: 0,
        currentTime: 0,
        velocity: 0,      // momentum for the "coast to a stop" scrub feel
        duration: 0,
        isLoaded: false
      };

      // Prime the video so the first frame actually paints instead of
      // showing black until the user starts scrubbing (needed on Safari/iOS).
      const primeFirstFrame = () => {
        video.currentTime = 0;
        const p = video.play();
        if (p && p.then) p.then(() => video.pause()).catch(() => {});
        else video.pause();
      };

      video.addEventListener('loadedmetadata', () => {
        data.duration = video.duration || 5;
        data.isLoaded = true;
        primeFirstFrame();
      });

      if (video.readyState >= 1) {
        data.duration = video.duration || 5;
        data.isLoaded = true;
        primeFirstFrame();
      }

      videoData.push(data);
    }
  });

  // ── ACTIVE SECTION CLASS ─────────────────────────────────
  // Drives the CSS choreography: video Ken Burns settle + staggered
  // content reveal (see .is-active rules in style.css). Only one
  // section is ever "active" at a time.
  let activeSectionEl = null;
  function setActiveSection(idx) {
    const nextEl = document.getElementById(slideIds[idx]);
    if (activeSectionEl && activeSectionEl !== nextEl) {
      activeSectionEl.classList.remove('is-active');
    }
    if (nextEl) nextEl.classList.add('is-active');
    activeSectionEl = nextEl;
  }
  setActiveSection(0); // hero is visible from the start

  // ── CUSTOM SCROLL ANIMATION ──────────────────────────────
  // Drives the slide transition ourselves (instead of native scrollIntoView)
  // so we know exactly when it finishes and don't fight CSS scroll-snap.
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function animateScrollTo(targetEl, onComplete) {
    if (!targetEl) { if (onComplete) onComplete(); return; }

    const startY = window.scrollY;
    const endY = targetEl.getBoundingClientRect().top + startY;
    const distance = endY - startY;

    if (Math.abs(distance) < 1) { if (onComplete) onComplete(); return; }

    const duration = Math.min(900, Math.max(450, Math.abs(distance) * 0.6));
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      window.scrollTo(0, startY + distance * easeInOutCubic(t));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        window.scrollTo(0, endY);
        if (onComplete) onComplete();
      }
    }
    requestAnimationFrame(step);
  }

  // ── SLIDE NAVIGATION ────────────────────────────────────
  function goToSlide(idx) {
    if (idx < 0 || idx >= slideIds.length || isNavigating) return;

    const fromIdx = currentSlideIdx;
    const enteringForward = idx > fromIdx;
    isNavigating = true;

    const targetEl = document.getElementById(slideIds[idx]);

    // Snap the entering video to its correct start frame *before* it comes
    // into view: frame 0 when arriving from above, last frame when arriving
    // from below. (Previously this comparison ran after currentSlideIdx had
    // already been overwritten, so it always evaluated false — the bug
    // behind the frame jumps when scrolling back up.)
    const data = videoData.find(d => d.sectionId === slideIds[idx]);
    if (data && data.isLoaded) {
      const startTime = enteringForward ? 0 : data.duration;
      data.targetTime = startTime;
      data.currentTime = startTime;
      data.velocity = 0;
      try { data.video.currentTime = startTime; } catch (e) {}
    }

    // Kill any leftover momentum on the slide being left so it doesn't
    // silently keep drifting off-screen.
    const leavingData = videoData.find(d => d.sectionId === slideIds[fromIdx]);
    if (leavingData) leavingData.velocity = 0;

    currentSlideIdx = idx;
    updateNavUI(idx);
    setActiveSection(idx);

    animateScrollTo(targetEl, () => {
      isNavigating = false;
    });
  }

  // ── WHEEL DELTA NORMALIZATION ────────────────────────────
  // Browsers report deltaY in different units depending on input device
  // (pixel mode for most trackpads, "line" mode for many mice in Firefox).
  // Without normalizing, scrub speed feels wildly inconsistent between
  // devices. We also clamp extreme spikes from fast trackpad flicks so a
  // single event can't jump the video several seconds at once.
  const MAX_WHEEL_DELTA = 120;
  function normalizeWheelDelta(e) {
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 18;        // lines -> ~pixels
    else if (e.deltaMode === 2) delta *= window.innerHeight; // pages -> pixels
    return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));
  }

  // ── SCRUB PHYSICS ─────────────────────────────────────────
  // Instead of snapping targetTime directly to the wheel delta, wheel
  // input adds an impulse to a velocity that decays over time (see
  // animLoop). This gives the scrub a "coast to a stop" quality after
  // the user stops scrolling — closer to real inertial trackpad motion
  // than a 1:1 mechanical mapping.
  const SCRUB_FRICTION = 0.90;      // per-frame velocity decay
  const MAX_SCRUB_VELOCITY = 0.09;  // seconds/frame cap so flicks can't skip too far
  function applyScrubImpulse(data, delta) {
    const impulse = delta * SCRUB_SPEED;
    data.velocity = Math.max(-MAX_SCRUB_VELOCITY, Math.min(MAX_SCRUB_VELOCITY, data.velocity + impulse));
    // Also nudge targetTime immediately so response still feels instant,
    // not just momentum-driven.
    data.targetTime = Math.max(0, Math.min(data.duration, data.targetTime + impulse * 0.6));
  }

  // ── WHEEL HIJACKING ENGINE ──────────────────────────────
  window.addEventListener('wheel', e => {
    if (isNavigating) {
      e.preventDefault();
      return;
    }

    const currentSlideId = slideIds[currentSlideIdx];
    const data = videoData.find(d => d.sectionId === currentSlideId);

    // If current slide is an animation section
    if (data && data.isLoaded && data.duration > 0) {
      const delta = normalizeWheelDelta(e);

      // Are we in the middle of scrubbing the video?
      const inProgress = (delta > 0 && data.targetTime < data.duration - 0.05) ||
                         (delta < 0 && data.targetTime > 0.05);

      if (inProgress) {
        e.preventDefault(); // Lock page scroll!
        applyScrubImpulse(data, delta);
        return;
      }

      // Reached the END of the animation and scrolling down -> go to NEXT slide!
      if (delta > 0 && data.targetTime >= data.duration - 0.05) {
        e.preventDefault();
        data.targetTime = data.duration;
        data.velocity = 0;
        goToSlide(currentSlideIdx + 1);
        return;
      }

      // Reached the START of the animation and scrolling up -> go to PREVIOUS slide!
      if (delta < 0 && data.targetTime <= 0.05) {
        e.preventDefault();
        data.targetTime = 0;
        data.velocity = 0;
        goToSlide(currentSlideIdx - 1);
        return;
      }
    } else {
      // Non-video slides (Hero or Finale): wheel advances to next/prev slide
      const delta = normalizeWheelDelta(e);
      if (delta > 30 && currentSlideIdx < slideIds.length - 1) {
        e.preventDefault();
        goToSlide(currentSlideIdx + 1);
      } else if (delta < -30 && currentSlideIdx > 0) {
        e.preventDefault();
        goToSlide(currentSlideIdx - 1);
      }
    }
  }, { passive: false });

  // Touch swipe support for mobile
  let touchY = 0;
  window.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (isNavigating) return;
    const currentSlideId = slideIds[currentSlideIdx];
    const data = videoData.find(d => d.sectionId === currentSlideId);

    if (data && data.isLoaded && data.duration > 0) {
      const curY = e.touches[0].clientY;
      const delta = (touchY - curY) * 2;
      touchY = curY;

      const inProgress = (delta > 0 && data.targetTime < data.duration - 0.05) ||
                         (delta < 0 && data.targetTime > 0.05);

      if (inProgress) {
        if (e.cancelable) e.preventDefault();
        applyScrubImpulse(data, delta);
      } else if (delta > 20 && data.targetTime >= data.duration - 0.05) {
        if (e.cancelable) e.preventDefault();
        data.velocity = 0;
        goToSlide(currentSlideIdx + 1);
      } else if (delta < -20 && data.targetTime <= 0.05) {
        if (e.cancelable) e.preventDefault();
        data.velocity = 0;
        goToSlide(currentSlideIdx - 1);
      }
    }
  }, { passive: false });

  // ── SMOOTH VIDEO SCRUB RENDER LOOP ─────────────────────────
  // Tuned relative to a fixed 60fps baseline originally, which meant the
  // exact same physics constants produced a floatier scrub on 120/144Hz
  // screens and a laggier one on slower devices — read as "random
  // glitchiness". Now scaled by real elapsed time each frame so the feel
  // is identical regardless of refresh rate.
  const BASELINE_MS = 1000 / 60;
  let lastFrameTime = performance.now();

  function animLoop(now) {
    let dt = (now - lastFrameTime) / BASELINE_MS;
    lastFrameTime = now;
    // Clamp so a dropped frame / tab switch can't fling the video forward.
    dt = Math.max(0, Math.min(dt, 3));

    videoData.forEach(data => {
      if (data.isLoaded && data.duration > 0) {
        // Momentum: bleed velocity into targetTime, then decay it. This is
        // what makes the scrub keep gliding for a beat after the wheel
        // stops, instead of halting the instant input does.
        if (Math.abs(data.velocity) > 0.0002) {
          data.targetTime = Math.max(0, Math.min(data.duration, data.targetTime + data.velocity * dt));
          data.velocity *= Math.pow(SCRUB_FRICTION, dt);
          if (Math.abs(data.velocity) < 0.0002) data.velocity = 0;
        }

        const diff = data.targetTime - data.currentTime;
        if (Math.abs(diff) > 0.004) {
          const lerpAmt = 1 - Math.pow(1 - 0.28, dt);
          data.currentTime += diff * lerpAmt; // Smooth lerp toward target

          // Guard against overlapping seeks: firing video.currentTime
          // again while the previous seek is still resolving is what
          // causes the visible hitch/glitch during fast scrubbing.
          // Skip this frame's seek if one is already in flight or the
          // change is too small to matter (sub-frame at typical fps).
          if (!data.video.seeking && Math.abs(data.video.currentTime - data.currentTime) > 0.008) {
            try { data.video.currentTime = data.currentTime; } catch (e) {}
          }
        }

        // Update progress ring fill
        if (data.ring) {
          const pct = data.currentTime / data.duration;
          data.ring.style.strokeDashoffset = 125.6 * (1 - Math.max(0, Math.min(1, pct)));
        }
      }
    });
    requestAnimationFrame(animLoop);
  }
  requestAnimationFrame(animLoop);

  // ── OBSERVE CURRENT SLIDE ─────────────────────────────────
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !isNavigating) {
        const idx = slideIds.indexOf(entry.target.id);
        if (idx !== -1) {
          currentSlideIdx = idx;
          updateNavUI(idx);
          setActiveSection(idx);
        }
      }
    });
  }, { threshold: 0.6 });

  slideIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });

  // Global scroll listener for progress bar & navbar
  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    const windowH = window.innerHeight;
    const docH    = document.documentElement.scrollHeight - windowH;

    if (progressFill && docH > 0) {
      progressFill.style.width = `${(scrollY / docH) * 100}%`;
    }
    if (navbar) {
      navbar.classList.toggle('scrolled', scrollY > 40);
    }
  }, { passive: true });

  // ── NAV UI UPDATES ────────────────────────────────────────
  function updateNavUI(idx) {
    const currentId = slideIds[idx];
    navLinks.forEach(link => {
      const href = link.getAttribute('href').replace('#', '');
      link.classList.toggle('active', href === currentId);
    });
  }

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', e => {
      const targetId = anchor.getAttribute('href').replace('#', '');
      const idx = slideIds.indexOf(targetId);
      if (idx !== -1) {
        e.preventDefault();
        goToSlide(idx);
      }
    });
  });

  console.log(
    '%c THAR %c Scroll-Hijacked Video Slide Engine Active ',
    'background:#ff4d00;color:#000;font-weight:900;padding:4px 8px;font-size:13px;',
    'background:#111;color:#ff4d00;font-weight:600;padding:4px 8px;font-size:13px;'
  );

})();
