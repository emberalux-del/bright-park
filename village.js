(function () {
  'use strict';

  window.createBrightParkVillage = function (container, active) {
    const T = window.THREE;
    if (!T) return null;

    let renderer;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    } catch {
      return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    const canvas = renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    container.prepend(canvas);

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(41, 1, .1, 145);
    camera.position.set(12.5, 11.8, 25);
    camera.lookAt(0, 3.1, -7);
    scene.fog = new T.FogExp2(0xe7dccf, .028);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const hemi = new T.HemisphereLight(0xe6edff, 0x9a8268, 2);
    const sun = new T.DirectionalLight(0xffddad, 2);
    sun.position.set(-13, 15, 9);
    scene.add(hemi, sun);

    const sky = new T.ShaderMaterial({
      uniforms: { zenith: { value: new T.Color() }, horizon: { value: new T.Color() } },
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 p; void main(){p=uv; gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: [
        'varying vec2 p; uniform vec3 zenith, horizon;',
        'void main(){',
        '  float h=smoothstep(0.,1.,p.y);',
        '  float glow=exp(-length((p-vec2(.19,.55))*vec2(2.8,2.2))*4.);',
        '  gl_FragColor=vec4(mix(horizon,zenith,h)+vec3(.17,.10,.045)*glow,1.);',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n'),
    });
    const skyPlane = new T.Mesh(new T.PlaneGeometry(2, 2), sky);
    skyPlane.frustumCulled = false;
    skyPlane.renderOrder = -1;
    scene.add(skyPlane);

    let seed = 4129;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const makeMaterial = (color, properties = {}) => new T.MeshStandardMaterial({ color, roughness: .86, ...properties });
    const concrete = makeMaterial(0xd7c6b3);
    const lawn = makeMaterial(0x718151);
    const asphalt = makeMaterial(0x444544);
    const roof = makeMaterial(0x353936);
    const siding = makeMaterial(0xb89979);
    const plaster = makeMaterial(0xdfceb3);
    const trim = makeMaterial(0xeee1cd);
    const fence = makeMaterial(0x343a35);
    const timber = makeMaterial(0x524039);
    const foliage = [0x4d6042, 0x64754c, 0x7d8a58].map(color => makeMaterial(color));
    const needles = makeMaterial(0x475d4f);
    const glass = makeMaterial(0x54656a, { roughness: .28, emissive: 0xffb85d, emissiveIntensity: 0 });
    const lamp = makeMaterial(0xead9bc, { emissive: 0xffae4d, emissiveIntensity: 0 });
    const snow = makeMaterial(0xf0f4ff, { transparent: true, opacity: 0, depthWrite: false });
    const plough = makeMaterial(0xd18b31);
    const tyre = makeMaterial(0x262a29);

    const cube = new T.BoxGeometry(1, 1, 1);
    const cone = new T.ConeGeometry(1, 1, 8);
    const ball = new T.IcosahedronGeometry(1, 1);
    const cylinder = new T.CylinderGeometry(1, 1, 1, 8);
    const batches = new Map();
    const cursor = new T.Object3D();

    function piece(geometry, material, x, y, z, sx, sy, sz, rotation = 0) {
      cursor.position.set(x, y, z);
      cursor.rotation.set(0, rotation, 0);
      cursor.scale.set(sx, sy, sz);
      cursor.updateMatrix();
      const key = geometry.id + ':' + material.id;
      if (!batches.has(key)) batches.set(key, { geometry, material, matrices: [] });
      batches.get(key).matrices.push(cursor.matrix.clone());
    }
    const box = (material, ...args) => piece(cube, material, ...args);

    const roofShape = new T.Shape();
    roofShape.moveTo(-.5, 0);
    roofShape.lineTo(0, 1);
    roofShape.lineTo(.5, 0);
    roofShape.closePath();
    const roofGeometry = new T.ExtrudeGeometry(roofShape, { bevelEnabled: false, depth: 1 });
    roofGeometry.translate(0, 0, -.5);

    // Ground contact shadows are drawn once and reused by the houses, trees and truck.
    const shadowImage = document.createElement('canvas');
    shadowImage.width = shadowImage.height = 64;
    const shadowContext = shadowImage.getContext('2d');
    const shade = shadowContext.createRadialGradient(32, 32, 3, 32, 32, 32);
    shade.addColorStop(0, 'rgba(34,30,23,.46)');
    shade.addColorStop(.53, 'rgba(34,30,23,.24)');
    shade.addColorStop(1, 'rgba(34,30,23,0)');
    shadowContext.fillStyle = shade;
    shadowContext.fillRect(0, 0, 64, 64);
    const shadowMap = new T.CanvasTexture(shadowImage);
    shadowMap.colorSpace = T.SRGBColorSpace;
    const shadowMat = new T.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false });
    const shadowGeometry = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    function shadow(x, z, width, depth, y = .017) {
      piece(shadowGeometry, shadowMat, x, y, z, width, 1, depth);
    }
    function tree(x, z, size, evergreen) {
      piece(cylinder, timber, x, size * .46, z, size * .055, size * .9, size * .055);
      if (evergreen) {
        for (let layer = 0; layer < 3; layer++) {
          const w = size * (.43 - .086 * layer), y = size * (.65 + .29 * layer);
          piece(cone, needles, x, y, z, w, size * .74, w, layer * .2);
          piece(cone, snow, x, y + .083 * size, z, w * .72, size * .625, w * .72, layer * .2);
        }
      } else {
        for (let cluster = 0; cluster < 5; cluster++) {
          const angle = cluster * 2.4;
          piece(ball, foliage[cluster % 3], x + Math.cos(angle) * size * .18,
            size * (1.09 + .16 * (cluster % 3)), z + Math.sin(angle) * size * .18,
            size * .45, size * .47, size * .40);
        }
      }
      shadow(x + .5, z + .2, size * 2.2, size * 1.8);
    }
    function windowBay(x, y, z, width, height) {
      box(fence, x, y, z, width, height, .11);
      box(glass, x, y, z + .061, width - .11, height - .1, .026);
      box(trim, x, y, z + .087, .026, height - .1, .024);
      box(trim, x, y - height / 2, z + .063, width + .12, .04, .13);
    }
    function house(x, z, width, depth, variant) {
      const y = 1.8, facade = z + depth / 2;
      shadow(x + .85, z + .48, width * 1.85, depth * 1.6);
      box(concrete, x, .14, z, width + .12, .27, depth + .12);
      box(variant % 3 === 1 ? siding : plaster, x, y / 2 + .24, z, width, y, depth);
      box(trim, x, 2.02, z, width + .37, .12, depth + .35);
      piece(roofGeometry, roof, x, 2.07, z, width + .44, 1.46, depth + .43);
      piece(roofGeometry, snow, x, 2.12, z, width + .37, 1.47, depth + .36);
      box(timber, x + width * .26, 2.86, z - depth * .12, .30, 1, .35);
      box(fence, x + width * .26, 3.37, z - depth * .12, .40, .095, .44);
      box(timber, x, .77, facade + .085, .83, 1.2, .17);
      box(trim, x, .16, facade + .36, 1.39, .19, .64);
      box(roof, x, 1.51, facade + .31, 1.6, .11, .75);
      for (const side of [-1, 1]) {
        windowBay(x + side * width * .29, 1.11, facade, width * .25, .86);
        const sideX = x + side * (width / 2 + .05);
        box(fence, sideX, 1.12, z + .28, .12, .83, 1.10);
        box(glass, sideX + side * .069, 1.12, z + .28, .024, .72, .99);
      }
      box(concrete, x, .029, facade + 1.4, .95, .045, 2.4);
      for (let j = 0; j < 4; j++) {
        const a = j * 1.9;
        piece(ball, foliage[j % 3], x + width * .34 + Math.cos(a) * .65, .26,
          facade + .78 + Math.sin(a) * .30, .38, .35, .32);
      }
    }
    function streetLamp(x, z) {
      piece(cylinder, fence, x, 1.35, z, .048, 2.70, .048);
      box(fence, x + .19, 2.66, z, .43, .055, .09);
      box(lamp, x + .36, 2.62, z, .29, .056, .128);
    }

    box(lawn, 0, -.23, -22, 112, .45, 127);
    box(asphalt, 0, .001, -25, 7.2, .035, 105);
    box(asphalt, 0, .003, 11.6, 70, .037, 4.4);
    for (const side of [-1, 1]) {
      box(concrete, side * 4.06, .035, -25, .86, .10, 105);
      for (let i = 0; i < 5; i++) {
        const z = 4.6 - 9.2 * i + (side === 1 ? -3.6 : 1);
        const x = side * (8.1 + random() * .75);
        house(x, z, 5.25 + random() * .52, 4.55, i + (side === 1 ? 1 : 0));
        streetLamp(side * 3.8, z + 2.9);
        tree(side * (5.3 + random() * .54), z + 2.75, 1.25 + random() * .53, i % 2 === 0);
        tree(side * (11.9 + random() * 1.4), z + 1.5, 1.8 + random() * .7, true);
        for (let j = 0; j < 3; j++) {
          const fz = z - 2.5 + j * .86;
          box(fence, side * 4.87, .35, fz, .07, .69, .05);
          box(fence, side * 4.87, .43, fz + .39, .045, .13, .86);
        }
      }
      for (let i = 0; i < 37; i++) {
        const z = 8.2 - i * 1.72;
        const x = side * (3.32 + random() * .20);
        piece(ball, snow, x, .015, z, .34 + random() * .18, .16 + random() * .08, .75 + random() * .35);
      }
    }
    for (let i = 0; i < 24; i++) {
      tree((random() - .5) * 96, -36 - random() * 27, 1.8 + random() * 3.9, i % 3 !== 1);
    }
    for (const {geometry, material, matrices} of batches.values()) {
      const mesh = new T.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }

    const truck = new T.Group();
    function truckPart(geometry, material, x, y, z, sx, sy, sz) {
      const mesh = new T.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      truck.add(mesh);
      return mesh;
    }
    truckPart(cube, plough, 0, .55, 0, .97, .39, 1.62);
    truckPart(cube, plough, 0, .87, .48, .88, .87, .63);
    truckPart(cube, glass, 0, 1.02, .813, .74, .34, .026);
    truckPart(cube, plough, 0, .28, 1.035, 1.27, .25, .13).rotation.y = -.25;
    truckPart(cube, lamp, 0, 1.31, .46, .19, .12, .19);
    for (const x of [-.46, .46]) {
      for (const z of [-.46, .54]) {
        truckPart(cylinder, tyre, x, .23, z, .23, .14, .23).rotation.z = Math.PI / 2;
      }
      truckPart(cube, lamp, x * .84, .54, .85, .12, .11, .06);
    }
    const truckShadow = new T.Mesh(shadowGeometry, shadowMat);
    truckShadow.position.y = .027;
    truckShadow.scale.set(2.8, 1, 3.5);
    truck.add(truckShadow);
    truck.visible = false;
    scene.add(truck);

    const points = new Float32Array(135 * 3);
    for (let i = 0; i < points.length; i += 3) {
      points[i] = (random() - .5) * 30;
      points[i + 1] = random() * 16;
      points[i + 2] = 12 - random() * 44;
    }
    const flakeTextureCanvas = document.createElement('canvas');
    flakeTextureCanvas.width = flakeTextureCanvas.height = 32;
    const flakeContext = flakeTextureCanvas.getContext('2d');
    const flakeGradient = flakeContext.createRadialGradient(16,16,0,16,16,16);
    flakeGradient.addColorStop(0, 'rgba(255,255,255,.9)');
    flakeGradient.addColorStop(.4, 'rgba(255,255,255,.65)');
    flakeGradient.addColorStop(1, 'rgba(255,255,255,0)');
    flakeContext.fillStyle = flakeGradient;
    flakeContext.fillRect(0,0,32,32);
    const flakeGeometry = new T.BufferGeometry();
    flakeGeometry.setAttribute('position', new T.BufferAttribute(points, 3));
    const flakeMat = new T.PointsMaterial({
      map: new T.CanvasTexture(flakeTextureCanvas), color: 0xf5f5ff, size: .13,
      transparent: true, opacity: .72, depthWrite: false,
    });
    const flakes = new T.Points(flakeGeometry, flakeMat);
    flakes.frustumCulled = false;
    flakes.visible = false;
    scene.add(flakes);

    const palette = {
      summer: { top: 0xadcada, bottom: 0xe8ccb3, ground: 0x788450, road: 0x444640, snow: 0, night: 0 },
      evening: { top: 0x222d48, bottom: 0x8d6f6b, ground: 0x58664c, road: 0x3e444b, snow: 0, night: 1 },
      snowing: { top: 0xb9c6d3, bottom: 0xeee4dc, ground: 0xf1f5fb, road: 0xbac3cc, snow: 1, night: .08 },
      cleared: { top: 0xb1c5d7, bottom: 0xf2e0d2, ground: 0xeef2f6, road: 0x49535b, snow: 1, night: .02 },
      eveSnow: { top: 0x171f37, bottom: 0x626e84, ground: 0xc8d6e8, road: 0xa4b6cb, snow: 1, night: 1 },
      eveCleared: { top: 0x18233a, bottom: 0x756c7c, ground: 0xcfd9ec, road: 0x425166, snow: 1, night: 1 },
    };
    const colors = ['top', 'bottom', 'ground', 'road'];
    function copyLook(look) {
      return Object.fromEntries([...colors.map(key => [key, new T.Color(look[key])]), ['snow', look.snow], ['night', look.night]]);
    }
    let visual, target, transition = null, snowing = false;
    let truckStart = null;
    let frame = 0, lastDraw = 0, lost = false;

    function paint() {
      sky.uniforms.zenith.value.copy(visual.top);
      sky.uniforms.horizon.value.copy(visual.bottom);
      scene.fog.color.copy(visual.bottom);
      lawn.color.copy(visual.ground);
      asphalt.color.copy(visual.road);
      concrete.color.set(0xd7c6b3).lerp(new T.Color(0xc3cbd3), visual.snow * .62);
      // Fade only the thin snow shell, keeping the roof geometry solid.
      snow.visible = visual.snow > .004;
      for (const child of scene.children) if (child.material === snow) child.visible = snow.visible;
      snow.opacity = visual.snow;
      sun.intensity = 2.1 - 1.78 * visual.night;
      hemi.intensity = 1.85 - .95 * visual.night;
      hemi.color.set(0xe6edff).lerp(new T.Color(0x859cca), visual.night);
      glass.emissiveIntensity = 1.95 * visual.night;
      lamp.emissiveIntensity = 3.1 * visual.night;
    }
    function schedule() {
      if (!frame && !lost && visual && active()) frame = requestAnimationFrame(draw);
    }
    function draw(now) {
      frame = 0;
      if (lost || !active()) return;
      if (!transition && truckStart === null && snowing && lastDraw && now - lastDraw < 37) {
        schedule();
        return;
      }
      const elapsed = lastDraw ? Math.min(now - lastDraw, 100) : 0;
      lastDraw = now;
      if (transition) {
        const progress = motion.matches ? 1 : Math.min(1, (now - transition.start) / transition.duration);
        const t = progress * progress * (3 - 2 * progress);
        for (const key of colors) visual[key].copy(transition.from[key]).lerp(target[key], t);
        for (const key of ['snow', 'night']) visual[key] = T.MathUtils.lerp(transition.from[key], target[key], t);
        if (progress === 1) transition = null;
      }
      if (truckStart !== null) {
        const progress = (now - truckStart) / 2600;
        truck.visible = !motion.matches && progress < 1;
        truck.position.set(-1.3, 0, T.MathUtils.lerp(-22, 17, Math.min(1, progress)));
        if (!truck.visible) truckStart = null;
      }
      flakes.visible = snowing && !motion.matches;
      if (flakes.visible) {
        for (let i = 0; i < points.length; i += 3) {
          points[i] += elapsed * .0016;
          points[i + 1] -= elapsed * (.0015 + (i % 11) * .00016);
          if (points[i] > 15) points[i] = -15;
          if (points[i + 1] < .2) points[i + 1] = 16;
        }
        flakeGeometry.attributes.position.needsUpdate = true;
      }
      paint();
      renderer.render(scene, camera);
      container.classList.add('gl');
      if (transition || truckStart !== null || flakes.visible) schedule();
    }
    function resize() {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      schedule();
    }
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      lost = true;
      container.classList.remove('gl');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      lost = false;
      schedule();
    });
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('resize', resize);
    if (motion.addEventListener) motion.addEventListener('change', schedule);
    resize();

    return {
      show(state, mode) {
        if (!palette[state.img]) return;
        const next = copyLook(palette[state.img]);
        snowing = state.snow;
        const time = performance.now();
        if (!visual || motion.matches) {
          visual = copyLook(next);
          transition = null;
        } else if (state.img !== target?.image) {
          transition = { from: copyLook(visual), start: time, duration: mode === 'sweep' ? 1750 : 700 };
        }
        target = { ...next, image: state.img };
        if (mode === 'sweep' && !motion.matches) truckStart = time;
        schedule();
      },
      resize,
      sync: schedule,
    };
  };
})();
