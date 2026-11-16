import * as THREE from 'three';

const AUTO = 'AUTO';
const MANUAL = 'MANUAL';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0.5, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  const grid = new THREE.GridHelper(20, 20, 0x334155, 0x1f2937);
  scene.add(grid);

  const geometry = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  const material = new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: 0.35, metalness: 0.1 });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(0, 0.5, 0);
  scene.add(cube);

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', resize);
  resize();

  function render() {
    renderer.render(scene, camera);
  }

  return { scene, camera, renderer, cube, render, resize };
}

export function createHostSimulation(cube, opts = {}) {
  let mode = AUTO;
  let t = 0;
  const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
  const manualPos = { x: 0, z: 0 };
  const onModeChange = opts.onModeChange || (() => {});

  const A = 2.0;      // figure-eight width
  const B = 1.4;      // figure-eight depth
  const omega = 1.2;  // rad/s
  const manualSpeed = 2.5; // units/s
  const bounds = 3.5;
  const baseY = 0.5;

  function setMode(next) {
    mode = next;
    if (mode === MANUAL) {
      manualPos.x = cube.position.x;
      manualPos.z = cube.position.z;
    }
    onModeChange(mode);
  }

  function toggleMode() {
    setMode(mode === AUTO ? MANUAL : AUTO);
  }

  function onKeyDown(e) {
    if (e.key === 'm' || e.key === 'M') {
      toggleMode();
      return;
    }
    if (e.key in keys) {
      keys[e.key] = true;
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    if (e.key in keys) {
      keys[e.key] = false;
      e.preventDefault();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function step(dt) {
    t += dt;
    if (mode === AUTO) {
      const s = Math.sin(omega * t);
      const c = Math.cos(omega * t);
      cube.position.set(A * s, baseY, B * s * c);
      cube.rotation.set(t * 0.7, t * 1.1, 0);
    } else {
      let dx = 0, dz = 0;
      if (keys.ArrowLeft) dx -= 1;
      if (keys.ArrowRight) dx += 1;
      if (keys.ArrowUp) dz -= 1;
      if (keys.ArrowDown) dz += 1;
      if (dx !== 0 || dz !== 0) {
        const len = Math.hypot(dx, dz) || 1;
        manualPos.x += (dx / len) * manualSpeed * dt;
        manualPos.z += (dz / len) * manualSpeed * dt;
        manualPos.x = Math.max(-bounds, Math.min(bounds, manualPos.x));
        manualPos.z = Math.max(-bounds, Math.min(bounds, manualPos.z));
      }
      cube.position.set(manualPos.x, baseY, manualPos.z);
      cube.rotation.set(0.4, t * 0.8, 0);
    }
  }

  function getState() {
    return {
      position: [cube.position.x, cube.position.y, cube.position.z],
      rotation: [cube.rotation.x, cube.rotation.y, cube.rotation.z],
    };
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  return { step, getState, toggleMode, get mode() { return mode; }, dispose };
}

export function applyState(cube, state) {
  if (!state) return false;
  const p = state.position;
  const r = state.rotation;
  if (!Array.isArray(p) || p.length !== 3 || !Array.isArray(r) || r.length !== 3) return false;
  if (![...p, ...r].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  cube.position.set(p[0], p[1], p[2]);
  cube.rotation.set(r[0], r[1], r[2]);
  return true;
}

export { AUTO, MANUAL };
