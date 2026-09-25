// Geometry of the Yonder mark, on a 48-unit grid.
//
// A route forks. The left branch sweeps up to a start; the right branch stops
// short of a warm dot, the "yonder point": the place the group is heading,
// just beyond where the line has been drawn so far.

/** Standard weight, for logos and icons 48px and up. */
export const standard = {
  sw: 4.6,
  segments: [
    { kind: 'C', p: [[13, 12], [13, 19], [24, 19], [24, 27]] }, // left branch, arrives vertical
    { kind: 'L', p: [[24, 27], [24, 38]] }, //                      shared stem
    { kind: 'C', p: [[24, 27], [24, 21.5], [28, 18.5], [30.5, 16.5]] }, // right branch, aims at the dot
  ],
  dot: { cx: 36.6, cy: 11.6, r: 3.7 },
};

/**
 * Heavier cut for favicons (16-32px). The stem sits on x = 24, which lands on
 * a pixel edge at 16px and 32px, so a 6-unit stroke renders as exactly 2px/4px.
 * The branch is shortened so the gap before the dot survives at small sizes.
 */
export const small = {
  sw: 6,
  segments: [
    { kind: 'C', p: [[12.5, 11.5], [12.5, 19], [24, 19], [24, 27.5]] },
    { kind: 'L', p: [[24, 27.5], [24, 39]] },
    { kind: 'C', p: [[24, 27.5], [24, 22.5], [27, 19.5], [29, 18]] },
  ],
  // Centered on a pixel center at 16px (3 units/px) so the dot stays round.
  dot: { cx: 37.5, cy: 10.5, r: 4.5 },
};

const f = (n) => +n.toFixed(3);

export function pathData(g) {
  const out = [];
  let pen = null;
  for (const s of g.segments) {
    const [start, ...rest] = s.p;
    if (!pen || pen[0] !== start[0] || pen[1] !== start[1]) out.push(`M${f(start[0])} ${f(start[1])}`);
    out.push(s.kind + rest.map(([x, y]) => `${f(x)} ${f(y)}`).join(' '));
    pen = rest.at(-1);
  }
  return out.join('');
}

function bezier([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** Sample points on the stroke centerline plus the radius each point is inflated by. */
function samples(g) {
  const pts = [];
  for (const s of g.segments) {
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const p = s.kind === 'C' ? bezier(s.p, t) : [s.p[0][0] + (s.p[1][0] - s.p[0][0]) * t, s.p[0][1] + (s.p[1][1] - s.p[0][1]) * t];
      pts.push({ x: p[0], y: p[1], r: g.sw / 2 });
    }
  }
  pts.push({ x: g.dot.cx, y: g.dot.cy, r: g.dot.r });
  return pts;
}

/** Exact-enough ink bounds (round caps and joins, so inflating by sw/2 is right). */
export function bounds(g) {
  const pts = samples(g);
  const x1 = Math.min(...pts.map((p) => p.x - p.r));
  const y1 = Math.min(...pts.map((p) => p.y - p.r));
  const x2 = Math.max(...pts.map((p) => p.x + p.r));
  const y2 = Math.max(...pts.map((p) => p.y + p.r));
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

/** Largest distance from (cx, cy) to any inked point: used to fit the maskable safe zone. */
export function reach(g, cx, cy) {
  return Math.max(...samples(g).map((p) => Math.hypot(p.x - cx, p.y - cy) + p.r));
}

/** The mark as SVG elements in grid units. */
export function markElements(g, { stroke, dot }) {
  return (
    `<path d="${pathData(g)}" fill="none" stroke="${stroke}" stroke-width="${g.sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${g.dot.cx}" cy="${g.dot.cy}" r="${g.dot.r}" fill="${dot}"/>`
  );
}
