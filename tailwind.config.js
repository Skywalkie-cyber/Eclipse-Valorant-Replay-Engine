/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        valRed: "#ff4655",
        valDark: "#0f1115",
        valCard: "#181b22",
        valBorder: "#272c38",
        valMuted: "#8b949e",
      },
    },
  },
  plugins: [],
}

