const territory = [
  "11110000",
  "11110100",
  "11111000",
  "11110100",
  "11110010",
  "11111000",
  "11011110",
  "11101100",
  "11111101",
  "11111010",
  "11111111",
  "11111110",
];

export function HeroArtwork() {
  return <div className="hero-artwork" aria-hidden="true">
    <svg className="hero-tiles-blue" viewBox="-120 0 600 740" preserveAspectRatio="xMidYMid slice" focusable="false">
      <defs>
        <linearGradient id="hero-blue-tiles" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="480" y2="0">
          <stop stopColor="var(--blue)" stopOpacity=".5" />
          <stop offset=".65" stopColor="var(--blue)" stopOpacity=".28" />
          <stop offset="1" stopColor="var(--blue)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform="rotate(-18 60 420)" fill="url(#hero-blue-tiles)">
        {territory.flatMap((row, y) => [...row].map((occupied, x) => occupied === "1"
          ? <rect key={`${y}-${x}`} x={x * 58 - 120} y={y * 58 + 100} width="54" height="54" /> : null))}
      </g>
    </svg>
    <svg className="hero-tiles-red" viewBox="1120 0 600 740" preserveAspectRatio="xMidYMid slice" focusable="false">
      <defs>
        <linearGradient id="hero-red-tiles" gradientUnits="userSpaceOnUse" x1="1130" y1="0" x2="1600" y2="0">
          <stop stopColor="var(--coral)" stopOpacity="0" />
          <stop offset=".35" stopColor="var(--coral)" stopOpacity=".3" />
          <stop offset="1" stopColor="var(--coral)" stopOpacity=".55" />
        </linearGradient>
      </defs>
      <g transform="rotate(-18 1480 180)" fill="url(#hero-red-tiles)">
        {[...territory].reverse().flatMap((row, y) => [...row].reverse().map((occupied, x) => occupied === "1"
          ? <rect key={`${y}-${x}`} x={x * 58 + 1190} y={y * 58 - 150} width="54" height="54" /> : null))}
      </g>
    </svg>
  </div>;
}
