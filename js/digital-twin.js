/**
 * Gemelo Digital — Subestación Eléctrica Minera
 * Three.js r128 + OrbitControls + Chart.js
 * Patio AT: TORRE-AT-01 → TRANS-01 / SENSOR-TEMP-01 → BROKER-KAFKA → DB-MONGODB
 */
(function () {
  "use strict";

  const UMBRAL_MW = 70;
  const state = {
    loadMW: 48,
    tempC: 56,
    voltKV: 136.3,
    oilC: 61,
    overload: false,
    kafkaPct: 19,
    docs: 128450,
    packets: 0,
    alarmLatched: false,
    time: 0
  };

  const refs = {
    transformerBodies: [],
    kafkaLeds: [],
    mongoHalo: null,
    sensorLed: null,
    floodSpots: []
  };

  const labelBindings = [];
  const particles = [];
  const curves = {};

  let renderer, scene, camera, controls;
  let clock;
  let chartTemp, chartVolt;
  let frames = 0;
  let fpsT = 0;

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                         */
  /* ------------------------------------------------------------------ */

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function noiseCanvas(size, paint) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    paint(ctx, size);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function addBeam(parent, ax, ay, az, bx, by, bz, material, thickness) {
    const start = new THREE.Vector3(ax, ay, az);
    const end = new THREE.Vector3(bx, by, bz);
    const len = start.distanceTo(end);
    if (len < 0.001) return null;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, len), material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.lookAt(end);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function makePlate(text, w, h, fg, bg) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, 488, 232);
    ctx.fillStyle = fg;
    ctx.font = "bold 42px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 128);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.55,
      metalness: 0.15,
      emissive: new THREE.Color(fg).multiplyScalar(0.15)
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    return mesh;
  }

  /* ------------------------------------------------------------------ */
  /* Texturas procedurales (concreto, grava, malla)                     */
  /* ------------------------------------------------------------------ */

  function texConcrete() {
    return noiseCanvas(1024, function (ctx, s) {
      ctx.fillStyle = "#2a2c30";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 18000; i++) {
        const v = 28 + Math.random() * 42;
        ctx.fillStyle = "rgba(" + v + "," + (v + 2) + "," + (v - 4) + "," + (0.18 + Math.random() * 0.35) + ")";
        ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2);
      }
      ctx.strokeStyle = "rgba(210, 180, 40, 0.92)";
      ctx.lineWidth = 10;
      ctx.strokeRect(48, 48, s - 96, s - 96);
      ctx.strokeStyle = "rgba(210, 180, 40, 0.35)";
      ctx.lineWidth = 4;
      ctx.strokeRect(70, 70, s - 140, s - 140);
      const stripe = 28;
      for (let x = 0; x < s; x += stripe) {
        ctx.fillStyle = x / stripe % 2 === 0 ? "#c9a227" : "#121212";
        ctx.fillRect(x, 0, stripe, 22);
        ctx.fillRect(x, s - 22, stripe, 22);
      }
      ctx.strokeStyle = "rgba(220, 220, 210, 0.18)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s * 0.5, 80);
      ctx.lineTo(s * 0.5, s - 80);
      ctx.stroke();
    });
  }

  function texGravel() {
    return noiseCanvas(1024, function (ctx, s) {
      ctx.fillStyle = "#1a1714";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 9000; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const r = 1 + Math.random() * 4;
        const g = 40 + Math.random() * 50;
        ctx.fillStyle = "rgb(" + (g + 8) + "," + g + "," + (g - 12) + ")";
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.5 + Math.random() * 0.6), Math.random() * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function texFence() {
    return noiseCanvas(256, function (ctx, s) {
      ctx.clearRect(0, 0, s, s);
      ctx.strokeStyle = "rgba(160, 170, 180, 0.55)";
      ctx.lineWidth = 2;
      for (let i = 0; i <= s; i += 16) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, s);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(s, i);
        ctx.stroke();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Entorno minero                                                     */
  /* ------------------------------------------------------------------ */

  function createEnvironment() {
    const gravelTex = texGravel();
    gravelTex.repeat.set(6, 6);
    const gravel = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 0.95, metalness: 0.02, color: 0x8a8074 })
    );
    gravel.rotation.x = -Math.PI / 2;
    gravel.receiveShadow = true;
    scene.add(gravel);

    const concTex = texConcrete();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(52, 0.18, 28),
      new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.82, metalness: 0.08, color: 0xc4c2bc })
    );
    slab.position.y = 0.09;
    slab.receiveShadow = true;
    slab.castShadow = true;
    scene.add(slab);

    const hills = [
      [-52, 3, -48, 16, 8, 12],
      [54, 3.5, -46, 14, 9, 13],
      [-8, 4, -58, 22, 10, 10],
      [38, 2.8, 52, 16, 6, 12]
    ];
    hills.forEach(function (h) {
      const m = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1, 1),
        new THREE.MeshStandardMaterial({ color: 0x3a332c, roughness: 0.95, metalness: 0.05, flatShading: true })
      );
      m.position.set(h[0], h[1] * 0.35, h[2]);
      m.scale.set(h[3], h[4], h[5]);
      m.receiveShadow = true;
      scene.add(m);
    });

    for (let i = 0; i < 40; i++) {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(rand(0.15, 0.45), 0),
        new THREE.MeshStandardMaterial({ color: 0x5a5348, roughness: 0.9, metalness: 0.05, flatShading: true })
      );
      const ang = Math.random() * Math.PI * 2;
      const rad = 18 + Math.random() * 28;
      rock.position.set(Math.cos(ang) * rad, 0.2, Math.sin(ang) * rad);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      scene.add(rock);
    }

    createFence();
    createFloodlight(-22, 10);
    createFloodlight(10, 10);
    createFloodlight(22, -8);
  }

  function createFence() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x4d5560, metalness: 0.85, roughness: 0.32 });
    const fenceTex = texFence();
    fenceTex.repeat.set(20, 2);
    const meshMat = new THREE.MeshStandardMaterial({
      map: fenceTex,
      transparent: true,
      opacity: 0.55,
      metalness: 0.7,
      roughness: 0.35,
      side: THREE.DoubleSide,
      color: 0x9aa3ad
    });
    const pts = [
      [-26, -14], [26, -14], [26, 14], [-26, 14], [-26, -14]
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const cx = (a[0] + b[0]) / 2;
      const cz = (a[1] + b[1]) / 2;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.1), meshMat);
      panel.position.set(cx, 1.15, cz);
      panel.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
      scene.add(panel);
      const posts = Math.max(2, Math.round(len / 4));
      for (let p = 0; p <= posts; p++) {
        const t = p / posts;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.3, 0.12), steel);
        post.position.set(a[0] + dx * t, 1.15, a[1] + dz * t);
        post.castShadow = true;
        scene.add(post);
      }
    }
  }

  function createFloodlight(x, z) {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2f3540, metalness: 0.8, roughness: 0.35 });
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7.2, 10), steel);
    pole.position.y = 3.6;
    pole.castShadow = true;
    g.add(pole);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.28, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.7, roughness: 0.4 })
    );
    head.position.set(0, 7.15, 0.15);
    g.add(head);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 16),
      new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffe7a0, emissiveIntensity: 1.4 })
    );
    lens.position.set(0, 7.12, 0.36);
    g.add(lens);
    const spot = new THREE.SpotLight(0xfff3d0, 1.15, 38, Math.PI / 7, 0.45, 1.1);
    spot.position.set(0, 7.1, 0.2);
    spot.target.position.set(0, 0, -6);
    g.add(spot);
    g.add(spot.target);
    g.position.set(x, 0, z);
    scene.add(g);
    refs.floodSpots.push(spot);
  }

  /* ------------------------------------------------------------------ */
  /* TORRE-AT-01 — celosía de alta tensión                              */
  /* ------------------------------------------------------------------ */

  function createTower() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({
      color: 0x6a7380,
      metalness: 0.92,
      roughness: 0.28
    });
    const height = 16;
    const segs = 8;
    const baseW = 3.4;
    const topW = 0.85;

    function widthAt(t) {
      return baseW + (topW - baseW) * t;
    }

    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const y0 = t0 * height;
      const y1 = t1 * height;
      const w0 = widthAt(t0) / 2;
      const w1 = widthAt(t1) / 2;
      const c0 = [
        [-w0, y0, -w0], [w0, y0, -w0], [w0, y0, w0], [-w0, y0, w0]
      ];
      const c1 = [
        [-w1, y1, -w1], [w1, y1, -w1], [w1, y1, w1], [-w1, y1, w1]
      ];
      for (let k = 0; k < 4; k++) {
        addBeam(g, c0[k][0], c0[k][1], c0[k][2], c1[k][0], c1[k][1], c1[k][2], steel, 0.1);
        addBeam(g, c1[k][0], c1[k][1], c1[k][2], c1[(k + 1) % 4][0], c1[(k + 1) % 4][1], c1[(k + 1) % 4][2], steel, 0.07);
        addBeam(g, c0[k][0], c0[k][1], c0[k][2], c1[(k + 1) % 4][0], c1[(k + 1) % 4][1], c1[(k + 1) % 4][2], steel, 0.055);
      }
    }

    const armY = height + 0.15;
    addBeam(g, -3.2, armY, 0, 3.2, armY, 0, steel, 0.12);
    addBeam(g, -3.2, armY, 0, -3.2, armY - 0.5, 0, steel, 0.08);
    addBeam(g, 3.2, armY, 0, 3.2, armY - 0.5, 0, steel, 0.08);
    addBeam(g, 0, height, 0, 0, height + 1.4, 0, steel, 0.07);

    const ceramic = new THREE.MeshStandardMaterial({
      color: 0xd8cfc0,
      roughness: 0.35,
      metalness: 0.08
    });
    const hangX = [-2.4, 0, 2.4];
    hangX.forEach(function (hx) {
      const string = new THREE.Group();
      for (let i = 0; i < 9; i++) {
        const r = i % 2 === 0 ? 0.16 : 0.1;
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.07, 16), ceramic);
        disc.position.y = -i * 0.14;
        string.add(disc);
      }
      string.position.set(hx, armY - 0.2, 0);
      g.add(string);
    });

    const plate = makePlate("TORRE-AT-01", 1.6, 0.45, "#00e8ff", "#0b1218");
    plate.position.set(0, 3.2, baseW / 2 + 0.08);
    g.add(plate);

    g.position.set(-14.5, 0.18, 0);
    scene.add(g);
    refs.tower = g;
    bindLabel(g, "[TORRE-AT-01]", "Torre de celosía AT de entrada", new THREE.Vector3(0, 18.2, 0));
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* TRANS-01 — transformador de potencia                               */
  /* ------------------------------------------------------------------ */

  function createBushing(height, sheds) {
    const g = new THREE.Group();
    const ceramic = new THREE.MeshStandardMaterial({
      color: 0xe8ddd0,
      roughness: 0.28,
      metalness: 0.05
    });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, height, 12), ceramic);
    core.position.y = height / 2;
    g.add(core);
    for (let i = 0; i < sheds; i++) {
      const y = 0.18 + (i / sheds) * (height - 0.3);
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.13, 0.05, 18),
        ceramic
      );
      disc.position.y = y;
      g.add(disc);
    }
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.95, roughness: 0.2 })
    );
    cap.position.y = height;
    g.add(cap);
    return g;
  }

  function createTransformer() {
    const g = new THREE.Group();
    const tankMat = new THREE.MeshStandardMaterial({
      color: 0x1f7a4a,
      metalness: 0.72,
      roughness: 0.32,
      emissive: new THREE.Color(0x062818),
      emissiveIntensity: 0.35
    });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a414c, metalness: 0.85, roughness: 0.3 });
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x247a4e,
      metalness: 0.7,
      roughness: 0.38,
      emissive: new THREE.Color(0x062818),
      emissiveIntensity: 0.25
    });

    const base = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.28, 3.1), steel);
    base.position.y = 0.14;
    base.castShadow = true;
    g.add(base);

    const tank = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 2.2), tankMat);
    tank.position.y = 1.55;
    tank.castShadow = true;
    tank.receiveShadow = true;
    g.add(tank);
    refs.transformerBodies.push(tank, finMat);

    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 12; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.2, 0.95), finMat);
        fin.position.set(side * 1.95, 1.45, -1.1 + i * 0.2);
        fin.castShadow = true;
        g.add(fin);
        refs.transformerBodies.push(fin);
      }
    }

    const conservator = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 2.4, 20),
      tankMat
    );
    conservator.rotation.z = Math.PI / 2;
    conservator.position.set(0, 3.15, 0);
    conservator.castShadow = true;
    g.add(conservator);
    refs.transformerBodies.push(conservator);

    const hv = [-0.85, 0, 0.85];
    hv.forEach(function (x, i) {
      const b = createBushing(i === 1 ? 1.7 : 1.45, 10);
      b.position.set(x, 2.85, -0.45);
      g.add(b);
    });
    const lv = [-0.55, 0, 0.55];
    lv.forEach(function (x) {
      const b = createBushing(0.85, 6);
      b.position.set(x, 2.85, 0.7);
      g.add(b);
    });

    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8),
      steel
    );
    pipe.position.set(1.2, 2.85, 0);
    g.add(pipe);

    const plate = makePlate("TRANS-01  40/50 MVA", 1.8, 0.42, "#3dff8a", "#08140e");
    plate.position.set(0, 1.6, 1.12);
    g.add(plate);

    const warn = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.35, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xe6b800, roughness: 0.5, metalness: 0.2, emissive: 0x332200, emissiveIntensity: 0.4 })
    );
    warn.position.set(1.4, 2.2, 1.12);
    g.add(warn);

    g.position.set(-4.2, 0.18, 0);
    g.rotation.y = 0.35;
    scene.add(g);
    refs.transformer = g;
    bindLabel(g, "[TRANS-01]", "Transformador de potencia principal", new THREE.Vector3(0, 5.1, 0), "trans");
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* SENSOR-TEMP-01                                                     */
  /* ------------------------------------------------------------------ */

  function createSensor(parent) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.28, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x1a222c, metalness: 0.6, roughness: 0.4 })
    );
    box.castShadow = true;
    g.add(box);
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x3dff8a, emissive: 0x3dff8a, emissiveIntensity: 1.6 })
    );
    led.position.set(0.14, 0.06, 0.12);
    g.add(led);
    refs.sensorLed = led;

    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.45, 8),
      new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.9, roughness: 0.2 })
    );
    ant.position.set(-0.12, 0.34, 0);
    g.add(ant);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x00e8ff, emissive: 0x00e8ff, emissiveIntensity: 0.9 })
    );
    tip.position.set(-0.12, 0.58, 0);
    g.add(tip);

    const plate = makePlate("IoT RTD/PT100", 0.5, 0.16, "#00e8ff", "#071018");
    plate.position.set(0, 0, 0.12);
    g.add(plate);

    g.position.set(0.2, 3.05, 1.22);
    parent.add(g);
    refs.sensor = g;
    bindLabel(g, "[SENSOR-TEMP-01]", "Sensor IoT temperatura / voltaje", new THREE.Vector3(0, 0.95, 0.2), "sensor");
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* BROKER-KAFKA — rack industrial                                     */
  /* ------------------------------------------------------------------ */

  function createKafka() {
    const g = new THREE.Group();
    const frame = new THREE.MeshStandardMaterial({ color: 0x1c222b, metalness: 0.75, roughness: 0.35 });
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.35, 0.85), frame);
    cab.position.y = 1.2;
    cab.castShadow = true;
    cab.receiveShadow = true;
    g.add(cab);

    const rails = new THREE.MeshStandardMaterial({ color: 0x0d1116, metalness: 0.4, roughness: 0.5 });
    for (let i = 0; i < 10; i++) {
      const u = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.16, 0.78), rails);
      u.position.set(0, 0.28 + i * 0.21, 0.02);
      g.add(u);
      for (let k = 0; k < 3; k++) {
        const colors = [0x3dff8a, 0x00e8ff, 0xffb020];
        const led = new THREE.Mesh(
          new THREE.BoxGeometry(0.045, 0.03, 0.02),
          new THREE.MeshStandardMaterial({
            color: colors[k],
            emissive: colors[k],
            emissiveIntensity: 0.8
          })
        );
        led.position.set(-0.42 + k * 0.12, 0.28 + i * 0.21, 0.42);
        g.add(led);
        refs.kafkaLeds.push(led);
      }
    }

    const plate = makePlate("BROKER-KAFKA", 1.15, 0.28, "#00e8ff", "#070c12");
    plate.position.set(0, 2.28, 0.44);
    g.add(plate);

    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.12, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x2a313b, metalness: 0.7, roughness: 0.4 })
    );
    foot.position.y = 0.06;
    g.add(foot);

    g.position.set(6.4, 0.18, 0.2);
    scene.add(g);
    refs.kafka = g;
    bindLabel(g, "[BROKER-KAFKA]", "Rack streaming MQTT / Kafka", new THREE.Vector3(0, 2.85, 0), "kafka");
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* DB-MONGODB — silo NoSQL                                            */
  /* ------------------------------------------------------------------ */

  function createMongo() {
    const g = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({
      color: 0x1c3a2a,
      metalness: 0.55,
      roughness: 0.4,
      emissive: 0x0a2818,
      emissiveIntensity: 0.25
    });
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.22, 2.7, 28), shell);
    cyl.position.y = 1.5;
    cyl.castShadow = true;
    cyl.receiveShadow = true;
    g.add(cyl);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.18, 0.07, 10, 28),
      new THREE.MeshStandardMaterial({ color: 0x3dff8a, metalness: 0.6, roughness: 0.3, emissive: 0x1dff70, emissiveIntensity: 0.55 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.05;
    g.add(ring);
    refs.mongoHalo = ring;

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 1.15, 0.18, 24),
      new THREE.MeshStandardMaterial({ color: 0x2d6a4f, metalness: 0.7, roughness: 0.3 })
    );
    cap.position.y = 2.88;
    g.add(cap);

    const plate = makePlate("DB-MONGODB", 1.6, 0.4, "#3dff8a", "#08140e");
    plate.position.set(0, 1.5, 1.24);
    g.add(plate);

    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x1a8a4a, emissiveIntensity: 0.5, metalness: 0.3, roughness: 0.4 })
    );
    leaf.position.set(0, 3.18, 0);
    g.add(leaf);

    g.position.set(12.2, 0.18, 0);
    scene.add(g);
    refs.mongo = g;
    bindLabel(g, "[DB-MONGODB]", "Almacenamiento histórico NoSQL", new THREE.Vector3(0, 3.55, 0));
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Pipeline de datos — tubos + partículas                             */
  /* ------------------------------------------------------------------ */

  function makeCurve(pts) {
    return new THREE.CatmullRomCurve3(pts.map(function (p) {
      return new THREE.Vector3(p[0], p[1], p[2]);
    }));
  }

  function addTube(curve, color, radius) {
    const geom = new THREE.TubeGeometry(curve, 80, radius, 8, false);
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.25,
      metalness: 0.55,
      roughness: 0.35,
      transparent: true,
      opacity: 0.85
    });
    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    return mesh;
  }

  function spawnParticles(curve, color, count, speed) {
    const glow = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), glow);
      scene.add(mesh);
      particles.push({
        mesh: mesh,
        curve: curve,
        t: i / count,
        speed: speed * (0.85 + Math.random() * 0.3)
      });
    }
  }

  function wp(obj, x, y, z) {
    return obj.localToWorld(new THREE.Vector3(x, y, z)).toArray();
  }

  function createPipeline() {
    const towerTop = wp(refs.tower, 0, 14.6, 0);
    const transHv = wp(refs.transformer, 0, 4.4, -0.45);
    const sensorPos = wp(refs.sensor, 0, 0.2, 0.15);
    const kafkaIn = wp(refs.kafka, -0.7, 1.8, 0);
    const kafkaOut = wp(refs.kafka, 0.7, 1.6, 0);
    const mongoIn = wp(refs.mongo, -1.2, 1.7, 0);

    curves.power = makeCurve([
      towerTop,
      [-11, 10.8, 1.1],
      [-7.6, 6.8, 0.5],
      transHv
    ]);
    curves.iot = makeCurve([
      sensorPos,
      [-0.6, 4.7, 2.0],
      [2.8, 3.4, 1.2],
      kafkaIn
    ]);
    curves.persist = makeCurve([
      kafkaOut,
      [8.6, 2.6, 0.35],
      [10.2, 2.35, -0.1],
      mongoIn
    ]);

    addTube(curves.power, 0xe6c35c, 0.045);
    addTube(curves.iot, 0x00e8ff, 0.04);
    addTube(curves.persist, 0x3dff8a, 0.04);

    spawnParticles(curves.power, 0xffe08a, 14, 0.12);
    spawnParticles(curves.iot, 0x00e8ff, 18, 0.22);
    spawnParticles(curves.persist, 0x3dff8a, 16, 0.2);
  }

  /* ------------------------------------------------------------------ */
  /* Etiquetas HTML proyectadas                                         */
  /* ------------------------------------------------------------------ */

  function bindLabel(object, name, subtitle, offset, key) {
    const el = document.createElement("div");
    el.className = "label";
    el.innerHTML = "<span class='tag'>" + name + "</span><small>" + subtitle + "</small>";
    document.getElementById("labels").appendChild(el);
    labelBindings.push({ object: object, el: el, offset: offset || new THREE.Vector3(0, 2, 0), key: key || "" });
  }

  function updateLabels() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    labelBindings.forEach(function (b) {
      const pos = b.object.localToWorld(b.offset.clone());
      pos.project(camera);
      const visible = pos.z < 1;
      b.el.style.display = visible ? "block" : "none";
      if (!visible) return;
      const x = (pos.x * 0.5 + 0.5) * w;
      const y = (-pos.y * 0.5 + 0.5) * h;
      b.el.style.left = x + "px";
      b.el.style.top = y + "px";
      if (b.key === "trans" || b.key === "sensor" || b.key === "kafka") {
        b.el.classList.toggle("alarm", state.overload);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Iluminación PBR + sombras                                          */
  /* ------------------------------------------------------------------ */

  function createLights() {
    scene.add(new THREE.HemisphereLight(0x6d849c, 0x2a2418, 0.55));

    const sun = new THREE.DirectionalLight(0xfff1d2, 1.15);
    sun.position.set(-18, 28, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 24;
    sun.shadow.camera.bottom = -24;
    sun.shadow.bias = -0.00025;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x88aacc, 0.28);
    fill.position.set(20, 12, -18);
    scene.add(fill);

    const yard = new THREE.PointLight(0x7ad0ff, 0.55, 28, 2);
    yard.position.set(-5, 6, 4);
    scene.add(yard);
  }

  /* ------------------------------------------------------------------ */
  /* UI / telemetría / Chart.js                                         */
  /* ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function makeChart(canvasId, color, fill) {
    const ctx = $(canvasId).getContext("2d");
    return new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: color,
          backgroundColor: fill,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: {
            ticks: { color: "#7a8a98", font: { size: 9 }, maxTicksLimit: 4 },
            grid: { color: "rgba(0, 232, 255, 0.08)" }
          }
        }
      }
    });
  }

  function pushChart(chart, value) {
    const t = new Date();
    const stamp = t.toLocaleTimeString("es-CL", { hour12: false });
    chart.data.labels.push(stamp);
    chart.data.datasets[0].data.push(Number(value.toFixed(2)));
    if (chart.data.labels.length > 24) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.update("none");
  }

  function computeTelemetry(dt) {
    const load = state.loadMW;
    const wobble = Math.sin(state.time * 1.7) * 0.8 + Math.sin(state.time * 0.4) * 0.4;
    state.tempC = 25.5 + load * 0.64 + wobble;
    state.oilC = state.tempC + 4.6 + Math.sin(state.time * 0.9) * 0.5;
    state.voltKV = 138.4 - load * 0.042 + Math.sin(state.time * 0.65) * 0.22;
    state.overload = load > UMBRAL_MW || state.tempC > 70;
    state.kafkaPct = state.overload
      ? Math.min(99, 78 + (load - UMBRAL_MW) * 1.6 + Math.abs(Math.sin(state.time * 6)) * 6)
      : Math.max(8, load * 0.38 + 4);
    state.docs += Math.round((18 + load * 0.7) * dt);
    state.packets += 1;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function alarmBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 740;
      gain.gain.value = 0.04;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } catch (e) { /* audio opcional */ }
  }

  function renderUI() {
    const ov = state.overload;
    setText("loadValue", state.loadMW.toFixed(1));
    $("kpiTemp").innerHTML = state.tempC.toFixed(1) + "<span>°C</span>";
    $("kpiVolt").innerHTML = state.voltKV.toFixed(1) + "<span>kV</span>";
    $("kpiOil").innerHTML = state.oilC.toFixed(1) + "<span>°C</span>";
    $("kpiPower").innerHTML = state.loadMW.toFixed(1) + "<span>MW</span>";
    $("kpiTemp").parentElement.classList.toggle("hot", ov);
    $("kpiOil").parentElement.classList.toggle("hot", ov);

    $("kafkaFill").style.width = state.kafkaPct.toFixed(1) + "%";
    $("kafkaFill").classList.toggle("sat", ov);
    setText("kafkaStatus", ov ? "COLA SATURADA · BACKPRESSURE" : "Cola estable · " + state.kafkaPct.toFixed(0) + "%");
    setText("kafkaRate", ov ? (4.8 + state.loadMW * 0.06).toFixed(1) + "k msg/s" : (0.7 + state.loadMW * 0.018).toFixed(1) + "k msg/s");
    setText("mongoOps", Math.round(420 + state.loadMW * 12) + "/s");
    setText("mongoDocs", state.docs.toLocaleString("es-CL"));
    setText("mongoReplica", ov ? "LAG REPLICA" : "PRIMARY");

    const payload = {
      ts: new Date().toISOString(),
      asset: "TRANS-01",
      sensor: "SENSOR-TEMP-01",
      load_mw: Number(state.loadMW.toFixed(2)),
      temp_c: Number(state.tempC.toFixed(2)),
      volt_kv: Number(state.voltKV.toFixed(2)),
      kafka_lag: Math.round(state.kafkaPct),
      alarm: ov
    };
    $("payloadBox").textContent = JSON.stringify(payload, null, 2);

    $("alertBanner").classList.toggle("is-on", ov);
    $("alertBanner").hidden = !ov;
    $("modeChip").textContent = ov ? "MODO ALARMA" : "MODO NOMINAL";
    $("modeChip").classList.toggle("alarm", ov);

    setText("appTemp", state.tempC.toFixed(1) + "°");
    setText("appVolt", state.voltKV.toFixed(1) + " kV");
    setText("appLoad", state.loadMW.toFixed(0) + " MW");
    $("appBadge").textContent = ov ? "ALARM" : "OK";
    $("appBadge").classList.toggle("alarm", ov);
    $("appAlert").hidden = !ov;

    const line = "[" + new Date().toLocaleTimeString("es-CL", { hour12: false }) + "] " +
      (ov ? "WARN queue_sat temp=" : "OK  publish temp=") +
      state.tempC.toFixed(1) + "C  " + state.voltKV.toFixed(1) + "kV";
    const feed = $("appFeed");
    feed.innerHTML = line + "<br>" + feed.innerHTML;
    if (feed.children.length > 8) feed.removeChild(feed.lastChild);

    setText("packetLabel", "PKT " + String(state.packets).padStart(6, "0"));

    if (ov && !state.alarmLatched) {
      state.alarmLatched = true;
      alarmBeep();
    }
    if (!ov) state.alarmLatched = false;
  }

  function applyTransformerAlarm(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 10);
    refs.transformerBodies.forEach(function (obj) {
      const mat = obj.material || obj;
      if (!mat.color) return;
      if (state.overload) {
        mat.color.setRGB(0.75 + pulse * 0.2, 0.05, 0.06);
        if (mat.emissive) {
          mat.emissive.setRGB(0.55 * pulse, 0.02, 0.02);
          mat.emissiveIntensity = 0.7 + pulse * 0.8;
        }
      } else {
        mat.color.setHex(0x1f7a4a);
        if (mat.emissive) {
          mat.emissive.setHex(0x062818);
          mat.emissiveIntensity = 0.3;
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Three.js bootstrap                                                 */
  /* ------------------------------------------------------------------ */

  function initThree() {
    const canvas = $("viewport");
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (renderer.outputEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1018);
    scene.fog = new THREE.FogExp2(0x0a1018, 0.016);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 220);
    camera.position.set(2, 13, 30);
    camera.fov = 48;
    camera.updateProjectionMatrix();

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, 3.2, 0);
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 6;
    controls.maxDistance = 55;
    controls.update();

    createLights();
    createEnvironment();
    createTower();
    const trans = createTransformer();
    createSensor(trans);
    createKafka();
    createMongo();
    scene.updateMatrixWorld(true);
    createPipeline();

    window.addEventListener("resize", onResize);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function initUI() {
    const slider = $("loadSlider");
    slider.addEventListener("input", function () {
      state.loadMW = parseFloat(slider.value);
      setText("loadValue", state.loadMW.toFixed(1));
    });
    chartTemp = makeChart("chartTemp", "#ff6b4a", "rgba(255, 107, 74, 0.16)");
    chartVolt = makeChart("chartVolt", "#00e8ff", "rgba(0, 232, 255, 0.14)");
    for (let i = 0; i < 12; i++) {
      pushChart(chartTemp, 50 + i * 0.3);
      pushChart(chartVolt, 136 + Math.sin(i) * 0.2);
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    state.time += dt;
    frames += 1;
    fpsT += dt;
    if (fpsT >= 0.5) {
      setText("fpsLabel", Math.round(frames / fpsT) + " FPS");
      frames = 0;
      fpsT = 0;
    }

    computeTelemetry(dt);
    applyTransformerAlarm(state.time);

    if (refs.sensorLed && refs.sensorLed.material) {
      refs.sensorLed.material.emissiveIntensity = state.overload
        ? 0.4 + Math.sin(state.time * 12) * 0.6
        : 1.2 + Math.sin(state.time * 4) * 0.4;
      refs.sensorLed.material.color.setHex(state.overload ? 0xff3355 : 0x3dff8a);
      refs.sensorLed.material.emissive.setHex(state.overload ? 0xff3355 : 0x3dff8a);
    }

    refs.kafkaLeds.forEach(function (led, i) {
      const blink = state.overload ? 18 : 6;
      const on = Math.sin(state.time * blink + i * 0.7) > (state.overload ? -0.2 : 0.15);
      led.material.emissiveIntensity = on ? (state.overload ? 2.2 : 1.3) : 0.12;
      if (state.overload && i % 3 === 2) {
        led.material.emissive.setHex(0xff3355);
        led.material.color.setHex(0xff3355);
      } else if (i % 3 === 2) {
        led.material.emissive.setHex(0xffb020);
        led.material.color.setHex(0xffb020);
      }
    });

    if (refs.mongoHalo) {
      refs.mongoHalo.rotation.z += dt * 0.7;
    }

    const speedBoost = state.overload ? 1.85 : 1;
    particles.forEach(function (p) {
      p.t = (p.t + p.speed * speedBoost * dt) % 1;
      p.mesh.position.copy(p.curve.getPointAt(p.t));
    });

    controls.update();
    renderer.render(scene, camera);
    updateLabels();

    const now = new Date();
    setText("clockChip", now.toLocaleTimeString("es-CL", { hour12: false }));
    setText("phoneTime", now.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false }));
  }

  function startLoops() {
    setInterval(function () {
      renderUI();
      pushChart(chartTemp, state.tempC);
      pushChart(chartVolt, state.voltKV);
    }, 450);
  }

  function init() {
    try {
      if (typeof THREE === "undefined" || typeof THREE.OrbitControls === "undefined" || typeof Chart === "undefined") {
        throw new Error("No se pudieron cargar Three.js, OrbitControls o Chart.js");
      }
      clock = new THREE.Clock();
      initThree();
      initUI();
      computeTelemetry(0);
      renderUI();
      animate();
      startLoops();
      $("loader").classList.add("hide");
    } catch (err) {
      console.error(err);
      var box = $("loader");
      if (box) {
        box.innerHTML = "<div class='loader-inner'><p>ERROR DE INICIALIZACIÓN</p><small>" +
          String(err && err.message ? err.message : err) + "</small></div>";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
