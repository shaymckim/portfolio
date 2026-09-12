'use strict';

function initIntro(onComplete) {
  const root = document.documentElement;
  const hero = document.getElementById('hero');
  const video = document.getElementById('hero-video');
  const main = document.getElementById('main-content');
  const mobileNav = document.getElementById('mobile-nav');
  const loader = document.getElementById('intro-loader');
  const status = document.getElementById('intro-status');
  const detail = document.getElementById('intro-detail');
  const playButton = document.getElementById('intro-play');
  const retryButton = document.getElementById('intro-retry');
  const continueButton = document.getElementById('intro-continue');
  const playbackControls = document.getElementById('intro-playback-controls');
  const playbackStatus = document.getElementById('intro-playback-status');
  const resumeButton = document.getElementById('intro-resume');
  const finishButton = document.getElementById('intro-finish');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const previousScrollRestoration = history.scrollRestoration;
  let finished = false;
  let hasPlayed = false;
  let state = 'loading';
  let slowTimer;
  let frameRequest;
  let playAttempt = 0;
  let download;
  let assetUrl;
  let wantPlayback = !reducedMotion;
  let nativeSource = false;
  const videoUrl = new URL('intro-video.mp4', document.baseURI).href;

  history.scrollRestoration = 'manual';
  main.inert = true;
  main.setAttribute('aria-hidden', 'true');
  mobileNav.inert = true;
  video.muted = true;
  video.defaultMuted = true;

  function cancelFrame() {
    if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
    frameRequest = undefined;
  }

  function showLoader(nextState, title, message) {
    // This is a one-way reveal: the full-screen loader can never return.
    if (finished || hasPlayed) return;
    cancelFrame();
    clearTimeout(slowTimer);
    state = nextState;
    hero.dataset.introState = nextState;
    loader.dataset.state = nextState;
    loader.hidden = false;
    loader.setAttribute('aria-busy', String(nextState === 'loading'));
    status.textContent = title;
    detail.textContent = message;
    playButton.hidden = nextState !== 'blocked';
    retryButton.hidden = nextState !== 'error';
    continueButton.hidden = nextState !== 'error';

    if (nextState === 'loading') {
      // A slow connection never counts as a completed intro.
      slowTimer = setTimeout(() => {
        detail.textContent = 'Still loading. Thanks for your patience.';
        retryButton.hidden = false;
        // Some mobile browsers need a gesture before buffering native video.
        if (nativeSource) playButton.hidden = false;
      }, 12000);
    }
  }

  function showPlayback() {
    if (finished || document.hidden || video.paused || video.readyState < 2) return;
    clearTimeout(slowTimer);
    state = 'playing';
    hasPlayed = true;
    hero.dataset.introState = state;
    loader.hidden = true;
    loader.setAttribute('aria-busy', 'false');
    playbackControls.hidden = true;
  }

  function handlePlaying() {
    if (finished) {
      video.pause();
      return;
    }
    cancelFrame();
    // Keep the loading screen until a decoded frame is actually presented.
    if ('requestVideoFrameCallback' in video) {
      frameRequest = video.requestVideoFrameCallback(() => {
        frameRequest = undefined;
        showPlayback();
      });
    } else {
      showPlayback();
    }
  }

  function showPlaybackControls(failed = false) {
    if (finished) return;
    clearTimeout(slowTimer);
    state = failed ? 'error' : 'blocked';
    playbackStatus.textContent = failed ? 'The intro couldn’t finish playing.' : 'Press play to continue the intro.';
    finishButton.hidden = !failed;
    playbackControls.hidden = false;
  }

  function showError() {
    if (finished) return;
    if (hasPlayed) showPlaybackControls(true);
    else if (assetUrl && !nativeSource) useNativeVideo(videoUrl);
    else showLoader('error', 'The intro couldn’t load.', 'Try again, or head straight to the projects.');
  }

  function releaseSource() {
    if (assetUrl && !nativeSource) URL.revokeObjectURL(assetUrl);
    assetUrl = undefined;
  }

  function useNativeVideo(url) {
    ++playAttempt;
    releaseSource();
    nativeSource = true;
    assetUrl = url;
    video.src = url;
    video.load();
  }

  function nativeVideoReady() {
    if (!nativeSource || !wantPlayback || finished || hasPlayed || !video.paused || state === 'blocked' || state === 'error') return;
    // Keep the same steady loader until the entire short native clip is buffered.
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || video.readyState < 2) return;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= duration - 0.01) {
        tryPlay();
        break;
      }
    }
  }

  async function prepareVideo(nextDownload) {
    download?.controller.abort();
    download = nextDownload;
    const result = await nextDownload.promise;
    if (finished || download !== nextDownload) return;
    if (result.nativeUrl || result.error) {
      useNativeVideo(result.nativeUrl || videoUrl);
      return;
    }
    releaseSource();
    nativeSource = false;
    // All bytes are local before play(): no partial-download flash or rebuffering.
    assetUrl = URL.createObjectURL(result.blob);
    video.src = assetUrl;
    window.introDownload = null;
    if (wantPlayback) tryPlay();
  }

  function tryPlay() {
    if (finished || document.hidden) return;
    wantPlayback = true;
    if (!hasPlayed) showLoader('loading', 'Loading the intro.', 'A little motion before the projects.');
    if (!assetUrl) return;
    const attempt = ++playAttempt;
    playbackControls.hidden = true;
    video.play().catch(error => {
      if (finished || attempt !== playAttempt || document.hidden) return;
      if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
        if (hasPlayed) showPlaybackControls();
        else showLoader('blocked', 'Your intro is ready.', 'Press play to begin.');
      } else {
        showError();
      }
    });
  }

  function scheduleProjectReveal() {
    let cancelled = false;
    let centerTimer;
    const controller = new AbortController();
    const cancel = () => {
      cancelled = true;
      clearTimeout(scrollTimer);
      clearTimeout(centerTimer);
      controller.abort();
    };
    ['pointerdown', 'wheel', 'touchstart', 'keydown', 'hashchange'].forEach(type => {
      window.addEventListener(type, cancel, { passive: true, signal: controller.signal });
    });
    document.addEventListener('visibilitychange', cancel, { signal: controller.signal });
    const scrollTimer = setTimeout(() => {
      if (cancelled || document.hidden || window.scrollY > 20 || document.body.dataset.projectIndexUsed) {
        cancel();
        return;
      }
      const first = document.getElementById('project-1');
      const firstMedia = first?.querySelector('.project-images');
      first?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      centerTimer = setTimeout(() => {
        if (!cancelled && matchMedia('(min-width: 861px)').matches && firstMedia) {
          const rect = firstMedia.getBoundingClientRect();
          const targetTop = Math.max(88, (window.innerHeight - rect.height) / 2);
          window.scrollBy({ top: rect.top - targetTop, behavior: 'smooth' });
        }
        controller.abort();
      }, 650);
    }, 3600);
  }

  function finish(playedIntro) {
    if (finished) return;
    finished = true;
    ++playAttempt;
    clearTimeout(slowTimer);
    cancelFrame();
    video.pause();
    video.classList.add('frozen');
    hero.dataset.introState = playedIntro ? 'complete' : 'unavailable';
    const loaderHadFocus = loader.contains(document.activeElement) || playbackControls.contains(document.activeElement);
    loader.hidden = true;
    playbackControls.hidden = true;
    main.inert = false;
    main.removeAttribute('aria-hidden');
    mobileNav.inert = false;
    root.classList.remove('intro-pending');
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    history.scrollRestoration = previousScrollRestoration;
    onComplete();

    if (loaderHadFocus) {
      const title = document.querySelector('.hero-title');
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }

    // Honor incoming project links after the intro, never in place of it.
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (_) { /* Invalid fragment. */ }
    if (target && target !== hero) {
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
    } else if (playedIntro && !reducedMotion) {
      scheduleProjectReveal();
    }
  }

  video.addEventListener('playing', handlePlaying);
  ['progress', 'loadeddata', 'canplaythrough', 'durationchange'].forEach(type => {
    video.addEventListener(type, nativeVideoReady);
  });
  video.addEventListener('waiting', () => {
    if (finished || !hasPlayed) return;
    // Retain the last frame if the decoder stalls; never cover it with loading UI.
    if (state === 'playing') {
      state = 'buffering';
      clearTimeout(slowTimer);
      slowTimer = setTimeout(() => showPlaybackControls(), 12000);
    }
  });
  video.addEventListener('error', showError);
  video.addEventListener('ended', () => {
    if (hasPlayed && !document.hidden) finish(true);
  });
  video.addEventListener('pause', () => {
    if (!finished && !video.ended && !document.hidden && hasPlayed && state !== 'error') {
      showPlaybackControls();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (finished) return;
    if (document.hidden) {
      ++playAttempt;
      cancelFrame();
      video.pause();
    } else if (video.ended && hasPlayed) {
      finish(true);
    } else if (state !== 'blocked' && state !== 'error') {
      tryPlay();
    }
  });
  playButton.addEventListener('click', tryPlay);
  retryButton.addEventListener('click', () => {
    ++playAttempt;
    wantPlayback = true;
    releaseSource();
    nativeSource = false;
    showLoader('loading', 'Loading the intro.', 'A little motion before the projects.');
    prepareVideo(downloadIntroVideo(true));
  });
  resumeButton.addEventListener('click', () => {
    if (video.error) video.load();
    tryPlay();
  });
  finishButton.addEventListener('click', () => finish(false));
  // Only an actual media/playback error exposes this explicit escape hatch.
  continueButton.addEventListener('click', () => finish(false));

  if (reducedMotion) {
    showLoader('blocked', 'Start with a little motion.', 'Press play when you’re ready for the intro.');
  } else {
    showLoader('loading', 'Loading the intro.', 'A little motion before the projects.');
  }
  prepareVideo(window.introDownload || downloadIntroVideo());
}
