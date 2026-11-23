// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Rulers along the top and left of the diagram canvas (DGM-14 S3, 3a): board units, labelled
// every major step, the selection's span highlighted. Drawn in screen pixels from the view.
type Box = [number, number, number, number];
interface View {
  tx: number;
  ty: number;
  z: number;
}

const STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
/** The smallest step whose labels are at least 60 screen pixels apart. */
export const rulerStep = (z: number) => STEPS.find((s) => s * z >= 60) ?? STEPS[STEPS.length - 1];

function ticks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to && out.length < 400; v += step) out.push(v);
  return out;
}

export function Rulers({ view, size, span }: { view: View; size: [number, number]; span: Box | null }) {
  const [W, H] = size;
  const { tx, ty, z } = view;
  const step = rulerStep(z);
  const R = 20; // ruler thickness in screen px (1.25rem at the default size; drawing only)
  const xs = ticks((R - tx) / z, (W - tx) / z, step);
  const ys = ticks((R - ty) / z, (H - ty) / z, step);
  const minor = step / 5;
  const xm = minor * z >= 6 ? ticks((R - tx) / z, (W - tx) / z, minor) : [];
  const ym = minor * z >= 6 ? ticks((R - ty) / z, (H - ty) / z, minor) : [];
  return (
    <div className="ocdg-rulers" aria-hidden="true">
      <div className="ocdg-rul h">
        <svg>
          {span ? <rect className="ocdg-span" x={span[0] * z + tx - R} y={0} width={(span[2] - span[0]) * z} height="100%" fill="var(--accent-soft)" /> : null}
          {xm.map((v) => (
            <line key={"m" + v} x1={v * z + tx - R} x2={v * z + tx - R} y1={15} y2={20} stroke="var(--line-2)" />
          ))}
          {xs.map((v) => (
            <g key={v}>
              <line x1={v * z + tx - R} x2={v * z + tx - R} y1={8} y2={20} stroke="var(--fg-4)" />
              <text x={v * z + tx - R + 3} y={10} fontSize={10}>{v}</text>
            </g>
          ))}
        </svg>
      </div>
      <div className="ocdg-rul v">
        <svg>
          {span ? <rect className="ocdg-span" y={span[1] * z + ty - R} x={0} height={(span[3] - span[1]) * z} width="100%" fill="var(--accent-soft)" /> : null}
          {ym.map((v) => (
            <line key={"m" + v} y1={v * z + ty - R} y2={v * z + ty - R} x1={15} x2={20} stroke="var(--line-2)" />
          ))}
          {ys.map((v) => (
            <g key={v}>
              <line y1={v * z + ty - R} y2={v * z + ty - R} x1={8} x2={20} stroke="var(--fg-4)" />
              <text x={10} y={v * z + ty - R + 3} fontSize={10} transform={`rotate(-90 10 ${v * z + ty - R + 3})`} textAnchor="end">{v}</text>
            </g>
          ))}
        </svg>
      </div>
      <div className="ocdg-rc" />
    </div>
  );
}
