import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface ActorNode {
  id: string;
  label: string;
  kind: "counter" | "chat";
  connected: boolean;
  value: number;
}
export interface SceneLabel {
  id: string;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  label: string;
  detail: string;
  kind: "client" | "runtime" | "counter" | "chat" | "layer";
  connected: boolean;
}

/** A live entity field. Orbs are actors; the small orange node routes their keys. */
export function createActorScene(
  canvas: HTMLCanvasElement,
  select: (id: string) => void,
  layout: (labels: SceneLabel[]) => void,
) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0b0d12, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-11, 11, 7, -7, 0.1, 100);
  const target = new THREE.Vector3(-1, 0, 1);
  camera.position.copy(target).add(new THREE.Vector3(13, 11, 18));
  camera.lookAt(target);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minAzimuthAngle = 0.3;
  controls.maxAzimuthAngle = 0.95;
  controls.minPolarAngle = 0.75;
  controls.maxPolarAngle = 1.18;
  scene.add(new THREE.AmbientLight(0xaac4dc, 1.2));
  const key = new THREE.DirectionalLight(0xe7f3ff, 3.5);
  key.position.set(2, 12, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x82e4ba, 1.2);
  rim.position.set(-8, 4, -6);
  scene.add(rim);
  const field = new THREE.Group();
  scene.add(field);
  const grid = new THREE.GridHelper(30, 30, 0x263344, 0x182230);
  grid.position.set(-2, -1.25, 1);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.42;
  field.add(grid);
  const routes = new THREE.Group();
  field.add(routes);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let dirty = true;
  let visible = true;
  let disposed = false;
  let paused = false;
  let width = 1;
  let height = 1;
  let selected = "";
  let nodes: ActorNode[] = [];
  let previousLabels = "";
  let horizontal = 10.5;
  let initialActorsFramed = false;
  let fitTarget: { center: THREE.Vector3; halfWidth: number } | null = null;
  const slots = [
    [-3, 0],
    [-6, -3.6],
    [-6, 3.6],
    [-2.4, -4.3],
    [-2.4, 4.3],
    [-9, 0],
    [-5.5, 7.2],
  ] as const;
  const actors = new Map<
    string,
    {
      group: THREE.Group;
      slot: number;
      shell: THREE.Mesh;
      edge: THREE.Mesh;
      birth: number;
      core: THREE.Mesh;
      flash: number;
      value: number;
      connected: boolean;
    }
  >();
  const retiring: { group: THREE.Group; scale: number }[] = [];
  const paths = new Map<string, THREE.CatmullRomCurve3>();
  const packets: {
    mesh: THREE.Mesh;
    path: THREE.CatmullRomCurve3;
    progress: number;
    reverse: boolean;
  }[] = [];
  const gatewayPoint = new THREE.Vector3(4.2, -0.15, 0);
  const gateway = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.42),
    new THREE.MeshStandardMaterial({
      color: 0xff744b,
      emissive: 0xff744b,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.25,
    }),
  );
  gateway.position.copy(gatewayPoint);
  field.add(gateway);
  const gatewayHalo = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 40),
    new THREE.MeshBasicMaterial({
      color: 0xff744b,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    }),
  );
  gatewayHalo.rotation.x = -Math.PI / 2;
  gatewayHalo.position.set(gatewayPoint.x, -1.23, gatewayPoint.z);
  field.add(gatewayHalo);
  const clientPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(11.5, -0.15, 0),
    new THREE.Vector3(7.5, -0.15, 0),
    gatewayPoint.clone(),
  ]);
  field.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(clientPath.getPoints(28)),
      new THREE.LineBasicMaterial({
        color: 0x9d6255,
        transparent: true,
        opacity: 0.65,
      }),
    ),
  );

  function free(root: THREE.Object3D) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        material?.dispose();
    });
  }
  function invalidate() {
    dirty = true;
  }
  function motionPreference() {
    controls.enableDamping = !reduced.matches;
    controls.update();
    if (reduced.matches && fitTarget) {
      const pending = fitTarget;
      fitTarget = null;
      applyFrame(pending.center, pending.halfWidth);
      syncLabels();
    }
    dirty = true;
  }
  controls.enableDamping = !reduced.matches;
  controls.addEventListener("change", invalidate);
  reduced.addEventListener("change", motionPreference);
  canvas.addEventListener("webglcontextrestored", invalidate);

  function pulse(path: THREE.CatmullRomCurve3, reverse = false) {
    if (paused || reduced.matches) return;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color: reverse ? 0x82e4ba : 0xff744b }),
    );
    mesh.position.copy(path.getPoint(reverse ? 1 : 0));
    field.add(mesh);
    packets.push({ mesh, path, progress: 0, reverse });
    if (packets.length > 40) {
      const old = packets.shift()!;
      field.remove(old.mesh);
      free(old.mesh);
    }
    dirty = true;
  }
  function rebuildRoutes() {
    free(routes);
    routes.clear();
    paths.clear();
    for (const node of nodes) {
      const position = actors.get(node.id)!.group.position;
      const path = new THREE.CatmullRomCurve3([
        gatewayPoint.clone(),
        new THREE.Vector3(1.6, -0.15, position.z * 0.4),
        new THREE.Vector3(position.x + 1.15, -0.15, position.z),
      ]);
      paths.set(node.id, path);
      routes.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(path.getPoints(30)),
          new THREE.LineBasicMaterial({
            color: node.connected ? 0x526d7b : 0x27313e,
            transparent: true,
            opacity: node.id === selected && node.connected ? 0.28 : 0,
          }),
        ),
      );
    }
  }
  function update(next: ActorNode[], active: string) {
    const membershipChanged =
      next.length !== nodes.length ||
      next.some((node, i) => node.id !== nodes[i]?.id);
    const structural =
      selected !== active ||
      next.length !== nodes.length ||
      next.some(
        (node, i) =>
          node.id !== nodes[i]?.id || node.connected !== nodes[i]?.connected,
      );
    selected = active;
    for (const [id, actor] of actors)
      if (!next.some((node) => node.id === id)) {
        if (paused || reduced.matches) {
          field.remove(actor.group);
          free(actor.group);
        } else
          retiring.push({ group: actor.group, scale: actor.group.scale.x });
        actors.delete(id);
      }
    for (const node of next) {
      let actor = actors.get(node.id);
      if (!actor) {
        const taken = new Set([...actors.values()].map((item) => item.slot));
        let slot = 0;
        while (taken.has(slot)) slot++;
        const [x, z] = slots[slot % slots.length];
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        const geometry = new THREE.SphereGeometry(1.04, 32, 24);
        const shell = new THREE.Mesh(
          geometry,
          new THREE.MeshPhysicalMaterial({
            color: 0x2d4658,
            transparent: true,
            opacity: 0.08,
            roughness: 0.3,
            metalness: 0.25,
            depthWrite: false,
          }),
        );
        const edge = new THREE.Mesh(
          new THREE.RingGeometry(1.12, 1.135, 64),
          new THREE.MeshBasicMaterial({
            color: 0x82e4ba,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        shell.renderOrder = 1;
        edge.renderOrder = 3;
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.86, 40, 32),
          new THREE.MeshStandardMaterial({
            color: slot % 2 ? 0x6ba3ff : 0x82e4ba,
            emissive: slot % 2 ? 0x6ba3ff : 0x82e4ba,
            emissiveIntensity: 0.35,
            roughness: 0.25,
            metalness: 0.3,
          }),
        );
        group.add(shell, edge, core);
        field.add(group);
        actor = {
          group,
          shell,
          edge,
          core,
          slot,
          flash: 0,
          birth: paused || reduced.matches ? 1 : 0,
          value: node.value,
          connected: node.connected,
        };
        actors.set(node.id, actor);
        group.traverse((object) => {
          object.userData.id = node.id;
        });
      }
      if (actor.value !== node.value && node.connected) {
        const path = paths.get(node.id);
        if (path) pulse(path, true);
        pulse(clientPath, true);
        actor.flash = reduced.matches ? 0 : 1;
      }
      actor.value = node.value;
      actor.connected = node.connected;
      const chosen = node.id === selected;
      const edge = actor.edge.material as THREE.MeshBasicMaterial;
      edge.color.setHex(
        chosen ? 0xff744b : actor.slot % 2 ? 0x6ba3ff : 0x82e4ba,
      );
      edge.opacity = chosen ? 0.8 : node.connected ? 0.22 : 0.08;
      (actor.shell.material as THREE.MeshPhysicalMaterial).opacity = chosen
        ? 0.12
        : 0.04;
      const core = actor.core.material as THREE.MeshStandardMaterial;
      core.color.setHex(
        chosen ? 0xff744b : actor.slot % 2 ? 0x6ba3ff : 0x82e4ba,
      );
      core.emissive.copy(core.color);
      actor.core.userData.baseIntensity = chosen ? 0.3 : 0.16;
      if (!node.connected) core.color.setHex(0x35414d);
      core.emissiveIntensity = node.connected
        ? actor.core.userData.baseIntensity + actor.flash
        : 0.03;
    }
    nodes = next.map((node) => ({ ...node }));
    if (structural) rebuildRoutes();
    dirty = true;
    if (membershipChanged) {
      frameActors(
        initialActorsFramed && visible && !document.hidden && !reduced.matches,
      );
      initialActorsFramed = next.length > 0;
    }
    syncLabels();
  }
  function syncLabels() {
    if (disposed || !width || !height) return;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    const result = nodes.map((node): SceneLabel => {
      const actor = actors.get(node.id)!;
      const point = actor.group.position
        .clone()
        .add(new THREE.Vector3(0, 1.55, 0))
        .project(camera);
      const anchor = actor.group.position
        .clone()
        .add(new THREE.Vector3(0, 1.1, 0))
        .project(camera);
      return {
        id: node.id,
        x: THREE.MathUtils.clamp(((point.x + 1) / 2) * width, 24, width - 24),
        y: THREE.MathUtils.clamp(((1 - point.y) / 2) * height, 24, height - 35),
        anchorX: ((anchor.x + 1) / 2) * width,
        anchorY: ((1 - anchor.y) / 2) * height,
        label: node.label,
        detail:
          node.kind === "counter" ? `count: ${node.value}` : "Conversation",
        kind: node.kind,
        connected: node.connected,
      };
    });
    const signature = JSON.stringify(
      result.map((item) => ({
        ...item,
        x: Math.round(item.x),
        y: Math.round(item.y),
        anchorX: Math.round(item.anchorX),
        anchorY: Math.round(item.anchorY),
      })),
    );
    if (signature !== previousLabels) {
      previousLabels = signature;
      layout(result);
    }
  }
  function projectFrame() {
    const aspect = width / height;
    camera.left = -horizontal;
    camera.right = horizontal;
    camera.top = horizontal / aspect;
    camera.bottom = -horizontal / aspect;
    camera.updateProjectionMatrix();
  }
  function applyFrame(center: THREE.Vector3, halfWidth: number) {
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(center);
    camera.position.copy(center).add(offset);
    horizontal = halfWidth;
    projectFrame();
    controls.update();
    dirty = true;
  }
  /** Frame actual actor volumes and the gateway, never the infinite guide grid. */
  function frameActors(animate: boolean) {
    if (width <= 1 || height <= 1) return;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(
      camera.matrixWorld,
      0,
    );
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const object of [
      ...Array.from(actors.values(), (actor) => actor.group),
      gateway,
    ]) {
      const bounds =
        object === gateway
          ? new THREE.Box3().setFromObject(object)
          : new THREE.Box3(
              object.position.clone().addScalar(-1.3),
              object.position.clone().addScalar(1.3),
            );
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z);
            const projectedX = corner.dot(right),
              projectedY = corner.dot(up);
            minX = Math.min(minX, projectedX);
            maxX = Math.max(maxX, projectedX);
            minY = Math.min(minY, projectedY);
            maxY = Math.max(maxY, projectedY);
          }
    }
    const center = controls.target
      .clone()
      .addScaledVector(right, (minX + maxX) / 2 - controls.target.dot(right))
      .addScaledVector(up, (minY + maxY) / 2 - controls.target.dot(up));
    const padding = width < 500 ? 0.8 : 0.84;
    const halfWidth = Math.max(
      (maxX - minX) / 2 / padding,
      (((maxY - minY) / 2 / padding) * width) / height,
      width < 500 ? 4.5 : 8.8,
    );
    if (animate) fitTarget = { center, halfWidth };
    else {
      fitTarget = null;
      applyFrame(center, halfWidth);
    }
    dirty = true;
  }
  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (!width || !height) return;
    projectFrame();
    frameActors(false);
    renderer.setSize(width, height, false);
    controls.enableRotate = width > 600;
    canvas.style.touchAction = width > 600 ? "none" : "pan-y";
    dirty = true;
    syncLabels();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) dirty = true;
    else if (fitTarget) {
      const pending = fitTarget;
      fitTarget = null;
      applyFrame(pending.center, pending.halfWidth);
    }
    syncLabels();
  });
  visibility.observe(canvas);
  const raycaster = new THREE.Raycaster();
  let downX = 0;
  let downY = 0;
  const down = (event: PointerEvent) => {
    downX = event.clientX;
    downY = event.clientY;
  };
  const up = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) return;
    const bounds = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - bounds.left) / width) * 2 - 1,
        (-(event.clientY - bounds.top) / height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObjects(
      [...actors.values()]
        .filter((actor) => actor.group.visible)
        .map((actor) => actor.shell),
      false,
    )[0];
    if (hit?.object.userData.id) select(hit.object.userData.id);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const elapsed = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (disposed || !visible || document.hidden) return;
    let fitting = false;
    if (fitTarget) {
      const pending = fitTarget;
      const amount = reduced.matches ? 1 : 1 - Math.exp(-elapsed * 11);
      const center = controls.target.clone().lerp(pending.center, amount);
      const halfWidth = THREE.MathUtils.lerp(
        horizontal,
        pending.halfWidth,
        amount,
      );
      if (
        center.distanceTo(pending.center) < 0.015 &&
        Math.abs(halfWidth - pending.halfWidth) < 0.01
      ) {
        fitTarget = null;
        applyFrame(pending.center, pending.halfWidth);
      } else applyFrame(center, halfWidth);
      fitting = true;
    }
    const cameraChanged = controls.update();
    let animating = fitting;
    for (const actor of actors.values()) {
      actor.edge.quaternion.copy(camera.quaternion);
      if (actor.birth < 1) {
        actor.birth =
          paused || reduced.matches
            ? 1
            : Math.min(1, actor.birth + elapsed * 3.5);
        actor.group.scale.setScalar(1 - Math.pow(1 - actor.birth, 3));
        animating = true;
      }
      if (actor.flash > 0 && !paused) {
        actor.flash = reduced.matches
          ? 0
          : Math.max(0, actor.flash - elapsed * 1.8);
        (actor.core.material as THREE.MeshStandardMaterial).emissiveIntensity =
          actor.connected
            ? actor.core.userData.baseIntensity + actor.flash * 0.6
            : 0.03;
        actor.core.scale.setScalar(1 + actor.flash * 0.1);
        animating = true;
      }
    }
    for (let i = retiring.length - 1; i >= 0; i--) {
      const actor = retiring[i];
      actor.scale =
        paused || reduced.matches ? 0 : Math.max(0, actor.scale - elapsed * 5);
      actor.group.scale.setScalar(actor.scale);
      if (actor.scale === 0) {
        field.remove(actor.group);
        free(actor.group);
        retiring.splice(i, 1);
      }
      animating = true;
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const packet = packets[i];
      if (!paused) packet.progress += elapsed / 0.85;
      if (packet.progress >= 1 || reduced.matches) {
        field.remove(packet.mesh);
        free(packet.mesh);
        packets.splice(i, 1);
        dirty = true;
      } else {
        packet.mesh.position.copy(
          packet.path.getPoint(
            packet.reverse ? 1 - packet.progress : packet.progress,
          ),
        );
        if (!paused) animating = true;
      }
    }
    if (dirty || cameraChanged || animating) {
      renderer.render(scene, camera);
      syncLabels();
      dirty = false;
    }
  });
  resize();
  return {
    update,
    action(id: string) {
      const actor = actors.get(id);
      if (actor && !paused && !reduced.matches) actor.flash = 1;
      const path = paths.get(id);
      if (path) pulse(path);
      pulse(clientPath);
    },
    setPaused(value: boolean) {
      if (paused !== value) dirty = true;
      paused = value;
    },
    rotate() {
      const offset = camera.position.clone().sub(controls.target);
      const angle = new THREE.Spherical().setFromVector3(offset);
      angle.theta += Math.PI / 14;
      if (angle.theta > controls.maxAzimuthAngle)
        angle.theta = controls.minAzimuthAngle;
      camera.position.copy(controls.target).add(offset.setFromSpherical(angle));
      controls.update();
      dirty = true;
      syncLabels();
    },
    reset() {
      camera.position.copy(target).add(new THREE.Vector3(13, 11, 18));
      controls.target.copy(target);
      controls.update();
      frameActors(false);
      dirty = true;
      syncLabels();
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      visibility.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("webglcontextrestored", invalidate);
      controls.removeEventListener("change", invalidate);
      reduced.removeEventListener("change", motionPreference);
      controls.dispose();
      free(scene);
      renderer.dispose();
    },
  };
}
