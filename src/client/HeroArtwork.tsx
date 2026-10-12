const territory = [
  "1111100000",
  "1111110100",
  "1111101000",
  "1111110000",
  "1111110000",
  "1111110100",
  "1111111000",
  "1111110100",
  "1111110010",
  "1111111000",
  "1111011110",
  "1111101100",
  "1111111101",
  "1111111010",
  "1111111111",
  "1111111110",
];

const rivalTerritory = [
  "00111111111",
  "00011111111",
  "01011011111",
  "00101111111",
  "10011101111",
  "00110111111",
  "01001110111",
  "00111011111",
  "00010111111",
  "10001110111",
  "00110111111",
  "01001101111",
  "00011011111",
  "00101111111",
  "00011011111",
  "00110111111",
  "00011101111",
  "00101111111",
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
          ? <rect key={`${y}-${x}`} x={x * 58 - 236} y={y * 58 - 132} width="54" height="54" /> : null))}
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
        {rivalTerritory.flatMap((row, y) => [...row].map((occupied, x) => occupied === "1"
          ? <rect key={`${y}-${x}`} x={x * 58 + 1150} y={y * 58 - 150} width="54" height="54" /> : null))}
      </g>
    </svg>
  </div>;
}
