import * as THREE from 'three';
import type { Vec3 } from '../types';

/**
 * Screen point -> world GPS (metres), by intersecting the pointer ray with a
 * plane through the scene centre that faces the camera.
 *
 * Used only by the designer's "click a map point" connect flow. It reads the
 * camera; it never writes to it, so it cannot hijack the view (see
 * CameraDirector).
 */
export function gpsFromScreen(
  camera: THREE.Camera | null,
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  planeCenterKm: Vec3,
): Vec3 | null {
  if (!camera || rect.width <= 0 || rect.height <= 0) return null;
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal,
    new THREE.Vector3(planeCenterKm.x, planeCenterKm.y, planeCenterKm.z),
  );
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  return { x: hit.x * 1000, y: hit.y * 1000, z: hit.z * 1000 };
}
