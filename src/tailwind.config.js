// =============================================================================
// Tailwind cấu hình – build cho toàn bộ project
// [1] Quét toàn bộ template trong modules / static / root
// [2] Thêm breakpoint "wide" = 1280px
// [3] Thêm màu overlay + shadow "modal"
// [4] Bật plugin tailwindcss-animate
// [5] Định nghĩa btn-primary chuẩn UX
// =============================================================================

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./modules/**/templates/**/*.html", // [1.1]
    "./templates/**/*.html",            // [1.2]
    "./static/js/**/*.js",              // [1.3]
    "./modules/**/static/js/**/*.js",   // [1.4]
  ],
  theme: {
    extend: {
      /* [2] Breakpoint mở rộng */
      screens: {
        wide: "1280px",
      },

      /* [3] Màu & shadow modal */
      colors: {
        overlay: "rgba(5,5,5,0.5)", // bg-overlay
      },
      boxShadow: {
        modal: "0 8px 24px rgba(0,0,0,0.18)", // shadow-modal
      },
    },
  },

  /* [4] Plugins */
  plugins: [
    require("tailwindcss-animate"), // dùng animate-in/out, zoom, fade...

    /* [5] Component: btn-primary */
    function ({ addComponents }) {
      addComponents({
        ".btn-primary": {
          "@apply bg-[#003F7A] text-white px-4 py-[10px] rounded-full font-medium shadow-md transition": {},
          "&:hover": {
            "@apply bg-[#144E84] shadow-lg": {},
          },
          "&:active": {
            "@apply bg-[#003A70] shadow-inner": {},
          },
          "&:focus-visible": {
            "@apply outline-none ring-2 ring-blue-300 ring-offset-2 ring-offset-[#1F1F1F]": {},
          },
          "&[disabled]": {
            "@apply opacity-60 cursor-not-allowed": {},
          },
        },
      });
    },
  ],
};
