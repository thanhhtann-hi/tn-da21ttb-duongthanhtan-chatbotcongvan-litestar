// =============================================================================
// PostCSS config (dùng cho toàn bộ project)
// • Hỗ trợ @import, nesting, Tailwind, Autoprefixer
// • Tự động minify bằng cssnano khi NODE_ENV = production
// =============================================================================

module.exports = {
  plugins: [
    require("postcss-import"),              // @import "..." trong CSS
    require("tailwindcss/nesting"),         // hỗ trợ nesting chuẩn CSS
    require("tailwindcss"),                 // Tailwind ↔ tailwind.config.js
    require("autoprefixer"),                // thêm prefix theo caniuse
    ...(process.env.NODE_ENV === "production"
      ? [require("cssnano")({ preset: "default" })] // minify khi build prod
      : []),
  ],
};
