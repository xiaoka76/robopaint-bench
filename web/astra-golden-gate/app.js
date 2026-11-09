/* =========================================================================
   Astra · Golden Gate Bridge — painting-process reconstruction
   -------------------------------------------------------------------------
   The action positions, durations and palette choices come from the published
   GPT-6 Astra record (see data.js / README.md); the recorded final canvases
   are kept as references only. The painting itself is approximated in the
   browser by depositing Canvas 2D brush dabs along the recorded trajectories,
   with the dab width driven by the recorded brush height (z).

   Coordinate mapping
   ------------------
   The task record uses Unity-style metres (x right, y away, z up). The plane
   we see here is (x, z, -y). The recorded waypoints are the brush tip; the
   paper surface is at TIP_Z = 0.065 in the record. We therefore place the
   paper at PAPER_Y and map tip height as (z - 0.065) + PAPER_Y.
   ========================================================================= */
(() => {
  'use strict';

  const DATA = window.ASTRA_GOLDEN_GATE;
  if (!DATA) {
    document.getElementById('loading').innerHTML = '<div class="loading-inner"><p>数据未加载</p><span>data.js missing</span></div>';
    return;
  }

  /* ---------------------------------------------------------------------
     0. Constants and tiny helpers
     --------------------------------------------------------------------- */
  const CANVAS = DATA.meta.canvas;
  const CW = CANVAS.x1 - CANVAS.x0;
  const CH = CANVAS.y0 - CANVAS.y1;
  const PAPER_Y = 0.0042;
  const TIP_Z = 0.065;
  const CONTACT_Z = 0.102;
  const CLASS_ORDER = ['lightblue', 'blue', 'green', 'orange', 'red', 'dark', 'white'];
  const CLASS_INDEX = Object.fromEntries(CLASS_ORDER.map((id, i) => [id, i]));
  const PHASE_LABEL = {
    sky: '天空', water: '水面', land: '山丘', bridge: '桥体',
    foreground: '前景', detail: '细节', submit: '提交',
  };
  const FALLBACK_CLASS = { black: 'dark', purple: 'blue', brightred: 'red' };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const fmtTime = (s) => {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  };
  const fmtDuration = (s) => {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  };
  const $ = (id) => document.getElementById(id);

  const PALETTE = DATA.palette.map((p) => ({
    ...p,
    color: new THREE.Color(p.hex),
    hex: p.hex,
  }));
  const PAL_BY_ID = Object.fromEntries(PALETTE.map((p) => [p.id, p]));
  const USED_WELLS = PALETTE.filter((p) => p.used);

  function wellClass(well) {
    if (well.used) return CLASS_INDEX[well.id];
    return CLASS_INDEX[FALLBACK_CLASS[well.id] || 'dark'];
  }

  function nearestWell(x, y) {
    let best = null;
    let bd = Infinity;
    for (const w of PALETTE) {
      const d = (w.well[0] - x) ** 2 + (w.well[1] - y) ** 2;
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  function nearestUsedWell(x, y) {
    let best = null;
    let bd = Infinity;
    for (const w of USED_WELLS) {
      const d = (w.well[0] - x) ** 2 + (w.well[1] - y) ** 2;
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  /* Width of a paint deposit as a function of the recorded brush height.
     Lower z means the brush is pressed closer to the paper, so the deposit is
     wider; lifting the brush tapers it to a fine line. Calibrated against the
     recorded canvases: broad sky/water passes are ~40 px, fine hanger/cable
     work is ~7–9 px. Values are in painting pixels. */
  const WIDTH_TABLE = [
    [0.065, 43], [0.075, 40], [0.080, 34], [0.086, 26],
    [0.092, 19], [0.096, 15], [0.098, 13], [0.100, 10],
    [0.101, 8], [0.102, 0],
  ];
  function strokeWidthPx(z) {
    if (z <= WIDTH_TABLE[0][0]) return WIDTH_TABLE[0][1];
    if (z >= WIDTH_TABLE[WIDTH_TABLE.length - 1][0]) return 0;
    for (let i = 1; i < WIDTH_TABLE.length; i++) {
      const [z1, w1] = WIDTH_TABLE[i];
      const [z0, w0] = WIDTH_TABLE[i - 1];
      if (z <= z1) {
        const t = (z - z0) / (z1 - z0);
        return lerp(w0, w1, t);
      }
    }
    return 0;
  }

  /* ---------------------------------------------------------------------
     1. DOM refs
     --------------------------------------------------------------------- */
  const els = {
    canvas: $('scene'),
    loading: $('loading'),
    intro: $('intro'),
    hero: $('hero'),
    topStatus: $('top-status'),
    previewCard: $('preview-card'),
    previewFrame: $('preview-frame'),
    previewRound: $('preview-round'),
    previewColor: $('preview-color'),
    previewPct: $('preview-pct'),
    noteCard: $('note-card'),
    noteRound: $('note-round'),
    notePhase: $('note-phase'),
    noteCount: $('note-count'),
    noteZh: $('note-zh'),
    noteEn: $('note-en'),
    roundRail: $('round-rail'),
    roundBtns: [...document.querySelectorAll('.round-btn')],
    play: $('btn-play'),
    restart: $('btn-restart'),
    speed: $('btn-speed'),
    timeline: $('timeline'),
    timelineTicks: $('timeline-ticks'),
    timeCurrent: $('time-current'),
    timeTotal: $('time-total'),
    about: $('about-modal'),
    complete: $('complete-modal'),
    completeImg: $('complete-img'),
    completeRef: $('complete-ref'),
    completeRefClip: $('compare-ref-clip'),
    completeRange: $('compare-range'),
    completeHandle: $('compare-handle'),
    completeEyebrow: $('complete-eyebrow'),
    completeTitle: $('complete-title'),
    completeSub: $('complete-sub'),
    completeActions: $('complete-actions'),
    completeTime: $('complete-time'),
    completeNote: $('complete-note'),
    nextRound: $('btn-next-round'),
    replayRound: $('btn-replay-round'),
    completeDownload: $('complete-download'),
    camBtns: [...document.querySelectorAll('.cam-btn')],
    startFinal: $('btn-start-final'),
    startAll: $('btn-start-all'),
    aboutOpen: $('btn-about'),
  };

  /* ---------------------------------------------------------------------
     2. Three.js setup
     --------------------------------------------------------------------- */
  const renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x0b0d0e, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0e);
  scene.fog = new THREE.Fog(0x0b0d0e, 2.15, 5.4);

  const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.01, 20);
  camera.up.set(0, 1, 0);

  const previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x0d0f11);
  const previewCamera = new THREE.OrthographicCamera(-0.25, 0.25, 0.177, -0.177, 0.01, 10);
  previewCamera.position.set(0, 0, 1);
  previewCamera.lookAt(0, 0, 0);

  /* ---------------------------------------------------------------------
     3. Materials & small geometry helpers
     --------------------------------------------------------------------- */
  const MAT = {
    white: new THREE.MeshStandardMaterial({ color: 0xecebe5, roughness: 0.34, metalness: 0.05 }),
    whiteSoft: new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.5, metalness: 0.03 }),
    black: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.38, metalness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.52, metalness: 0.22 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x969793, roughness: 0.26, metalness: 0.82 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6a4a33, roughness: 0.48, metalness: 0.05 }),
    bristle: new THREE.MeshStandardMaterial({ color: 0x4b3728, roughness: 0.82, metalness: 0.0 }),
    table: null,
    paper: null,
    paint: {},
  };

  function makeCanvasTexture(size, draw, opts = {}) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    draw(ctx, size);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    return tex;
  }

  // A quiet tan work surface with a little tooth.
  MAT.table = new THREE.MeshStandardMaterial({
    map: makeCanvasTexture(512, (ctx, s) => {
      ctx.fillStyle = '#c9aa7d';
      ctx.fillRect(0, 0, s, s);
      const img = ctx.getImageData(0, 0, s, s);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * 12;
        d[i] = clamp(d[i] + n, 0, 255);
        d[i + 1] = clamp(d[i + 1] + n * 0.9, 0, 255);
        d[i + 2] = clamp(d[i + 2] + n * 0.8, 0, 255);
      }
      ctx.putImageData(img, 0, 0);
      ctx.globalAlpha = 0.045;
      ctx.strokeStyle = '#6e5437';
      for (let i = 0; i < 70; i++) {
        ctx.beginPath();
        const y = Math.random() * s;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(s * 0.3, y + (Math.random() - 0.5) * 9, s * 0.7, y + (Math.random() - 0.5) * 9, s, y + (Math.random() - 0.5) * 6);
        ctx.stroke();
      }
    }, { repeat: [2.4, 1.8] }),
    color: 0xffffff,
    roughness: 0.87,
    metalness: 0.015,
  });

  MAT.paper = new THREE.MeshStandardMaterial({
    map: makeCanvasTexture(512, (ctx, s) => {
      ctx.fillStyle = '#fbfaf3';
      ctx.fillRect(0, 0, s, s);
      ctx.globalAlpha = 0.035;
      for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? '#b8b2a3' : '#ffffff';
        ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
      }
    }, { repeat: [2, 2] }),
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
  });

  function addMesh(parent, geo, mat, pos, cast = true, receive = true) {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    m.castShadow = cast;
    m.receiveShadow = receive;
    parent.add(m);
    return m;
  }

  function addCyl(parent, rTop, rBottom, h, pos, mat, seg = 32) {
    return addMesh(parent, new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat, pos);
  }

  function addBox(parent, sx, sy, sz, pos, mat, rot) {
    const m = addMesh(parent, new THREE.BoxGeometry(sx, sy, sz), mat, pos);
    if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    return m;
  }

  function addSphere(parent, r, pos, mat, seg = 24) {
    return addMesh(parent, new THREE.SphereGeometry(r, seg, Math.max(12, seg / 2)), mat, pos);
  }

  function addCapsule(parent, r, length, pos, mat, seg = 24) {
    const cyl = Math.max(0.001, length - r * 2);
    const geo = new THREE.CapsuleGeometry(r, cyl, 8, seg);
    return addMesh(parent, geo, mat, pos);
  }

  /* ---------------------------------------------------------------------
     4. Stage: table, wall, window, paper
     --------------------------------------------------------------------- */
  const TABLE_CENTER = new THREE.Vector3(0.06, -0.0275, -0.43);
  const TABLE = new THREE.Mesh(new THREE.BoxGeometry(1.40, 0.055, 1.02), MAT.table);
  TABLE.position.copy(TABLE_CENTER);
  TABLE.castShadow = true;
  TABLE.receiveShadow = true;
  scene.add(TABLE);

  // A dark edge under the tabletop gives it weight.
  addBox(scene, 1.405, 0.006, 1.025, [0.06, -0.056, -0.43], MAT.black, null);

  // Back wall + window.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x24251f, roughness: 0.97, metalness: 0.0 });
  const wall = addMesh(scene, new THREE.PlaneGeometry(3.4, 1.8), wallMat, [0.02, 0.85, -1.06], false, true);
  addBox(scene, 3.4, 0.03, 0.04, [0.02, 0.015, -1.04], MAT.dark, null);

  const windowGroup = new THREE.Group();
  windowGroup.position.set(-0.70, 0.56, -1.045);
  scene.add(windowGroup);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x8b7253, roughness: 0.72, metalness: 0.02 });
  addBox(windowGroup, 0.66, 0.50, 0.035, [0, 0, 0], frameMat, null);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.60, 0.44),
    new THREE.MeshBasicMaterial({ color: 0xb9d6e6, toneMapped: false })
  );
  glass.position.set(0, 0, 0.022);
  windowGroup.add(glass);
  addBox(windowGroup, 0.022, 0.44, 0.022, [0, 0, 0.04], frameMat, null);
  addBox(windowGroup, 0.60, 0.022, 0.022, [0, 0.03, 0.04], frameMat, null);
  addBox(windowGroup, 0.74, 0.035, 0.10, [0, -0.265, 0.03], frameMat, null);
  // A soft window glow card behind the glass.
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.74, 0.54),
    new THREE.MeshBasicMaterial({ color: 0xdcebf2, transparent: true, opacity: 0.10, depthWrite: false })
  );
  glow.position.set(0, 0, 0.05);
  windowGroup.add(glow);

  // Paper stack: a slightly oversized backing sheet plus the painting plane.
  const paperCenter = new THREE.Vector3((CANVAS.x0 + CANVAS.x1) / 2, 0, -(CANVAS.y0 + CANVAS.y1) / 2);
  const backing = addMesh(
    scene,
    new THREE.PlaneGeometry(CW + 0.020, CH + 0.020),
    MAT.paper,
    [paperCenter.x, 0.0024, paperCenter.z],
    false,
    true
  );
  backing.rotation.x = -Math.PI / 2;

  const canvasGeo = new THREE.PlaneGeometry(CW, CH);
  const canvasMesh = new THREE.Mesh(canvasGeo, null);
  canvasMesh.rotation.x = -Math.PI / 2;
  canvasMesh.position.set(paperCenter.x, 0.0036, paperCenter.z);
  canvasMesh.receiveShadow = false;
  scene.add(canvasMesh);

  // Shadow-only overlay: the painting is unlit, so let the arm cast a
  // real shadow onto a transparent plane just above the paper.
  const shadowMat = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.055, transparent: true, depthWrite: false });
  const shadowPlane = new THREE.Mesh(canvasGeo, shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.set(paperCenter.x, 0.00385, paperCenter.z);
  shadowPlane.receiveShadow = true;
  shadowPlane.castShadow = false;
  scene.add(shadowPlane);

  /* ---------------------------------------------------------------------
     5. Palette wells
     --------------------------------------------------------------------- */
  const wellMeshes = [];
  const paletteGroup = new THREE.Group();
  scene.add(paletteGroup);
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xf0eee7, roughness: 0.3, metalness: 0.02 });
  const ceramicInner = new THREE.MeshStandardMaterial({ color: 0x9c988e, roughness: 0.55, metalness: 0.05 });
  const wellShadow = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.20, depthWrite: false });

  for (const p of PALETTE) {
    const g = new THREE.Group();
    g.position.set(p.well[0], 0, -p.well[1]);
    paletteGroup.add(g);

    addCyl(g, 0.0205, 0.0220, 0.013, [0, 0.0065, 0], ceramic, 40);
    addCyl(g, 0.0175, 0.0175, 0.011, [0, 0.0115, 0], ceramicInner, 40);
    // paint surface
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: p.color,
      roughness: 0.28,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
    });
    MAT.paint[p.id] = paintMat;
    const disc = addMesh(g, new THREE.CircleGeometry(0.0162, 40), paintMat, [0, 0.0172, 0], false, true);
    disc.rotation.x = -Math.PI / 2;
    // rim and inner shade
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.0158, 0.0181, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.20, side: THREE.DoubleSide, depthWrite: false })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.0177;
    g.add(rim);
    const shade = new THREE.Mesh(
      new THREE.RingGeometry(0.0138, 0.0178, 40),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false })
    );
    shade.rotation.x = -Math.PI / 2;
    shade.position.y = 0.0173;
    g.add(shade);
    // contact shadow
    const cs = new THREE.Mesh(new THREE.CircleGeometry(0.027, 32), wellShadow);
    cs.rotation.x = -Math.PI / 2;
    cs.position.y = 0.0006;
    g.add(cs);

    wellMeshes.push({ palette: p, group: g });
  }

  /* ---------------------------------------------------------------------
     6. Lighting
     --------------------------------------------------------------------- */
  scene.add(new THREE.HemisphereLight(0xcfe0ee, 0x5a4632, 0.62));

  const key = new THREE.DirectionalLight(0xfff1dc, 2.35);
  key.position.set(-0.95, 1.85, 0.85);
  key.target.position.set(0.08, 0, -0.42);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -1.15;
  key.shadow.camera.right = 1.15;
  key.shadow.camera.top = 1.0;
  key.shadow.camera.bottom = -0.85;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 3.4;
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.014;
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.75);
  fill.position.set(1.3, 0.85, -0.75);
  fill.target.position.set(0.0, 0, -0.45);
  scene.add(fill);
  scene.add(fill.target);

  const rim = new THREE.DirectionalLight(0xffe7c6, 0.55);
  rim.position.set(0.4, 0.7, 1.2);
  rim.target.position.set(0.05, 0.03, -0.45);
  scene.add(rim);
  scene.add(rim.target);

  // Subtle dust in the air.
  const dustGeo = new THREE.BufferGeometry();
  const dustCount = 110;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 1.5;
    dustPos[i * 3 + 1] = 0.08 + Math.random() * 0.55;
    dustPos[i * 3 + 2] = -0.95 + Math.random() * 1.0;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({ color: 0xfff2dc, size: 0.0022, transparent: true, opacity: 0.28, depthWrite: false, sizeAttenuation: true })
  );
  scene.add(dust);

  /* ---------------------------------------------------------------------
     7. Panda arm
     --------------------------------------------------------------------- */
  const BRUSH_DIR = new THREE.Vector3(0.13, -0.985, -0.11).normalize();
  const HANDLE_UP = BRUSH_DIR.clone().negate();
  const HAND_QUAT = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), HANDLE_UP);
  const BRUSH_LEN = 0.085;

  class PandaArm {
    constructor() {
      this.base = new THREE.Vector3(0.46, 0, -0.205);
      this.L1 = 0.42;
      this.L2 = 0.40;
      this.shoulderY = 0.16;

      this.root = new THREE.Group();
      this.root.position.copy(this.base);
      scene.add(this.root);

      // base plate / column
      addCyl(this.root, 0.096, 0.100, 0.022, [0, 0.011, 0], MAT.black, 48);
      addCyl(this.root, 0.063, 0.071, 0.030, [0, 0.033, 0], MAT.dark, 40);
      addCyl(this.root, 0.050, 0.056, 0.075, [0, 0.078, 0], MAT.white, 40);
      addCyl(this.root, 0.054, 0.054, 0.012, [0, 0.118, 0], MAT.black, 40);
      // small base bolts
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        addCyl(this.root, 0.007, 0.007, 0.006, [Math.cos(a) * 0.083, 0.026, Math.sin(a) * 0.083], MAT.steel, 12);
      }

      this.yaw = new THREE.Group();
      this.yaw.position.set(0, 0.10, 0);
      this.root.add(this.yaw);

      // shoulder joint
      this.shoulder = new THREE.Group();
      this.shoulder.position.set(0, 0.06, 0);
      this.yaw.add(this.shoulder);
      addCyl(this.shoulder, 0.046, 0.046, 0.078, [0, 0, 0], MAT.black, 32).rotation.z = Math.PI / 2;
      addSphere(this.shoulder, 0.047, [0, 0, 0], MAT.dark, 24);
      addBox(this.shoulder, 0.088, 0.062, 0.088, [0, 0.014, 0], MAT.white, [0.1, 0, 0]);

      // upper arm
      this.upper = new THREE.Group();
      this.shoulder.add(this.upper);
      addCapsule(this.upper, 0.033, this.L1, [0, this.L1 / 2, 0], MAT.white, 24);
      addCyl(this.upper, 0.036, 0.036, 0.012, [0, 0.06, 0], MAT.black, 28);
      addCyl(this.upper, 0.036, 0.036, 0.010, [0, this.L1 - 0.055, 0], MAT.black, 28);
      addBox(this.upper, 0.017, 0.20, 0.044, [0.034, 0.22, 0], MAT.whiteSoft, null);
      addBox(this.upper, 0.012, 0.14, 0.028, [-0.036, 0.25, 0], MAT.dark, null);

      // elbow
      this.elbow = new THREE.Group();
      this.elbow.position.set(0, this.L1, 0);
      this.upper.add(this.elbow);
      addCyl(this.elbow, 0.043, 0.043, 0.074, [0, 0, 0], MAT.black, 32).rotation.z = Math.PI / 2;
      addSphere(this.elbow, 0.041, [0, 0, 0], MAT.dark, 24);

      // forearm: this group is stretched if the recorded point is just out of
      // the nominal reach, so the brush tip can stay exactly on the path.
      this.forearm = new THREE.Group();
      this.elbow.add(this.forearm);
      this.forearmScale = new THREE.Group();
      this.forearm.add(this.forearmScale);
      addCapsule(this.forearmScale, 0.030, this.L2, [0, this.L2 / 2, 0], MAT.white, 24);
      addCyl(this.forearmScale, 0.033, 0.033, 0.012, [0, this.L2 * 0.22, 0], MAT.black, 28);
      addCyl(this.forearmScale, 0.033, 0.033, 0.010, [0, this.L2 - 0.045, 0], MAT.black, 28);
      addBox(this.forearmScale, 0.014, 0.16, 0.034, [0.031, this.L2 * 0.52, 0], MAT.whiteSoft, null);

      // hand + brush (world-oriented, placed each frame)
      this.hand = new THREE.Group();
      this.hand.quaternion.copy(HAND_QUAT);
      scene.add(this.hand);

      addSphere(this.hand, 0.030, [0, 0.002, 0], MAT.black, 24);
      addBox(this.hand, 0.062, 0.026, 0.050, [0, -0.020, 0], MAT.dark, null);
      addBox(this.hand, 0.072, 0.016, 0.054, [0, -0.004, 0], MAT.white, null);
      // parallel fingers
      const fingerL = addBox(this.hand, 0.011, 0.052, 0.026, [-0.022, -0.041, 0.002], MAT.white, [0, 0, -0.06]);
      const fingerR = addBox(this.hand, 0.011, 0.052, 0.026, [0.022, -0.041, 0.002], MAT.white, [0, 0, 0.06]);
      fingerL.castShadow = fingerR.castShadow = true;
      addBox(this.hand, 0.044, 0.011, 0.022, [0, -0.061, 0.017], MAT.black, null);
      addBox(this.hand, 0.044, 0.011, 0.022, [0, -0.061, -0.017], MAT.black, null);

      // brush: local -Y is toward the paper tip
      addCyl(this.hand, 0.0058, 0.0062, 0.090, [0, -0.020, 0], MAT.wood, 16);
      addCyl(this.hand, 0.0072, 0.0072, 0.012, [0, -0.072, 0], MAT.steel, 16);
      addCyl(this.hand, 0.0062, 0.0010, 0.016, [0, -0.077, 0], MAT.bristle, 16);
      addSphere(this.hand, 0.0042, [0, -0.070, 0], MAT.bristle, 12);

      this.tipPaintMat = new THREE.MeshStandardMaterial({
        color: 0x4b3728, roughness: 0.34, metalness: 0.0,
        emissive: 0x000000, emissiveIntensity: 0.0,
      });
      this.tipPaint = addMesh(this.hand, new THREE.SphereGeometry(0.0026, 16, 12), this.tipPaintMat, [0, -0.0823, 0], false, false);
      this.tipPaint.visible = false;

      // state
      this.yawAngle = 0;
      this.theta1 = 0;
      this.theta2 = 0;
      this.stretch = 1;
      this.lastHand = new THREE.Vector3();
      this.initialized = false;
    }

    setTip(tip) {
      const hand = tip.clone().addScaledVector(HANDLE_UP, BRUSH_LEN);
      const dx = hand.x - this.base.x;
      const dz = hand.z - this.base.z;
      const yaw = Math.atan2(dx, dz);
      const horizontal = Math.hypot(dx, dz);
      const shoulderY = this.base.y + this.shoulderY;
      const vertical = hand.y - shoulderY;
      const dist = Math.hypot(horizontal, vertical);
      const reach = this.L1 + this.L2;

      let t1;
      let t2;
      if (dist >= reach - 1e-5) {
        // fully extended; the forearm stretches to bridge any remainder
        t1 = Math.atan2(horizontal, vertical);
        t2 = 0;
      } else {
        const R = Math.max(dist, Math.abs(this.L1 - this.L2) + 1e-4);
        const cos2 = clamp((R * R - this.L1 * this.L1 - this.L2 * this.L2) / (2 * this.L1 * this.L2), -1, 1);
        t2 = Math.acos(cos2);
        const phi = Math.atan2(horizontal, vertical);
        t1 = phi - Math.atan2(this.L2 * Math.sin(t2), this.L1 + this.L2 * Math.cos(t2));
      }

      // elbow position in the yaw plane (local z forward, local y up)
      const elbowZ = this.L1 * Math.sin(t1);
      const elbowY = this.L1 * Math.cos(t1);
      const toHandZ = horizontal - elbowZ;
      const toHandY = vertical - elbowY;
      const foreDist = Math.hypot(toHandZ, toHandY);
      const foreAngle = Math.atan2(toHandZ, toHandY);
      const stretch = clamp(foreDist / this.L2, 0.82, 1.16);

      // Smooth the yaw through the ±π wrap just once.
      if (!this.initialized) {
        this.yawAngle = yaw;
        this.initialized = true;
      } else {
        let d = yaw - this.yawAngle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yawAngle += d;
      }

      this.yaw.rotation.y = this.yawAngle;
      this.upper.rotation.x = t1;
      this.forearm.rotation.x = foreAngle - t1;
      this.forearmScale.scale.y = stretch;

      this.stretch = stretch;
      this.lastHand.copy(hand);
      this.hand.position.copy(hand);
      this.hand.quaternion.copy(HAND_QUAT);
    }

    setPaintColor(colorIndex) {
      if (colorIndex === null || colorIndex === undefined || colorIndex < 0) {
        this.tipPaint.visible = false;
        this.tipPaintMat.color.setHex(0x4b3728);
        this.tipPaintMat.emissive.setHex(0x000000);
        return;
      }
      const id = CLASS_ORDER[colorIndex];
      const p = PAL_BY_ID[id];
      this.tipPaint.visible = true;
      this.tipPaintMat.color.copy(p.color);
      this.tipPaintMat.emissive.copy(p.color).multiplyScalar(0.10);
    }
  }

  const arm = new PandaArm();

  /* ---------------------------------------------------------------------
     8. Canvas 2D paint surface
     ---------------------------------------------------------------------
     No recorded final pixels are used to paint the canvas. Every recorded
     waypoint becomes a brush dab on a 1024 x 725 Canvas 2D surface; the dab
     width is derived from the recorded brush height (z) through
     strokeWidthPx(). The surface is uploaded as a CanvasTexture and shared
     by the 3D paper and the flat LIVE CANVAS preview.
     --------------------------------------------------------------------- */
  const PAINT_W = 1024;
  const PAINT_H = 725;
  const PAINT_MARGIN = 6;
  const PAINT_CLIP_RADIUS = 11;
  const DAB_STEP = 1.15;

  const PAPER_X0 = CANVAS.x0;
  const PAPER_X1 = CANVAS.x1;
  const PAPER_Y0 = CANVAS.y0;
  const PAPER_Y1 = CANVAS.y1;

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function paperClipPath(ctx) {
    roundedRectPath(
      ctx,
      PAINT_MARGIN,
      PAINT_MARGIN,
      PAINT_W - PAINT_MARGIN * 2,
      PAINT_H - PAINT_MARGIN * 2,
      PAINT_CLIP_RADIUS
    );
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makePaperBase() {
    const c = document.createElement('canvas');
    c.width = PAINT_W;
    c.height = PAINT_H;
    const ctx = c.getContext('2d');
    const rnd = mulberry32(107);
    ctx.fillStyle = '#fbfaf3';
    ctx.fillRect(0, 0, PAINT_W, PAINT_H);

    const img = ctx.getImageData(0, 0, PAINT_W, PAINT_H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 2.6;
      const warm = (rnd() - 0.5) * 1.6;
      d[i] = clamp(d[i] + n + warm, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n - warm * 0.7, 0, 255);
    }
    ctx.putImageData(img, 0, 0);

    // Sparse paper fibres.
    for (let i = 0; i < 420; i++) {
      const x = rnd() * PAINT_W;
      const y = rnd() * PAINT_H;
      const len = 2 + rnd() * 15;
      const a = rnd() * Math.PI;
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(133,122,101,0.055)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 0.5 + rnd() * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }

    // Deckle edge: a very slightly uneven warm-grey rim.
    ctx.strokeStyle = 'rgba(147,134,111,0.20)';
    ctx.lineWidth = 1.1;
    roundedRectPath(ctx, 3.5, 3.5, PAINT_W - 7, PAINT_H - 7, 9);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    roundedRectPath(ctx, 5.5, 5.5, PAINT_W - 11, PAINT_H - 11, 8);
    ctx.stroke();

    return c;
  }

  const paperBase = makePaperBase();

  const paintCanvas = document.createElement('canvas');
  paintCanvas.width = PAINT_W;
  paintCanvas.height = PAINT_H;
  const paintCtx = paintCanvas.getContext('2d', { alpha: false, desynchronized: true });

  const paintTexture = new THREE.CanvasTexture(paintCanvas);
  paintTexture.colorSpace = THREE.SRGBColorSpace;
  paintTexture.flipY = true;
  paintTexture.minFilter = THREE.LinearMipmapLinearFilter;
  paintTexture.magFilter = THREE.LinearFilter;
  paintTexture.generateMipmaps = true;
  paintTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const canvasMaterial = new THREE.MeshBasicMaterial({
    map: paintTexture,
    color: 0xffffff,
    toneMapped: false,
    side: THREE.FrontSide,
  });

  let paintClipped = false;
  function resetPaint() {
    if (paintClipped) {
      paintCtx.restore();
      paintClipped = false;
    }
    paintCtx.setTransform(1, 0, 0, 1, 0, 0);
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    paintCtx.drawImage(paperBase, 0, 0);
    paintCtx.save();
    paperClipPath(paintCtx);
    paintCtx.clip();
    paintClipped = true;
    paintTexture.needsUpdate = true;
  }

  // ---- Brush stamps ------------------------------------------------------
  function makeBrushStamp(hex, variant) {
    const S = 128;
    const alpha = document.createElement('canvas');
    alpha.width = alpha.height = S;
    const a = alpha.getContext('2d');

    a.save();
    a.translate(S / 2, S / 2);
    a.scale(1, 0.62 + variant * 0.012);
    const g = a.createRadialGradient(0, 0, S * 0.08, 0, 0, S * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.52, 'rgba(255,255,255,0.99)');
    g.addColorStop(0.76, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.92, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    a.fillStyle = g;
    a.beginPath();
    a.arc(0, 0, S * 0.5, 0, Math.PI * 2);
    a.fill();
    a.restore();

    // Bristle grooves and a few dry spots.
    a.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 64; i++) {
      const x = Math.random() * S;
      const len = (0.36 + Math.random() * 0.52) * S;
      a.fillStyle = 'rgba(0,0,0,' + (0.008 + Math.random() * 0.05) + ')';
      a.fillRect(x, (S - len) / 2, 0.7 + Math.random() * 1.7, len);
    }
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = S * (0.37 + Math.random() * 0.12);
      const x = S / 2 + Math.cos(ang) * rad;
      const y = S / 2 + Math.sin(ang) * rad * 0.62;
      a.fillStyle = 'rgba(0,0,0,' + (0.04 + Math.random() * 0.10) + ')';
      a.beginPath();
      a.arc(x, y, 1 + Math.random() * 3.2, 0, Math.PI * 2);
      a.fill();
    }
    a.globalCompositeOperation = 'source-over';

    const out = document.createElement('canvas');
    out.width = out.height = S;
    const o = out.getContext('2d');
    o.drawImage(alpha, 0, 0);
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = hex;
    o.fillRect(0, 0, S, S);
    o.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 42; i++) {
      o.fillStyle = Math.random() > 0.5
        ? 'rgba(255,255,255,0.022)'
        : 'rgba(0,0,0,0.020)';
      o.fillRect(Math.random() * S, 0, 0.7 + Math.random() * 1.6, S);
    }
    return out;
  }

  const BRUSH_STAMPS = CLASS_ORDER.map((id) =>
    Array.from({ length: 5 }, (_, v) => makeBrushStamp(PAL_BY_ID[id].hex, v))
  );

  // ---- Dab deposition ----------------------------------------------------
  function paintPixel(x, y) {
    return [
      ((x - PAPER_X0) / CW) * PAINT_W,
      ((PAPER_Y0 - y) / CH) * PAINT_H,
    ];
  }

  function hash01(n) {
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }

  function drawPaintSegment(seg, f0, f1) {
    if (f1 - f0 < 1e-5) return;
    const x0 = lerp(seg.x0, seg.x1, f0);
    const y0 = lerp(seg.y0, seg.y1, f0);
    const z0 = lerp(seg.z0, seg.z1, f0);
    const x1 = lerp(seg.x0, seg.x1, f1);
    const y1 = lerp(seg.y0, seg.y1, f1);
    const z1 = lerp(seg.z0, seg.z1, f1);
    const [px0, py0] = paintPixel(x0, y0);
    const [px1, py1] = paintPixel(x1, y1);
    const w0 = strokeWidthPx(z0);
    const w1 = strokeWidthPx(z1);
    if (w0 <= 0.25 && w1 <= 0.25) return;

    const dist = Math.hypot(px1 - px0, py1 - py0);
    if (dist < 0.01) return;
    const steps = Math.max(1, Math.ceil(dist / DAB_STEP));
    const angle = Math.atan2(py1 - py0, px1 - px0);
    const stamps = BRUSH_STAMPS[seg.color] || BRUSH_STAMPS[0];
    const from = Math.max(0, Math.floor(f0 * steps) - 1);
    const to = Math.min(steps, Math.ceil(f1 * steps) + 1);
    const seed = seg.id * 1000003;

    for (let i = from; i <= to; i++) {
      const t = i / steps;
      const z = lerp(z0, z1, t);
      let w = lerp(w0, w1, t);
      if (w < 0.35) continue;
      const j1 = hash01(seed + i * 7);
      const j2 = hash01(seed + i * 7 + 1);
      const j3 = hash01(seed + i * 7 + 2);
      const j4 = hash01(seed + i * 7 + 3);
      w *= 0.955 + j1 * 0.09;
      const x = px0 + (px1 - px0) * t + (j2 - 0.5) * 0.85;
      const y = py0 + (py1 - py0) * t + (j3 - 0.5) * 0.85;
      const a = angle + (j4 - 0.5) * 0.07;
      const stamp = stamps[Math.floor(hash01(seed + i * 7 + 4) * stamps.length)];
      paintCtx.save();
      paintCtx.translate(x, y);
      paintCtx.rotate(a - Math.PI / 2);
      paintCtx.drawImage(stamp, -w / 2, -w / 2, w, w);
      paintCtx.restore();
    }
  }

  function redrawPaintTo(time) {
    resetPaint();
    for (const seg of state.round.segs) {
      if (seg.t0 >= time) break;
      const f1 = clamp((time - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0), 0, 1);
      drawPaintSegment(seg, 0, f1);
    }
    paintTexture.needsUpdate = true;
    state.lastDrawTime = time;
  }

  function advancePaintTo(prevTime, newTime) {
    let drew = false;
    for (const seg of state.round.segs) {
      if (seg.t0 >= newTime) break;
      if (seg.t1 <= prevTime) continue;
      const a = Math.max(seg.t0, prevTime);
      const b = Math.min(seg.t1, newTime);
      if (b <= a) continue;
      const f0 = (a - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0);
      const f1 = (b - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0);
      drawPaintSegment(seg, f0, f1);
      drew = true;
    }
    if (drew) paintTexture.needsUpdate = true;
  }

  resetPaint();
  canvasMesh.material = canvasMaterial;

  // Preview scene: a flat, orthographic view of the same paper/material.
  const previewBacking = new THREE.Mesh(
    new THREE.PlaneGeometry(CW + 0.020, CH + 0.020),
    new THREE.MeshBasicMaterial({ color: 0xfbfaf3, toneMapped: false })
  );
  previewBacking.position.z = -0.0012;
  previewScene.add(previewBacking);

  const previewPaper = new THREE.Mesh(canvasGeo, canvasMaterial);
  previewScene.add(previewPaper);

  /* ---------------------------------------------------------------------
     9. Build the three round timelines from the record
     --------------------------------------------------------------------- */
  const INITIAL_TIP = new THREE.Vector3(
    0.089563,
    (0.210012 - TIP_Z) + PAPER_Y,
    -0.438309
  );

  function clipAxis(p0, p1, min, max, range) {
    // range = [lo, hi]; returns false if the segment is wholly outside.
    const d = p1 - p0;
    if (Math.abs(d) < 1e-9) {
      if (p0 < min || p0 > max) return false;
      return true;
    }
    let t1 = (min - p0) / d;
    let t2 = (max - p0) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    range[0] = Math.max(range[0], t1);
    range[1] = Math.min(range[1], t2);
    return range[1] > range[0];
  }

  function clipStroke(p0, z0, p1, z1) {
    const range = [0, 1];
    // vertical contact gate
    if (z0 > CONTACT_Z && z1 > CONTACT_Z) return null;
    if (Math.abs(z1 - z0) < 1e-9) {
      if (z0 > CONTACT_Z) return null;
    } else {
      const a = (CONTACT_Z - z0) / (z1 - z0);
      if (z0 > CONTACT_Z) range[0] = Math.max(range[0], a);
      if (z1 > CONTACT_Z) range[1] = Math.min(range[1], a);
    }
    if (range[1] <= range[0]) return null;
    // canvas x
    if (!clipAxis(p0.x, p1.x, CANVAS.x0 + 0.001, CANVAS.x1 - 0.001, range)) return null;
    // canvas y is -z
    if (!clipAxis(-p0.z, -p1.z, CANVAS.y1 + 0.001, CANVAS.y0 - 0.001, range)) return null;
    if (range[1] - range[0] < 1e-5) return null;
    return range;
  }

  function buildRound(data, index) {
    const actions = data.actions;
    const keyframes = [{ t: 0, p: INITIAL_TIP.clone(), action: 0 }];
    const segs = [];
    const dips = [];
    let t = 0;
    let prevRaw = INITIAL_TIP.clone();
    let prevZ = 0.210012;
    let color = -1;
    let recordedTime = 0;

    actions.forEach((a, ai) => {
      a.startTime = t;
      // small hold at the start of every action, like the pause between tool calls
      t += 0.14;
      keyframes.push({ t, p: prevRaw.clone(), action: ai, hold: true });

      if (!a.wps.length) {
        // SubmitPainting
        t += 0.9;
        keyframes.push({ t, p: prevRaw.clone(), action: ai });
        a.endTime = t;
        return;
      }

      for (let j = 0; j < a.wps.length; j++) {
        const w = a.wps[j];
        const raw = new THREE.Vector3(w[0], (w[2] - TIP_Z) + PAPER_Y, -w[1]);
        const dur = Math.max(0.005, w[3]);
        recordedTime += dur;
        const segStart = t;
        t += dur;
        keyframes.push({ t, p: raw.clone(), action: ai, wp: j });

        // Deposit paint with the colour currently on the brush. A dip at
        // this waypoint only changes the colour for the following segment.
        if (color >= 0) {
          const span = clipStroke(prevRaw, prevZ, raw, w[2]);
          if (span) {
            const a0 = span[0];
            const a1 = span[1];
            const x0 = lerp(prevRaw.x, raw.x, a0);
            const x1 = lerp(prevRaw.x, raw.x, a1);
            const y0 = lerp(-prevRaw.z, -raw.z, a0);
            const y1 = lerp(-prevRaw.z, -raw.z, a1);
            const zz0 = lerp(prevZ, w[2], a0);
            const zz1 = lerp(prevZ, w[2], a1);
            segs.push({
              id: segs.length,
              t0: segStart + dur * a0,
              t1: segStart + dur * a1,
              color,
              x0, y0, z0: zz0,
              x1, y1, z1: zz1,
            });
          }
        }

        // Pick up paint at the palette for the next segment.
        if (w[0] < -0.15 && w[2] <= 0.12) {
          const well = nearestWell(w[0], w[1]);
          if (well) {
            color = wellClass(well);
            dips.push({ t, color, well, action: ai });
          }
        }

        prevRaw = raw;
        prevZ = w[2];
      }
      a.endTime = t;
    });

    // A short tail so completion lands after the last recorded action.
    t += 1.6;
    keyframes.push({ t, p: prevRaw.clone(), action: Math.max(0, actions.length - 1) });
    segs.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);

    return {
      data,
      index,
      actions,
      keyframes,
      segs,
      dips,
      total: t,
      recordedTime,
      painting: data.painting,
    };
  }

  const ROUNDS = DATA.rounds.map((r, i) => buildRound(r, i));

  /* ---------------------------------------------------------------------
     11. State
     --------------------------------------------------------------------- */
  const state = {
    roundIndex: 2,
    round: ROUNDS[2],
    time: 0,
    lastDrawTime: 0,
    playing: false,
    speed: 8,
    completed: false,
    completedRounds: new Set(),
    playAll: false,
    actionIndex: -1,
    lastDipIndex: -1,
    currentColor: -1,
    seeking: false,
    introVisible: true,
    pointers: new Map(),
    lastPointer: null,
    camMode: 'overview',
    previewRect: { x: 0, y: 0, w: 0, h: 0 },
  };

  const cam = {
    target: new THREE.Vector3(0.02, 0.03, -0.44),
    radius: window.innerWidth < 700 ? 2.45 : 1.85,
    polar: 0.56,
    azimuth: -0.30,
    up: new THREE.Vector3(0, 1, 0),
    follow: false,
    goal: {
      target: new THREE.Vector3(0.02, 0.03, -0.44),
      radius: window.innerWidth < 700 ? 2.45 : 1.85,
      polar: 0.56,
      azimuth: -0.30,
      follow: false,
    },
  };

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  /* ---------------------------------------------------------------------
     13. Timeline sampling
     --------------------------------------------------------------------- */
  function sampleRawTip(time) {
    const kf = state.round.keyframes;
    if (time <= kf[0].t) return kf[0].p.clone();
    const last = kf[kf.length - 1];
    if (time >= last.t) return last.p.clone();
    let lo = 0;
    let hi = kf.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (kf[mid].t <= time) lo = mid; else hi = mid;
    }
    const a = kf[lo];
    const b = kf[hi];
    const t = (time - a.t) / Math.max(1e-6, b.t - a.t);
    return new THREE.Vector3(
      lerp(a.p.x, b.p.x, t),
      lerp(a.p.y, b.p.y, t),
      lerp(a.p.z, b.p.z, t)
    );
  }

  function visualTip(raw) {
    const z = raw.y - PAPER_Y + TIP_Z;
    if (z <= 0.108) return new THREE.Vector3(raw.x, PAPER_Y + 0.00015, raw.z);
    if (z >= 0.155) return raw.clone();
    const k = smoothstep(0.108, 0.155, z);
    return new THREE.Vector3(raw.x, lerp(PAPER_Y + 0.00015, raw.y, k), raw.z);
  }

  function findActionIndex(time) {
    const actions = state.round.actions;
    let idx = 0;
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].startTime <= time) idx = i; else break;
    }
    return idx;
  }

  function findDipIndex(time) {
    const dips = state.round.dips;
    let idx = -1;
    for (let i = 0; i < dips.length; i++) {
      if (dips[i].t <= time) idx = i; else break;
    }
    return idx;
  }

  /* ---------------------------------------------------------------------
     14. Ripple pool for paint dips
     --------------------------------------------------------------------- */
  const rippleGeo = new THREE.RingGeometry(0.0075, 0.0092, 36);
  const ripples = [];
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const m = new THREE.Mesh(rippleGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.renderOrder = 3;
    scene.add(m);
    ripples.push({ mesh: m, mat, life: 0, active: false });
  }
  let rippleCursor = 0;

  function spawnRipple(dip) {
    const p = dip.well;
    const r = ripples[rippleCursor++ % ripples.length];
    r.active = true;
    r.life = 0;
    r.mesh.visible = true;
    r.mesh.position.set(p.well[0], 0.0195, -p.well[1]);
    r.mesh.scale.setScalar(1);
    r.mat.color.copy(PAL_BY_ID[dip.well.id]?.color || new THREE.Color(0xffffff));
    r.mat.opacity = 0.55;
  }

  function updateRipples(dt) {
    for (const r of ripples) {
      if (!r.active) continue;
      r.life += dt;
      const t = r.life / 0.62;
      if (t >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const s = 1 + t * 2.6;
      r.mesh.scale.setScalar(s);
      r.mat.opacity = 0.5 * (1 - t) ** 1.5;
    }
  }

  /* ---------------------------------------------------------------------
     15. Round management / UI
     --------------------------------------------------------------------- */
  const ui = {
    lastAction: -1,
    lastRound: -1,
    lastColor: -2,
    lastPct: -1,
    lastTime: -1,
    ticks: [],
  };

  function setRound(index, { autoplay = false, playAll = false } = {}) {
    index = clamp(index, 0, ROUNDS.length - 1);
    state.roundIndex = index;
    state.round = ROUNDS[index];
    state.time = 0;
    state.lastDrawTime = 0;
    state.completed = false;
    state.playing = false;
    state.playAll = playAll;
    state.actionIndex = -1;
    state.lastDipIndex = -1;
    state.currentColor = -1;
    state.seeking = false;

    arm.setPaintColor(-1);
    resetPaint();

    // Round rail
    for (const btn of els.roundBtns) {
      const ri = Number(btn.dataset.round);
      btn.classList.toggle('is-active', ri === index);
      btn.classList.toggle('is-done', state.completedRounds.has(ri) && ri !== index);
    }

    // Labels
    els.previewRound.textContent = 'ROUND 0' + (index + 1);
    els.noteRound.textContent = 'ROUND 0' + (index + 1);
    els.timeTotal.textContent = fmtTime(state.round.total);
    document.title = '金门大桥 · GPT-6 Astra · 第 ' + (index + 1) + ' 轮';

    buildTicks();

    // Reset visuals
    const raw = sampleRawTip(0);
    const tip = visualTip(raw);
    arm.setTip(tip);
    arm.setPaintColor(-1);
    updateNote(true);
    updateColorUI();
    updateProgressUI(true);
    updatePlayUI();

    if (autoplay) {
      hideIntro();
      play();
    }
  }

  function play() {
    if (state.completed) {
      setRound(state.roundIndex, { autoplay: true, playAll: state.playAll });
      return;
    }
    if (state.time >= state.round.total - 0.001) {
      setRound(state.roundIndex, { autoplay: true, playAll: state.playAll });
      return;
    }
    state.playing = true;
    updatePlayUI();
  }

  function pause() {
    state.playing = false;
    updatePlayUI();
  }

  function togglePlay() {
    if (state.introVisible) {
      hideIntro();
      setRound(state.roundIndex, { autoplay: true, playAll: false });
      return;
    }
    if (state.playing) pause(); else play();
  }

  function updatePlayUI() {
    document.body.classList.toggle('is-playing', state.playing);
    els.play.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    els.play.title = state.playing ? '暂停 (空格)' : '播放 (空格)';
  }

  function hideIntro() {
    if (!state.introVisible) return;
    state.introVisible = false;
    document.body.classList.remove('intro-open');
    els.intro.classList.add('is-gone');
    setTimeout(() => { els.intro.style.display = 'none'; }, 950);
  }

  function updateNote(force = false) {
    const actions = state.round.actions;
    const idx = state.actionIndex < 0 ? findActionIndex(state.time) : state.actionIndex;
    const a = actions[idx];
    if (!a) return;
    if (!force && idx === ui.lastAction) return;
    ui.lastAction = idx;
    els.notePhase.textContent = PHASE_LABEL[a.phase] || '过程';
    els.noteCount.textContent = '动作 ' + String(idx + 1).padStart(2, '0') + ' / ' + actions.length;
    els.noteZh.textContent = a.zh;
    els.noteEn.textContent = a.text;
    els.noteCard.classList.remove('is-hidden');
    // little enter animation
    els.noteZh.animate(
      [{ opacity: 0.25, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: 320, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
  }

  function updateColorUI() {
    const idx = state.lastDipIndex;
    const dip = idx >= 0 ? state.round.dips[idx] : null;
    const p = dip ? PAL_BY_ID[dip.well.id] : null;
    const colorId = p ? p.id : null;
    if (colorId === ui.lastColor) return;
    ui.lastColor = colorId;
    if (p) {
      els.previewColor.innerHTML = '<i style="background:' + p.hex + '"></i><b>' + p.zh + '</b>';
      let ci = CLASS_INDEX[p.id];
      if (ci === undefined) ci = CLASS_INDEX[FALLBACK_CLASS[p.id] || 'dark'];
      arm.setPaintColor(ci);
    } else {
      els.previewColor.innerHTML = '<i></i><b>未蘸颜料</b>';
      arm.setPaintColor(-1);
    }
  }

  function updateProgressUI(force = false) {
    const pct = state.round.total > 0 ? clamp(state.time / state.round.total, 0, 1) : 0;
    const thousand = Math.round(pct * 1000);
    if (force || thousand !== ui.lastPct) {
      ui.lastPct = thousand;
      els.timeline.value = String(thousand);
      els.timeline.style.setProperty('--p', (pct * 100).toFixed(2) + '%');
      els.previewPct.textContent = Math.round(pct * 100) + '%';
    }
    const t = Math.floor(state.time);
    if (force || t !== ui.lastTime) {
      ui.lastTime = t;
      els.timeCurrent.textContent = fmtTime(state.time);
    }
    if (force || state.actionIndex !== ui.lastTickAction) {
      ui.lastTickAction = state.actionIndex;
      const idx = state.actionIndex;
      for (let i = 0; i < ui.ticks.length; i++) {
        ui.ticks[i].classList.toggle('is-current', i === idx);
      }
    }
  }

  function buildTicks() {
    els.timelineTicks.innerHTML = '';
    ui.ticks = [];
    const total = state.round.total;
    state.round.actions.forEach((a, i) => {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = (a.startTime / total * 100).toFixed(3) + '%';
      tick.title = PHASE_LABEL[a.phase] + ' · ' + a.zh.slice(0, 26);
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        seek(a.startTime + 0.001, true);
      });
      els.timelineTicks.appendChild(tick);
      ui.ticks.push(tick);
    });
    ui.lastTickAction = -2;
  }

  function seek(time, keepPlaying = false) {
    time = clamp(time, 0, state.round.total);
    state.time = time;
    state.completed = false;

    const idx = findActionIndex(time);
    const dipIdx = findDipIndex(time);
    state.actionIndex = idx;
    state.lastDipIndex = dipIdx;
    state.currentColor = dipIdx >= 0 ? state.round.dips[dipIdx].color : -1;
    arm.setPaintColor(state.currentColor);

    redrawPaintTo(time);
    updateNote(true);
    updateColorUI();
    updateProgressUI(true);

    const raw = sampleRawTip(time);
    const tip = visualTip(raw);
    arm.setTip(tip);

    if (keepPlaying && !state.playing && !state.completed) {
      state.playing = true;
      updatePlayUI();
    }
  }

  /* ---------------------------------------------------------------------
     16. Completion modal
     --------------------------------------------------------------------- */
  function completeRound() {
    if (state.completed) return;
    state.completed = true;
    state.playing = false;
    state.completedRounds.add(state.roundIndex);
    updatePlayUI();

    for (const btn of els.roundBtns) {
      const ri = Number(btn.dataset.round);
      btn.classList.toggle('is-done', state.completedRounds.has(ri) && ri !== state.roundIndex);
      btn.classList.toggle('is-active', ri === state.roundIndex);
    }

    if (state.playAll && state.roundIndex < ROUNDS.length - 1) {
      // Keep the flow going in "from round 1" mode; no modal interruption.
      setTimeout(() => {
        if (!state.playAll) return;
        setRound(state.roundIndex + 1, { autoplay: true, playAll: true });
      }, 1200);
      return;
    }
    openComplete();
  }

  function openComplete() {
    const r = state.round;
    const n = r.index + 1;
    const titles = ['初稿 · 第 1 轮', '修正 · 第 2 轮', '定稿 · 第 3 轮'];
    const subs = [
      '39 个动作，逐笔绘制完成。Astra 随即进入下一轮。',
      '31 个动作，第二轮逐笔绘制完成。',
      '33 个动作，终轮逐笔绘制完成。',
    ];
    els.completeEyebrow.textContent = 'ROUND 0' + n + ' COMPLETE';
    els.completeTitle.textContent = titles[r.index];
    els.completeSub.textContent = subs[r.index];
    els.completeActions.textContent = String(r.actions.length);
    els.completeTime.textContent = fmtDuration(r.recordedTime);
    const dataUrl = paintCanvas.toDataURL('image/png');
    els.completeNote.innerHTML = (r.index === 2
      ? '本轮画布由 33 个动作逐笔绘制，是近似重建；终点不复制记录 PNG。'
      : '本轮画布由 ' + r.actions.length + ' 个动作逐笔绘制，是近似重建。')
      + ' <a class="inline-link" href="' + r.painting + '" download>记录原图</a>';
    els.completeImg.src = dataUrl;
    els.completeDownload.href = dataUrl;
    els.completeDownload.download = 'astra-golden-gate-simulated-round-0' + n + '.png';
    els.completeImg.alt = '本页逐笔绘制的第 ' + n + ' 轮画布';
    els.completeRef.src = DATA.meta.reference.data || DATA.meta.reference.path;
    els.nextRound.style.display = '';
    els.nextRound.innerHTML = r.index < ROUNDS.length - 1 ? '下一轮 <span>→</span>' : '关闭';
    els.completeRange.value = '50';
    els.complete.classList.add('is-open');
    els.complete.setAttribute('aria-hidden', 'false');
    updateCompareClip(50);
    requestAnimationFrame(() => updateCompareClip(50));
  }

  function closeComplete() {
    els.complete.classList.remove('is-open');
    els.complete.setAttribute('aria-hidden', 'true');
  }

  function updateCompareClip(value) {
    const p = clamp(value, 0, 100);
    els.completeRefClip.style.width = p + '%';
    els.completeHandle.style.left = p + '%';
    const frame = els.completeRefClip.parentElement;
    if (frame) {
      const w = frame.getBoundingClientRect().width;
      if (w > 0) {
        els.completeRef.style.width = w + 'px';
        els.completeRef.style.height = '100%';
        els.completeRef.style.maxWidth = 'none';
        els.completeRef.style.objectFit = 'cover';
        els.completeRef.style.position = 'absolute';
        els.completeRef.style.left = '0';
        els.completeRef.style.top = '0';
      }
    }
  }

  /* ---------------------------------------------------------------------
     17. Camera
     --------------------------------------------------------------------- */
  function overviewRadius() {
    return window.innerWidth / window.innerHeight < 1 ? 2.45 : 1.85;
  }

  const CAM_PRESETS = {
    overview: () => ({ target: new THREE.Vector3(0.02, 0.03, -0.44), radius: overviewRadius(), polar: 0.56, azimuth: -0.30, follow: false }),
    canvas: () => ({
      target: new THREE.Vector3(paperCenter.x, 0.0, paperCenter.z),
      radius: window.innerWidth / window.innerHeight < 1 ? 2.18 : 0.97,
      polar: 0.17,
      azimuth: 0.0,
      follow: false,
    }),
    side: () => ({ target: new THREE.Vector3(0.02, 0.03, -0.45), radius: 0.98, polar: 0.99, azimuth: 0.34, follow: false }),
    follow: () => ({ target: new THREE.Vector3(0.09, 0.0, -0.46), radius: 0.72, polar: 0.68, azimuth: -0.62, follow: true }),
  };

  function applyCameraPreset(name, instant = false) {
    const p = CAM_PRESETS[name]();
    if (!p) return;
    state.camMode = name;
    cam.goal.target.copy(p.target);
    cam.goal.radius = p.radius;
    cam.goal.polar = p.polar;
    cam.goal.azimuth = p.azimuth;
    cam.goal.follow = p.follow;
    cam.follow = p.follow;
    if (instant) {
      cam.target.copy(p.target);
      cam.radius = p.radius;
      cam.polar = p.polar;
      cam.azimuth = p.azimuth;
    }
    for (const b of els.camBtns) b.classList.toggle('is-active', b.dataset.cam === name);
  }

  function currentCamUp(polar, out) {
    const k = smoothstep(0.20, 0.48, polar);
    out.set(0, k, -(1 - k)).normalize();
    return out;
  }

  function updateCamera(dt) {
    // follow target (smoothed)
    if (cam.follow) {
      const t = arm.lastTipForCamera || arm.lastHand;
      tmpV.set(t.x, t.y + 0.012, t.z);
      cam.goal.target.copy(tmpV);
    }
    const dampF = 1 - Math.exp(-4.8 * dt);
    cam.target.lerp(cam.goal.target, dampF);
    cam.radius = damp(cam.radius, cam.goal.radius, 5.2, dt);
    cam.polar = damp(cam.polar, cam.goal.polar, 5.2, dt);
    cam.azimuth = damp(cam.azimuth, cam.goal.azimuth, 5.2, dt);

    const sp = Math.sin(cam.polar);
    const cp = Math.cos(cam.polar);
    camera.position.set(
      cam.target.x + cam.radius * sp * Math.sin(cam.azimuth),
      cam.target.y + cam.radius * cp,
      cam.target.z + cam.radius * sp * Math.cos(cam.azimuth)
    );
    currentCamUp(cam.polar, cam.up);
    camera.up.copy(cam.up);
    camera.lookAt(cam.target);
  }

  function setCamButtonActive(name) {
    for (const b of els.camBtns) b.classList.toggle('is-active', b.dataset.cam === name);
  }

  /* ---------------------------------------------------------------------
     18. Pointer / orbit controls
     --------------------------------------------------------------------- */
  const canvasEl = renderer.domElement;
  canvasEl.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.lastPointer = { x: e.clientX, y: e.clientY };
    canvasEl.setPointerCapture(e.pointerId);
    canvasEl.classList.add('is-dragging');
    setCamButtonActive('');
  });
  canvasEl.addEventListener('pointermove', (e) => {
    const prev = state.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (state.pointers.size === 1) {
      const dAz = -dx * 0.0045;
      const dPol = -dy * 0.0042;
      cam.azimuth += dAz;
      cam.goal.azimuth = cam.azimuth;
      cam.polar = clamp(cam.polar + dPol, 0.1, 1.38);
      cam.goal.polar = cam.polar;
    } else if (state.pointers.size === 2) {
      // pinch zoom
      const pts = [...state.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (state.pinchDist) {
        const scale = state.pinchDist / Math.max(1, d);
        cam.radius = clamp(cam.radius * scale, 0.5, 2.75);
        cam.goal.radius = cam.radius;
      }
      state.pinchDist = d;
    }
  });
  const endPointer = (e) => {
    state.pointers.delete(e.pointerId);
    if (state.pointers.size < 2) state.pinchDist = 0;
    if (state.pointers.size === 0) {
      canvasEl.classList.remove('is-dragging');
      state.lastPointer = null;
    }
  };
  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
  canvasEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.0011);
    cam.radius = clamp(cam.radius * scale, 0.5, 2.75);
    cam.goal.radius = cam.radius;
  }, { passive: false });

  /* ---------------------------------------------------------------------
     19. UI events
     --------------------------------------------------------------------- */
  els.play.addEventListener('click', togglePlay);
  els.restart.addEventListener('click', () => {
    setRound(state.roundIndex, { autoplay: true, playAll: state.playAll });
  });
  els.speed.addEventListener('click', () => {
    const speeds = [1, 2, 4, 8, 16];
    const i = speeds.indexOf(state.speed);
    state.speed = speeds[(i + 1) % speeds.length];
    els.speed.textContent = state.speed + '×';
  });
  for (const btn of els.roundBtns) {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.round);
      setRound(idx, { autoplay: true, playAll: false });
    });
  }
  for (const btn of els.camBtns) {
    btn.addEventListener('click', () => applyCameraPreset(btn.dataset.cam));
  }
  els.startFinal.addEventListener('click', () => {
    setRound(2, { autoplay: true, playAll: false });
    hideIntro();
  });
  els.startAll.addEventListener('click', () => {
    setRound(0, { autoplay: true, playAll: true });
    hideIntro();
  });
  els.timeline.addEventListener('pointerdown', () => { state.seeking = true; });
  els.timeline.addEventListener('input', () => {
    const t = Number(els.timeline.value) / 1000 * state.round.total;
    seek(t);
  });
  const endSeek = () => { state.seeking = false; };
  els.timeline.addEventListener('pointerup', endSeek);
  els.timeline.addEventListener('pointercancel', endSeek);
  els.timeline.addEventListener('change', endSeek);

  els.aboutOpen.addEventListener('click', () => {
    els.about.classList.add('is-open');
    els.about.setAttribute('aria-hidden', 'false');
  });
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      const modal = $(btn.dataset.close);
      if (!modal) return;
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
    });
  }
  for (const modal of [els.about, els.complete]) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }
  els.completeRange.addEventListener('input', () => updateCompareClip(Number(els.completeRange.value)));
  els.completeRange.addEventListener('pointerup', () => updateCompareClip(Number(els.completeRange.value)));
  els.replayRound.addEventListener('click', () => {
    closeComplete();
    setRound(state.roundIndex, { autoplay: true, playAll: false });
  });
  els.nextRound.addEventListener('click', () => {
    if (state.roundIndex < ROUNDS.length - 1) {
      closeComplete();
      setRound(state.roundIndex + 1, { autoplay: true, playAll: false });
    } else {
      closeComplete();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r' || e.key === 'R') { setRound(state.roundIndex, { autoplay: true, playAll: state.playAll }); }
    else if (e.key === '1') { setRound(0, { autoplay: true }); }
    else if (e.key === '2') { setRound(1, { autoplay: true }); }
    else if (e.key === '3') { setRound(2, { autoplay: true }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.time + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.time - 5); }
    else if (e.key === 'c' || e.key === 'C') {
      const order = ['overview', 'canvas', 'side', 'follow'];
      applyCameraPreset(order[(order.indexOf(state.camMode) + 1) % order.length]);
    } else if (e.key === 'Escape') {
      for (const m of [els.about, els.complete]) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); }
    }
  });

  /* ---------------------------------------------------------------------
     20. Resize / preview viewport
     --------------------------------------------------------------------- */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (state.camMode === 'overview') {
      cam.goal.radius = overviewRadius();
      if (state.introVisible) cam.radius = overviewRadius();
    }
    // Preview camera: frame the paper with a small margin, preserving aspect.
    const rect = els.previewFrame.getBoundingClientRect();
    if (rect.width > 4 && rect.height > 4) {
      const aspect = rect.width / rect.height;
      const targetAspect = 1024 / 725;
      let vw = CW * 1.07;
      let vh = vw / aspect;
      if (vh < CH * 1.07) {
        vh = CH * 1.07;
        vw = vh * aspect;
      }
      previewCamera.left = -vw / 2;
      previewCamera.right = vw / 2;
      previewCamera.top = vh / 2;
      previewCamera.bottom = -vh / 2;
      previewCamera.updateProjectionMatrix();
    }
  }
  window.addEventListener('resize', () => {
    resize();
    if (state.camMode === 'canvas') {
      cam.goal.radius = window.innerWidth / window.innerHeight < 1 ? 2.18 : 0.97;
    }
    if (els.complete.classList.contains('is-open')) updateCompareClip(Number(els.completeRange.value));
  });

  /* ---------------------------------------------------------------------
     21. Frame loop
     --------------------------------------------------------------------- */
  const clock = new THREE.Clock();
  let lastPreviewUpdate = 0;

  function renderPreview() {
    if (state.introVisible) return;
    if (els.previewCard.offsetParent === null) return;
    const rect = els.previewFrame.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return;
    const x = rect.left;
    const y = window.innerHeight - rect.bottom;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.setClearColor(0x0d0f11, 1);
    renderer.clear(true, true, false);
    renderer.render(previewScene, previewCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }

  function updateRipplesAndDust(dt, elapsed) {
    updateRipples(dt);
    dust.rotation.y = Math.sin(elapsed * 0.03) * 0.03;
    for (let i = 0; i < dustCount; i++) {
      const iy = i * 3 + 1;
      dustGeo.attributes.position.array[iy] += Math.sin(elapsed * 0.2 + i) * 0.000015;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.06);
    const elapsed = clock.elapsedTime;

    if (state.playing && !state.completed) {
      const prev = state.time;
      const next = Math.min(prev + dt * state.speed, state.round.total);
      if (next > prev) {
        advancePaintTo(prev, next);
        state.time = next;

        // Color and dip events
        const dipIdx = findDipIndex(next);
        if (dipIdx > state.lastDipIndex) {
          for (let i = state.lastDipIndex + 1; i <= dipIdx; i++) {
            if (state.round.dips[i].t > prev) spawnRipple(state.round.dips[i]);
          }
          state.lastDipIndex = dipIdx;
          state.currentColor = state.round.dips[dipIdx].color;
          arm.setPaintColor(state.currentColor);
          updateColorUI();
        }

        const idx = findActionIndex(next);
        if (idx !== state.actionIndex) {
          state.actionIndex = idx;
          updateNote();
          updateColorUI();
        }

      }
      updateProgressUI();

      if (state.time >= state.round.total - 1e-4) {
        if (!state.completed) completeRound();
      }
    }

    // Brush tip
    const raw = sampleRawTip(state.time);
    const tip = visualTip(raw);
    arm.setTip(tip);
    arm.lastTipForCamera = tip;

    updateCamera(dt);
    updateRipplesAndDust(dt, elapsed);

    // UI bits that need continuous updates
    if (!state.seeking) {
      const pct = state.round.total > 0 ? clamp(state.time / state.round.total, 0, 1) : 0;
      const thousand = Math.round(pct * 1000);
      if (thousand !== ui.lastPct) {
        ui.lastPct = thousand;
        els.timeline.value = String(thousand);
        els.timeline.style.setProperty('--p', (pct * 100).toFixed(2) + '%');
        els.previewPct.textContent = Math.round(pct * 100) + '%';
      }
      const t = Math.floor(state.time);
      if (t !== ui.lastTime) {
        ui.lastTime = t;
        els.timeCurrent.textContent = fmtTime(state.time);
      }
      if (state.actionIndex !== ui.lastTickAction) {
        ui.lastTickAction = state.actionIndex;
        for (let i = 0; i < ui.ticks.length; i++) ui.ticks[i].classList.toggle('is-current', i === state.actionIndex);
      }
    }

    // Main render
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x0b0d0e, 1);
    renderer.render(scene, camera);
    renderPreview();
  }

  /* ---------------------------------------------------------------------
     22. Boot
     --------------------------------------------------------------------- */
  function boot() {
    resize();
    applyCameraPreset('overview', true);
    // Preload the reference used by the completion comparison.
    els.completeRef.src = DATA.meta.reference.data || DATA.meta.reference.path;
    // Initial pose: round 3, t=0, blank paper.
    setRound(2, { autoplay: false });
    els.loading.classList.add('is-gone');
    setTimeout(() => { els.loading.style.display = 'none'; }, 760);
    requestAnimationFrame(frame);
  }

  // Small debug surface used by the visual QA scripts; harmless in production.
  window.__ASTRA = {
    state, ROUNDS, seek, setRound, applyCameraPreset, togglePlay, play, pause,
    arm, camera, cam, renderer, paintCanvas, paintCtx, paintTexture, canvasMaterial,
    BRUSH_STAMPS, drawPaintSegment, redrawPaintTo, strokeWidthPx,
    scene, previewScene, shadowPlane, dust, key,
  };

  // Keep the intro visible until the user starts.
  document.body.classList.remove('is-playing');
  boot();
})();
