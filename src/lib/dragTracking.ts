export function movedEnough(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  minDistance = 5,
) {
  return Math.hypot(currentX - startX, currentY - startY) > minDistance
}
