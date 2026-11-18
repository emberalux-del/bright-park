(function () {
  'use strict';

  const SAMPLE_WIDTH = 560;
  const FACADE = [
    [62, 325], [186, 244], [282, 244], [326, 256], [337, 248],
    [476, 325], [463, 332], [460, 438], [436, 446], [83, 446], [78, 333],
  ];

  function inside(x, y) {
    let hit = false;
    for (let i = 0, j = FACADE.length - 1; i < FACADE.length; j = i++) {
      const [ax, ay] = FACADE[i];
      const [bx, by] = FACADE[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  }

  // Identical paths and sampling positions preserve the outline between seasons.
  function particlePositions() {
    let seed = 1249;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const result = [];
    for (let y = 245; y < 446; y += 3.55) {
      for (let x = 63; x < 476; x += 3.55) {
        const sx = x + random() * 1.7 - .85;
        const sy = y + random() * 1.7 - .85;
        if (!inside(sx, sy)) continue;
        result.push({
          x: sx - 268,
          y: sy - 346,
          pixel: (Math.round(sy) * SAMPLE_WIDTH + Math.round(sx)) * 4,
          fromX: (random() - .5) * 485,
          fromY: (random() - .5) * 300,
          delay: (446 - sy) / 202 * .19 + random() * .17,
          radius: .69 + random() * .61,
        });
      }
    }
    return result;
  }

  window.createBrightParkParticles = function (container, active) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const sample = document.createElement('canvas');
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    if (!context || !sampleContext) return null;

    sample.width = sample.height = SAMPLE_WIDTH;
    canvas.setAttribute('aria-hidden', 'true');
    container.prepend(canvas);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const images = new Map(Array.from(container.querySelectorAll('img[data-s]'), image => [image.dataset.s, image]));
    const palettes = new Map();
    const particles = particlePositions();
    let width = 0, height = 0, ratio = 1, viewScale = 1;
    let target = null, previous = null, current = null, requested = null;
    let start = 0, frame = 0, duration = 0;

    async function getPalette(key) {
      if (palettes.has(key)) return palettes.get(key);
      const image = images.get(key);
      if (!image) return null;
      if (!image.complete || !image.naturalWidth) await image.decode();
      sampleContext.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_WIDTH);
      const rgba = sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_WIDTH).data;
      const colors = new Uint8Array(particles.length * 3);
      particles.forEach((point, index) => {
        const { pixel } = point;
        // Raise the darkest roof pixels just enough to remain readable on black.
        for (let channel = 0; channel < 3; channel++) {
          const value = rgba[pixel + channel];
          colors[index * 3 + channel] = Math.min(255, Math.round(value * .91 + 22));
        }
      });
      palettes.set(key, colors);
      return colors;
    }

    const clamp = value => Math.max(0, Math.min(1, value));
    function assemblyProgress(elapsed, point) {
      const progress = clamp((elapsed - point.delay) / (1 - point.delay));
      return 1 - (1 - progress) ** 3;
    }

    function paint(time) {
      frame = 0;
      if (!target || !width || !height || !active()) return;
      const progress = duration && !reduce.matches ? clamp((time - start) / duration) : 1;
      const colorProgress = progress * progress * (3 - 2 * progress);

      context.fillStyle = '#080808';
      context.fillRect(0, 0, width, height);

      const ground = context.createRadialGradient(width * .50, height * .69, 0, width * .50, height * .69, width * .54);
      ground.addColorStop(0, 'rgba(205,162,106,.055)');
      ground.addColorStop(1, 'rgba(205,162,106,0)');
      context.fillStyle = ground;
      context.fillRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height * .555;
      particles.forEach((point, i) => {
        const motion = previous ? 1 : assemblyProgress(progress, point);
        const travel = 1 - motion;
        const x = centerX + (point.x * motion + point.fromX * travel) * viewScale;
        const y = centerY + (point.y * motion + point.fromY * travel) * viewScale;
        const size = (point.radius + .11 * motion) * viewScale * 2;
        const offset = i * 3;
        const mixed = channel => previous && progress < 1 ?
          Math.round(previous[offset + channel] + (target[offset + channel] - previous[offset + channel]) * colorProgress) :
          target[offset + channel];
        context.globalAlpha = .09 + .91 * motion;
        context.fillStyle = 'rgb(' + mixed(0) + ',' + mixed(1) + ',' + mixed(2) + ')';
        context.fillRect(x - size / 2, y - size / 2, size, size);
      });
      context.globalAlpha = 1;

      container.classList.add('particles-ready');
      if (progress < 1) {
        schedule();
      } else {
        current = target;
        previous = target;
        duration = 0;
      }
    }

    function schedule() {
      if (!frame && target && active()) frame = requestAnimationFrame(paint);
    }

    function resize() {
      width = container.clientWidth;
      height = container.clientHeight;
      if (!width || !height) return;
      ratio = Math.min(window.devicePixelRatio || 1, 1.75);
      viewScale = Math.min(width * .84 / 414, height * .5 / 202);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      schedule();
    }

    document.addEventListener('visibilitychange', schedule);
    if (reduce.addEventListener) reduce.addEventListener('change', schedule);
    resize();

    return {
      async show(state) {
        if (requested === state.img) return;
        requested = state.img;
        let palette;
        try { palette = await getPalette(state.img); }
        catch {
          if (requested === state.img) {
            requested = null;
            if (!target) container.classList.remove('particles-ready');
          }
          return;
        }
        if (!palette || requested !== state.img) return;
        // If a season changes mid-transition, continue from the displayed colours.
        if (previous && target && duration) {
          const p = reduce.matches ? 1 : clamp((performance.now() - start) / duration);
          const t = p * p * (3 - 2 * p);
          current = previous.map((value, i) => Math.round(value + (target[i] - value) * t));
        }
        previous = current;
        target = palette;
        start = performance.now();
        duration = previous ? 320 : 1180;
        schedule();
      },
      resize,
      sync: schedule,
    };
  };
})();
