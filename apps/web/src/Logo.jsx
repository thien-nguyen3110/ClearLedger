import React from 'react';

// ClearLedger's mark: two isometric ledger slabs, processor over bank, stacked in register.
// Each slab has a lit top, a dim left face, and a darker right face, so the mark reads as a
// solid object at 28px in the sidebar and at display size on the connect and empty screens.
function Slab({ y }) {
  const top = `32,${y} 58,${y + 13} 32,${y + 26} 6,${y + 13}`;
  const left = `6,${y + 13} 32,${y + 26} 32,${y + 34} 6,${y + 21}`;
  const right = `32,${y + 26} 58,${y + 13} 58,${y + 21} 32,${y + 34}`;
  return <g className="slab">
    <polygon className="face-left" points={left} />
    <polygon className="face-right" points={right} />
    <polygon className="face-top" points={top} />
    <polyline className="edge" points={`6,${y + 13} 6,${y + 21} 32,${y + 34} 58,${y + 21} 58,${y + 13}`} />
    <line className="edge" x1="32" y1={y + 26} x2="32" y2={y + 34} />
  </g>;
}

export function Logo({ size = 28, className = '' }) {
  return <svg className={'logo3d ' + className} viewBox="0 0 64 58" width={size} height={size * 58 / 64} aria-hidden="true" focusable="false">
    <Slab y={21} />
    <Slab y={3} />
    {/* The register line: both slabs aligned, the reconciled state the product works toward. */}
    <polyline className="tick" points="22,16 29,20 43,11" />
  </svg>;
}
