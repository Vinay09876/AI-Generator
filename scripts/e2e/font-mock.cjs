// Isolated E2E only: answers next/font/google's build-time CSS requests from memory via Next's
// documented NEXT_FONT_GOOGLE_MOCKED_RESPONSES test hook, so the build needs no network. Keys are
// the exact URLs Next builds for src/app/layout.tsx (Inter and Sora, variable weight, swap).
// Font files become placeholder bytes, so the browser renders fallback fonts (visual difference only).
const css = (family, weights) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weights};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/mock/${family.toLowerCase()}-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`;

module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap": css("Inter", "100 900"),
  "https://fonts.googleapis.com/css2?family=Sora:wght@100..800&display=swap": css("Sora", "100 800"),
};
